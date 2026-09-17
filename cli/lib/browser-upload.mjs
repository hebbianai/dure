import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";

const CHUNK = 64 * 1024;
const LIMIT = 64 * 1024 * 1024;

function unavailable(cause) {
  throw new Error("browser_upload_file_unavailable", { cause });
}

async function read(file, offset, length) {
  const bytes = Buffer.alloc(length);
  let received = 0;
  while (received < length) {
    const part = await file.read(bytes, received, length - received, offset + received).catch(unavailable);
    if (!part.bytesRead) throw new Error("browser_upload_file_changed");
    received += part.bytesRead;
  }
  return bytes;
}

async function stageBrowserFile(request, resource, manifest, chunk) {
  const { name, size } = manifest;
  let offset = 0;
  let id;
  while (true) {
    const bytes = await chunk(offset, Math.min(CHUNK, size - offset));
    const response = await request({ kind: "upload_chunk", resource, chunk: { file: manifest, offset, base64: bytes.toString("base64") } });
    const receipt = response?.result;
    if (!receipt || !/^[0-9a-f]{64}$/.test(receipt.id) || (id && id !== receipt.id) || receipt.file?.name !== name || receipt.file.size !== size || receipt.file.sha256 !== manifest.sha256 || !Number.isSafeInteger(receipt.received) || receipt.received < offset + bytes.length || receipt.received > size || receipt.complete !== (receipt.received === size)) throw new Error("browser_upload_response_invalid");
    id ??= receipt.id;
    if (receipt.complete) break;
    offset = receipt.received;
  }
  return id;
}

// Only client-selected bytes cross the backend transport. The server never
// interprets a client's local path as permission to read a server-side file.
export async function stageBrowserUploads(request, resource, filenames) {
  if (!filenames.length || filenames.length > 16) throw new Error("browser_upload_files_invalid");
  const files = [];
  try {
    let total = 0;
    for (const filename of filenames) {
      const path = resolve(filename);
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(unavailable);
      files.push({ file, name: basename(path) });
      const metadata = await file.stat().catch(unavailable);
      total += metadata.size;
      if (!metadata.isFile()) throw new Error("browser_upload_file_unavailable");
      if (!Number.isSafeInteger(metadata.size) || metadata.size > LIMIT || total > LIMIT) throw new Error("browser_upload_byte_limit");
      files.at(-1).size = metadata.size;
    }
    const ids = [];
    for (const { file, name, size } of files) {
      const hash = createHash("sha256");
      for (let offset = 0; offset < size; offset += CHUNK) hash.update(await read(file, offset, Math.min(CHUNK, size - offset)));
      const manifest = { name, size, sha256: hash.digest("hex") };
      const id = await stageBrowserFile(request, resource, manifest, (offset, length) => read(file, offset, length));
      if ((await file.stat().catch(unavailable)).size !== size) throw new Error("browser_upload_file_changed");
      ids.push(id);
    }
    return ids;
  } finally {
    await Promise.all(files.map(({ file }) => file.close().catch(unavailable)));
  }
}

// In-memory data uses the same chunk/digest protocol as caller-selected files.
export async function stageBrowserUploadBytes(request, resource, name, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) throw new Error("browser_upload_byte_limit");
  const manifest = { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return stageBrowserFile(request, resource, manifest, (offset, length) => bytes.subarray(offset, offset + length));
}
