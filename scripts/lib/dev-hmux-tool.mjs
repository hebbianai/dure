import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { devHmuxToolPaths, validateAppChannel } from "./app-channel.mjs";
import { DEV_HMUX_STANDALONE_OPERATION_CAPABILITY } from "./dev-hmux-operation-contract.mjs";
import { resolvePosixShellExecutable } from "./unix-process-tools.mjs";
import {
  computeHmuxDevBuildId,
  HMUX_DEV_RUSTC_IDENTITY_TIMEOUT_MS,
} from "../hmux-dev-build-id.mjs";

const DEV_HMUX_CAPABILITY_TIMEOUT_MS = 2_000;
const DEV_HMUX_CAPABILITY_MAX_BYTES = 64 * 1024;
const DEV_HMUX_PREPARE_MAX_BYTES = 64 * 1024 * 1024;
const DEV_HMUX_BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

class DevHmuxUnavailableError extends Error {}

export function parseDevHmuxBuildId(value) {
  if (typeof value !== "string" || !DEV_HMUX_BUILD_ID.test(value)) {
    throw new Error("development Hmux build identity is invalid");
  }
  return value;
}

function isDevAppChannel(value) {
  try {
    return validateAppChannel(value) === value && value.startsWith("dev-");
  } catch {
    return false;
  }
}

export function parseDevHmuxActivationProof(
  value,
  expected = {},
  label = "development Hmux activation",
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    !SOURCE_REVISION.test(value.sourceRevision ?? "") ||
    !isDevAppChannel(value.channel)
  ) {
    throw new Error(`${label} is invalid`);
  }
  const proof = {
    schemaVersion: 1,
    sourceRevision: value.sourceRevision,
    channel: value.channel,
    buildId: parseDevHmuxBuildId(value.buildId),
  };
  if (
    (expected.sourceRevision &&
      proof.sourceRevision !== expected.sourceRevision) ||
    (expected.channel && proof.channel !== expected.channel)
  ) {
    throw new Error(`${label} does not match the deployment target`);
  }
  return proof;
}

function ownerExecutable(pathname) {
  const metadata = lstatSync(pathname);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o111) === 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid())
  ) {
    throw new Error("development Hmux executable is unsafe");
  }
}

function immutableVersion(paths, expectedBuildId) {
  const versions = realpathSync(join(paths.installRoot, "versions"));
  const canonicalBuildId = parseDevHmuxBuildId(expectedBuildId);
  const selected = join(versions, canonicalBuildId);
  if (lstatSync(selected).isSymbolicLink()) {
    throw new Error("development Hmux target version is unsafe");
  }
  const version = realpathSync(selected);
  const buildId = version.slice(versions.length + 1);
  if (
    dirname(version) !== versions ||
    parseDevHmuxBuildId(buildId) !== canonicalBuildId
  ) {
    throw new Error("development Hmux target version is unsafe");
  }
  const metadataPath = join(version, "install.json");
  const metadataStat = lstatSync(metadataPath);
  if (
    metadataStat.isSymbolicLink() ||
    !metadataStat.isFile() ||
    metadataStat.nlink !== 1 ||
    (metadataStat.mode & 0o022) !== 0 ||
    (process.getuid && metadataStat.uid !== process.getuid())
  ) {
    throw new Error("development Hmux install metadata is unsafe");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.schemaVersion !== 1 || metadata.buildId !== buildId) {
    throw new Error("development Hmux install metadata is invalid");
  }
  return { buildId, version };
}

function capabilityEnvironment(home, source = process.env) {
  const environment = { HOME: home };
  for (const key of ["LANG", "LC_ALL", "PATH", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"]) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  return environment;
}

function resolveDevHmuxTool({
  home,
  channel,
  requiredCapability = DEV_HMUX_STANDALONE_OPERATION_CAPABILITY,
  expectedBuildId,
}) {
  const paths = devHmuxToolPaths(home, channel);
  let version;
  let buildId;
  let executable;
  try {
    ({ buildId, version } = immutableVersion(paths, expectedBuildId));
    executable = realpathSync(
      join(version, "bin", process.platform === "win32" ? "hmux.exe" : "hmux"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new DevHmuxUnavailableError("development Hmux is not installed");
    }
    throw error;
  }
  const expected = join(
    version,
    "bin",
    process.platform === "win32" ? "hmux.exe" : "hmux",
  );
  if (executable !== expected) {
    throw new Error("development Hmux target command is unsafe");
  }
  ownerExecutable(executable);
  let capabilities;
  try {
    capabilities = JSON.parse(
      execFileSync(executable, ["capabilities", "--json"], {
        encoding: "utf8",
        env: capabilityEnvironment(home),
        maxBuffer: DEV_HMUX_CAPABILITY_MAX_BYTES,
        timeout: DEV_HMUX_CAPABILITY_TIMEOUT_MS,
      }),
    );
  } catch {
    throw new Error("development Hmux target capability probe failed");
  }
  if (
    capabilities?.schemaVersion !== 2 ||
    capabilities.buildInfo?.buildId !== buildId ||
    capabilities.buildInfo?.source !== "hmux_cli" ||
    !Array.isArray(capabilities.capabilities) ||
    !capabilities.capabilities.includes(requiredCapability)
  ) {
    throw new Error("development Hmux target build is not self-consistent");
  }
  return executable;
}

function preparationEnvironment(home, source = process.env) {
  const environment = { HOME: home };
  for (const key of [
    "CARGO_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "RUSTUP_HOME",
    "SHELL",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
  ]) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  return environment;
}

export function targetDevHmuxBuildId({ root, home, timeoutMs }) {
  return computeHmuxDevBuildId({
    repositoryRoot: root,
    environment: preparationEnvironment(home),
    rustcTimeoutMs:
      timeoutMs === undefined
        ? HMUX_DEV_RUSTC_IDENTITY_TIMEOUT_MS
        : Math.min(timeoutMs, HMUX_DEV_RUSTC_IDENTITY_TIMEOUT_MS),
  });
}

function boundedOutputTail(value, maximum = 4_096) {
  const output = typeof value === "string" ? value.trim() : "";
  return output.length > maximum ? output.slice(-maximum) : output;
}

function prepareDevHmuxTool({
  root,
  home,
  channel,
  expectedBuildId,
  shellExecutable,
  timeoutMs,
}) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "scripts", "run-with-build-storage.mjs"),
      "dev",
      "--",
      shellExecutable,
      join(root, "scripts", "prepare-hmux-dev-tools.sh"),
    ],
    {
      cwd: root,
      env: {
        ...preparationEnvironment(home),
        DURE_POSIX_SHELL: shellExecutable,
        HMUX_DEV_BUILD_ID: expectedBuildId,
        HMUX_DEV_CHANNEL: channel,
      },
      encoding: "utf8",
      maxBuffer: DEV_HMUX_PREPARE_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    },
  );
  if (result.status !== 0) {
    const detail =
      boundedOutputTail(result.stderr) || boundedOutputTail(result.stdout);
    const summary =
      result.error?.message ??
      `development Hmux preparation exited with status ${result.status}`;
    throw new Error(
      detail.length > 0 ? `${summary}: ${detail}` : summary,
    );
  }
}

export function ensureDevHmuxTool(
  {
    root,
    home,
    channel,
    requiredCapability = DEV_HMUX_STANDALONE_OPERATION_CAPABILITY,
    expectedBuildId,
    shellExecutable,
    timeoutMs,
  },
  { prepare = prepareDevHmuxTool } = {},
) {
  try {
    return resolveDevHmuxTool({
      home,
      channel,
      requiredCapability,
      expectedBuildId,
    });
  } catch (error) {
    if (!(error instanceof DevHmuxUnavailableError)) throw error;
  }
  const selectedShell =
    shellExecutable ?? resolvePosixShellExecutable();
  if (!selectedShell) {
    throw new Error(
      "development Hmux preparation failed: a POSIX shell is unavailable",
    );
  }
  prepare({
    root,
    home,
    channel,
    expectedBuildId,
    shellExecutable: selectedShell,
    timeoutMs,
  });
  return resolveDevHmuxTool({
    home,
    channel,
    requiredCapability,
    expectedBuildId,
  });
}
