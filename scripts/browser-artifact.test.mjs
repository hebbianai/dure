import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { downloadBrowserArtifact } from "../cli/lib/browser-artifact.mjs";

test("page downloads preserve arbitrary binary bytes and empty files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dure-browser-page-download-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  for (const bytes of [Buffer.alloc(0), Buffer.from(Array.from({ length: 180_013 }, (_, i) => i % 256))]) {
    const destination = join(directory, `file-${bytes.length}.bin`);
    const artifact = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/octet-stream", suggestedFilename: "../사이트 파일.bin" };
    const request = async ({ offset }) => {
      const part = bytes.subarray(offset, offset + 64 * 1024);
      return { artifact, offset, base64: part.toString("base64"), eof: offset + part.length === bytes.length };
    };
    const result = await downloadBrowserArtifact(request, "page-download", destination);
    assert.deepEqual(result.artifact, artifact);
    assert.deepEqual(await readFile(destination), bytes);
  }
  assert.deepEqual((await readdir(directory)).sort(), ["file-0.bin", "file-180013.bin"]);
});

test.each(["disconnect", "corrupt", "offset", "manifest", "none"])("artifact transfer publishes complete verified bytes and preserves destinations on failure: %s", async (fault) => {
  const directory = await mkdtemp(join(tmpdir(), "dure-browser-download-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, "capture.png");
  const bytes = Buffer.alloc(200_003, 0x61);
  const artifact = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png" };
  await writeFile(destination, "existing capture");
  const requests = [];
  const request = async (body) => {
    requests.push(body);
    assert.equal(body.kind, "artifact");
    assert.equal(body.operation_id, "completed-operation");
    const offset = body.offset;
    if (fault === "disconnect" && offset > 0) throw new Error("connection lost");
    const data = Buffer.from(bytes.subarray(offset, offset + 64 * 1024));
    if (fault === "corrupt" && offset > 0) data[0] ^= 1;
    return { artifact: { ...artifact, ...(fault === "manifest" && offset > 0 ? { sha256: "0".repeat(64) } : {}) }, offset: fault === "offset" && offset > 0 ? 0 : offset, base64: data.toString("base64"), eof: offset + data.length === bytes.length };
  };
  const operation = downloadBrowserArtifact(request, "completed-operation", destination);
  if (fault === "none") {
    assert.deepEqual((await operation).artifact, artifact);
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(requests.map((body) => body.offset), [0, 65536, 131072, 196608]);
  } else {
    await assert.rejects(operation);
    assert.equal(await readFile(destination, "utf8"), "existing capture");
  }
  assert.deepEqual(await readdir(directory), ["capture.png"]);
});
