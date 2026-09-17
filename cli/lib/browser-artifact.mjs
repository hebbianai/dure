import { createHash, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// The browser operation executes once. Only immutable file chunks are fetched here;
// failures leave an existing destination intact and the operation recoverable.
export async function downloadBrowserArtifact(request, operationId, output) {
  if (output !== undefined && (typeof output !== "string" || !output)) throw new Error("browser_output_required");
  const destination = output === undefined ? undefined : resolve(output);
  const temporary = destination === undefined ? undefined : join(dirname(destination), `.dure-browser-${randomUUID()}.tmp`);
  const file = temporary === undefined ? undefined : await open(temporary, "wx", 0o600);
  let inline;
  try {
    const hash = createHash("sha256");
    let offset = 0;
    let artifact;
    while (true) {
      const part = await request({ kind: "artifact", operation_id: operationId, offset });
      const manifest = part.artifact;
      if (!manifest || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size > 64 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(manifest.sha256) || !["image/png", "image/jpeg", "application/pdf", "application/octet-stream", "application/json", "video/mp4", "video/webm"].includes(manifest.mimeType)) throw new Error("browser_artifact_invalid");
      artifact ??= manifest;
      if (manifest.size !== artifact.size || manifest.sha256 !== artifact.sha256 || manifest.mimeType !== artifact.mimeType || manifest.suggestedFilename !== artifact.suggestedFilename || part.offset !== offset || typeof part.base64 !== "string" || part.base64.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.base64)) throw new Error("browser_artifact_invalid");
      const bytes = Buffer.from(part.base64, "base64");
      if ((!bytes.length && artifact.size !== 0) || bytes.length > 64 * 1024 || offset + bytes.length > artifact.size || part.eof !== (offset + bytes.length === artifact.size)) throw new Error("browser_artifact_invalid");
      if (file) await file.writeFile(bytes);
      else {
        inline ??= Buffer.alloc(artifact.size);
        bytes.copy(inline, offset);
      }
      hash.update(bytes);
      offset += bytes.length;
      if (part.eof) break;
    }
    if (hash.digest("hex") !== artifact.sha256) throw new Error("browser_artifact_digest_mismatch");
    if (!file) return { artifact, base64: inline.toString("base64"), mimeType: artifact.mimeType };
    await file.sync();
    await file.close();
    await rename(temporary, destination);
    return { artifact, output, mimeType: artifact.mimeType };
  } finally {
    if (file) await file.close().catch(() => {});
    if (temporary !== undefined) await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
