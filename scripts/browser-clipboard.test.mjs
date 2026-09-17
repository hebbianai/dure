import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "clipboard-resource", generation: "resource-generation", workspace_id: "clipboard-workspace" };
const page = { resource, page_id: "clipboard-page", document_revision: "4" };
const lease = { resource, controller_id: "clipboard-agent", epoch: "8" };
const view = { control: { resource, controller: lease, next_command_sequence: "7" }, pages: [{ page }] };
const authority = ["--page", page.page_id, "--controller", lease.controller_id, "--epoch", lease.epoch];

function fixture({ observed = view, loseResponse = false, denied = false } = {}) {
  const calls = [];
  const shortcuts = [];
  const clipboard = {
    text: "original 한글\ntext",
    writes: [],
    reads: 0,
    async readText() {
      assert.equal(this, clipboard);
      this.reads++;
      if (denied) throw new Error("NotAllowedError: clipboard permission denied");
      return this.text;
    },
    async writeText(text) {
      assert.equal(this, clipboard);
      await Promise.resolve();
      if (denied) throw new Error("NotAllowedError: clipboard permission denied");
      this.writes.push(text);
      this.text = text;
    },
  };
  const run = (values, flags = authority) => collectBrowserCommand({
    args: ["clipboard", resource.resource_id, ...flags, "--idempotency-key", "clipboard-operation", ...values],
    resolveBackend: async () => ({ profile: { id: "clipboard-backend" } }),
    requestBackend: async (_profile, request) => {
      calls.push(request);
      if (request.body.kind === "observe") return { result: { result: observed } };
      assert.equal(request.body.kind, "action");
      let response;
      if (request.body.action.kind === "clipboard") {
        const operation = request.body.action.operation;
        assert.ok(["copy", "paste"].includes(operation));
        shortcuts.push(operation);
        response = { success: true, data: { [operation === "copy" ? "copied" : "pasted"]: true } };
      } else try {
        assert.equal(request.body.action.kind, "evaluate");
        const result = await runInNewContext(request.body.action.script, { navigator: { clipboard } });
        response = { success: true, data: { result: JSON.parse(JSON.stringify(result)) } };
      } catch (error) {
        response = { success: false, error: error.message };
      }
      if (loseResponse) throw new Error("browser_response_lost");
      return { result: { result: { response } } };
    },
  });
  return { run, clipboard, calls, shortcuts };
}

test.each(["copy", "paste"])("clipboard %s leaves platform selection to the execution host", async (operation) => {
  const { run, calls, clipboard, shortcuts } = fixture();
  const result = await run([operation]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.map((call) => call.body.kind), ["observe", "action"]);
  assert.deepEqual(calls[1].body.action, { kind: "clipboard", operation });
  assert.deepEqual(calls[1].body.authority, { lease, page, operation_id: "clipboard-operation", command_sequence: "7" });
  assert.deepEqual(shortcuts, [operation]);
  assert.equal(clipboard.reads, 0);
  assert.deepEqual(clipboard.writes, []);
});

test.each(["copy", "paste"])("lost clipboard %s response never repeats its shortcut", async (operation) => {
  const { run, calls, shortcuts } = fixture({ loseResponse: true });
  const result = await run([operation]);
  assert.equal(result.ok, false);
  assert.equal(result.operation_id, "clipboard-operation");
  assert.equal(result.error.code, "browser_response_lost");
  assert.deepEqual(shortcuts, [operation]);
  assert.equal(calls.length, 2);
});

test("clipboard read uses admitted page evaluation and retains the exact authority", async () => {
  const { run, clipboard, calls } = fixture();
  const result = await run(["read"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.response.data.result, { text: clipboard.text });
  assert.equal(clipboard.reads, 1);
  assert.deepEqual(calls.map((call) => call.body.kind), ["observe", "action"]);
  assert.deepEqual(calls[1].requiredCapabilities, ["browser.resource.v1"]);
  assert.deepEqual(calls[1].body.authority, { lease, page, operation_id: "clipboard-operation", command_sequence: "7" });
  assert.equal(calls[1].body.caller, lease.controller_id);
});

test("clipboard write awaits the API and preserves empty, Korean, escaped and literal option text", async () => {
  for (const text of ["", "한글\n🚀", "'\"\\\r\n\t\u0000", ");throw Error('injected');//", "--help", "a".repeat(8192), "한".repeat(2730) + "ab"]) {
    const { run, clipboard } = fixture();
    const result = await run(["write", "--", text]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(clipboard.writes, [text]);
    assert.deepEqual(result.result.response.data.result, { written: text });
  }
});

test("clipboard write accepts the pinned Orca text flag including an empty value", async () => {
  for (const text of ["", "옵션으로 전달", "--help"]) {
    const { run, clipboard } = fixture();
    const result = await run(["write", "--text", text]);
    assert.equal(result.ok, true);
    assert.deepEqual(clipboard.writes, [text]);
  }
});

test("malformed clipboard proposals cannot resolve or contact a backend", async () => {
  for (const values of [[], ["copy", "extra"], ["paste", "extra"], ["copy", "--text", "x"], ["paste", "--text", "x"], ["read", "extra"], ["read", "--text", "x"], ["write"], ["write", "one", "two"], ["write", "one", "--text", "two"], ["write", "x", "--output", "/tmp/unrequested"], ["read", "--timeout", "10"], ["write", "x".repeat(8193)], ["write", "한".repeat(2731)], ["write", "--text", "🚀".repeat(2049)]]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: ["clipboard", resource.resource_id, ...values], resolveBackend: async () => { contacts++; throw new Error("unexpected backend resolution"); } });
    assert.equal(result.ok, false);
    assert.equal(contacts, 0);
    assert.match(result.error.code, /^browser_clipboard_(invalid|text_too_large)$/);
  }
});

test("clipboard access requires the current controller and an observed page", async () => {
  for (const operation of [["read"], ["write", "replacement"], ["copy"], ["paste"]]) {
    for (const flags of [["--page", page.page_id], ["--page", page.page_id, "--controller", "someone-else", "--epoch", lease.epoch], ["--page", page.page_id, "--controller", lease.controller_id, "--epoch", "stale"]]) {
      const { run, clipboard, calls } = fixture();
      const result = await run(operation, flags);
      assert.equal(result.error.code, "browser_controller_changed");
      assert.equal(clipboard.reads, 0);
      assert.deepEqual(clipboard.writes, []);
      assert.deepEqual(calls.map((call) => call.body.kind), ["observe"]);
    }
    const { run, calls } = fixture({ observed: { ...view, pages: [] } });
    const result = await run(operation);
    assert.equal(result.error.code, "browser_page_required");
    assert.equal(calls.length, 1);
  }
});

test("clipboard permission failures remain failed actions with no fallback", async () => {
  for (const operation of [["read"], ["write", "replacement"]]) {
    const { run, clipboard, calls } = fixture({ denied: true });
    const result = await run(operation);
    assert.equal(result.ok, false);
    assert.match(result.result.response.error, /NotAllowedError/);
    assert.equal(clipboard.text, "original 한글\ntext");
    assert.deepEqual(clipboard.writes, []);
    assert.equal(calls.length, 2);
  }
});

test("lost clipboard response keeps the operation ID and does not repeat the write", async () => {
  const { run, clipboard, calls } = fixture({ loseResponse: true });
  const result = await run(["write", "replacement"]);
  assert.equal(result.ok, false);
  assert.equal(result.operation_id, "clipboard-operation");
  assert.equal(result.error.code, "browser_response_lost");
  assert.deepEqual(clipboard.writes, ["replacement"]);
  assert.equal(calls.length, 2);
});

test("explicit clipboard and geolocation permissions use the existing origin-scoped controller action", async () => {
  for (const permission of ["clipboard-read", "clipboard-write", "geolocation"]) {
    for (const setting of ["granted", "denied", "prompt"]) {
      const calls = [];
      const result = await collectBrowserCommand({
        args: ["permission", resource.resource_id, permission, setting, "https://example.com:443/", ...authority],
        resolveBackend: async () => ({ profile: { id: "clipboard-backend" } }),
        requestBackend: async (_profile, request) => {
          calls.push(request.body);
          return { result: { result: request.body.kind === "observe" ? view : { response: { success: true } } } };
        },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(calls.map((body) => body.kind), ["observe", "action"]);
      assert.deepEqual(calls[1].action, { kind: "environment", action: { kind: "permission", permission, setting, origin: "https://example.com" } });
      assert.deepEqual(calls[1].authority.lease, lease);
      assert.deepEqual(calls[1].authority.page, page);
    }
  }
});

test("clipboard permission rejects invalid names, settings and origins before backend contact", async () => {
  for (const values of [["clipboard", "granted", "https://example.com"], ["clipboard-read", "constructor", "https://example.com"], ["clipboard-read", "granted", "file:///tmp/page"], ["clipboard-write", "granted", "https://example.com/path"], ["clipboard-write", "granted", "https://user@example.com"], ["clipboard-write", "granted", "https://example.com/#fragment"]]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: ["permission", resource.resource_id, ...values], resolveBackend: async () => { contacts++; throw new Error("unexpected backend resolution"); } });
    assert.equal(result.ok, false);
    assert.match(result.error.code, /^browser_permission(_origin)?_invalid$/);
    assert.equal(contacts, 0);
  }
});
