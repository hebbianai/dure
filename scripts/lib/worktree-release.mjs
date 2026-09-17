import { createHash } from "node:crypto";
import { constants, closeSync, cpSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadAppControlDescriptor } from "../../cli/lib/app-control-location.mjs";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";
import { readVerifiedDescriptorText } from "../../cli/lib/fd-verified-read.mjs";
import { artifactDigest, parseMetadata } from "../../cli/lib/dure-cli-channel-launcher.mjs";
import {
  createWorktreePresentationEnvelope,
  parseWorktreePresentationEnvelope,
  readWorktreePresentationEnvelope,
  WORKTREE_PRESENTATION_FILE,
} from "../../src/lib/persistence/worktreePresentationEnvelope.ts";
import { appControlDirectory, worktreeDevIdentity } from "./app-channel.mjs";
import { assertOwnerOnlyDirectory, safeLstat } from "./dev-launch-storage.mjs";
import { writeExclusiveFile } from "./durable-file.mjs";

export function worktreeReleasePlan(worktreeRoot, instance, baseConfig) {
  const source = worktreeDevIdentity(worktreeRoot, instance);
  const profile = {
    sourceChannel: source.channel,
    targetChannel: `release-${source.channel.slice(4)}`,
    identifier: `io.hebbian.ade.release.${source.hash}`,
    dataStoreIdentifier: Array.from(createHash("sha256")
      .update(`dure-worktree-release-v1\0${source.channel}`).digest().subarray(0, 16)),
  };
  const productName = source.productName.replace("Dure Dev ", "Dure Worktree ");
  const windows = baseConfig.app?.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error("worktree release requires an initial window");
  }
  return {
    profile,
    source,
    productName,
    config: {
      productName,
      identifier: profile.identifier,
      build: { devUrl: null, beforeDevCommand: null },
      app: {
        ...baseConfig.app,
        windows: windows.map((window, index) => ({
          ...window,
          ...(index === 0 ? { title: source.windowTitle.replace("Dure Dev", "Dure Worktree") } : {}),
          dataDirectory: `dure-worktree-release-${source.hash}`,
        })),
      },
      bundle: { createUpdaterArtifacts: false },
    },
  };
}

function readPrivateEnvelope(pathname) {
  const descriptor = openSync(pathname, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.size > 17n * 1024n * 1024n ||
      (process.getuid && (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n))) {
      throw new Error("unsafe worktree presentation file");
    }
    const raw = readVerifiedDescriptorText(descriptor, stat);
    if (raw === null) throw new Error("worktree presentation changed while reading");
    return parseWorktreePresentationEnvelope(raw);
  } finally {
    closeSync(descriptor);
  }
}

/** The retained original envelope is a recovery copy, never an ongoing store mirror. */
export async function prepareWorktreePresentation({ home, profile, request = requestAppControl }) {
  const directory = appControlDirectory(home, profile.targetChannel);
  assertOwnerOnlyDirectory(directory, { create: true });
  const pathname = join(directory, WORKTREE_PRESENTATION_FILE);
  const consumedPath = `${pathname}.imported`;
  if (safeLstat(consumedPath) && safeLstat(pathname)) {
    throw new Error("worktree presentation archive conflicts with a pending import");
  }
  for (const candidate of [consumedPath, pathname]) {
    if (safeLstat(candidate)) {
      await readWorktreePresentationEnvelope(readPrivateEnvelope(candidate), profile);
      return { pathname: candidate, reused: true };
    }
  }
  const descriptor = loadAppControlDescriptor(appControlDirectory(home, profile.sourceChannel));
  if (!descriptor || descriptor.channel !== profile.sourceChannel) {
    throw new Error("worktree presentation source app is unavailable");
  }
  if (!descriptor.capabilities?.includes("worktree.presentation_export_v1")) {
    throw new Error("the source dev app must be updated to support presentation export");
  }
  const response = await request({
    descriptor,
    path: "/worktree/presentation/export",
    body: { sourceChannel: profile.sourceChannel },
    maxResponseBytes: 17 * 1024 * 1024,
  });
  if (response.schemaVersion !== 1 || response.sourceChannel !== profile.sourceChannel) {
    throw new Error("worktree presentation export identity mismatch");
  }
  const envelope = await createWorktreePresentationEnvelope(profile, response.serializedValue);
  try {
    writeExclusiveFile(pathname, `${JSON.stringify(envelope)}\n`);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await readWorktreePresentationEnvelope(readPrivateEnvelope(pathname), profile);
  }
  return { pathname, reused: false };
}

export function stageWorktreeReleaseBundle(sourceBundle, artifactRoot, productName) {
  const bundleDigest = artifactDigest(sourceBundle);
  mkdirSync(artifactRoot, { recursive: true });
  const version = join(artifactRoot, bundleDigest);
  const bundle = join(version, `${productName}.app`);
  if (safeLstat(version)) {
    if (artifactDigest(bundle) !== bundleDigest) throw new Error("existing worktree release artifact is corrupt");
    return { bundleDigest, bundle };
  }
  const temporary = mkdtempSync(join(artifactRoot, ".stage-"));
  try {
    const staged = join(temporary, `${productName}.app`);
    cpSync(sourceBundle, staged, { recursive: true, verbatimSymlinks: true });
    if (artifactDigest(staged) !== bundleDigest) throw new Error("worktree release bundle changed during staging");
    renameSync(temporary, version);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return { bundleDigest, bundle };
}

export function readWorktreeReleaseReceipt(pathname, profile, {
  artifactRoot, productName, cliRoot, readCliMetadata = parseMetadata,
}) {
  const receipt = JSON.parse(readFileSync(pathname, "utf8"));
  if (receipt.schemaVersion !== 1 || JSON.stringify(receipt.profile) !== JSON.stringify(profile) ||
    !/^[a-f0-9]{64}$/.test(receipt.bundleDigest) || !/^[a-f0-9]{64}$/.test(receipt.cliArtifactDigest) ||
    !/^[a-f0-9]{40}$/.test(receipt.sourceRevision)) {
    throw new Error("worktree release build receipt does not match this worktree");
  }
  const bundle = join(artifactRoot, receipt.bundleDigest, `${productName}.app`);
  if (artifactDigest(bundle) !== receipt.bundleDigest) throw new Error("worktree release bundle changed since the build");
  const metadata = readCliMetadata(realpathSync(join(cliRoot, "current")));
  if (metadata.bundle.artifactDigest !== receipt.cliArtifactDigest ||
    metadata.bundle.app.channel !== profile.targetChannel ||
    metadata.bundle.app.sourceRevision !== receipt.sourceRevision) {
    throw new Error("worktree release CLI no longer matches the built app");
  }
  return { ...receipt, executable: join(bundle, "Contents/MacOS/dure") };
}
