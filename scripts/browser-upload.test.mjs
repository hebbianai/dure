import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { stageBrowserUploads } from "../cli/lib/browser-upload.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("unavailable local files are reported before sending bytes to the backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-upload-missing-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  await assert.rejects(stageBrowserUploads(async () => { requests++; }, {}, [join(root, "missing.txt")]), /browser_upload_file_unavailable/);
  assert.equal(requests, 0);
});

test("client uploads resume after a lost chunk receipt and retain file names and empty files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-upload-client-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const paths = [join(root, "첨부 파일.txt"), join(root, "empty.txt")];
  await writeFile(paths[0], "한글 데이터".repeat(15_000));
  await writeFile(paths[1], "");
  const stored = new Map();
  let lose = true;
  const resource = { resource_id: "owned", generation: "one", workspace_id: "workspace" };
  const request = async (body) => {
    assert.deepEqual(body.resource, resource);
    const { file, offset, base64 } = body.chunk;
    const id = digest(JSON.stringify(file));
    const bytes = Buffer.from(base64, "base64");
    const previous = stored.get(id) ?? Buffer.alloc(0);
    if (offset < previous.length) assert.deepEqual(previous.subarray(offset, offset + bytes.length), bytes);
    else stored.set(id, Buffer.concat([previous, bytes]));
    const content = stored.get(id);
    if (lose) { lose = false; throw new Error("lost receipt after storing bytes"); }
    const complete = content.length === file.size;
    if (complete) assert.equal(digest(content), file.sha256);
    return { result: { id, file, received: content.length, complete } };
  };
  await assert.rejects(stageBrowserUploads(request, resource, paths), /lost receipt/);
  const ids = await stageBrowserUploads(request, resource, paths);
  assert.equal(ids.length, 2);
  for (const [index, path] of paths.entries()) assert.deepEqual(stored.get(ids[index]), await readFile(path));
});

test("a local file that grows during transfer is not attached as a truncated file", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-upload-change-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "growing.txt");
  await writeFile(path, "before");
  const request = async ({ chunk }) => {
    await writeFile(path, "before and appended data");
    return { result: { id: "a".repeat(64), file: chunk.file, received: chunk.file.size, complete: true } };
  };
  await assert.rejects(stageBrowserUploads(request, {}, [path]), /browser_upload_file_changed/);
});

test("changed manifests and impossible progress are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-upload-response-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "data.txt");
  await writeFile(path, "data");
  for (const fault of ["name", "offset", "complete"]) {
    const request = async ({ chunk }) => ({ result: { id: "b".repeat(64), file: { ...chunk.file, ...(fault === "name" ? { name: "different" } : {}) }, received: fault === "offset" ? 999 : chunk.file.size, complete: fault !== "complete" } });
    await assert.rejects(stageBrowserUploads(request, {}, [path]), /browser_upload_response_invalid/);
  }
  assert.equal(await readFile(path, "utf8"), "data");
});
