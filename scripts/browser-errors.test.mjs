import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "resource", generation: "generation", workspace_id: "workspace" };
const page = { resource, page_id: "page", document_revision: "7" };
const lease = { resource, controller_id: "agent", epoch: "9" };
const control = { resource, controller: lease, current_page: page, next_command_sequence: "11" };
const authority = ["--controller", "agent", "--epoch", "9", "--idempotency-key", "errors-once"];
const entries = [{ sequence: "9007199254740993", kind: "exception", level: "error", text: "한글 예외", source: "worker:1", timestamp: 1700000000000.25 }];

function fixture(fault) {
  const calls = [];
  const run = (args) => collectBrowserCommand({ args, sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "selected" } }),
    requestBackend: async (_profile, { body, requiredCapabilities }) => {
      calls.push(body);
      assert.deepEqual(requiredCapabilities, ["browser.resource.v1", "browser.query.v1"]);
      if (body.kind === "control_state") return { result: { result: fault === "lease" ? { ...control, controller: { ...lease, epoch: "10" } } : control } };
      if (body.kind === "console") {
        if (fault === "backend") return { result: { error: { code: "browser_console_unavailable" } } };
        const observed = fault === "page" ? { ...page, page_id: "other" }
          : fault === "document" ? { ...page, document_revision: "8" }
            : ["generation", "workspace_id"].includes(fault) ? { ...page, resource: { ...resource, [fault]: "other" } } : page;
        return { result: { result: { page: observed, entries, next_before: entries[0].sequence, truncated: true, history_truncated: false } } };
      }
      assert.equal(body.kind, "action");
      if (fault === "lost") throw new Error("browser_response_lost");
      return { result: { result: { response: { success: true, data: { cleared: true, removed: 1 } } } } };
    } });
  return { run, calls };
}

test("direct and native errors query exceptions through the existing console owner", async () => {
  for (const args of [["errors", "resource"], ["exec", "resource", "--command", "errors"]]) {
    const { run, calls } = fixture();
    const result = await run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result.entries, entries);
    assert.equal(result.result.next_before, entries[0].sequence);
    assert.equal(result.result.truncated, true);
    assert.deepEqual(calls, [{ kind: "control_state", resource_id: "resource" }, { kind: "console", resource, page_id: "page", query: { limit: 100, kind: "exception" } }]);
  }
});

test("error pagination preserves the lossless cursor and applies the kind at the Host query", async () => {
  const { run, calls } = fixture();
  const result = await run(["errors", "resource", "--page", "page", "--limit", "2", "--before", "18446744073709551615"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls[1].query, { limit: 2, before: "18446744073709551615", kind: "exception" });
  assert.equal(calls.some((call) => call.kind === "action" || call.kind === "observe"), false);
});

test("direct and native error clearing journal one selective action with exact authority", async () => {
  for (const args of [["errors", "resource", "clear"], ["exec", "resource", "--command", "errors --clear"]]) {
    const { run, calls } = fixture();
    const result = await run([...args, ...authority]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(calls[2], { kind: "action", caller: "agent", authority: { lease, page, operation_id: "errors-once", command_sequence: "11" }, action: { kind: "console_clear", entry_kind: "exception" } });
  }
});

test("console and errors reject explicit pages returned from another resource generation or workspace", async () => {
  for (const command of ["console", "errors"]) for (const fault of ["generation", "workspace_id", "page"]) {
    const { run, calls } = fixture(fault);
    const result = await run([command, "resource", "--page", "page"]);
    assert.equal(result.ok, false, JSON.stringify({ command, fault, result }));
    assert.equal(result.error.code, "browser_response_invalid");
    assert.equal(calls.length, 2);
  }
});

test("errors preserve backend failures and reject stale control/document without retrying a lost clear", async () => {
  for (const fault of ["backend", "lease", "document", "lost"]) {
    const { run, calls } = fixture(fault);
    const result = await run(["errors", "resource", "clear", ...authority]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, { backend: "browser_console_unavailable", lease: "browser_controller_changed", document: "browser_response_invalid", lost: "browser_response_lost" }[fault]);
    assert.equal(calls.filter((call) => call.kind === "action").length, fault === "lost" ? 1 : 0);
  }
});

test("malformed error operations never contact a backend", async () => {
  for (const args of [
    ["errors", "resource", "clear", "extra", ...authority], ["errors", "resource", "clear", "--limit", "1", ...authority],
    ["errors", "resource", "--limit", "0"], ["errors", "resource", "--before", "01"],
    ["exec", "resource", "--command", "errors --backend peer"], ["exec", "resource", "--command", "errors --clear --clear"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args, sourceEnvironment: {}, resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(contacts, 0);
  }
});
