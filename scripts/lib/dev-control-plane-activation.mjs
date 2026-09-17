import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveBundledClaudeStructuredRuntimePayload,
} from "../../cli/lib/claude-structured-runtime.mjs";
import { parseMetadata } from "../../cli/lib/dure-cli-channel-launcher.mjs";
import {
  parseLocalExecutableIdentity,
} from "../../cli/lib/local-backend-executable-identity.mjs";
import { devHmuxToolPaths, worktreeDevIdentity } from "./app-channel.mjs";
import { withoutLocalGitOverrides } from "./git-environment.mjs";

const FULL_COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOCAL_BACKEND_GENERATION = /^local-v1-[a-f0-9]{32}$/;
const CONTROL_PLANE_COMMAND =
  process.platform === "win32"
    ? "dure-control-plane.exe"
    : "dure-control-plane";
const HMUX_RUNTIME_COMMAND =
  process.platform === "win32" ? "hmux-runtime.exe" : "hmux-runtime";
const DEFAULT_ACTIVATION_POLL_MS = 250;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function pending(reason) {
  return { status: "pending", reason };
}

function skew(reason) {
  return { status: "skew", reason };
}

export function parseDevControlPlaneActivationProof(
  value,
  targetHead,
  label = "control-plane activation proof",
) {
  if (
    !FULL_COMMIT_SHA.test(targetHead ?? "") ||
    !exactKeys(value, [
      "schemaVersion",
      "sourceRevision",
      "cliArtifactDigest",
      "controlPlaneExecutableSha256",
      "claudePayloadDigest",
      "backendId",
      "backendGeneration",
    ]) ||
    value.schemaVersion !== 1 ||
    value.sourceRevision !== targetHead ||
    !SHA256.test(value.cliArtifactDigest) ||
    !SHA256.test(value.controlPlaneExecutableSha256) ||
    !SHA256.test(value.claudePayloadDigest) ||
    value.backendId !== "dure-local" ||
    !LOCAL_BACKEND_GENERATION.test(value.backendGeneration)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return {
    schemaVersion: 1,
    sourceRevision: value.sourceRevision,
    cliArtifactDigest: value.cliArtifactDigest,
    controlPlaneExecutableSha256: value.controlPlaneExecutableSha256,
    claudePayloadDigest: value.claudePayloadDigest,
    backendId: value.backendId,
    backendGeneration: value.backendGeneration,
  };
}

export function devControlPlaneArtifactReadiness(metadata, targetHead) {
  if (!FULL_COMMIT_SHA.test(targetHead ?? "")) {
    throw new Error(
      "control-plane activation target must be an exact Git commit",
    );
  }
  const app = metadata?.bundle?.app;
  if (app?.schemaVersion !== 2 || app.sourceRevision !== targetHead) {
    return pending(
      "the exact control-plane payload for the deployment target is not staged yet",
    );
  }
  return { status: "ready", sourceRevision: app.sourceRevision };
}

export function hasPendingDevControlPlaneActivation(deployment) {
  return Boolean(
    deployment?.backendHead &&
      deployment.appliedAtMs !== undefined &&
      !deployment.controlPlaneActivation,
  );
}

function channelPaths(root, homeDirectory) {
  const { channel } = worktreeDevIdentity(root);
  const cliRoot = join(
    homeDirectory,
    ".local",
    "share",
    "hebbian-ide-cli",
    "channels",
    channel,
  );
  const hmux = devHmuxToolPaths(homeDirectory, channel);
  return { channel, cliRoot, hmux };
}

function resolveDevControlPlaneBundle({ root, targetHead, homeDirectory }) {
  const { channel, cliRoot } = channelPaths(root, homeDirectory);
  let versionRoot;
  try {
    const versionsRoot = realpathSync(join(cliRoot, "versions"));
    versionRoot = realpathSync(join(cliRoot, "current"));
    if (dirname(versionRoot) !== versionsRoot) {
      return skew("the control-plane channel pointer escaped immutable versions");
    }
  } catch (error) {
    return error?.code === "ENOENT"
      ? pending("the control-plane payload has not been staged")
      : skew("the control-plane channel pointer is unreadable");
  }

  let metadata;
  try {
    metadata = parseMetadata(versionRoot);
  } catch {
    return skew(
      "the staged control-plane payload is not a valid immutable bundle",
    );
  }
  const readiness = devControlPlaneArtifactReadiness(metadata, targetHead);
  return readiness.status === "ready"
    ? { ...readiness, channel, cliRoot, metadata, versionRoot }
    : readiness;
}

export function inspectDevControlPlanePayload({
  root,
  targetHead,
  environment = process.env,
  homeDirectory = environment.HOME || homedir(),
}) {
  const bundle = resolveDevControlPlaneBundle({
    root,
    targetHead,
    homeDirectory,
  });
  return bundle.status === "ready"
    ? { status: "ready", sourceRevision: bundle.sourceRevision }
    : bundle;
}

export function installDevControlPlanePayload({
  root,
  targetHead,
  environment = process.env,
  homeDirectory = environment.HOME || homedir(),
  execute = execFileSync,
}) {
  devControlPlaneArtifactReadiness(undefined, targetHead);
  const { channel, cliRoot, hmux } = channelPaths(
    root,
    homeDirectory,
  );
  const installEnvironment = withoutLocalGitOverrides({
    ...environment,
    HOME: homeDirectory,
    DURE_APP_CHANNEL: channel,
    DURE_CLI_INSTALL_ROOT: cliRoot,
    DURE_CLI_INSTALL_DIR: join(cliRoot, "bin"),
    DURE_CLI_SOURCE_REVISION: targetHead,
    DURE_CLI_LOCK_WAIT_MS: "60000",
    DURE_HMUX_BIN: hmux.hmuxCommand,
    DURE_HMUX_RUNTIME_BIN: join(
      hmux.commandDirectory,
      HMUX_RUNTIME_COMMAND,
    ),
  });
  delete installEnvironment.DURE_CLI_BUILD_ID;
  delete installEnvironment.HEBBIAN_IDE_CLI_BUILD_ID;
  delete installEnvironment.DURE_CONTROL_PLANE_BIN;
  delete installEnvironment.DURE_CLAUDE_PROCESS_RELAY_BIN;
  delete installEnvironment.HMUX_BUILD_ID;
  delete installEnvironment.DURE_HMUX_BUILD_ID;
  const stdout = execute(
    process.execPath,
    [join(root, "scripts", "install-dure-cli.mjs"), "--development"],
    {
      cwd: root,
      encoding: "utf8",
      env: installEnvironment,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (stdout) process.stderr.write(stdout);
}

export async function activateDevControlPlaneTarget(
  {
    root,
    targetHead,
    timeoutMs,
    environment = process.env,
    homeDirectory = environment.HOME || homedir(),
  },
  {
    inspect = inspectDevControlPlanePayload,
    install = installDevControlPlanePayload,
    reconcile = reconcileDevControlPlaneActivation,
    now = Date.now,
    wait = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("control-plane activation timeout must be positive");
  }
  const request = { root, targetHead, environment, homeDirectory };
  const startedAtMs = now();
  let readiness = inspect(request);
  let staged = false;
  if (readiness.status !== "ready") {
    install(request);
    staged = true;
    readiness = inspect(request);
  }
  if (readiness.status !== "ready") return { ...readiness, staged };

  for (;;) {
    const activation = reconcile(request);
    if (activation.status !== "pending") return { ...activation, staged };
    const remainingMs = timeoutMs - (now() - startedAtMs);
    if (remainingMs <= 0) return { ...activation, staged };
    await wait(Math.min(DEFAULT_ACTIVATION_POLL_MS, remainingMs));
  }
}

function digest(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function jsonReceipt(source) {
  for (const line of String(source ?? "").trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Continue past human-readable diagnostics to the structured receipt.
    }
  }
  return undefined;
}

function reconcileReceipt(result) {
  const receipt = jsonReceipt(
    result.status === 0 ? result.stdout : result.stderr,
  );
  if (
    result.status === 0 &&
    receipt?.schemaVersion === 1 &&
    receipt.apiVersion === "dure.backend-reconcile/v1" &&
    receipt.kind === "dure.backend.reconcile" &&
    receipt.status === "ready" &&
    receipt.authority?.backendId === "dure-local" &&
    LOCAL_BACKEND_GENERATION.test(receipt.authority.generation ?? "")
  ) {
    return { status: "ready", receipt };
  }
  if (receipt?.error?.code === "recovering") {
    return pending("the control-plane replacement is still converging");
  }
  return skew(
    receipt?.error?.code
      ? `control-plane reconcile failed: ${receipt.error.code}`
      : "control-plane reconcile did not return a verified local authority",
  );
}

export function devControlPlaneActivationMatches({
  descriptor,
  receipt,
  expectedExecutableSha256,
}) {
  const activeIdentity = parseLocalExecutableIdentity(
    descriptor?.controlPlaneIdentity,
  );
  return Boolean(
    descriptor?.backendId === receipt?.authority?.backendId &&
      descriptor?.generation === receipt?.authority?.generation &&
      activeIdentity?.executableSha256 === expectedExecutableSha256,
  );
}

export function reconcileDevControlPlaneActivation({
  root,
  targetHead,
  environment = process.env,
  homeDirectory = environment.HOME || homedir(),
}) {
  const bundle = resolveDevControlPlaneBundle({
    root,
    targetHead,
    homeDirectory,
  });
  if (bundle.status !== "ready") return bundle;
  const { channel, metadata, versionRoot } = bundle;

  const cliScriptPath = join(versionRoot, "bin", "dure.mjs");
  const controlPlanePath = join(versionRoot, "bin", CONTROL_PLANE_COMMAND);
  let controlPlaneDigest;
  let claudePayload;
  try {
    controlPlaneDigest = digest(controlPlanePath);
    if (controlPlaneDigest !== metadata.bundle.controlPlane?.digest) {
      return skew(
        "the immutable control-plane digest does not match its metadata",
      );
    }
    claudePayload = resolveBundledClaudeStructuredRuntimePayload({
      cliScriptPath,
    });
  } catch {
    return skew("the bundled Claude runtime payload is invalid");
  }
  if (!claudePayload) {
    return skew("the immutable CLI has no bundled Claude runtime payload");
  }

  const result = spawnSync(
    process.execPath,
    [cliScriptPath, "backend", "activate", "--json"],
    {
      encoding: "utf8",
      env: {
        ...environment,
        HOME: homeDirectory,
        DURE_APP_CHANNEL: channel,
        DURE_CONTROL_PLANE_BIN: controlPlanePath,
        DURE_HMUX_BIN: metadata.bundle.hmux.executablePath,
        DURE_HMUX_RUNTIME_BIN: metadata.bundle.hmux.runtimeExecutablePath,
      },
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    },
  );
  const reconciled = reconcileReceipt(result);
  if (reconciled.status !== "ready") return reconciled;

  const appRoot = environment.DURE_HOME || join(homeDirectory, ".dure");
  let descriptor;
  try {
    descriptor = JSON.parse(
      readFileSync(join(appRoot, "backend", "control-plane.json"), "utf8"),
    );
  } catch (error) {
    return error?.code === "ENOENT"
      ? pending("the reconciled control-plane descriptor is not visible yet")
      : skew("the reconciled control-plane descriptor is unreadable");
  }
  if (!devControlPlaneActivationMatches({
    descriptor,
    receipt: reconciled.receipt,
    expectedExecutableSha256: controlPlaneDigest,
  })) {
    return pending("the active control-plane payload has not converged yet");
  }

  const proof = parseDevControlPlaneActivationProof(
    {
      schemaVersion: 1,
      sourceRevision: bundle.sourceRevision,
      cliArtifactDigest: metadata.bundle.artifactDigest,
      controlPlaneExecutableSha256: controlPlaneDigest,
      claudePayloadDigest: claudePayload.payloadDigest,
      backendId: descriptor.backendId,
      backendGeneration: descriptor.generation,
    },
    targetHead,
  );
  return { status: "ok", reason: "exact control-plane payload is active", proof };
}
