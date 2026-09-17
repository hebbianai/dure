import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const resource = { resource_id: "state-resource", generation: "generation", workspace_id: "workspace" };
const page = { resource, page_id: "page", document_revision: "3" };
const lease = { resource, controller_id: "state-proof", epoch: "4" };
const flags = ["--page", page.page_id, "--controller", lease.controller_id, "--epoch", lease.epoch, "--idempotency-key", "state-operation"];

function fixture({ controller = lease, loseResponse = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-state-load-")); roots.push(root);
  const bytes = Buffer.from(JSON.stringify({ cookies: [], origins: [{ origin: "https://example.test", localStorage: [{ name: "한글", value: "x".repeat(130000) }] }] }));
  writeFileSync(join(root, "state file.json"), bytes);
  const calls = []; const chunks = [];
  return { root, bytes, calls, chunks, run: (args) => collectBrowserCommand({ args: [...args, ...flags], cwd: root, sourceEnvironment: { DURE_HOME: join(root, "dure-home") },
    resolveBackend: async () => ({ profile: { id: "remote-state-backend" } }),
    requestBackend: async (_profile, { body, requiredCapabilities }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control: { resource, current_page: page, controller, next_command_sequence: "7" }, pages: [{ page }] } } };
      assert.ok(requiredCapabilities.includes("browser.files.v1"));
      if (body.kind === "upload_chunk") {
        assert.deepEqual(body.resource, resource);
        assert.equal(body.chunk.offset, Buffer.concat(chunks).length);
        chunks.push(Buffer.from(body.chunk.base64, "base64"));
        const received = Buffer.concat(chunks).length;
        return { result: { result: { id: "a".repeat(64), file: body.chunk.file, received, complete: received === body.chunk.file.size } } };
      }
      assert.equal(body.kind, "action");
      if (loseResponse) throw new Error("browser_response_lost");
      return { result: { result: { response: { success: true, data: { loaded: true } } } } };
    },
  }) };
}

test.each([
  ["state", resource.resource_id, "load", "state file.json"],
  ["state", "load", "state file.json", "--resource", resource.resource_id],
  ["exec", resource.resource_id, "--command", 'state load "state file.json"'],
])("state load stages complete local bytes before one admitted action: %j", async (...args) => {
  const f = fixture(); const result = await f.run(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Buffer.concat(f.chunks), f.bytes);
  const chunks = f.calls.filter((body) => body.kind === "upload_chunk");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].chunk.file.sha256, createHash("sha256").update(f.bytes).digest("hex"));
  assert.equal(JSON.stringify(f.calls).includes(f.root), false);
  const actions = f.calls.filter((body) => body.kind === "action");
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].action, { kind: "state_load", file: "a".repeat(64) });
  assert.deepEqual(actions[0].authority, { lease, page, operation_id: "state-operation", command_sequence: "7" });
});

test("state load refuses changed control before staging and preserves lost-response identity", async () => {
  const stale = fixture({ controller: { ...lease, epoch: "5" } });
  assert.equal((await stale.run(["state", resource.resource_id, "load", "state file.json"])).ok, false);
  assert.deepEqual(stale.calls.map((call) => call.kind), ["observe"]);
  const lost = fixture({ loseResponse: true });
  const result = await lost.run(["state", resource.resource_id, "load", "state file.json"]);
  assert.equal(result.ok, false); assert.equal(result.operation_id, "state-operation");
  assert.equal(result.error.code, "browser_response_lost");
  assert.equal(lost.calls.filter((body) => body.kind === "action").length, 1);
});

test.each(["list", "show", "clear", "clean", "rename"])("state load treats a management-command filename as a file: %s", async (filename) => {
  const f = fixture();
  writeFileSync(join(f.root, filename), f.bytes);
  const result = await f.run(["state", "load", filename, "--resource", resource.resource_id]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(Buffer.concat(f.chunks).equals(f.bytes), true, "complete file bytes were not staged");
  assert.equal(f.calls.find((body) => body.kind === "action").action.kind, "state_load");
});

test("state load never dispatches a missing/non-file input or ambiguous command", async () => {
  for (const values of [["load", "missing"], ["load", "."], ["load"], ["load", "state file.json", "extra"], ["load", "state file.json", "--url", "https://other.test"]]) {
    const f = fixture(); const result = await f.run(["state", resource.resource_id, ...values]);
    assert.equal(result.ok, false);
    assert.equal(f.calls.some((body) => body.kind === "action"), false);
  }
});

test.each([
  ["state", resource.resource_id, "save", "state file.json"],
  ["state", "save", "state file.json", "--resource", resource.resource_id],
  ["exec", resource.resource_id, "--command", 'state save "state file.json"'],
  ["state", resource.resource_id, "save", "--output", "state file.json"],
  ["state", "save", "--resource", resource.resource_id],
  ["exec", resource.resource_id, "--command", "state save"],
])("state save exports one admitted operation to a verified local file: %j", async (...args) => {
  const root = mkdtempSync(join(tmpdir(), "dure-state-save-")); roots.push(root);
  const bytes = Buffer.from(JSON.stringify({ cookies: [], origins: [{ origin: "https://example.test", localStorage: [{ name: "한글", value: "x".repeat(130000) }], sessionStorage: [] }] }));
  const artifact = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/json" };
  const calls = [];
  const environment = { DURE_HOME: join(root, "dure-home") };
  const result = await collectBrowserCommand({ args: [...args, ...flags], cwd: root, sourceEnvironment: environment,
    resolveBackend: async () => ({ profile: { id: "remote-state-backend" } }),
    requestBackend: async (_profile, { body, requiredCapabilities }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control: { resource, current_page: page, controller: lease, next_command_sequence: "7" }, pages: [{ page }] } } };
      assert.ok(requiredCapabilities.includes("browser.capture.v1"));
      if (body.kind === "action") {
        assert.deepEqual(body.action, { kind: "state_save" });
        assert.deepEqual(body.authority, { lease, page, operation_id: "state-operation", command_sequence: "7" });
        return { result: { result: { response: { success: true, data: { saved: true } }, artifact } } };
      }
      assert.equal(body.kind, "artifact");
      assert.equal(body.operation_id, "state-operation");
      const part = bytes.subarray(body.offset, body.offset + 64 * 1024);
      return { result: { artifact, offset: body.offset, base64: part.toString("base64"), eof: body.offset + part.length === bytes.length } };
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const filename = args.some((arg) => arg.includes("state file.json")) ? "state file.json" : join("dure-home", "browser", "states", `browser-${createHash("sha256").update(resource.resource_id).digest("hex")}.json`);
  assert.deepEqual(readFileSync(join(root, filename)), bytes);
  assert.equal(JSON.stringify(calls).includes(root), false);
  assert.equal(calls.filter((body) => body.kind === "action").length, 1);
  assert.equal(calls.filter((body) => body.kind === "artifact").length, 2);
  if (!args.some((arg) => arg.includes("state file.json"))) {
    const listed = await collectBrowserCommand({ args: ["state", "list"], sourceEnvironment: environment, cwd: root, resolveBackend: () => { throw Error("local list resolved backend"); } });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.result.files.length, 1);
    assert.equal(listed.result.files[0].path, join(root, filename));
  }
});

test("state save rejects ambiguous destinations before any dispatch", async () => {
  for (const values of [["save", "one", "two"], ["save", "one", "--output", "two"], ["save", "--output", ""], ["unsupported"]]) {
    const f = fixture();
    const result = await f.run(["state", resource.resource_id, ...values]);
    assert.equal(result.ok, false);
    assert.deepEqual(f.calls, []);
  }
});
