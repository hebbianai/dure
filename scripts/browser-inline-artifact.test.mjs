import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { downloadBrowserArtifact } from "../cli/lib/browser-artifact.mjs";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function transfer(bytes, mimeType = "image/png", fault) {
  const calls = [];
  const artifact = { size: bytes.length, sha256: digest(bytes), mimeType, suggestedFilename: "../한글.bin" };
  return { artifact, calls, request: async (body) => {
    calls.push(body);
    assert.equal(body.kind, "artifact");
    let part = Buffer.from(bytes.subarray(body.offset, body.offset + 65536));
    const reply = { artifact: { ...artifact }, offset: body.offset, eof: body.offset + part.length === bytes.length, base64: part.toString("base64") };
    if (body.offset > 0) {
      if (fault === "disconnect") throw new Error("browser_response_lost");
      if (fault === "corrupt") { part[0] ^= 1; reply.base64 = part.toString("base64"); }
      if (fault === "offset") reply.offset = 0;
      if (fault === "manifest") reply.artifact.sha256 = "0".repeat(64);
      if (fault === "filename") reply.artifact.suggestedFilename = "changed.bin";
      if (fault === "type") reply.artifact.mimeType = "application/pdf";
      if (fault === "size") reply.artifact.size++;
      if (fault === "eof") reply.eof = !reply.eof;
      if (fault === "empty") reply.base64 = "";
      if (fault === "base64") reply.base64 = "????";
      if (fault === "chunk") reply.base64 = Buffer.alloc(65537).toString("base64");
    }
    if (fault === "limit") reply.artifact.size = 64 * 1024 * 1024 + 1;
    if (fault === "mime") reply.artifact.mimeType = "text/html";
    return reply;
  } };
}

test.each(["image/png", "image/jpeg", "application/pdf", "application/json", "application/octet-stream"])("inline %s artifacts preserve verified bytes without an output file", async (mimeType) => {
  for (const size of [0, 1, 65535, 65536, 65537, 180013]) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, index) => index % 256));
    const source = transfer(bytes, mimeType);
    const result = await downloadBrowserArtifact(source.request, "saved-once");
    assert.deepEqual(result.artifact, source.artifact);
    assert.equal(result.mimeType, mimeType);
    assert.deepEqual(Buffer.from(result.base64, "base64"), bytes);
    assert.equal(Object.hasOwn(result, "output"), false);
    assert.deepEqual(source.calls, Array.from({ length: Math.max(1, Math.ceil(size / 65536)) }, (_, index) => ({ kind: "artifact", operation_id: "saved-once", offset: index * 65536 })));
  }
});

test.each(["disconnect", "corrupt", "offset", "manifest", "filename", "type", "size", "eof", "empty", "base64", "chunk", "limit", "mime"])("inline transfer rejects %s and leaves its completed operation recoverable", async (fault) => {
  const bytes = Buffer.alloc(180013, 0x61);
  const source = transfer(bytes, "image/png", fault);
  await assert.rejects(downloadBrowserArtifact(source.request, "saved-once"), /browser_(artifact|response)/);
  assert.equal(new Set(source.calls.map((body) => body.offset)).size, source.calls.length);
  const recovered = transfer(bytes);
  const result = await downloadBrowserArtifact(recovered.request, "saved-once");
  assert.deepEqual(Buffer.from(result.base64, "base64"), bytes);
  assert.ok(recovered.calls.every((body) => body.kind === "artifact" && body.operation_id === "saved-once"));
});

const resource = { resource_id: "stop", generation: "generation:one", workspace_id: "workspace:one" };
const page = { resource, page_id: "page:one", document_revision: "7" };
const lease = { resource, controller_id: "agent", epoch: "4" };
const control = { resource, controller: lease, current_page: page, next_command_sequence: "8" };
const flags = ["--controller", "agent", "--epoch", "4"];

function client(bytes, mimeType, { transferFault, failOperation = false, responseLost = false, observed = control } = {}) {
  const source = transfer(bytes, mimeType, transferFault);
  const calls = [];
  return { calls, source, run: (args) => collectBrowserCommand({
    args: [...args, "--idempotency-key", "capture-once"], cwd: "/tasks/한글",
    resolveBackend: async () => ({ profile: { id: "inline", transport: { kind: "local" } } }),
    requestBackend: async (_, { body }) => {
      calls.push(body);
      if (body.kind === "artifact") return { result: await source.request(body) };
      if (body.kind === "list") return { result: { result: { workspace_id: resource.workspace_id, resources: [control] } } };
      if (body.kind === "observe") return { result: { result: { control: observed, pages: [{ page }] } } };
      if (body.kind === "control_state") return { result: { result: observed } };
      if (body.kind === "network_capture_state") return { result: { result: { page, recording: true } } };
      if (responseLost) throw new Error("browser_response_lost");
      return { result: { operation_id: "capture-once", result: { response: { success: !failOperation, data: { artifact: source.artifact } } } } };
    },
  }) };
}

const commands = [
  [["screenshot"], "image/png"], [["screenshot", "--format", "jpeg"], "image/jpeg"],
  [["full-screenshot"], "image/png"], [["pdf", ...flags], "application/pdf"],
  [["capture", "stop", ...flags], "application/json"],
];

test.each(commands)("%j returns the same saved bytes inline or in an explicit file", async (args, mimeType) => {
  const root = await mkdtemp(join(tmpdir(), "dure-inline-export-"));
  try {
    const bytes = Buffer.alloc(180013, 0x61);
    const inline = client(bytes, mimeType);
    const file = client(bytes, mimeType);
    const result = await inline.run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(Buffer.from(result.result.base64, "base64"), bytes);
    assert.equal(result.operation_id, "capture-once");
    assert.equal(result.result.mimeType, mimeType);
    assert.deepEqual(await readdir(root), []);
    const output = join(root, "capture.bin");
    const saved = await file.run([...args, "--output", output]);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(await readFile(output), bytes);
    assert.equal(saved.result.output, output);
    assert.equal(Object.hasOwn(saved.result, "base64"), false);
    assert.deepEqual(inline.calls, file.calls);
    assert.equal(inline.calls.filter((body) => ["action", "capture"].includes(body.kind)).length, 1);
    if (args[0] === "pdf") assert.equal(inline.calls.find((body) => body.kind === "action").action.kind, "print_pdf");
    if (args[0] === "capture") assert.deepEqual(inline.calls.find((body) => body.kind === "action").action, { kind: "network_capture", action: "stop" });
    assert.deepEqual(await readdir(root), ["capture.bin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inline artifact recovery only reads the completed operation, including arbitrary download bytes", async () => {
  const bytes = Buffer.from([0, 255, 128, 10, 13, 0]);
  const reader = client(bytes, "application/octet-stream");
  const result = await reader.run(["artifact", "earlier-operation"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.operation_id, "earlier-operation");
  assert.deepEqual(Buffer.from(result.result.base64, "base64"), bytes);
  assert.deepEqual(reader.calls, [{ kind: "artifact", operation_id: "earlier-operation", offset: 0 }]);
});

test.each(["start", "stop", "status"])("capture %s preserves explicit and legacy resource targets", async (action) => {
  const bytes = Buffer.from('{"log":{"version":"1.2","entries":[]}}');
  const explicit = client(bytes, "application/json");
  const expected = await explicit.run(["capture", action, "--resource", resource.resource_id, ...flags]);
  assert.equal(expected.ok, true, JSON.stringify(expected));
  for (const [args, scoped] of [
    [["capture", resource.resource_id, action, ...flags], false],
    [["capture", action, ...flags], true],
    [["capture", action, "--worktree", "current", ...flags], true],
  ]) {
    const current = client(bytes, "application/json");
    assert.deepEqual(await current.run(args), expected);
    if (scoped) assert.deepEqual(current.calls[0], { kind: "list", workspace_path: "/tasks/한글" });
    assert.deepEqual(current.calls.slice(scoped ? 1 : 0), explicit.calls);
  }
});

test("failed captures and transfers never return partial bytes or repeat input", async () => {
  for (const config of [{ failOperation: true }, { responseLost: true }, { transferFault: "disconnect" }, { transferFault: "corrupt" }]) {
    const c = client(Buffer.alloc(180013, 0x61), "application/pdf", config);
    const result = await c.run(["pdf", "--resource", resource.resource_id, ...flags]);
    assert.equal(result.ok, false);
    assert.equal(result.operation_id, "capture-once");
    assert.equal(result.result?.base64, undefined);
    assert.equal(c.calls.filter((body) => body.kind === "action").length, 1);
    if (config.failOperation || config.responseLost) assert.equal(c.source.calls.length, 0);
  }
  for (const args of [["pdf"], ["capture", "stop"]]) {
    const c = client(Buffer.from("pdf"), "application/pdf");
    assert.equal((await c.run(args)).ok, false);
    assert.equal(c.calls.some((body) => body.kind === "action" || body.kind === "control"), false);
  }
});

test("explicit empty output and missing download destination fail before backend selection", async () => {
  for (const args of [
    ["screenshot", "--output", ""], ["pdf", ...flags, "--output", ""],
    ["artifact", "saved", "--output", ""], ["capture", "stop", ...flags, "--output", ""],
    ["download", "--element", "a", ...flags],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args, resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(contacts, 0, JSON.stringify(args));
  }
});
