import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  LINUX_UPDATER_PACKAGES,
  planBetaMetadataUpdate,
  withLinuxPlatforms,
} from "./beta-release-metadata.mjs";
import {
  RELEASE_CANDIDATE_FILES,
  RELEASE_CARGO_WORKSPACES,
  replaceReleaseCargoLock,
} from "./release-candidate.mjs";
import { normalizeFullCommitSha } from "./release-gate.mjs";
import {
  VERSION_FILES,
  bump,
  parseVersion,
  readVersionText,
  replaceVersion,
} from "./release-version.mjs";

export const RELEASE_REPOSITORY = "hebbianai/dure";
export const COMPATIBILITY_REPOSITORY = "hebbianai/hebbian-releases";

export function releaseVersion(tag) {
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) ||
    tag.trim() !== tag
  )
    throw new Error("release_tag_invalid");
  const version = tag.slice(1);
  const parts = parseVersion(version);
  if (!parts.every(Number.isSafeInteger))
    throw new Error("release_version_invalid");
  // Earlier desktop versions already belong to the pre-transition publisher.
  if (parts[0] === 0 && (parts[1] < 2 || (parts[1] === 2 && parts[2] < 29))) {
    throw new Error(
      "release_version_reserved: reconcile the reviewed version inventory before releasing v0.2.29 or later",
    );
  }
  return version;
}

export function releaseAdmission({
  repository,
  event,
  ref,
  source,
  head,
  current,
  bumpKind,
  verification,
}) {
  if (
    repository !== RELEASE_REPOSITORY ||
    event !== "workflow_dispatch" ||
    ref !== "refs/heads/main"
  ) {
    throw new Error("release_requires_canonical_main_dispatch");
  }
  const sourceSha = normalizeFullCommitSha(source);
  const workflowSha = normalizeFullCommitSha(head);
  const version = bump(current, bumpKind);
  const tag = `v${version}`;
  releaseVersion(tag);
  if (
    !["full", "emergency-0.2"].includes(verification) ||
    (verification === "emergency-0.2" && !/^0\.2\.\d+$/.test(version))
  ) {
    throw new Error("release_verification_scope_invalid");
  }
  return {
    sourceSha, workflowSha, current, version, tag, verification, channel: "beta",
  };
}

/** The privileged version writer reconstructs every allowed byte from its own source. */
export function expectedVersionFiles(read, current, next) {
  const files = new Map();
  for (const file of VERSION_FILES) {
    const original = read(file.path);
    if (readVersionText(file, original) !== current)
      throw new Error("release_source_inventory_mismatch");
    files.set(file.path, replaceVersion(file, original, next));
  }
  for (const workspace of RELEASE_CARGO_WORKSPACES) {
    files.set(
      workspace.lockPath,
      replaceReleaseCargoLock(
        read(workspace.lockPath),
        workspace,
        current,
        next,
      ),
    );
  }
  assert.deepEqual([...files.keys()], RELEASE_CANDIDATE_FILES);
  return files;
}

const MACOS_ARCHIVE = "Dure.app.tar.gz";

/** The macOS app's four files; `linux` adds every Linux package and its
 * updater signature. latest.json always describes exactly the files present. */
export function releaseAssetNames(tag, { linux = false } = {}) {
  return [
    ...macosReleaseAssetNames(tag),
    ...(linux ? linuxReleaseAssetNames(tag) : []),
  ].sort();
}

function macosReleaseAssetNames(tag) {
  return [
    `Dure_${releaseVersion(tag)}_aarch64.dmg`,
    MACOS_ARCHIVE,
    `${MACOS_ARCHIVE}.sig`,
    "latest.json",
  ].sort();
}

export function linuxReleaseAssetNames(tag) {
  const version = releaseVersion(tag);
  return LINUX_UPDATER_PACKAGES.flatMap((entry) => [
    entry.file(version),
    `${entry.file(version)}.sig`,
  ]).sort();
}

function hashFile(file, algorithm = "sha256") {
  const hash = createHash(algorithm);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile())
      throw new Error("release_asset_not_regular");
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Verify Tauri's base64-wrapped, prehashed minisign archive and trusted comment. */
export function verifyUpdaterSignature(file, encodedKey, encodedSignature) {
  const keyLines = Buffer.from(encodedKey, "base64")
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  const lines = Buffer.from(encodedSignature, "base64")
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  const key = Buffer.from(keyLines[1] ?? "", "base64");
  const signature = Buffer.from(lines[1] ?? "", "base64");
  const commentSignature = Buffer.from(lines[3] ?? "", "base64");
  if (
    keyLines.length !== 2 ||
    lines.length !== 4 ||
    key.length !== 42 ||
    signature.length !== 74 ||
    commentSignature.length !== 64 ||
    !["Ed", "ED"].includes(key.subarray(0, 2).toString()) ||
    signature.subarray(0, 2).toString() !== "ED" ||
    !key.subarray(2, 10).equals(signature.subarray(2, 10)) ||
    !lines[2].startsWith("trusted comment: ")
  )
    throw new Error("release_signature_format_invalid");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  const signed = signature.subarray(10);
  if (
    !verify(
      null,
      Buffer.from(hashFile(file, "blake2b512"), "hex"),
      publicKey,
      signed,
    ) ||
    !verify(
      null,
      Buffer.concat([signed, Buffer.from(lines[2].slice(17))]),
      publicKey,
      commentSignature,
    )
  ) {
    throw new Error("release_updater_signature_invalid");
  }
}

export function inspectReleaseFiles(directory, tag, publicKey) {
  const present = fs.readdirSync(directory).sort();
  const linux = present.length !== macosReleaseAssetNames(tag).length;
  const names = releaseAssetNames(tag, { linux });
  assert.deepEqual(present, names, "release_asset_set_required");
  const assets = names.map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size <= 0)
      throw new Error("release_asset_not_regular");
    return { name, size: stat.size, digest: `sha256:${hashFile(file)}` };
  });
  const bytes = fs.readFileSync(path.join(directory, "latest.json"));
  const read = (name) => fs.readFileSync(path.join(directory, name), "utf8").trim();
  const signature = read(`${MACOS_ARCHIVE}.sig`);
  planBetaMetadataUpdate({ tag, bytes, signature, previous: null });
  const manifest = JSON.parse(bytes);
  if (
    manifest.platforms["darwin-aarch64"].url !==
    `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${MACOS_ARCHIVE}`
  ) {
    throw new Error("release_manifest_source_repository_mismatch");
  }
  if ((Object.keys(manifest.platforms).length > 1) !== linux)
    throw new Error("release_manifest_platform_set_mismatch");
  verifyUpdaterSignature(
    path.join(directory, MACOS_ARCHIVE),
    publicKey,
    signature,
  );
  if (linux) {
    const version = releaseVersion(tag);
    for (const entry of LINUX_UPDATER_PACKAGES) {
      const file = entry.file(version);
      const packageSignature = read(`${file}.sig`);
      if (manifest.platforms[entry.platform].signature !== packageSignature)
        throw new Error(`release_manifest_linux_binding_mismatch: ${entry.platform}`);
      verifyUpdaterSignature(path.join(directory, file), publicKey, packageSignature);
    }
  }
  return { assets, bytes, signature, linux };
}

/** One release directory from the macOS build's four files and the signed
 * Linux packages. The macOS manifest gains the Linux entries deterministically,
 * so staging and later verification derive identical latest.json bytes. */
export function assembleReleaseFiles({ tag, macos, linux, output }) {
  const macosNames = macosReleaseAssetNames(tag);
  const linuxNames = linuxReleaseAssetNames(tag);
  assert.deepEqual(fs.readdirSync(macos).sort(), macosNames, "release_macos_assets_required");
  assert.deepEqual(fs.readdirSync(linux).sort(), linuxNames, "release_linux_assets_required");
  fs.mkdirSync(output);
  const copy = (from, name) => {
    const source = path.join(from, name);
    if (!fs.lstatSync(source).isFile()) throw new Error("release_asset_not_regular");
    fs.copyFileSync(source, path.join(output, name), fs.constants.COPYFILE_EXCL);
  };
  for (const name of macosNames.filter((name) => name !== "latest.json")) copy(macos, name);
  for (const name of linuxNames) copy(linux, name);
  fs.writeFileSync(
    path.join(output, "latest.json"),
    withLinuxPlatforms(fs.readFileSync(path.join(macos, "latest.json")), (file) =>
      fs.readFileSync(path.join(linux, `${file}.sig`), "utf8")),
    { flag: "wx" },
  );
  return output;
}

/** Missing-only reconciliation: neither a draft nor a retry permits replacement. */
export function missingReleaseAssets(
  expected,
  remote,
  { complete = false } = {},
) {
  if (
    !Array.isArray(remote) ||
    new Set(remote.map((asset) => asset.name)).size !== remote.length
  )
    throw new Error("release_asset_inventory_invalid");
  for (const actual of remote) {
    const wanted = expected.find((asset) => asset.name === actual.name);
    if (
      !wanted ||
      actual.state !== "uploaded" ||
      wanted.size !== actual.size ||
      wanted.digest !== actual.digest
    ) {
      throw new Error(`release_asset_mismatch: ${actual.name}`);
    }
  }
  const missing = expected.filter(
    (asset) => !remote.some((actual) => actual.name === asset.name),
  );
  if (complete && missing.length) throw new Error("release_assets_incomplete");
  return missing;
}
