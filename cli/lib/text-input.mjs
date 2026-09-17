import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// This bounds CLI buffering, not the runtime's independently enforced admission.
export function readUtf8Input(source, maxBytes = 64 * 1024) {
  const ownsDescriptor = typeof source === "string";
  const descriptor = ownsDescriptor
    ? openSync(source, constants.O_RDONLY | constants.O_NONBLOCK)
    : source;
  try {
    if (ownsDescriptor && !fstatSync(descriptor).isFile()) {
      throw new Error("Input file must be a regular file");
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes`);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, length),
    );
  } finally {
    if (ownsDescriptor) closeSync(descriptor);
  }
}
