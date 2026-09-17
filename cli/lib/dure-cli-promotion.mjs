import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { validateControlPlaneBundleIdentity } from "./control-plane-contract.mjs";
import { parseMetadata } from "./dure-cli-channel-launcher.mjs";
import { validateOrchestrationPayloadIdentity } from "./orchestration-integration.mjs";
import {
  acquireDureCliMutationLock,
  releaseDureCliMutationLock,
} from "./dure-cli-mutation-lock.mjs";

const COMMAND = "dure";
const COMMAND_SCRIPT = `${COMMAND}.mjs`;
const CONTROL_PLANE_COMMAND =
  process.platform === "win32" ? "dure-control-plane.exe" : "dure-control-plane";
const CLAUDE_RELAY_COMMAND =
  process.platform === "win32"
    ? "dure-claude-process-relay.exe"
    : "dure-claude-process-relay";
const COMPATIBILITY_COMMANDS = ["hebbian-ade", "hebbian-ide"];
const LEGACY_METADATA_LIMIT_BYTES = 64 * 1024;

function pathExists(pathname) {
  try {
    lstatSync(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function restoreExecutableBits(sourcePath, targetPath) {
  const source = lstatSync(sourcePath);
  if (source.isSymbolicLink()) return;
  if (source.isDirectory()) {
    for (const entry of readdirSync(sourcePath)) {
      restoreExecutableBits(join(sourcePath, entry), join(targetPath, entry));
    }
    return;
  }
  if (!source.isFile()) {
    throw new Error("Dure CLI payload contains an unsupported entry");
  }
  const target = lstatSync(targetPath);
  const desiredMode = (target.mode & ~0o111) | (source.mode & 0o111);
  if (desiredMode !== target.mode) chmodSync(targetPath, desiredMode);
}

// Existing installations prove ownership and their own immutable bytes. They
// are being replaced, so they need not implement the incoming CLI's contract.
function validateOwnedVersion(sourceVersionDirectory) {
  const source = realpathSync(sourceVersionDirectory);
  if (basename(dirname(source)) !== "versions") {
    throw new Error("Dure CLI source is not an immutable installed version");
  }
  const metadata = parseMetadata(source);
  if (
    metadata.schemaVersion !== 3 ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(metadata.buildId) ||
    !/^[a-f0-9]{64}$/.test(metadata.sourceDigest) ||
    typeof metadata.packageVersion !== "string" ||
    basename(source) !== metadata.buildId ||
    metadata.command !== COMMAND ||
    metadata.controlPlaneCommand !== CONTROL_PLANE_COMMAND ||
    JSON.stringify(metadata.compatibilityCommands) !==
      JSON.stringify(COMPATIBILITY_COMMANDS) ||
    metadata.bundle?.schemaVersion !== 2
  ) {
    throw new Error("Dure CLI source metadata is invalid");
  }
  const commandPath = join(source, "bin", COMMAND);
  if (
    !lstatSync(commandPath).isSymbolicLink() ||
    readlinkSync(commandPath) !== COMMAND_SCRIPT
  ) {
    throw new Error(`Dure CLI source ${COMMAND} entrypoint is invalid`);
  }
  const script = lstatSync(join(source, "bin", COMMAND_SCRIPT));
  if (script.isSymbolicLink() || !script.isFile()) {
    throw new Error(`Dure CLI source ${COMMAND_SCRIPT} is not an immutable file`);
  }
  for (const command of COMPATIBILITY_COMMANDS) {
    const pathname = join(source, "bin", command);
    if (!lstatSync(pathname).isSymbolicLink() || readlinkSync(pathname) !== COMMAND) {
      throw new Error(`Dure CLI source ${command} alias is invalid`);
    }
  }
  return { metadata, source };
}

function validatePreparedVersion(sourceVersionDirectory) {
  const { metadata, source } = validateOwnedVersion(sourceVersionDirectory);
  for (const command of [
    CONTROL_PLANE_COMMAND,
    CLAUDE_RELAY_COMMAND,
  ]) {
    const pathname = join(source, "bin", command);
    const stat = lstatSync(pathname);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Dure CLI source ${command} is not an immutable file`);
    }
  }
  for (const relativePath of [
    ["orchestration-integration", "SKILL.md"],
    ["orchestration-integration", "mcp.json"],
    ["orchestration-integration", "lifecycle.json"],
    ["lib", "orchestration-client.mjs"],
    ["lib", "orchestration-command.mjs"],
    ["lib", "orchestration-backend-transport.mjs"],
    ["lib", "orchestration-lifecycle.mjs"],
    ["lib", "orchestration-mcp-server.mjs"],
    ["lib", "orchestration-next-work.mjs"],
    ["lib", "orchestration-integration.mjs"],
    ["lib", "control-plane-build-identity.json"],
    ["lib", "control-plane-contract.mjs"],
    ["lib", "backend-profiles.mjs"],
    ["lib", "backend-ssh-references.mjs"],
    ["lib", "backend-transport.mjs"],
    ["lib", "schedule-client.mjs"],
    ["lib", "dure-cli-channel-launcher.mjs"],
    ["provider-drivers", "claude", "package.json"],
    ["provider-drivers", "claude", "sdk-runtime.mjs"],
    ["provider-drivers", "claude", "claude-runtime-artifact.mjs"],
    ["provider-drivers", "claude", "claude-runtime-provision.mjs"],
    ["provider-drivers", "claude", "shared-sdk-host-entrypoint.mjs"],
    [
      "provider-drivers",
      "claude",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "package.json",
    ],
  ]) {
    const pathname = join(source, "bin", ...relativePath);
    if (!lstatSync(pathname).isFile()) {
      throw new Error(`Dure CLI orchestration payload is invalid: ${pathname}`);
    }
  }
  validateControlPlaneBundleIdentity(
    metadata.bundle.controlPlane,
    join(source, "bin", CONTROL_PLANE_COMMAND),
  );
  validateOrchestrationPayloadIdentity(
    metadata.bundle.orchestration,
    join(source, "bin", COMMAND_SCRIPT),
  );
  return { metadata, source };
}

function replaceSymlink(target, linkPath) {
  const temporaryLink = join(
    dirname(linkPath),
    `.dure-link-${process.pid}-${basename(linkPath)}`,
  );
  rmSync(temporaryLink, { force: true });
  symlinkSync(target, temporaryLink);
  renameSync(temporaryLink, linkPath);
}

function schemaTwoVersionOwnedByDure(versionRoot) {
  const metadataPath = join(versionRoot, "install.json");
  const metadataStat = lstatSync(metadataPath);
  if (
    metadataStat.isSymbolicLink() ||
    !metadataStat.isFile() ||
    metadataStat.size < 1 ||
    metadataStat.size > LEGACY_METADATA_LIMIT_BYTES
  ) {
    return false;
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const commandPath = join(versionRoot, "bin", COMMAND);
  const scriptPath = join(versionRoot, "bin", COMMAND_SCRIPT);
  return (
    metadata?.schemaVersion === 2 &&
    typeof metadata.packageVersion === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(metadata.buildId) &&
    /^[a-f0-9]{64}$/.test(metadata.sourceDigest) &&
    metadata.buildId ===
      `${metadata.packageVersion}+${metadata.sourceDigest.slice(0, 16)}` &&
    basename(versionRoot) === metadata.buildId &&
    metadata.command === COMMAND &&
    metadata.controlPlaneCommand === CONTROL_PLANE_COMMAND &&
    JSON.stringify(metadata.compatibilityCommands) ===
      JSON.stringify(COMPATIBILITY_COMMANDS) &&
    metadata.bundle?.schemaVersion === 1 &&
    /^[a-f0-9]{64}$/.test(metadata.bundle.controlPlane?.digest) &&
    /^[a-f0-9]{64}$/.test(metadata.bundle.orchestration?.digest) &&
    lstatSync(commandPath).isSymbolicLink() &&
    readlinkSync(commandPath) === COMMAND_SCRIPT &&
    lstatSync(scriptPath).isFile() &&
    !lstatSync(scriptPath).isSymbolicLink()
  );
}

function verifiedLegacyCommand(commandPath, canonicalInstallRoot) {
  if (!pathExists(commandPath) || !lstatSync(commandPath).isSymbolicLink()) {
    return false;
  }
  try {
    const target = realpathSync(commandPath);
    if (basename(target) !== COMMAND_SCRIPT) return false;
    const versionRoot = dirname(dirname(target));
    if (realpathSync(dirname(dirname(versionRoot))) !== canonicalInstallRoot) {
      return false;
    }
    try {
      validateOwnedVersion(versionRoot);
    } catch {
      if (!schemaTwoVersionOwnedByDure(versionRoot)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function commandUsesLauncher(commandPath, launcherPath) {
  if (
    !pathExists(commandPath) ||
    !pathExists(launcherPath) ||
    !lstatSync(commandPath).isSymbolicLink()
  ) {
    return false;
  }
  try {
    return realpathSync(commandPath) === realpathSync(launcherPath);
  } catch {
    return false;
  }
}

function installLauncher(prepared, canonicalInstallRoot) {
  const launcherDirectory = join(canonicalInstallRoot, "launcher");
  mkdirSync(launcherDirectory, { recursive: true });
  if (lstatSync(launcherDirectory).isSymbolicLink()) {
    throw new Error("refusing unsafe Dure CLI launcher directory");
  }
  const source = join(
    prepared.source,
    "bin",
    "lib",
    "dure-cli-channel-launcher.mjs",
  );
  const launcherPath = join(launcherDirectory, "dure.mjs");
  if (pathExists(launcherPath) && lstatSync(launcherPath).isDirectory()) {
    throw new Error("refusing unsafe Dure CLI launcher");
  }
  const temporaryLauncher = join(
    launcherDirectory,
    `.dure-launcher-${process.pid}.tmp`,
  );
  rmSync(temporaryLauncher, { force: true });
  copyFileSync(source, temporaryLauncher);
  chmodSync(temporaryLauncher, 0o755);
  renameSync(temporaryLauncher, launcherPath);
  return launcherPath;
}

function installChannelCommand(canonicalInstallRoot, launcherPath) {
  const directory = join(canonicalInstallRoot, "bin");
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error("refusing unsafe Dure CLI channel command directory");
  }
  const commandPath = join(directory, COMMAND);
  if (pathExists(commandPath) && !lstatSync(commandPath).isSymbolicLink()) {
    throw new Error("refusing unsafe Dure CLI channel command");
  }
  replaceSymlink(launcherPath, commandPath);
}

function prepareInstallLocations(installRoot, commandDirectory, lockWaitMs) {
  if (!Number.isInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 60_000) {
    throw new Error("Dure CLI install lock wait must be 0..60000 milliseconds");
  }
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(commandDirectory, { recursive: true });
  return {
    installRoot: realpathSync(installRoot),
    commandDirectory: realpathSync(commandDirectory),
  };
}

export function promoteDureCli({
  sourceVersionDirectory,
  reconcileManaged = false,
  installRoot = process.env.DURE_CLI_INSTALL_ROOT ||
    join(homedir(), ".local", "share", "hebbian-ide-cli"),
  commandDirectory = process.env.DURE_CLI_INSTALL_DIR ||
    join(homedir(), ".local", "bin"),
  lockWaitMs = 15_000,
}) {
  const prepared = validatePreparedVersion(sourceVersionDirectory);
  const {
    installRoot: canonicalInstallRoot,
    commandDirectory: canonicalCommandDirectory,
  } = prepareInstallLocations(installRoot, commandDirectory, lockWaitMs);
  const versionsDirectory = join(canonicalInstallRoot, "versions");
  mkdirSync(versionsDirectory, { recursive: true });
  if (lstatSync(versionsDirectory).isSymbolicLink()) {
    throw new Error("refusing unsafe Dure CLI versions directory");
  }

  const lock = acquireDureCliMutationLock(canonicalInstallRoot, lockWaitMs);

  let temporaryRoot;
  try {
    if (reconcileManaged) {
      const current = join(canonicalInstallRoot, "current");
      if (pathExists(current)) {
        const installed = validateOwnedVersion(current);
        if (dirname(installed.source) !== versionsDirectory) {
          throw new Error("Dure CLI current pointer escaped immutable versions");
        }
        const launcher = join(canonicalInstallRoot, "launcher", "dure.mjs");
        const sourceLauncher = join(prepared.source, "bin", "lib", "dure-cli-channel-launcher.mjs");
        if (
          JSON.stringify(installed.metadata) === JSON.stringify(prepared.metadata) &&
          commandUsesLauncher(join(canonicalInstallRoot, "bin", COMMAND), launcher) &&
          readFileSync(launcher).equals(readFileSync(sourceLauncher))
        ) {
          return {
            schemaVersion: 1,
            status: "current",
            buildId: installed.metadata.buildId,
          };
        }
      } else if (
        readdirSync(versionsDirectory).length !== 0 ||
        readdirSync(canonicalCommandDirectory).length !== 0 ||
        pathExists(join(canonicalInstallRoot, "launcher"))
      ) {
        throw new Error("refusing to bootstrap over an incomplete Dure CLI install");
      }
    }
    const versionDirectory = join(versionsDirectory, prepared.metadata.buildId);
    if (pathExists(versionDirectory)) {
      let installed;
      let installedError;
      try {
        installed = validatePreparedVersion(versionDirectory);
      } catch (error) {
        installedError = error;
      }
      if (
        !installed ||
        JSON.stringify(installed.metadata) !== JSON.stringify(prepared.metadata)
      ) {
        throw new Error(
          `refusing to replace immutable Dure CLI build ${prepared.metadata.buildId}`,
          { cause: installedError },
        );
      }
    } else {
      temporaryRoot = mkdtempSync(join(canonicalInstallRoot, ".install-"));
      const stagedVersion = join(temporaryRoot, prepared.metadata.buildId);
      cpSync(prepared.source, stagedVersion, {
        recursive: true,
        verbatimSymlinks: true,
      });
      // cpSync applies the caller's umask to new files. The artifact identity
      // includes every executable bit, including dependency entrypoints.
      restoreExecutableBits(prepared.source, stagedVersion);
      renameSync(stagedVersion, versionDirectory);
      rmdirSync(temporaryRoot);
      temporaryRoot = undefined;
    }

    for (const command of [
      COMMAND,
      CONTROL_PLANE_COMMAND,
      ...COMPATIBILITY_COMMANDS,
    ]) {
      const commandPath = join(canonicalCommandDirectory, command);
      if (!existsSync(commandPath) || lstatSync(commandPath).isSymbolicLink()) continue;
      const rollbackRoot = join(canonicalInstallRoot, "rollback");
      if (pathExists(rollbackRoot) && lstatSync(rollbackRoot).isSymbolicLink()) {
        throw new Error("refusing unsafe Dure CLI rollback directory");
      }
      const rollbackDirectory = join(rollbackRoot, "pre-versioned", "bin");
      mkdirSync(rollbackDirectory, { recursive: true });
      const rollbackCommand = join(rollbackDirectory, command);
      if (pathExists(rollbackCommand) && lstatSync(rollbackCommand).isSymbolicLink()) {
        throw new Error("refusing unsafe Dure CLI rollback command");
      }
      if (!pathExists(rollbackCommand)) {
        copyFileSync(commandPath, rollbackCommand);
        chmodSync(rollbackCommand, 0o755);
      }
    }

    replaceSymlink(
      `versions/${prepared.metadata.buildId}`,
      join(canonicalInstallRoot, "current"),
    );
    const launcherPath = installLauncher(prepared, canonicalInstallRoot);
    installChannelCommand(canonicalInstallRoot, launcherPath);
    for (const command of [
      COMMAND,
      CONTROL_PLANE_COMMAND,
      ...COMPATIBILITY_COMMANDS,
    ]) {
      const target =
        command !== CONTROL_PLANE_COMMAND
          ? launcherPath
          : join(canonicalInstallRoot, "current", "bin", command);
      replaceSymlink(
        target,
        join(canonicalCommandDirectory, command),
      );
    }
    return {
      schemaVersion: 1,
      buildId: prepared.metadata.buildId,
      digest: prepared.metadata.sourceDigest,
      bundle: prepared.metadata.bundle,
      installRoot: canonicalInstallRoot,
      commandDirectory: canonicalCommandDirectory,
      command: join(canonicalCommandDirectory, COMMAND),
    };
  } finally {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    releaseDureCliMutationLock(lock);
  }
}

export function reconcileDureCliLauncher({
  sourceVersionDirectory,
  installRoot = join(homedir(), ".local", "share", "hebbian-ide-cli"),
  commandDirectory = join(homedir(), ".local", "bin"),
  lockWaitMs = 15_000,
}) {
  const prepared = validatePreparedVersion(sourceVersionDirectory);
  if (!pathExists(installRoot) || !pathExists(commandDirectory)) {
    return {
      schemaVersion: 1,
      status: "unmanaged",
      command: join(commandDirectory, COMMAND),
    };
  }
  const {
    installRoot: canonicalInstallRoot,
    commandDirectory: canonicalCommandDirectory,
  } = prepareInstallLocations(installRoot, commandDirectory, lockWaitMs);
  const commandPath = join(canonicalCommandDirectory, COMMAND);
  const launcherPath = join(canonicalInstallRoot, "launcher", "dure.mjs");
  const lock = acquireDureCliMutationLock(canonicalInstallRoot, lockWaitMs);
  try {
    const current = commandUsesLauncher(commandPath, launcherPath);
    if (!current && !verifiedLegacyCommand(commandPath, canonicalInstallRoot)) {
      return { schemaVersion: 1, status: "unmanaged", command: commandPath };
    }
    // Reconcile the global command, not its selected stable payload. A dev
    // installation must not give the stable bootstrap another bundle's bytes.
    const currentVersion = realpathSync(join(canonicalInstallRoot, "current"));
    if (
      dirname(currentVersion) !==
      realpathSync(join(canonicalInstallRoot, "versions"))
    ) {
      throw new Error("Dure CLI current pointer escaped immutable versions");
    }
    const launcherSource = schemaTwoVersionOwnedByDure(currentVersion)
      ? prepared
      : validateOwnedVersion(currentVersion);
    const installedLauncher = installLauncher(
      launcherSource,
      canonicalInstallRoot,
    );
    installChannelCommand(canonicalInstallRoot, installedLauncher);
    if (!current) replaceSymlink(installedLauncher, commandPath);
    for (const command of COMPATIBILITY_COMMANDS) {
      const compatibilityPath = join(canonicalCommandDirectory, command);
      if (verifiedLegacyCommand(compatibilityPath, canonicalInstallRoot)) {
        replaceSymlink(installedLauncher, compatibilityPath);
      }
    }
    return {
      schemaVersion: 1,
      status: current ? "current" : "repaired",
      command: commandPath,
    };
  } finally {
    releaseDureCliMutationLock(lock);
  }
}

export function promoteRunningDureCli(cliScriptPath) {
  const sourceCommand = realpathSync(cliScriptPath);
  const sourceVersionDirectory = dirname(dirname(sourceCommand));
  if (parseMetadata(sourceVersionDirectory).bundle.app.channel !== "stable") {
    throw new Error(
      "a development-channel CLI cannot replace the stable global install",
    );
  }
  return promoteDureCli({
    sourceVersionDirectory,
  });
}
