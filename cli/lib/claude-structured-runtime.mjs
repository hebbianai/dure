import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const DRIVER_DIRECTORY = join("provider-drivers", "claude");
const RELAY_COMMAND =
  process.platform === "win32"
    ? "dure-claude-process-relay.exe"
    : "dure-claude-process-relay";
const VERSION = /^\d+\.\d+\.\d+$/u;

export class ClaudeStructuredRuntimeBundleError extends Error {
  constructor(reason, options = {}) {
    super(`the bundled Claude structured runtime is invalid: ${reason}`, options);
    this.code = "claude_structured_runtime_bundle_invalid";
    this.reason = reason;
    this.name = "ClaudeStructuredRuntimeBundleError";
  }
}

function invalid(reason, options) {
  throw new ClaudeStructuredRuntimeBundleError(reason, options);
}

function readJson(pathname, reason) {
  let value;
  try {
    value = JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    invalid(reason, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(reason);
  }
  return value;
}

function regularFile(pathname, { executable = false, reason }) {
  let path;
  let stat;
  try {
    stat = lstatSync(pathname, { bigint: true });
    if (stat.isSymbolicLink()) invalid(reason);
    path = realpathSync(pathname);
  } catch (error) {
    if (error instanceof ClaudeStructuredRuntimeBundleError) throw error;
    invalid(reason, { cause: error });
  }
  if (
    !stat.isFile() ||
    stat.size < 1n ||
    stat.size > 512n * 1024n * 1024n ||
    (stat.mode & 0o022n) !== 0n ||
    (executable && (stat.mode & 0o111n) === 0n)
  ) {
    invalid(reason);
  }
  return path;
}

function ownerDirectory(pathname, reason) {
  let stat;
  try {
    stat = lstatSync(pathname, { bigint: true });
  } catch (error) {
    invalid(reason, { cause: error });
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077n) !== 0n ||
    (typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid()))
  ) {
    invalid(reason);
  }
  return realpathSync(pathname);
}

function ensureRuntimeRoot(appRoot) {
  if (!isAbsolute(appRoot)) invalid("app_root_invalid");
  const runtimesRoot = join(resolve(appRoot), "runtimes");
  const runtimeRoot = join(runtimesRoot, "claude-code");
  for (const directory of [runtimesRoot, runtimeRoot]) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        invalid("runtime_root_unsafe", { cause: error });
      }
    }
    ownerDirectory(directory, "runtime_root_unsafe");
  }
  return realpathSync(runtimeRoot);
}

function pathExists(pathname) {
  try {
    lstatSync(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function runtimePayloadDigest({
  claudeCodeVersion,
  driverRoot,
  nodeVersion,
  relayBin,
  sdkVersion,
}) {
  const runtimeFiles = readdirSync(driverRoot)
    .filter(
      (name) =>
        name === "package.json" ||
        name === "pnpm-lock.yaml" ||
        name === "pnpm-workspace.yaml" ||
        (name.endsWith(".mjs") && !name.endsWith(".test.mjs")),
    )
    .sort();
  const digest = createHash("sha256");
  for (const name of runtimeFiles) {
    digest.update(name).update("\0");
    digest.update(readFileSync(join(driverRoot, name))).update("\0");
  }
  digest
    .update(readFileSync(relayBin))
    .update("\0")
    .update(String(lstatSync(relayBin).mode & 0o111))
    .update("\0");
  digest
    .update(nodeVersion)
    .update("\0")
    .update(sdkVersion)
    .update("\0")
    .update(claudeCodeVersion);
  return digest.digest("hex");
}

export function resolveBundledClaudeStructuredRuntimePayload({
  cliScriptPath,
  nodeVersion = process.versions.node,
}) {
  const cliRoot = dirname(resolve(cliScriptPath));
  const driverRoot = join(cliRoot, DRIVER_DIRECTORY);
  const relayCandidate = join(cliRoot, RELAY_COMMAND);
  const entrypointCandidate = join(driverRoot, "shared-sdk-host-entrypoint.mjs");
  const driverManifestCandidate = join(driverRoot, "package.json");
  const sdkManifestCandidate = join(
    driverRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "package.json",
  );
  const candidates = [
    relayCandidate,
    entrypointCandidate,
    driverManifestCandidate,
    sdkManifestCandidate,
  ];
  const present = candidates.map(pathExists);
  if (present.every((value) => !value)) return null;
  if (present.some((value) => !value)) invalid("payload_incomplete");

  const driverManifest = readJson(driverManifestCandidate, "driver_manifest_invalid");
  const sdkVersion = driverManifest.dependencies?.["@anthropic-ai/claude-agent-sdk"];
  if (!VERSION.test(sdkVersion ?? "")) invalid("sdk_version_invalid");
  if (driverManifest.engines?.node !== nodeVersion) {
    invalid("node_version_mismatch");
  }
  const sdkManifest = readJson(sdkManifestCandidate, "sdk_manifest_invalid");
  if (
    sdkManifest.version !== sdkVersion ||
    !VERSION.test(sdkManifest.claudeCodeVersion ?? "")
  ) {
    invalid("sdk_manifest_mismatch");
  }

  const hostEntrypoint = regularFile(entrypointCandidate, {
    reason: "entrypoint_invalid",
  });
  const relayBin = regularFile(relayCandidate, {
    executable: true,
    reason: "relay_invalid",
  });
  return Object.freeze({
    claudeCodeVersion: sdkManifest.claudeCodeVersion,
    payloadDigest: runtimePayloadDigest({
      claudeCodeVersion: sdkManifest.claudeCodeVersion,
      driverRoot,
      nodeVersion,
      relayBin,
      sdkVersion,
    }),
    hostEntrypoint,
    relayBin,
    sdkVersion,
  });
}

export function resolveBundledClaudeStructuredRuntime({
  appRoot,
  cliScriptPath,
  nodeExecutable = process.execPath,
  nodeVersion = process.versions.node,
  platform = process.platform,
}) {
  if (platform !== "darwin" && platform !== "linux") return null;
  const payload = resolveBundledClaudeStructuredRuntimePayload({
    cliScriptPath,
    nodeVersion,
  });
  if (!payload) return null;
  return Object.freeze({
    ...payload,
    nodeBin: regularFile(nodeExecutable, {
      executable: true,
      reason: "node_invalid",
    }),
    runtimeRoot: ensureRuntimeRoot(appRoot),
  });
}

export function sameClaudeStructuredRuntimePayload(left, right) {
  return left === null || right === null
    ? left === right
    : left.payloadDigest === right.payloadDigest;
}

export function claudeStructuredRuntimeArguments(runtime) {
  if (!runtime) return [];
  return [
    "--claude-node-bin",
    runtime.nodeBin,
    "--claude-host-entrypoint",
    runtime.hostEntrypoint,
    "--claude-relay-bin",
    runtime.relayBin,
    "--claude-runtime-root",
    runtime.runtimeRoot,
  ];
}
