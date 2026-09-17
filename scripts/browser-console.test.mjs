import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const page = { resource: { resource_id: "r", generation: "g", workspace_id: "w" }, page_id: "p", document_revision: "7" };
const lease = { resource: page.resource, controller_id: "agent", epoch: "9" };

test("invalid console limits and cursors fail before contacting a backend", async () => {
  for (const options of [["--limit", "0"], ["--limit", "-1"], ["--limit", "1.5"], ["--limit", "01"], ["--limit", "9007199254740992"], ["--before", "0"], ["--before", "01"], ["--before", "18446744073709551616"], ["clear", "--limit", "1"], ["unknown"], ["clear", "extra"]]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: ["console", "r", "--page", "p", ...options], resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(contacts, 0);
    assert.equal(result.ok, false);
    assert.ok(result.error.code.startsWith("browser_console_"));
  }
});

test("console pagination uses the existing query capability without renderer observation or control", async () => {
  const calls = [];
  const entries = [{ sequence: "9007199254740993", text: "한글" }];
  const result = await collectBrowserCommand({ args: ["console", "r", "--page", "p", "--limit", "1", "--before", "18446744073709551615"],
    resolveBackend: async () => ({ profile: { id: "test" } }),
    requestBackend: async (_profile, request) => {
      calls.push(request);
      assert.deepEqual(request.requiredCapabilities, ["browser.resource.v1", "browser.query.v1"]);
      if (request.body.kind === "control_state") return { result: { result: { resource: page.resource, controller: null } } };
      assert.equal(request.body.kind, "console");
      return { result: { result: { page, entries } } };
    } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.entries, entries);
  assert.deepEqual(calls.map((call) => call.body.kind), ["control_state", "console"]);
  assert.deepEqual(calls[1].body, { kind: "console", resource: page.resource, page_id: "p", query: { limit: 1, before: "18446744073709551615" } });
});

test("console clear journals one action with the observed page and controller sequence", async () => {
  const calls = [];
  const result = await collectBrowserCommand({ args: ["console", "r", "clear", "--page", "p", "--controller", "agent", "--epoch", "9", "--idempotency-key", "clear-once"],
    resolveBackend: async () => ({ profile: { id: "test" } }),
    requestBackend: async (_profile, request) => {
      calls.push(request.body);
      if (request.body.kind === "control_state") return { result: { result: { resource: page.resource, controller: lease, next_command_sequence: "11" } } };
      if (request.body.kind === "console") return { result: { result: { page, entries: [] } } };
      return { result: { result: { response: { success: true } } } };
    } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.kind), ["control_state", "console", "action"]);
  assert.deepEqual(calls[2], { kind: "action", caller: "agent", authority: { lease, page, operation_id: "clear-once", command_sequence: "11" }, action: { kind: "console_clear" } });
});

test("stale control and mismatched console pages never dispatch clear", async () => {
  for (const invalid of ["lease", "page"]) {
    const calls = [];
    const result = await collectBrowserCommand({ args: ["console", "r", "clear", "--page", "p", "--controller", "agent", "--epoch", "9"],
      resolveBackend: async () => ({ profile: { id: "test" } }),
      requestBackend: async (_profile, request) => {
        calls.push(request.body.kind);
        if (request.body.kind === "control_state") return { result: { result: { resource: page.resource, controller: invalid === "lease" ? { ...lease, epoch: "10" } : lease, next_command_sequence: "11" } } };
        return { result: { result: { page: invalid === "page" ? { ...page, page_id: "other" } : page, entries: [] } } };
      } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, invalid === "lease" ? "browser_controller_changed" : "browser_response_invalid");
    assert.equal(calls.includes("action"), false);
  }
});
