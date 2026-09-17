#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_METADATA_BYTES = 64 * 1024;
const CHANNEL = /^[a-z0-9-]{1,64}$/;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTROL_PLANE_BUILD = /^dure-control-plane\/v([1-9][0-9]*)-/;

function artifactDigest(root) {
  const digest = createHash("sha256");
  const visit = (pathname) => {
    const stat = lstatSync(pathname);
    const name = relative(root, pathname).replaceAll("\\", "/");
    if (name === "install.json") return;
    if (stat.isSymbolicLink()) {
      digest.update(`link\0${name}\0${readlinkSync(pathname)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      digest.update(`directory\0${name}\0`);
      for (const entry of readdirSync(pathname).sort()) {
        visit(join(pathname, entry));
      }
      return;
    }
    if (!stat.isFile()) throw new Error("unsupported immutable artifact entry");
    digest.update(`file\0${name}\0${stat.mode & 0o111}\0`);
    digest.update(readFileSync(pathname));
    digest.update("\0");
  };
  for (const entry of readdirSync(root).sort()) visit(join(root, entry));
  return digest.digest("hex");
}

function executableDigest(pathname) {
  const stat = lstatSync(pathname);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("bundle executable is invalid");
  }
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function launcherDigest(pathname) {
  const stat = lstatSync(pathname);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size < 1 ||
    stat.size > MAX_METADATA_BYTES
  ) {
    throw new Error("channel launcher is invalid");
  }
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validAppIdentity(value) {
  return (
    (exactKeys(value, ["schemaVersion", "channel"]) &&
      value.schemaVersion === 1 &&
      CHANNEL.test(value.channel)) ||
    (exactKeys(value, ["schemaVersion", "channel", "sourceRevision"]) &&
      value.schemaVersion === 2 &&
      CHANNEL.test(value.channel) &&
      GIT_COMMIT.test(value.sourceRevision))
  );
}

function sourceIdentityDigest(metadata) {
  const identity = JSON.stringify({
    schemaVersion: 3,
    packageVersion: metadata.packageVersion,
    artifactDigest: metadata.bundle.artifactDigest,
    app: metadata.bundle.app,
    controlPlane: metadata.bundle.controlPlane,
    orchestration: metadata.bundle.orchestration,
    hmux: metadata.bundle.hmux,
  });
  return createHash("sha256")
    .update("dure-cli-stabilized-snapshot-v3\0")
    .update(identity)
    .update("\0")
    .digest("hex");
}

function parseMetadata(versionRoot) {
  const source = readFileSync(join(versionRoot, "install.json"));
  if (source.byteLength < 1 || source.byteLength > MAX_METADATA_BYTES) {
    throw new Error("bundle metadata size is invalid");
  }
  const metadata = JSON.parse(source);
  if (
    !exactKeys(metadata, [
      "schemaVersion",
      "buildId",
      "packageVersion",
      "sourceDigest",
      "command",
      "controlPlaneCommand",
      "compatibilityCommands",
      "bundle",
    ]) ||
    metadata.schemaVersion !== 3 ||
    !BUILD_ID.test(metadata.buildId) ||
    basename(versionRoot) !== metadata.buildId ||
    !SHA256.test(metadata.sourceDigest) ||
    metadata.command !== "dure" ||
    metadata.controlPlaneCommand !==
      (process.platform === "win32"
        ? "dure-control-plane.exe"
        : "dure-control-plane") ||
    JSON.stringify(metadata.compatibilityCommands) !==
      JSON.stringify(["hebbian-ade", "hebbian-ide"]) ||
    !exactKeys(metadata.bundle, [
      "schemaVersion",
      "artifactDigest",
      "app",
      "controlPlane",
      "orchestration",
      "hmux",
    ]) ||
    metadata.bundle.schemaVersion !== 2 ||
    !SHA256.test(metadata.bundle.artifactDigest) ||
    !validAppIdentity(metadata.bundle.app) ||
    !exactKeys(metadata.bundle.hmux, [
      "schemaVersion",
      "channel",
      "buildId",
      "executablePath",
      "executableDigest",
      "runtimeExecutablePath",
      "runtimeExecutableDigest",
    ]) ||
    ![1, 2].includes(metadata.bundle.hmux.schemaVersion) ||
    (metadata.bundle.hmux.schemaVersion === 2 &&
      (metadata.bundle.app.schemaVersion !== 2 ||
        metadata.bundle.hmux.executablePath !== "bin/hmux" ||
        metadata.bundle.hmux.runtimeExecutablePath !== "bin/hmux-runtime")) ||
    !CHANNEL.test(metadata.bundle.hmux.channel) ||
    !BUILD_ID.test(metadata.bundle.hmux.buildId) ||
    !SHA256.test(metadata.bundle.hmux.executableDigest) ||
    !SHA256.test(metadata.bundle.hmux.runtimeExecutableDigest)
  ) {
    throw new Error("bundle metadata is incompatible");
  }
  if (artifactDigest(versionRoot) !== metadata.bundle.artifactDigest) {
    throw new Error("immutable bundle digest does not match");
  }
  if (metadata.bundle.hmux.schemaVersion === 2) {
    executableDigest(join(versionRoot, "bin", "node"));
  }
  if (
    metadata.bundle.app.schemaVersion === 2 &&
    sourceIdentityDigest(metadata) !== metadata.sourceDigest
  ) {
    throw new Error("source-bound bundle identity does not match");
  }
  if (
    executableDigest(
      resolveBundleHmuxPath(versionRoot, metadata.bundle.hmux, "executablePath"),
    ) !==
      metadata.bundle.hmux.executableDigest ||
    executableDigest(
      resolveBundleHmuxPath(versionRoot, metadata.bundle.hmux, "runtimeExecutablePath"),
    ) !==
      metadata.bundle.hmux.runtimeExecutableDigest
  ) {
    throw new Error("Hmux bundle digest does not match");
  }
  return metadata;
}

function resolveBundleHmuxPath(versionRoot, hmux, key) {
  return hmux.schemaVersion === 2 ? join(versionRoot, hmux[key]) : hmux[key];
}

function buildSequence(buildId) {
  const match = CONTROL_PLANE_BUILD.exec(buildId ?? "");
  const value = Number(match?.[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function updateRequired(reason) {
  const receipt = {
    schemaVersion: 1,
    kind: "dure.cli.handoff_receipt",
    status: "cli_update_required",
    error: { code: "cli_update_required", reason },
    action: {
      label: "Update Dure App",
      command: "dure install --global",
    },
  };
  process.stderr.write(`${JSON.stringify(receipt)}\n`);
  process.exit(2);
}

function installedVersion(installRoot) {
  const versionsRoot = realpathSync(join(installRoot, "versions"));
  const versionRoot = realpathSync(join(installRoot, "current"));
  if (dirname(versionRoot) !== versionsRoot) {
    throw new Error("channel current pointer escaped immutable versions");
  }
  return { versionRoot, metadata: parseMetadata(versionRoot) };
}

function resolveChannelCommand({
  launcherPath = fileURLToPath(import.meta.url),
  environment = process.env,
} = {}) {
  const launcher = realpathSync(launcherPath);
  const installRoot = resolve(dirname(launcher), "..");
  const channel =
    environment.DURE_APP_CHANNEL ??
    environment.HEBBIAN_APP_CHANNEL ??
    "stable";
  if (!CHANNEL.test(channel)) throw new Error("app channel is invalid");
  const nestedChannelRoot = join(installRoot, "channels", channel);
  const channelRoot =
    channel !== "stable" && existsSync(nestedChannelRoot)
      ? nestedChannelRoot
      : installRoot;
  const { versionRoot, metadata } = installedVersion(channelRoot);
  const launcherHash = launcherDigest(launcher);
  if (
    launcherHash !==
    launcherDigest(
      join(versionRoot, "bin", "lib", "dure-cli-channel-launcher.mjs"),
    )
  ) {
    // A global stable bootstrap can select a different dev launcher revision.
    // Verify its own source as well as the independently verified target above.
    if (channelRoot === installRoot) {
      throw new Error("channel launcher does not match its immutable version");
    }
    const owner = installedVersion(installRoot);
    if (
      owner.metadata.bundle.app.channel !== "stable" ||
      owner.metadata.bundle.hmux.channel !== "stable" ||
      launcherHash !==
        launcherDigest(
          join(owner.versionRoot, "bin", "lib", "dure-cli-channel-launcher.mjs"),
        )
    ) {
      throw new Error("channel launcher does not match its immutable version");
    }
  }
  if (
    metadata.bundle.app.channel !== channel ||
    metadata.bundle.hmux.channel !== channel
  ) {
    throw new Error("channel bundle identity does not match the requested app");
  }
  if (buildSequence(metadata.bundle.controlPlane?.buildId) === null) {
    throw new Error("channel control plane build identity is invalid");
  }
  // The selected payload owns backend protocol admission and replacement.
  // A local descriptor cannot authorize or block app-control/remote commands.
  const target = join(versionRoot, "bin", "dure");
  const resolvedTarget = realpathSync(target);
  if (resolvedTarget !== join(versionRoot, "bin", "dure.mjs")) {
    throw new Error("channel command escaped its immutable version");
  }
  return { channel, metadata, resolvedTarget, target };
}

async function launch() {
  let target;
  try {
    target = resolveChannelCommand().resolvedTarget;
  } catch (error) {
    updateRequired(error instanceof Error ? error.message : "channel verification failed");
  }
  process.env.DURE_INVOKED_AS ||= basename(process.argv[1] || "dure");
  process.argv[1] = target;
  // Keep Node, signals and exit status on the caller's process. Only bundle
  // verification failures belong to the launcher's update-required receipt.
  await import(pathToFileURL(target).href);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await launch();
}

export { artifactDigest, parseMetadata, resolveChannelCommand };
