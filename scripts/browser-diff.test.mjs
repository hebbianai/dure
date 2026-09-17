import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "browser:diff", workspace_id: "workspace:diff", generation: "generation:diff" };
const page = { resource, page_id: "page:diff", document_revision: "3" };
const control = { resource, current_page: page };
function fixture(cwd = "/fixture", lost = false) {
  const calls = [];
  const bytes = [];
  return { calls, bytes: () => Buffer.concat(bytes), run: args => collectBrowserCommand({ args, cwd, sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "selected", transport: { kind: "ssh" } } }),
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control, pages: [{ page }] } } };
      assert(Buffer.byteLength(JSON.stringify(body)) < 256 * 1024, "request exceeds the existing backend wire bound");
      if (body.kind === "upload_chunk") {
        const part = Buffer.from(body.chunk.base64, "base64");
        assert.equal(body.chunk.offset, bytes.reduce((n, b) => n + b.length, 0));
        bytes.push(part);
        const received = bytes.reduce((n, b) => n + b.length, 0);
        const file = body.chunk.file;
        if (lost === "upload") throw new Error("browser_response_lost");
        return { result: { result: { id: "a".repeat(64), file, received, complete: received === file.size } } };
      }
      if (lost) throw new Error("browser_response_lost");
      return { result: { result: { snapshot: { page, snapshot_revision: "4" }, data: { snapshot: "새 제목", refs: {}, diff: { changed: true, additions: 1, removals: 0, unchanged: 0, diff: "+새 제목" } } } } };
    },
  }) };
}

test.each([
  [["diff", resource.resource_id, "snapshot"], { diff_baseline: "" }],
  [["diff", resource.resource_id, "snapshot", "--baseline", "이전 제목", "--compact", "--depth", "2", "--selector", "#main"], { diff_baseline: "이전 제목", compact: true, depth: 2, selector: "#main" }],
  [["exec", resource.resource_id, "--command", "diff snapshot -b '이전 제목' -s '#main' -c -d 2"], { diff_baseline: "이전 제목", compact: true, depth: 2, selector: "#main" }],
  [["exec", resource.resource_id, "--command", "diff snapshot --json"], { diff_baseline: "" }],
])("snapshot comparison %j reads the exact observed page without taking control", async (args, options) => {
  const f = fixture(); const result = await f.run(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.map(call => call.kind), ["observe", "upload_chunk", "snapshot"]);
  assert.deepEqual(f.calls[0], { kind: "observe", resource_id: resource.resource_id });
  assert.deepEqual(f.calls[2], { kind: "snapshot", page, options: { ...options, diff_baseline: "a".repeat(64) } });
  assert.equal(f.bytes().toString("utf8"), options.diff_baseline);
  assert.equal(f.calls[1].chunk.file.sha256, createHash("sha256").update(f.bytes()).digest("hex"));
  assert.equal(result.result.data.diff.changed, true);
});

test("baseline files are read from the caller cwd; only UTF-8 text crosses the remote boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-browser-diff-cli-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "baseline.txt"), "- heading 한글\n");
  const f = fixture(root); const result = await f.run(["diff", resource.resource_id, "snapshot", "--baseline", "baseline.txt"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.bytes().toString("utf8"), "- heading 한글\n");
  assert.equal(f.calls.at(-1).options.diff_baseline, "a".repeat(64));
  assert.equal(JSON.stringify(f.calls).includes(root), false);
});

test("non-file, invalid UTF-8 and oversized baselines stop before backend contact", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-browser-diff-invalid-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "invalid"), Buffer.from([0xff]));
  await writeFile(join(root, "large"), Buffer.alloc(1024 * 1024 + 1, 65));
  await mkdir(join(root, "directory"));
  for (const name of ["invalid", "large", "directory"]) {
    const f = fixture(root); assert.equal((await f.run(["diff", resource.resource_id, "snapshot", "--baseline", name])).ok, false); assert.deepEqual(f.calls, []);
  }
});

test("lost snapshot response never reissues the read or replaces its page", async () => {
  const f = fixture("/fixture", true); const result = await f.run(["diff", resource.resource_id, "snapshot"]);
  assert.equal(result.ok, false); assert.equal(f.calls.filter(c => c.kind === "snapshot").length, 1);
});

for (const depth of ["0", "2147483647", "2147483648", "4294967295", "+4294967295", "4294967296", "-1", "1.5"]) {
  for (const native of [false, true]) test(`snapshot diff depth ${depth}, native=${native}, retains the u32 boundary`, async () => {
    const f = fixture();
    const args = native ? ["exec", resource.resource_id, "--command", `diff snapshot -d ${depth}`]
      : ["diff", resource.resource_id, "snapshot", "--depth", depth];
    const result = await f.run(args);
    const valid = /^\+?[0-9]+$/.test(depth) && BigInt(depth) <= 4294967295n;
    assert.equal(result.ok, valid, JSON.stringify(result));
    if (valid) {
      assert.equal(f.calls.at(-1).options.depth, Number(depth));
      assert.deepEqual(f.calls.at(-1).page, page);
      assert.equal(f.calls.filter(call => call.kind === "snapshot").length, 1);
    } else assert.deepEqual(f.calls, []);
  });
}

test.each([
  ["diff", resource.resource_id, "snapshot", "extra"],
  ["diff", resource.resource_id, "snapshot", "--depth", "-1"],
  ["diff", resource.resource_id, "snapshot", "--output", "unused"],
  ["diff", resource.resource_id, "snapshot", "--interactive"],
  ["snapshot", resource.resource_id, "--baseline", "text"],
  ["exec", resource.resource_id, "--command", "diff snapshot --baseline"],
  ["exec", resource.resource_id, "--command", "diff snapshot --page foreign"],
].map(args => [args]))("invalid comparison %j stops before backend contact", async args => {
  const f = fixture(); assert.equal((await f.run(args)).ok, false); assert.deepEqual(f.calls, []);
});


test("large baselines use bounded verified chunks and a lost chunk cannot dispatch a snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-browser-diff-large-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const text = "한글 baseline\n".repeat(25000);
  await writeFile(join(root, "large.txt"), text);
  const f = fixture(root);
  assert.equal((await f.run(["diff", resource.resource_id, "snapshot", "--baseline", "large.txt"])).ok, true);
  assert.equal(f.bytes().toString("utf8"), text);
  assert.equal(f.calls.filter(call => call.kind === "upload_chunk").length, 7);
  const lost = fixture(root, "upload");
  assert.equal((await lost.run(["diff", resource.resource_id, "snapshot", "--baseline", "large.txt"])).ok, false);
  assert.equal(lost.calls.filter(call => call.kind === "upload_chunk").length, 1);
  assert.equal(lost.calls.some(call => call.kind === "snapshot"), false);
});
