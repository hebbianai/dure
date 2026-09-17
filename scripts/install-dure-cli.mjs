#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corepackInstallInvocation } from "./lib/corepack-install.mjs";
import { ensureHeadroom } from "./lib/build-storage-admission.mjs";
import { buildStorageBudget } from "./lib/disk-space.mjs";
import { resolveBuiltDureControlPlane } from "./lib/dure-cli-install-paths.mjs";
import { signMacosExecutables } from "./lib/macos-executable-signing.mjs";
import { nativeBuildCommand } from "./lib/native-build-slot.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliSourceRoot = join(repositoryRoot, "cli");
const canonicalCommand = "dure";
const canonicalScript = `${canonicalCommand}.mjs`;
const compatibilityCommands = ["hebbian-ade", "hebbian-ide"];
const controlPlaneCommand =
  process.platform === "win32" ? "dure-control-plane.exe" : "dure-control-plane";
const claudeRelayCommand =
  process.platform === "win32"
    ? "dure-claude-process-relay.exe"
    : "dure-claude-process-relay";
const claudeDriverSourceRoot = join(
  repositoryRoot,
  "crates",
  "dure-app",
  "control-plane",
  "provider-drivers",
  "claude",
);
const claudeDriverPreparationInputNames = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "sdk-runtime.mjs",
];
const maxSnapshotGenerations = 4;
const development = process.argv.length === 3 && process.argv[2] === "--development";
const bundleDirectory = process.argv[2] === "--bundle" ? process.argv[3] : undefined;
if (!development && process.argv.length > 2 && (!bundleDirectory || process.argv.length !== 4)) {
  throw new Error("usage: install-dure-cli.mjs [--development | --bundle <directory>]");
}
if (development && (
  !/^dev-[a-z0-9-]{1,60}$/.test(process.env.DURE_APP_CHANNEL || "") ||
  process.env.DURE_CONTROL_PLANE_BIN
)) {
  throw new Error("Development installation requires a development channel and a source-built backend");
}
if (bundleDirectory && existsSync(bundleDirectory)) {
  throw new Error("Dure CLI bundle destination must not already exist");
}
const installRoot =
  bundleDirectory ||
  process.env.DURE_CLI_INSTALL_ROOT ||
  process.env.HEBBIAN_IDE_CLI_INSTALL_ROOT ||
  // Preserve immutable versions already installed by Hebbian ADE.
  join(homedir(), ".local", "share", "hebbian-ide-cli");
const commandDirectory =
  (bundleDirectory ? join(bundleDirectory, "bin") : undefined) ||
  process.env.DURE_CLI_INSTALL_DIR ||
  process.env.HEBBIAN_IDE_CLI_INSTALL_DIR ||
  join(homedir(), ".local", "bin");
const lockWaitMs = Number(
  process.env.DURE_CLI_LOCK_WAIT_MS ||
    process.env.HEBBIAN_IDE_CLI_LOCK_WAIT_MS ||
    "0",
);

function bundleExecutable(pathname, label) {
  const path = realpathSync(pathname);
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} must be an executable regular file`);
  }
  return {
    path,
    digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function hmuxBundleIdentity(binaryDirectory) {
  const channel = process.env.DURE_APP_CHANNEL || "stable";
  if (!/^[a-z0-9-]{1,64}$/.test(channel)) {
    throw new Error("DURE_APP_CHANNEL must be a lowercase filesystem-safe token");
  }
  const root =
    channel === "stable"
      ? join(homedir(), ".local", "share", "hmux")
      : join(homedir(), ".local", "share", "hmux", "channels", channel);
  const executable = bundleExecutable(
    process.env.DURE_HMUX_BIN || join(root, "current", "bin", "hmux"),
    "Hmux CLI",
  );
  const runtime = bundleExecutable(
    process.env.DURE_HMUX_RUNTIME_BIN ||
      join(
        root,
        "current",
        "bin",
        process.platform === "win32" ? "hmux-runtime.exe" : "hmux-runtime",
      ),
    "Hmux runtime",
  );
  const buildId =
    process.env.DURE_HMUX_BUILD_ID ||
    process.env.HMUX_BUILD_ID ||
    basename(dirname(dirname(executable.path)));
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(buildId)) {
    throw new Error("Hmux build identity is invalid");
  }
  if (bundleDirectory) {
    copyFileSync(executable.path, join(binaryDirectory, "hmux"));
    copyFileSync(runtime.path, join(binaryDirectory, "hmux-runtime"));
    chmodSync(join(binaryDirectory, "hmux"), 0o755);
    chmodSync(join(binaryDirectory, "hmux-runtime"), 0o755);
  }
  return {
    schemaVersion: bundleDirectory ? 2 : 1,
    channel,
    buildId,
    executablePath: bundleDirectory ? "bin/hmux" : executable.path,
    executableDigest: executable.digest,
    runtimeExecutablePath: bundleDirectory ? "bin/hmux-runtime" : runtime.path,
    runtimeExecutableDigest: runtime.digest,
  };
}

if (
  !Number.isInteger(lockWaitMs) ||
  lockWaitMs < 0 ||
  lockWaitMs > 60_000
) {
  throw new Error(
    "DURE_CLI_LOCK_WAIT_MS must be an integer from 0 through 60000",
  );
}

let controlPlaneSource = process.env.DURE_CONTROL_PLANE_BIN;
if (controlPlaneSource) {
  controlPlaneSource = resolve(controlPlaneSource);
} else {
  const headroom = ensureHeadroom({
    cwd: repositoryRoot,
    label: "Dure CLI control-plane build",
    requestedBytes: buildStorageBudget("cli"),
  });
  if (!headroom.ok) throw new Error(headroom.message);
  try {
    const build = nativeBuildCommand(
      "cargo",
      [
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        join(repositoryRoot, "crates", "dure-app", "Cargo.toml"),
        "--package",
        "dure-control-plane",
        ...(development ? ["--features", "browser-development"] : []),
      ],
    );
    execFileSync(build.command, build.args, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  } finally {
    headroom.reservation?.release();
  }
  controlPlaneSource = resolveBuiltDureControlPlane({
    cargoTargetDirectory: process.env.CARGO_TARGET_DIR,
    command: controlPlaneCommand,
    repositoryRoot,
  });
}
if (
  !existsSync(controlPlaneSource) ||
  !lstatSync(controlPlaneSource).isFile()
) {
  throw new Error("Dure control-plane executable is unavailable");
}
let claudeRelaySource = process.env.DURE_CLAUDE_PROCESS_RELAY_BIN;
if (claudeRelaySource) {
  claudeRelaySource = resolve(claudeRelaySource);
} else if (process.env.DURE_CONTROL_PLANE_BIN) {
  claudeRelaySource = join(dirname(controlPlaneSource), claudeRelayCommand);
} else {
  claudeRelaySource = resolveBuiltDureControlPlane({
    cargoTargetDirectory: process.env.CARGO_TARGET_DIR,
    command: claudeRelayCommand,
    repositoryRoot,
  });
}
bundleExecutable(claudeRelaySource, "Dure Claude process relay");

const requestedBuildId =
  process.env.DURE_CLI_BUILD_ID || process.env.HEBBIAN_IDE_CLI_BUILD_ID;
if (
  requestedBuildId &&
  !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(requestedBuildId)
) {
  throw new Error("DURE_CLI_BUILD_ID must be one safe path component");
}
const requestedSourceRevision = process.env.DURE_CLI_SOURCE_REVISION;
if (bundleDirectory && (
  !requestedSourceRevision || process.platform !== "darwin" ||
  (process.env.DURE_APP_CHANNEL || "stable") !== "stable"
)) {
  throw new Error("Dure CLI packaging requires a source-bound macOS build");
}
if (
  requestedSourceRevision !== undefined &&
  !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(requestedSourceRevision)
) {
  throw new Error(
    "DURE_CLI_SOURCE_REVISION must be an exact Git commit identity",
  );
}

class DureCliInstallSourceUnstableError extends Error {
  constructor(options = {}) {
    super(
      `[dure_cli_source_unstable] Dure CLI install source did not stabilize after ${maxSnapshotGenerations} snapshots`,
      options,
    );
    this.name = "DureCliInstallSourceUnstableError";
    this.code = "dure_cli_source_unstable";
  }
}

async function prepareClaudeDriverDependencies(stagingRoot) {
  const root = join(stagingRoot, "claude-driver-dependencies");
  mkdirSync(root);
  const inputs = claudeDriverPreparationInputNames.map((name) => {
    const contents = readFileSync(join(claudeDriverSourceRoot, name));
    writeFileSync(join(root, name), contents);
    return { name, contents };
  });
  const claudeDriverManifest = JSON.parse(inputs[0].contents.toString("utf8"));
  const corepack = corepackInstallInvocation({
    packageManager: claudeDriverManifest.packageManager,
  });
  execFileSync(corepack.file, corepack.arguments, {
    cwd: root,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
    stdio: "inherit",
  });
  const claudeSdk = await import(
    pathToFileURL(join(root, "sdk-runtime.mjs")).href
  );
  await claudeSdk.loadPinnedClaudeSdk();
  return {
    inputs,
    nodeModules: join(root, "node_modules"),
  };
}

function useBundledNode(script, runtimePath) {
  const source = readFileSync(script, "utf8");
  // The shell resolves symlinked global/channel commands before selecting the
  // immutable Node runtime. The second line is a comment when parsed by Node.
  const prelude = `#!/bin/sh\n':' //; p="$0"; while [ -L "$p" ]; do d=$(/usr/bin/dirname "$p"); p=$(/usr/bin/readlink "$p") || exit; case "$p" in /*) ;; *) p="$d/$p";; esac; done; exec "$(/usr/bin/dirname "$p")/${runtimePath}" "$p" "$@"\n`;
  writeFileSync(script, prelude + source.slice(source.indexOf("\n") + 1));
}

function stageSnapshotPayload(snapshotDirectory, preparedClaudeDriver) {
  const binaryDirectory = join(snapshotDirectory, "bin");
  mkdirSync(binaryDirectory, { recursive: true });
  copyFileSync(
    join(cliSourceRoot, "dure.mjs"),
    join(binaryDirectory, canonicalScript),
  );
  chmodSync(join(binaryDirectory, canonicalScript), 0o755);
  symlinkSync(canonicalScript, join(binaryDirectory, canonicalCommand));
  copyFileSync(controlPlaneSource, join(binaryDirectory, controlPlaneCommand));
  chmodSync(join(binaryDirectory, controlPlaneCommand), 0o755);
  copyFileSync(claudeRelaySource, join(binaryDirectory, claudeRelayCommand));
  chmodSync(join(binaryDirectory, claudeRelayCommand), 0o755);
  const stagedClaudeDriver = join(
    binaryDirectory,
    "provider-drivers",
    "claude",
  );
  cpSync(claudeDriverSourceRoot, stagedClaudeDriver, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const relativePath = source
        .slice(claudeDriverSourceRoot.length)
        .replaceAll("\\", "/");
      return (
        !relativePath.endsWith(".test.mjs") &&
        relativePath !== "/node_modules" &&
        !relativePath.startsWith("/node_modules/")
      );
    },
  });
  for (const { name, contents } of preparedClaudeDriver.inputs) {
    const stagedInput = readFileSync(join(stagedClaudeDriver, name));
    const currentInput = readFileSync(join(claudeDriverSourceRoot, name));
    if (!stagedInput.equals(contents) || !currentInput.equals(contents)) {
      throw new Error(
        `Claude SDK driver preparation input changed during install: ${name}`,
      );
    }
  }
  cpSync(
    preparedClaudeDriver.nodeModules,
    join(stagedClaudeDriver, "node_modules"),
    {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => {
        const relativePath = source
          .slice(preparedClaudeDriver.nodeModules.length)
          .replaceAll("\\", "/");
        return (
          relativePath !== "/.modules.yaml" &&
          relativePath !== "/.pnpm-workspace-state-v1.json"
        );
      },
    },
  );
  cpSync(join(cliSourceRoot, "lib"), join(binaryDirectory, "lib"), {
    recursive: true,
  });
  for (const command of compatibilityCommands) {
    symlinkSync(canonicalCommand, join(binaryDirectory, command));
  }
  cpSync(join(cliSourceRoot, "skills"), join(binaryDirectory, "skills"), {
    recursive: true,
  });
  cpSync(
    join(repositoryRoot, "orchestration", "integration"),
    join(binaryDirectory, "orchestration-integration"),
    { recursive: true },
  );
  if (bundleDirectory) {
    copyFileSync(process.execPath, join(binaryDirectory, "node"));
    chmodSync(join(binaryDirectory, "node"), 0o755);
    useBundledNode(join(binaryDirectory, canonicalScript), "node");
    useBundledNode(
      join(binaryDirectory, "lib", "dure-cli-channel-launcher.mjs"),
      "../current/bin/node",
    );
  }
  return binaryDirectory;
}

async function observeSnapshot(stagingRoot, generation, preparedClaudeDriver) {
  const generationDirectory = join(stagingRoot, `generation-${generation}`);
  const snapshotDirectory = join(generationDirectory, "version");
  mkdirSync(generationDirectory);
  const packageManifestPath = join(generationDirectory, "package.json");
  copyFileSync(join(cliSourceRoot, "package.json"), packageManifestPath);
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  if (typeof packageManifest.version !== "string") {
    throw new Error("Dure CLI package version is invalid");
  }
  const binaryDirectory = stageSnapshotPayload(
    snapshotDirectory,
    preparedClaudeDriver,
  );
  const { orchestrationWorkerCatalogue } = await import(
    pathToFileURL(join(binaryDirectory, "lib", "orchestration-mcp-server.mjs")).href
  );
  writeFileSync(
    join(binaryDirectory, "orchestration-mcp-catalogue.json"),
    `${JSON.stringify(await orchestrationWorkerCatalogue())}\n`,
    { mode: 0o644 },
  );
  const hmuxIdentity = hmuxBundleIdentity(binaryDirectory);
  return describeSnapshot(generationDirectory, snapshotDirectory, packageManifest.version, hmuxIdentity);
}

async function describeSnapshot(generationDirectory, snapshotDirectory, packageVersion, sourceHmuxIdentity) {
  const binaryDirectory = join(snapshotDirectory, "bin");
  const controlPlaneContract = await import(
    pathToFileURL(join(binaryDirectory, "lib", "control-plane-contract.mjs")).href
  );
  const orchestrationIntegration = await import(
    pathToFileURL(
      join(binaryDirectory, "lib", "orchestration-integration.mjs"),
    ).href
  );
  const channelLauncher = await import(
    pathToFileURL(
      join(binaryDirectory, "lib", "dure-cli-channel-launcher.mjs"),
    ).href
  );
  const controlPlaneIdentity =
    controlPlaneContract.currentControlPlaneBundleIdentity(
      join(binaryDirectory, controlPlaneCommand),
      { environment: process.env },
    );
  const orchestrationIdentity =
    orchestrationIntegration.orchestrationPayloadIdentity(
      join(binaryDirectory, canonicalScript),
    );
  const hmuxIdentity = bundleDirectory ? {
    ...sourceHmuxIdentity,
    executableDigest: bundleExecutable(join(binaryDirectory, "hmux"), "Staged Hmux CLI").digest,
    runtimeExecutableDigest: bundleExecutable(join(binaryDirectory, "hmux-runtime"), "Staged Hmux runtime").digest,
  } : sourceHmuxIdentity;
  const immutableDigest = channelLauncher.artifactDigest(snapshotDirectory);
  const appIdentity = {
    schemaVersion: requestedSourceRevision ? 2 : 1,
    channel: hmuxIdentity.channel,
    ...(requestedSourceRevision
      ? { sourceRevision: requestedSourceRevision }
      : {}),
  };
  const identity = JSON.stringify({
    schemaVersion: 3,
    packageVersion,
    artifactDigest: immutableDigest,
    app: appIdentity,
    controlPlane: controlPlaneIdentity,
    orchestration: orchestrationIdentity,
    hmux: hmuxIdentity,
  });
  const sourceDigest = createHash("sha256")
    .update("dure-cli-stabilized-snapshot-v3\0")
    .update(identity)
    .update("\0")
    .digest("hex");
  return {
    generationDirectory,
    snapshotDirectory,
    packageVersion,
    immutableDigest,
    appIdentity,
    controlPlaneIdentity,
    orchestrationIdentity,
    hmuxIdentity,
    identity,
    sourceDigest,
  };
}

async function stabilizeSnapshot(stagingRoot, preparedClaudeDriver) {
  let previous;
  let lastError;
  for (
    let generation = 1;
    generation <= maxSnapshotGenerations;
    generation += 1
  ) {
    let candidate;
    try {
      candidate = await observeSnapshot(
        stagingRoot,
        generation,
        preparedClaudeDriver,
      );
    } catch (error) {
      lastError = error;
      rmSync(join(stagingRoot, `generation-${generation}`), {
        recursive: true,
        force: true,
      });
      if (previous) {
        rmSync(previous.generationDirectory, { recursive: true, force: true });
        previous = undefined;
      }
      continue;
    }
    lastError = undefined;
    if (previous?.identity === candidate.identity) {
      rmSync(previous.generationDirectory, { recursive: true, force: true });
      return candidate;
    }
    if (previous) {
      rmSync(previous.generationDirectory, { recursive: true, force: true });
    }
    previous = candidate;
  }
  throw new DureCliInstallSourceUnstableError(
    lastError ? { cause: lastError } : undefined,
  );
}

let stagingRoot;
function cleanup() {
  if (stagingRoot) {
    rmSync(stagingRoot, { recursive: true, force: true });
    stagingRoot = undefined;
  }
}
process.once("SIGINT", () => {
  cleanup();
  process.exit(1);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(1);
});

try {
  stagingRoot = mkdtempSync(join(tmpdir(), "dure-cli-build-"));
  const preparedClaudeDriver =
    await prepareClaudeDriverDependencies(stagingRoot);
  let snapshot = await stabilizeSnapshot(stagingRoot, preparedClaudeDriver);
  if (bundleDirectory && process.env.APPLE_SIGNING_IDENTITY) {
    // Secure timestamps change bytes. Seal only the stabilized owned copies,
    // then derive all final identities from that payload; never sign each poll.
    signMacosExecutables(
      [controlPlaneCommand, claudeRelayCommand, "hmux", "hmux-runtime"].map((name) => join(snapshot.snapshotDirectory, "bin", name)),
      process.env.APPLE_SIGNING_IDENTITY,
    );
    snapshot = await describeSnapshot(snapshot.generationDirectory, snapshot.snapshotDirectory, snapshot.packageVersion, snapshot.hmuxIdentity);
  }
  const {
    snapshotDirectory,
    packageVersion,
    immutableDigest,
    appIdentity,
    controlPlaneIdentity,
    orchestrationIdentity,
    hmuxIdentity,
    sourceDigest,
  } = snapshot;
  const buildId =
    requestedBuildId || `${packageVersion}+${sourceDigest.slice(0, 16)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(buildId)) {
    throw new Error("DURE_CLI_BUILD_ID must be one safe path component");
  }
  const versionsDirectory = join(stagingRoot, "versions");
  const versionDirectory = join(versionsDirectory, buildId);
  mkdirSync(versionsDirectory);
  renameSync(snapshotDirectory, versionDirectory);
  writeFileSync(
    join(versionDirectory, "install.json"),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        buildId,
        packageVersion,
        sourceDigest,
        command: canonicalCommand,
        controlPlaneCommand,
        compatibilityCommands,
        bundle: {
          schemaVersion: 2,
          artifactDigest: immutableDigest,
          app: appIdentity,
          controlPlane: controlPlaneIdentity,
          orchestration: orchestrationIdentity,
          hmux: hmuxIdentity,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );

  const promotion = await import(
    pathToFileURL(
      join(versionDirectory, "bin", "lib", "dure-cli-promotion.mjs"),
    ).href
  );
  const receipt = promotion.promoteDureCli({
    sourceVersionDirectory: versionDirectory,
    installRoot,
    commandDirectory,
    lockWaitMs,
  });
  if (bundleDirectory) {
    // The package needs the immutable version and its relative current pointer.
    // User command links are created only by promotion at the destination home.
    rmSync(join(receipt.installRoot, "bin"), { recursive: true });
    rmSync(join(receipt.installRoot, "launcher"), { recursive: true });
  }
  const canonicalGlobalInstallRoot = join(
    homedir(),
    ".local",
    "share",
    "hebbian-ide-cli",
  );
  const canonicalChannelInstallRoot = join(
    canonicalGlobalInstallRoot,
    "channels",
    hmuxIdentity.channel,
  );
  const canonicalChannelCommandDirectory = join(
    canonicalChannelInstallRoot,
    "bin",
  );
  const launcherReconciliation =
    hmuxIdentity.channel !== "stable" &&
    resolve(installRoot) === resolve(canonicalChannelInstallRoot) &&
    resolve(commandDirectory) === resolve(canonicalChannelCommandDirectory)
      ? promotion.reconcileDureCliLauncher({
          sourceVersionDirectory: versionDirectory,
          installRoot: canonicalGlobalInstallRoot,
          commandDirectory: join(homedir(), ".local", "bin"),
          lockWaitMs,
        })
      : undefined;

  // Provider configuration remains an explicit user-approval boundary. App
  // onboarding or `dure integration install --global --approve-global-config`
  // performs that separate mutation.

  process.stdout.write(
    bundleDirectory ? `Staged immutable Dure CLI build ${buildId}\n` :
      `Installed immutable Dure CLI build ${buildId}\n` +
      `  current: ${join(receipt.installRoot, "current")}\n` +
      `  command: ${receipt.command}\n` +
      `  control plane: ${join(receipt.commandDirectory, controlPlaneCommand)}\n` +
      (launcherReconciliation?.status === "repaired"
        ? `  global launcher: ${launcherReconciliation.command}\n`
        : "") +
      `  deprecated compatibility: ${compatibilityCommands
        .map((command) => join(receipt.commandDirectory, command))
        .join(", ")}\n`,
  );
} finally {
  cleanup();
}
