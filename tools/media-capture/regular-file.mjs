import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** Reads one regular file without following a symbolic-link target. */
export async function readRegularFileNoFollow(path) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("not a regular file");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("file changed while opening");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
