#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";

const MAX_METADATA_BYTES = 64 * 1024;
const CHANNEL = /^[a-z0-9-]{1,64}$/;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTROL_PLANE_BUILD = /^dure-control-plane\/v([1-9][0-9]*)-/;

// A diagnostic listing of the payload, written by staging. The aggregate digest
// covers it and remains the only integrity decision; after a mismatch the
// listing names what differs.
const ARTIFACT_MANIFEST = "artifact-manifest.json";
const MAX_ARTIFACT_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_REPORTED_ENTRIES = 8;

// Verifying the payload hashes every byte of it, including the bundled Node,
// Hmux and provider drivers. Launch paths record a successful verification
// with the payload's file-system metadata, so later launches compare that
// metadata instead of hashing again. Writing, replacing, adding or removing an
// entry changes the metadata and brings back the full verification.
const VERIFICATION_RECEIPT_SCHEMA = 1;
const MAX_VERIFICATION_RECEIPT_BYTES = 4096;
// Some file systems keep coarse timestamps. A payload changed this recently
// could change again without a visible difference, so it is not recorded.
const RECENT_CHANGE_WINDOW_MS = 2_000;
// The launcher and the CLI it starts share one process and verify the same
// payload; the second check reuses the first.
const VERIFIED_IN_PROCESS = Symbol.for("dure.cli.verifiedArtifacts");

function walkArtifact(root, visit, { metadataOnly = false } = {}) {
  const walk = (pathname) => {
    const stat = lstatSync(pathname, { bigint: metadataOnly });
    const name = relative(root, pathname).replaceAll("\\", "/");
    if (name === "install.json") return;
    if (stat.isSymbolicLink()) {
      visit({ name, kind: "link", target: readlinkSync(pathname), stat });
      return;
    }
    if (stat.isDirectory()) {
      visit({ name, kind: "directory", stat });
      for (const entry of readdirSync(pathname).sort()) {
        walk(join(pathname, entry));
      }
      return;
    }
    if (!stat.isFile()) throw new Error("unsupported immutable artifact entry");
    visit(
      metadataOnly
        ? { name, kind: "file", stat }
        : {
            name,
            kind: "file",
            executable: stat.mode & 0o111,
            contents: readFileSync(pathname),
          },
    );
  };
  for (const entry of readdirSync(root).sort()) walk(join(root, entry));
}

/** File-system metadata of the payload and of executables it names outside itself. */
function artifactFingerprint(root, externalPaths = []) {
  const digest = createHash("sha256");
  let changedAtNs = 0n;
  const add = (label, stat) => {
    digest.update(
      `${label}\0${stat.mode}\0${stat.size}\0${stat.dev}\0${stat.ino}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`,
    );
    for (const time of [stat.mtimeNs, stat.ctimeNs]) {
      if (time > changedAtNs) changedAtNs = time;
    }
  };
  walkArtifact(
    root,
    (entry) =>
      add(
        entry.kind === "link"
          ? `link\0${entry.name}\0${entry.target}`
          : `${entry.kind}\0${entry.name}`,
        entry.stat,
      ),
    { metadataOnly: true },
  );
  for (const pathname of externalPaths) {
    add(`external\0${pathname}`, lstatSync(pathname, { bigint: true }));
  }
  return {
    fingerprint: digest.digest("hex"),
    changedAtMs: Number(changedAtNs / 1_000_000n),
  };
}

/** The per-user cache that holds verification receipts, or null without one. */
function verificationCacheDirectory(environment = process.env) {
  if (process.platform === "win32") {
    const local = environment.LOCALAPPDATA;
    return local && isAbsolute(local)
      ? join(local, "Dure", "cli-verification")
      : null;
  }
  const home = environment.HOME;
  if (!home || !isAbsolute(home)) return null;
  if (process.platform === "darwin") {
    return join(home, "Library", "Caches", "Dure", "cli-verification");
  }
  const cache = environment.XDG_CACHE_HOME;
  return join(
    cache && isAbsolute(cache) ? cache : join(home, ".cache"),
    "dure",
    "cli-verification",
  );
}

let verifierDigest;

/** A receipt is only as good as the checks that wrote it, so it names them. */
function currentVerifierDigest() {
  verifierDigest ??= createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex");
  return verifierDigest;
}

function readVerificationReceipt(pathname) {
  try {
    const stat = lstatSync(pathname);
    if (!stat.isFile() || stat.size > MAX_VERIFICATION_RECEIPT_BYTES) return null;
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

function writeVerificationReceipt(pathname, receipt) {
  const temporary = `${pathname}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, pathname);
  } catch {
    // The receipt only saves work; the next launch verifies in full instead.
    try {
      rmSync(temporary, { force: true });
    } catch {}
  }
}

/**
 * Whether this payload, with these metadata bytes, already passed the content
 * checks, and how to record that it did. Any failure here falls back to the
 * full verification, never to trusting the payload.
 */
function previousVerification(versionRoot, source, metadata, cacheDirectory) {
  try {
    const root = realpathSync(versionRoot);
    const verifier = currentVerifierDigest();
    const metadataDigest = createHash("sha256").update(source).digest("hex");
    const processKey = `${verifier}\0${root}\0${metadataDigest}`;
    const verified = (globalThis[VERIFIED_IN_PROCESS] ??= new Set());
    if (verified.has(processKey)) return { verified: true, record() {} };
    const { hmux } = metadata.bundle;
    // The fingerprint is taken before hashing: a change made while the
    // content is read leaves a receipt that no longer matches.
    const { fingerprint, changedAtMs } = artifactFingerprint(
      root,
      hmux.schemaVersion === 2
        ? []
        : [hmux.executablePath, hmux.runtimeExecutablePath],
    );
    const receipt = {
      schemaVersion: VERIFICATION_RECEIPT_SCHEMA,
      versionRoot: root,
      metadataDigest,
      fingerprint,
    };
    const pathname = join(
      cacheDirectory,
      `${createHash("sha256").update(`${verifier}\0${root}`).digest("hex")}.json`,
    );
    const recorded = readVerificationReceipt(pathname);
    if (
      exactKeys(recorded, Object.keys(receipt)) &&
      Object.entries(receipt).every(([key, value]) => recorded[key] === value)
    ) {
      verified.add(processKey);
      return { verified: true, record() {} };
    }
    return {
      verified: false,
      record() {
        verified.add(processKey);
        if (changedAtMs < Date.now() - RECENT_CHANGE_WINDOW_MS) {
          writeVerificationReceipt(pathname, receipt);
        }
      },
    };
  } catch {
    return null;
  }
}

function artifactDigest(root) {
  const digest = createHash("sha256");
  walkArtifact(root, (entry) => {
    if (entry.kind === "link") {
      digest.update(`link\0${entry.name}\0${entry.target}\0`);
    } else if (entry.kind === "directory") {
      digest.update(`directory\0${entry.name}\0`);
    } else {
      digest.update(`file\0${entry.name}\0${entry.executable}\0`);
      digest.update(entry.contents);
      digest.update("\0");
    }
  });
  return digest.digest("hex");
}

function artifactEntries(root) {
  const entries = [];
  walkArtifact(root, (entry) => {
    if (entry.name === ARTIFACT_MANIFEST) return;
    entries.push([
      entry.name,
      entry.kind === "link"
        ? `link ${entry.target}`
        : entry.kind === "directory"
          ? "directory"
          : `file ${entry.executable ? "x" : "-"} ${createHash("sha256").update(entry.contents).digest("hex")}`,
    ]);
  });
  return entries;
}

function writeArtifactManifest(root) {
  writeFileSync(
    join(root, ARTIFACT_MANIFEST),
    `${JSON.stringify({ schemaVersion: 1, entries: artifactEntries(root) })}\n`,
    { mode: 0o644 },
  );
}

function recordedArtifactEntries(root) {
  try {
    const pathname = join(root, ARTIFACT_MANIFEST);
    const stat = lstatSync(pathname);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_MANIFEST_BYTES) return null;
    const manifest = JSON.parse(readFileSync(pathname, "utf8"));
    if (
      !exactKeys(manifest, ["schemaVersion", "entries"]) ||
      manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.entries) ||
      !manifest.entries.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          entry.every((value) => typeof value === "string"),
      )
    ) {
      return null;
    }
    return new Map(manifest.entries);
  } catch {
    return null;
  }
}

/** Entries that differ from the staged listing; a directory covers its contents. */
function artifactDrift(root) {
  const recorded = recordedArtifactEntries(root);
  if (!recorded) return null;
  const observed = new Map(artifactEntries(root));
  const differences = [];
  for (const [name, entry] of observed) {
    if (!recorded.has(name)) differences.push([name, "unexpected"]);
    else if (recorded.get(name) !== entry) differences.push([name, "changed"]);
  }
  for (const name of recorded.keys()) {
    if (!observed.has(name)) differences.push([name, "missing"]);
  }
  // A reported directory stands for everything beneath it. Sorting places
  // each directory before its descendants.
  const drift = { unexpected: [], missing: [], changed: [] };
  const reported = new Set();
  differences.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [name, kind] of differences) {
    const parts = name.split("/");
    const covered = parts
      .slice(0, -1)
      .some((_, index) => reported.has(parts.slice(0, index + 1).join("/")));
    if (covered) continue;
    reported.add(name);
    drift[kind].push(name);
  }
  return drift;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function artifactDigestMismatch(versionRoot, buildId) {
  const subject = `Dure CLI build ${buildId} in ${versionRoot} changed after installation`;
  let drift;
  try {
    drift = artifactDrift(versionRoot);
  } catch {
    drift = null;
  }
  const installRoot = dirname(dirname(versionRoot));
  const reinstall =
    `Reinstall it: move ${installRoot} aside, then reopen the Dure app ` +
    "(or rerun the Dure CLI installation).";
  if (!drift) {
    return `immutable bundle digest does not match: ${subject}. ${reinstall}`;
  }
  const listed = Object.entries(drift)
    .filter(([, names]) => names.length > 0)
    .map(([kind, names]) => {
      const shown = names.slice(0, MAX_REPORTED_ENTRIES).join(", ");
      const more = names.length - MAX_REPORTED_ENTRIES;
      return `${kind}: ${shown}${more > 0 ? ` and ${more} more` : ""}`;
    });
  const changes = listed.length > 0 ? ` (${listed.join("; ")})` : "";
  if (drift.missing.length > 0 || drift.changed.length > 0 || drift.unexpected.length === 0) {
    return `immutable bundle digest does not match: ${subject}${changes}. ${reinstall}`;
  }
  const paths = drift.unexpected.map((name) => join(versionRoot, ...name.split("/")));
  const removal =
    paths.length > MAX_REPORTED_ENTRIES
      ? `remove the ${paths.length} entries that ${ARTIFACT_MANIFEST} does not list from ${versionRoot}`
      : process.platform === "win32"
        ? `remove ${paths.join(", ")}`
        : `rm -rf -- ${paths.map(shellQuote).join(" ")}`;
  return (
    `immutable bundle digest does not match: ${subject}${changes}. ` +
    "These entries are not part of Dure; a global package install that ran " +
    "with Dure's bundled Node can write them. To restore the build, " +
    `${removal}`
  );
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

/**
 * Reads and verifies an installed version. With `verificationCache`, a launch
 * path reuses an earlier verification of the unchanged payload; without it,
 * every byte is hashed again.
 */
function parseMetadata(versionRoot, { verificationCache = null } = {}) {
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
  const previous = verificationCache
    ? previousVerification(versionRoot, source, metadata, verificationCache)
    : null;
  const verified = previous?.verified === true;
  if (!verified) {
    if (artifactDigest(versionRoot) !== metadata.bundle.artifactDigest) {
      throw new Error(artifactDigestMismatch(versionRoot, metadata.buildId));
    }
    if (metadata.bundle.hmux.schemaVersion === 2) {
      executableDigest(join(versionRoot, "bin", "node"));
    }
  }
  if (
    metadata.bundle.app.schemaVersion === 2 &&
    sourceIdentityDigest(metadata) !== metadata.sourceDigest
  ) {
    throw new Error("source-bound bundle identity does not match");
  }
  if (!verified) {
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
    previous?.record();
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
  process.exitCode = 2;
}

function installedVersion(installRoot, verificationCache) {
  const versionsRoot = realpathSync(join(installRoot, "versions"));
  const versionRoot = realpathSync(join(installRoot, "current"));
  if (dirname(versionRoot) !== versionsRoot) {
    throw new Error("channel current pointer escaped immutable versions");
  }
  return {
    versionRoot,
    metadata: parseMetadata(versionRoot, { verificationCache }),
  };
}

function resolveChannelCommand({
  launcherPath = fileURLToPath(import.meta.url),
  environment = process.env,
  verificationCache = null,
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
  const { versionRoot, metadata } = installedVersion(channelRoot, verificationCache);
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
    const owner = installedVersion(installRoot, verificationCache);
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

// Every exit returns with process.exitCode set. Bundle verification hashes
// large files such as bin/node, and Node's fast exit path (process.exit() or
// an uncaught failure) can then hang while a V8 compile waits for a GC (#549).
// This file is installed alone as the global launcher, so it cannot import
// the CLI's shared process-exit helper.
async function launch() {
  let target;
  try {
    target = resolveChannelCommand({
      verificationCache: verificationCacheDirectory(),
    }).resolvedTarget;
  } catch (error) {
    updateRequired(error instanceof Error ? error.message : "channel verification failed");
    return;
  }
  process.env.DURE_INVOKED_AS ||= basename(process.argv[1] || "dure");
  process.argv[1] = target;
  // Keep Node, signals and exit status on the caller's process. Only bundle
  // verification failures belong to the launcher's update-required receipt.
  try {
    await import(pathToFileURL(target).href);
  } catch (error) {
    // The command reports its own failures; this is one it could not catch,
    // such as a module that failed to load.
    process.stderr.write(`${inspect(error)}\n`);
    process.exitCode ??= 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await launch();
}

export {
  artifactDigest,
  artifactFingerprint,
  buildSequence,
  parseMetadata,
  resolveChannelCommand,
  verificationCacheDirectory,
  writeArtifactManifest,
};
