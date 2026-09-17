import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { windowsPrivateStorage } from "./windows-private-storage.mjs";

export function fsyncDirectory(pathname) {
  // Node cannot flush directory handles on Windows; staged files are still fsynced.
  if (process.platform === "win32") return;
  const descriptor = openSync(pathname, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function stageFile(pathname, source, mode) {
  const temporary = join(
    dirname(pathname),
    `.${basename(pathname)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    if (process.platform === "win32" && mode === 0o600) {
      windowsPrivateStorage({
        operation: "createFile", pathname: temporary,
        sourceBase64: Buffer.from(source).toString("base64"),
      });
      return temporary;
    }
    const descriptor = openSync(temporary, "wx", mode);
    try {
      writeFileSync(descriptor, source);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return temporary;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeAtomicFile(pathname, source, { mode = 0o600 } = {}) {
  const temporary = stageFile(pathname, source, mode);
  try {
    renameSync(temporary, pathname);
    fsyncDirectory(dirname(pathname));
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeExclusiveFile(pathname, source, { mode = 0o600 } = {}) {
  const temporary = stageFile(pathname, source, mode);
  try {
    linkSync(temporary, pathname);
    fsyncDirectory(dirname(pathname));
  } finally {
    rmSync(temporary, { force: true });
  }
}
