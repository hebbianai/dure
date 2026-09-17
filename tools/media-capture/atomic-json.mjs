import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureSafeOutputDirectory } from "./compositor/secure-output.mjs";

/** Writes one complete JSON document below an explicitly trusted root. */
export async function writeJsonAtomically(path, value, { allowedRoot }) {
  const encoded = JSON.stringify(value, null, 2);
  if (encoded === undefined) {
    throw new Error("JSON output must be serializable");
  }
  await ensureSafeOutputDirectory({
    allowedRoot,
    directory: dirname(path),
    label: "JSON output",
  });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.partial`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${encoded}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
