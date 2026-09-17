import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { appControlDirectory } from "./app-channel.mjs";
import {
  DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  MAX_FRAME_BYTES,
  exactDescriptor,
} from "./dev-launch-contract.mjs";
import { writeAtomicFile, writeExclusiveFile } from "./durable-file.mjs";
import { windowsPrivateStorage } from "./windows-private-storage.mjs";

export function safeLstat(pathname) {
  try {
    return lstatSync(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function isOwner(stat) {
  return !process.getuid || stat.uid === process.getuid();
}

export function assertOwnerOnlyDirectory(pathname, { create = false } = {}) {
  if (process.platform === "win32") {
    windowsPrivateStorage({ operation: "directory", pathname, create });
    return;
  }
  if (create) mkdirSync(pathname, { recursive: true, mode: 0o700 });
  const stat = safeLstat(pathname);
  if (
    !stat || stat.isSymbolicLink() || !stat.isDirectory() ||
    !isOwner(stat) || (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`dev launch supervisor directory is unsafe: ${pathname}`);
  }
}

function descriptorStat(pathname) {
  if (process.platform === "win32") {
    windowsPrivateStorage({
      operation: "inspect", pathname, directory: dirname(pathname),
    });
  } else {
    assertOwnerOnlyDirectory(dirname(pathname));
  }
  const stat = safeLstat(pathname);
  if (
    !stat || stat.isSymbolicLink() || !stat.isFile() ||
    (process.platform !== "win32" && (!isOwner(stat) || (stat.mode & 0o077) !== 0)) ||
    stat.size > MAX_FRAME_BYTES
  ) {
    throw new Error(`dev launch supervisor file is unsafe: ${pathname}`);
  }
  return stat;
}

export function descriptorPath(home, channel) {
  return join(
    appControlDirectory(home, channel), DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
}

export function readDescriptor({ home, channel, worktreeRoot }) {
  const pathname = descriptorPath(home, channel);
  const stat = descriptorStat(pathname);
  let source;
  let value;
  try {
    source = readFileSync(pathname, "utf8");
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid dev launch supervisor descriptor JSON: ${error.message}`);
  }
  return {
    pathname, source, stat,
    value: exactDescriptor(value, { channel, worktreeRoot }),
  };
}

export function writeDescriptor(pathname, value) {
  writeAtomicFile(pathname, `${JSON.stringify(value)}\n`);
}

export function createDescriptor(pathname, value) {
  writeExclusiveFile(pathname, `${JSON.stringify(value)}\n`);
}

export function openDevLaunchLog(home, channel) {
  const directory = appControlDirectory(home, channel);
  assertOwnerOnlyDirectory(directory, { create: true });
  const pathname = join(directory, "dev-launch.log");
  const windows = process.platform === "win32";
  if (windows) windowsPrivateStorage({ operation: "ensureFile", pathname });
  const descriptor = openSync(
    pathname,
    constants.O_WRONLY | constants.O_APPEND | (windows ? 0 : constants.O_CREAT) |
    (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || (!windows && ((stat.mode & 0o077) !== 0 || !isOwner(stat)))) {
    closeSync(descriptor);
    throw new Error(`dev launch log is unsafe: ${pathname}`);
  }
  return { descriptor, pathname };
}
