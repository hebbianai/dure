import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

// The pinned portable format hashes UTF-8 key text once before AES-256-GCM.
// Only that derived key accompanies the admitted backend action; the password
// never enters its operation fingerprint, upload manifest or result.
export function browserStateEncryptionKey(environment) {
  const current = environment.DURE_BROWSER_ENCRYPTION_KEY;
  const upstream = environment.AGENT_BROWSER_ENCRYPTION_KEY;
  if (current !== undefined && upstream !== undefined && current !== upstream) throw new Error("browser_state_key_conflict");
  const value = current ?? upstream;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.length) throw new Error("browser_state_key_invalid");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function browserStateInput(filename, encryptionKey) {
  let path = filename;
  if (!path.endsWith(".enc") && encryptionKey !== undefined) {
    try { await stat(path); }
    catch (error) {
      if (error.code !== "ENOENT") throw new Error("browser_upload_file_unavailable", { cause: error });
      path += ".enc";
    }
  }
  if (!path.endsWith(".enc")) return { path };
  if (encryptionKey === undefined) throw new Error("browser_state_key_required");
  return { path, encryption_key: encryptionKey };
}
