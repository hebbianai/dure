import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** The text bound of a CLI input source; a Host also refuses a larger paste. */
export const MAX_TEXT_INPUT_BYTES = 64 * 1024;

// Pipes can be nonblocking once Node initializes stdin. Wait for their data
// through the stream instead of treating a temporary EAGAIN as a read failure.
export async function readUtf8Stdin(maxBytes = MAX_TEXT_INPUT_BYTES, input = process.stdin) {
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Buffer.concat(chunks, length),
  );
}

// This bounds CLI buffering, not the runtime's independently enforced admission.
export function readUtf8Input(source, maxBytes = MAX_TEXT_INPUT_BYTES) {
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
