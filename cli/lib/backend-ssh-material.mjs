import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import { BackendTransportError } from "./backend-transport.mjs";

const MAX_PATH_BYTES = 1024;
const MAX_MATERIAL_BYTES = 1024 * 1024;

function unavailable() {
  throw new BackendTransportError("backend_transport_reference_unavailable");
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function currentUserOwns(stat) {
  return (
    typeof process.getuid !== "function" ||
    stat.uid === BigInt(process.getuid())
  );
}

function assertOwnerOnlyRegular(stat, maximumBytes) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1n ||
    stat.size > BigInt(maximumBytes) ||
    (stat.mode & 0o077n) !== 0n ||
    !currentUserOwns(stat)
  )
    unavailable();
}

function closeDescriptor(descriptor) {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    unavailable();
  }
}

function openOwnerOnlyRegular(filePath, maximumBytes) {
  let descriptor;
  try {
    const pathStat = lstatSync(filePath, { bigint: true });
    assertOwnerOnlyRegular(pathStat, maximumBytes);
    if (
      !Number.isSafeInteger(fsConstants.O_NOFOLLOW) ||
      fsConstants.O_NOFOLLOW <= 0
    )
      unavailable();
    descriptor = openSync(
      filePath,
      fsConstants.O_RDONLY |
        (fsConstants.O_CLOEXEC ?? 0) |
        fsConstants.O_NOFOLLOW,
    );
    const snapshot = fstatSync(descriptor, { bigint: true });
    assertOwnerOnlyRegular(snapshot, maximumBytes);
    if (!sameSnapshot(pathStat, snapshot)) unavailable();
    return { descriptor, snapshot };
  } catch {
    closeDescriptor(descriptor);
    unavailable();
  }
}

function readOwnerOnlyRegular(filePath, maximumBytes, selected) {
  let opened;
  let buffer;
  try {
    opened = openOwnerOnlyRegular(filePath, maximumBytes);
    if (selected && !sameSnapshot(selected.snapshot, opened.snapshot))
      unavailable();
    buffer = Buffer.alloc(Number(opened.snapshot.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(
        opened.descriptor,
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(opened.descriptor, { bigint: true });
    const finalPath = lstatSync(filePath, { bigint: true });
    assertOwnerOnlyRegular(after, maximumBytes);
    assertOwnerOnlyRegular(finalPath, maximumBytes);
    if (
      offset !== Number(opened.snapshot.size) ||
      !sameSnapshot(opened.snapshot, after) ||
      !sameSnapshot(after, finalPath)
    )
      unavailable();
    const source = buffer.subarray(0, offset);
    const digest = createHash("sha256").update(source).digest("hex");
    if (selected && digest !== selected.digest) unavailable();
    return { source, snapshot: after, digest };
  } catch {
    buffer?.fill(0);
    unavailable();
  } finally {
    closeDescriptor(opened?.descriptor);
  }
}

export function readBackendSshCatalog(filePath, maximumBytes) {
  let read;
  try {
    try {
      lstatSync(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      unavailable();
    }
    read = readOwnerOnlyRegular(filePath, maximumBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(read.source);
  } catch {
    unavailable();
  } finally {
    read?.source.fill(0);
  }
}

export function selectBackendSshMaterial(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/.test(path)
  )
    unavailable();
  const { source, snapshot, digest } = readOwnerOnlyRegular(
    path,
    MAX_MATERIAL_BYTES,
  );
  source.fill(0);
  return Object.freeze({ path, snapshot, digest });
}

/** A connection owns its snapshots until its child has terminated. */
export function pinBackendSshMaterial(selected) {
  const sources = [];
  let root;
  let disposed = false;
  const dispose = () => {
    if (disposed || root === undefined) return;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      unavailable();
    }
    disposed = true;
  };
  try {
    for (const [name, material] of Object.entries(selected)) {
      const { source } = readOwnerOnlyRegular(
        material.path,
        MAX_MATERIAL_BYTES,
        material,
      );
      sources.push([name, source]);
    }
    // Like the Rust adapter, use a fixed parent so SSH option paths have no
    // environment-controlled whitespace or option expansion characters.
    root = mkdtempSync("/tmp/dure-ssh-material-");
    chmodSync(root, 0o700);
    const metadata = lstatSync(root, { bigint: true });
    if (
      !metadata.isDirectory() ||
      !currentUserOwns(metadata) ||
      (metadata.mode & 0o777n) !== 0o700n
    )
      unavailable();
    const paths = {};
    for (const [name, source] of sources) {
      const path = join(root, name);
      writeFileSync(path, source, { mode: 0o600, flag: "wx" });
      chmodSync(path, 0o600);
      paths[name] = path;
    }
    return Object.freeze({ ...paths, dispose });
  } catch {
    dispose();
    unavailable();
  } finally {
    for (const [, source] of sources) source.fill(0);
  }
}
