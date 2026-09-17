import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function sha256FileEvidence(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}
