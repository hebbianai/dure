import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

const LIMIT = 64 * 1024;

/** Startup sources belong to this creation. Only client-selected bytes cross
 * the transport; a remote backend never interprets client filesystem paths. */
export async function browserLaunchScripts(command, files, { cwd, environment = process.env }) {
  if (command !== "create") {
    if (files !== undefined) throw new Error("browser_init_script_requires_create");
    return undefined;
  }
  const inherited = (environment.AGENT_BROWSER_INIT_SCRIPTS ?? "").split(/[,\n]/).map(file => file.trim()).filter(Boolean);
  const paths = [...inherited, ...(files ?? [])];
  if (!paths.length) return undefined;
  if (paths.length > 16 || paths.some(file => !file || file.includes("\0"))) throw new Error("browser_init_script_files_invalid");
  const sources = [];
  let total = 0;
  for (const filename of paths) {
    const file = await open(resolve(cwd ?? process.cwd(), filename), constants.O_RDONLY | constants.O_NONBLOCK)
      .catch(cause => { throw new Error("browser_init_script_file_unavailable", { cause }); });
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new Error("browser_init_script_file_unavailable");
      total += before.size;
      if (!Number.isSafeInteger(total) || total > LIMIT) throw new Error("browser_script_too_large");
      const bytes = Buffer.alloc(before.size + 1);
      let received = 0;
      while (received < bytes.length) {
        const part = await file.read(bytes, received, bytes.length - received, received);
        if (!part.bytesRead) break;
        received += part.bytesRead;
      }
      const after = await file.stat();
      if (received !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("browser_init_script_file_changed");
      try { sources.push(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, received))); }
      catch (cause) { throw new Error("browser_init_script_encoding_invalid", { cause }); }
    } finally { await file.close(); }
  }
  return sources;
}
