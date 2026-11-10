import { createHash } from "node:crypto";
import { parseVersion } from "./release-version.mjs";

export const BETA_METADATA_PATH = "beta/latest.json";
export const BETA_UPDATER_URL =
  `https://raw.githubusercontent.com/hebbianai/hebbian-releases/main/${BETA_METADATA_PATH}`;

/** Linux packages a release may carry, keyed by the updater's installer target
 * (`{os}-{arch}-{installer}`). File names are Tauri's own bundle names. A
 * release carries all of them or none, so no Linux install sees a partial set. */
export const LINUX_UPDATER_PACKAGES = Object.freeze([
  { platform: "linux-aarch64-appimage", arch: "aarch64", file: (version) => `Dure_${version}_aarch64.AppImage` },
  { platform: "linux-aarch64-deb", arch: "aarch64", file: (version) => `Dure_${version}_arm64.deb` },
  { platform: "linux-x86_64-appimage", arch: "x86_64", file: (version) => `Dure_${version}_amd64.AppImage` },
  { platform: "linux-x86_64-deb", arch: "x86_64", file: (version) => `Dure_${version}_amd64.deb` },
]);

const releaseUrl = (repository, version, file) =>
  `https://github.com/${repository}/releases/download/v${version}/${file}`;

const updaterEntry = (entry) =>
  Object.keys(entry ?? {}).sort().join() === "signature,url" &&
  typeof entry.signature === "string" && entry.signature.trim() !== "";

function manifest(bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  const version = parseVersion(value.version);
  const platform = value.platforms?.["darwin-aarch64"];
  const platforms = Object.keys(value.platforms ?? {});
  const linux = platforms.length > 1;
  const expected = ["darwin-aarch64", ...(linux ? LINUX_UPDATER_PACKAGES.map((entry) => entry.platform) : [])];
  if (
    value.channel !== "beta" ||
    Object.keys(value).sort().join() !== "channel,platforms,pub_date,version" ||
    typeof value.pub_date !== "string" || !Number.isFinite(Date.parse(value.pub_date)) ||
    !version.every(Number.isSafeInteger) ||
    platforms.join() !== expected.join() ||
    !updaterEntry(platform) ||
    !["hebbianai/hebbian-releases", "hebbianai/dure"].some(
      repository => platform.url === releaseUrl(repository, value.version, "Dure.app.tar.gz"),
    ) ||
    // Linux packages are only published from the public source repository.
    (linux && !LINUX_UPDATER_PACKAGES.every((entry) => {
      const linuxPlatform = value.platforms[entry.platform];
      return updaterEntry(linuxPlatform) &&
        linuxPlatform.url === releaseUrl("hebbianai/dure", value.version, entry.file(value.version));
    }))
  ) throw new Error("beta_manifest_invalid: require beta macOS ARM64, optionally every Linux package, and immutable archive URLs/signatures");
  return value;
}

/** Add every Linux package to a macOS-only manifest without changing any of
 * its existing bytes, so the same inputs always produce the same feed. */
export function withLinuxPlatforms(bytes, readSignature) {
  const value = manifest(bytes);
  if (Object.keys(value.platforms).length !== 1) {
    throw new Error("beta_manifest_linux_already_present");
  }
  for (const entry of LINUX_UPDATER_PACKAGES) {
    const file = entry.file(value.version);
    value.platforms[entry.platform] = {
      signature: readSignature(file).trim(),
      url: releaseUrl("hebbianai/dure", value.version, file),
    };
  }
  const merged = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  manifest(merged);
  return merged;
}

/** The public versioned bytes own the channel update. GitHub's prior blob SHA
 * fences the only mutable file; a conflict must be reobserved by the caller. */
export function planBetaMetadataUpdate({ tag, bytes, signature, previous }) {
  const next = manifest(bytes);
  if (`v${next.version}` !== tag || next.platforms["darwin-aarch64"].signature !== signature.trim()) {
    throw new Error("beta_manifest_binding_mismatch: version or updater signature differs");
  }
  let sha;
  if (previous) {
    if (previous.type !== "file" || previous.path !== BETA_METADATA_PATH || previous.encoding !== "base64" || !/^[0-9a-f]{40}$/.test(previous.sha)) {
      throw new Error("beta_metadata_file_invalid");
    }
    const priorBytes = Buffer.from(previous.content, "base64");
    const digest = createHash("sha1").update(`blob ${priorBytes.length}\0`).update(priorBytes).digest("hex");
    if (digest !== previous.sha) throw new Error("beta_metadata_blob_mismatch");
    const prior = manifest(priorBytes);
    const left = parseVersion(prior.version);
    const right = parseVersion(next.version);
    const different = left.findIndex((part, index) => part !== right[index]);
    if (different < 0) {
      if (!bytes.equals(priorBytes)) throw new Error("beta_metadata_same_version_mismatch");
      return null;
    }
    if (left[different] > right[different]) throw new Error("beta_metadata_downgrade_refused");
    sha = previous.sha;
  }
  return {
    message: `Update Dure beta metadata to ${tag}`,
    branch: "main",
    content: bytes.toString("base64"),
    ...(sha ? { sha } : {}),
  };
}
