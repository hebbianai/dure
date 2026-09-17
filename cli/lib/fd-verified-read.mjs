import { fstatSync, readSync } from "node:fs";

/**
 * Read the full contents of an already-open file descriptor and re-verify the
 * file's identity afterwards.
 *
 * TOCTOU contract: `before` must be the `fstatSync(descriptor, { bigint: true })`
 * snapshot the caller already validated (file type, size bounds, ownership)
 * on this exact descriptor — validation and read share one open descriptor,
 * so a path swap after the caller's checks cannot redirect the read. The read
 * is bounded by that snapshot: the buffer is one byte larger than
 * `before.size` so a concurrently grown file overshoots the expected byte
 * count instead of silently truncating. After the read, the descriptor is
 * fstat-ed again and `dev`/`ino`/`size`/`mtimeNs`/`ctimeNs` must all be
 * unchanged and the bytes read must equal `before.size`; otherwise the
 * content was mutated mid-read and is rejected.
 *
 * Returns the UTF-8 text on success, or `null` when the identity re-check
 * fails. Callers must treat `null` as a concurrent-change failure, never as
 * content. I/O errors from read/fstat propagate to the caller unchanged.
 */
export function readVerifiedDescriptorText(descriptor, before) {
  const buffer = Buffer.alloc(Number(before.size) + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (count === 0) break;
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (
    offset !== Number(before.size) ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  ) {
    return null;
  }
  return buffer.subarray(0, offset).toString("utf8");
}
