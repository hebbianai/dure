import { createHash } from "node:crypto";
import { parseVersion } from "./release-version.mjs";

export const BETA_METADATA_PATH = "beta/latest.json";
export const BETA_UPDATER_URL =
  `https://raw.githubusercontent.com/hebbianai/hebbian-releases/main/${BETA_METADATA_PATH}`;

function manifest(bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  const version = parseVersion(value.version);
  const platform = value.platforms?.["darwin-aarch64"];
  if (
    value.channel !== "beta" ||
    Object.keys(value).sort().join() !== "channel,platforms,pub_date,version" ||
    typeof value.pub_date !== "string" || !Number.isFinite(Date.parse(value.pub_date)) ||
    !version.every(Number.isSafeInteger) ||
    Object.keys(value.platforms ?? {}).join() !== "darwin-aarch64" ||
    Object.keys(platform ?? {}).sort().join() !== "signature,url" ||
    platform?.url !== `https://github.com/hebbianai/hebbian-releases/releases/download/v${value.version}/Dure.app.tar.gz` ||
    typeof platform.signature !== "string" || !platform.signature.trim()
  ) throw new Error("beta_manifest_invalid: require beta macOS ARM64 and an immutable archive URL/signature");
  return value;
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
