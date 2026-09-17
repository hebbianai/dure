import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platformTauriConfigFile } from "./app-channel.mjs";
import { readPinnedDevNodeRuntime } from "./dev-node-tool.mjs";
import { HMUX_DEV_RUNTIME_INPUTS } from "./hmux-dev-build-inputs.mjs";
import { WINDOWS_JOB_SOURCE_PATHS } from "./windows-process-job.mjs";

export function hmuxDevRuntimeStageRequired(changedPaths) {
  return changedPaths.some(
    (relativePath) =>
      HMUX_DEV_RUNTIME_INPUTS.some(
        (input) =>
          relativePath === input.path ||
          (input.recursive && relativePath.startsWith(`${input.path}/`)),
      ),
  );
}

export const DEV_DEPLOY_IMPACT = Object.freeze({
  FRONTEND_RELOAD: "frontend_reload",
  BACKEND_REBUILD: "backend_rebuild",
  CHILD_RESTART: "child_restart",
  PARENT_RELOAD: "parent_reload",
});

export const DEV_PARENT_RELOAD_STRATEGY = Object.freeze({
  EXEC_HANDOFF: "exec_handoff",
  COLD_BOOTSTRAP: "cold_bootstrap",
});

export function devDeployRequiresChildRestart(impact) {
  return (
    impact.backendChanged === true ||
    impact.childRestartRequired === true ||
    impact.kind === DEV_DEPLOY_IMPACT.BACKEND_REBUILD ||
    impact.kind === DEV_DEPLOY_IMPACT.CHILD_RESTART
  );
}

export const DEV_PARENT_SOURCE_PATHS = Object.freeze([
  ...WINDOWS_JOB_SOURCE_PATHS,
  "cli/lib/fd-verified-read.mjs",
  "scripts/run-dev-app.mjs",
  "scripts/run-dev-launch-child.mjs",
  "scripts/run-dev-frontend.mjs",
  "scripts/run-process-group-witness.mjs",
  "scripts/node-dependency-preflight.mjs",
  "scripts/lib/app-channel.mjs",
  "scripts/lib/app-executable.mjs",
  "scripts/lib/atomic-directory-move.mjs",
  "scripts/lib/background-cpu-priority.mjs",
  "scripts/lib/backend-runtime-fingerprint.mjs",
  "scripts/lib/build-storage-admission.mjs",
  "scripts/lib/build-storage-reservation.mjs",
  "scripts/lib/corepack-install.mjs",
  "scripts/lib/daily-driver.mjs",
  "scripts/lib/dev-launch-admission.mjs",
  "scripts/lib/dev-frontend-authority.mjs",
  "scripts/lib/dev-launch-impact.mjs",
  "scripts/lib/dev-launch-prerequisites.mjs",
  "scripts/lib/dev-launch-client.mjs",
  "scripts/lib/dev-launch-contract.mjs",
  "scripts/lib/dev-launch-storage.mjs",
  "scripts/lib/dev-launch-supervisor.mjs",
  "scripts/lib/dev-server-profile.mjs",
  "scripts/lib/dev-tauri-cli.mjs",
  "scripts/lib/disk-gc-scope.mjs",
  "scripts/lib/disk-reclaim.mjs",
  "scripts/lib/disk-space.mjs",
  "scripts/lib/durable-file.mjs",
  "scripts/lib/dure-home.mjs",
  "scripts/lib/git-environment.mjs",
  "scripts/lib/hmux-dev-build-inputs.mjs",
  "scripts/lib/dev-node-tool.mjs",
  "scripts/lib/process-group-authority.mjs",
  "scripts/lib/dev-launch-retirement.mjs",
  "scripts/lib/process-group-witness.mjs",
  "scripts/lib/process-identity.mjs",
  "scripts/lib/unix-process-tools.mjs",
  "scripts/lib/worktree-inventory.mjs",
  "scripts/lib/windows-process-identity.mjs",
  "scripts/lib/windows-process-job.mjs",
  "scripts/lib/windows-private-storage.mjs",
  "scripts/native/atomic-directory-move.py",
  "scripts/native/linux-process-boundary.py",
  "scripts/native/owned-process-observer.c",
  "scripts/native/windows-process-boundary.js",
  "scripts/native/windows-private-storage.ps1",
  "src/contracts/frontendRuntimeObservation.mjs",
]);

export const DEV_NODE_DEPENDENCY_AUTHORITY_PATHS = Object.freeze([
  ".node-version",
  ".npmrc",
  ".nvmrc",
  ".pnpmfile.cjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/node-dependency-preflight.mjs",
  "scripts/lib/corepack-install.mjs",
]);
const DEV_NODE_DEPENDENCY_AUTHORITY_PATH_SET = new Set(
  DEV_NODE_DEPENDENCY_AUTHORITY_PATHS,
);

export const DEV_CHILD_PREPARATION_PATHS = Object.freeze([
  ...DEV_NODE_DEPENDENCY_AUTHORITY_PATHS,
  "scripts/guard-dev-channel.mjs",
  "scripts/stage-mobile-runtime.mjs",
  "scripts/prepare-agent-tools.sh",
  "scripts/dev-agent-tools-current.mjs",
  "scripts/lib/dure-cli-install-paths.mjs",
  "scripts/guard-hmux-app-stage.mjs",
  "scripts/lib/dev-app-runtime.mjs",
  "scripts/lib/dev-chain-recovery.mjs",
  "scripts/lib/dev-cold-bootstrap-operation.mjs",
  "scripts/lib/dev-deploy-lock.mjs",
  "scripts/lib/dev-hmux-operation-contract.mjs",
  "scripts/lib/dev-hmux-tool.mjs",
  "scripts/lib/hmux-app-stage-admission.mjs",
  "scripts/lib/macos-executable-signing.mjs",
  "scripts/lib/macos-signing-readiness.mjs",
  "scripts/lib/native-build-slot.mjs",
  "scripts/native/native-build-slot.py",
  "scripts/resolve-dev-app-channel.mjs",
  "scripts/verify-static-linux-binary.sh",
]);
const DEV_CHILD_PREPARATION_PATH_SET = new Set(DEV_CHILD_PREPARATION_PATHS);
const DEV_PARENT_COLD_BOOTSTRAP_PATHS = new Set([
  ".node-version",
  ".nvmrc",
]);
const TAURI_CONFIG_PATH = /^src-tauri\/tauri(?:\.[^.]+)?\.conf\.json$/;
const ORCHESTRATION_BACKEND_FILES = new Set(["orchestration/Cargo.toml"]);
const BACKEND_RUNTIME_AUTHORITY_FILES = new Set([
  ".cargo/config.toml",
  "rust-toolchain.toml",
  "scripts/backend-runtime-inputs.txt",
]);
const ORCHESTRATION_BACKEND_PREFIXES = ["orchestration/src/"];
const CONTROL_PLANE_PAYLOAD_FILES = new Set(["scripts/install-dure-cli.mjs"]);
const CONTROL_PLANE_PAYLOAD_PREFIXES = [
  "cli/",
  "orchestration/integration/",
  "crates/dure-app/control-plane/provider-drivers/claude/",
];

export function devParentLoadedPaths(platform = process.platform) {
  const platformConfig = platformTauriConfigFile(platform);
  return [
    ...DEV_PARENT_SOURCE_PATHS,
    "src-tauri/tauri.conf.json",
    ...(platformConfig ? [`src-tauri/${platformConfig}`] : []),
  ];
}

export function devParentSourceGeneration(
  configRoot,
  platform = process.platform,
  { sourceRoot = configRoot } = {},
) {
  const hash = createHash("sha256");
  const platformConfig = platformTauriConfigFile(platform);
  const inputs = [
    ...DEV_PARENT_SOURCE_PATHS.map((relativePath) => ({
      relativePath,
      root: sourceRoot,
    })),
    { relativePath: "src-tauri/tauri.conf.json", root: configRoot },
    ...[...DEV_PARENT_COLD_BOOTSTRAP_PATHS].map((relativePath) => ({
      relativePath,
      root: configRoot,
    })),
    ...(platformConfig
      ? [{ relativePath: `src-tauri/${platformConfig}`, root: configRoot }]
      : []),
  ];
  // The generation is also computed over the LIVE checkout, which may
  // predate a file this list gained later (dev-node-tool.mjs, 2026-09-03).
  // An absent file is a real, distinct generation, not a crash: hashing
  // "<absent>" makes an old checkout differ from a new one exactly as a
  // changed file would, so the parent reloads instead of the deploy dying
  // at the queue before it can advance that checkout.
  for (const { relativePath, root } of inputs.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    const pathname = join(root, relativePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(existsSync(pathname) ? readFileSync(pathname) : "<absent>");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function assertDevParentNodeRuntime(
  root,
  runtimeVersion = process.version,
) {
  const normalizedRuntime = runtimeVersion.replace(/^v/, "");
  const pin = readPinnedDevNodeRuntime(root);
  if (pin && pin.version !== normalizedRuntime) {
    throw new Error(
      `cold_bootstrap_required: Node ${runtimeVersion} does not match ${pin.sources[0]} (${pin.version})`,
    );
  }
  return normalizedRuntime;
}

export function backendRebuildRequired(changedPaths) {
  return changedPaths.some(
    (path) =>
      (path.startsWith("src-tauri/") && !TAURI_CONFIG_PATH.test(path)) ||
      path.startsWith("hmux/") ||
      path.startsWith("crates/") ||
      BACKEND_RUNTIME_AUTHORITY_FILES.has(path) ||
      ORCHESTRATION_BACKEND_FILES.has(path) ||
      ORCHESTRATION_BACKEND_PREFIXES.some((prefix) => path.startsWith(prefix)),
  ) || hmuxDevRuntimeStageRequired(changedPaths);
}

export function controlPlanePayloadStageRequired(changedPaths) {
  return changedPaths.some(
    (path) =>
      CONTROL_PLANE_PAYLOAD_FILES.has(path) ||
      CONTROL_PLANE_PAYLOAD_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
}

export function devDeployRequiresControlPlaneActivation(impact) {
  return (
    impact?.backendChanged === true ||
    impact?.controlPlanePayloadChanged === true
  );
}

export function nodeDependencyInstallRequired(changedPaths) {
  return changedPaths.some(
    (path) =>
      DEV_NODE_DEPENDENCY_AUTHORITY_PATH_SET.has(path) ||
      path.startsWith("patches/"),
  );
}

function childRestartRequired(changedPaths) {
  return changedPaths.some(
    (path) => DEV_CHILD_PREPARATION_PATH_SET.has(path),
  ) || nodeDependencyInstallRequired(changedPaths);
}

export function changedPathsRequireChildRestart(changedPaths) {
  return childRestartRequired(changedPaths) ||
    backendRebuildRequired(changedPaths);
}

export function devDeployImpact(changedPaths, platform = process.platform) {
  const parentPaths = new Set(devParentLoadedPaths(platform));
  const parentRuntimeChanged = changedPaths.some((path) =>
    DEV_PARENT_COLD_BOOTSTRAP_PATHS.has(path),
  );
  const parentReload = changedPaths.some((path) => parentPaths.has(path)) ||
    parentRuntimeChanged;
  const childRestart = childRestartRequired(changedPaths);
  const hmuxRuntimeChanged = hmuxDevRuntimeStageRequired(changedPaths);
  const backendChanged = backendRebuildRequired(changedPaths);
  const controlPlanePayloadChanged =
    controlPlanePayloadStageRequired(changedPaths);
  const kind = parentReload
    ? DEV_DEPLOY_IMPACT.PARENT_RELOAD
    : childRestart
      ? DEV_DEPLOY_IMPACT.CHILD_RESTART
      : backendChanged
        ? DEV_DEPLOY_IMPACT.BACKEND_REBUILD
        : DEV_DEPLOY_IMPACT.FRONTEND_RELOAD;
  return {
    kind,
    backendChanged,
    changedPathCount: changedPaths.length,
    ...(controlPlanePayloadChanged
      ? { controlPlanePayloadChanged: true }
      : {}),
    ...(hmuxRuntimeChanged ? { hmuxRuntimeChanged: true } : {}),
    ...(kind === DEV_DEPLOY_IMPACT.PARENT_RELOAD
      ? {
          parentStrategy: parentRuntimeChanged
            ? DEV_PARENT_RELOAD_STRATEGY.COLD_BOOTSTRAP
            : DEV_PARENT_RELOAD_STRATEGY.EXEC_HANDOFF,
          ...(childRestart || backendChanged
            ? { childRestartRequired: true }
            : {}),
        }
      : {}),
  };
}
