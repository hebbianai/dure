import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { encodeRef } from "../cli/lib/browser-reference.mjs";

const resource = { resource_id: "current-resource", generation: "generation", workspace_id: "workspace" };
const first = { resource, page_id: "first", document_revision: "3" };
const current = { resource, page_id: "current", document_revision: "7" };
const lease = { resource, controller_id: "agent", epoch: "8" };
const control = { resource, controller: lease, next_command_sequence: "12", current_page: current };
const pages = [first, current].map((page, index) => ({ page, title: page.page_id, url: "about:blank", profile_id: `profile:${index}` }));
const authority = ["--controller", lease.controller_id, "--epoch", lease.epoch];

function fixture({ observed = control, replyPage = current, loseResponse = false } = {}) {
  const calls = [];
  const run = (args) => collectBrowserCommand({
    args: [...args, "--idempotency-key", "current-operation"],
    resolveBackend: async () => ({ profile: { id: "backend" } }),
    requestBackend: async (_profile, request) => {
      calls.push(request.body);
      let result;
      switch (request.body.kind) {
        case "observe": result = { control: observed, pages }; break;
        case "control_state": result = observed; break;
        case "console": result = { page: replyPage, entries: [] }; break;
        case "interception_state": case "network_capture_state": result = { page: replyPage }; break;
        case "dialog_state": result = { page: replyPage, control: observed, dialog: { identity: { page: replyPage, revision: "20" } } }; break;
        default:
          if (loseResponse) throw new Error("browser_response_lost");
          result = { response: { success: true } };
      }
      return { result: { result } };
    },
  });
  return { run, calls };
}

test("omitted page targets Host's non-first profile page for reads and admitted input", async () => {
  for (const args of [["get", resource.resource_id, "title"], ["fill", resource.resource_id, "#value", "선택한 탭", ...authority]]) {
    const { run, calls } = fixture();
    const result = await run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].kind, "observe");
    if (calls[1].kind === "query") assert.deepEqual(calls[1].page, current);
    else {
      assert.equal(calls[1].kind, "action");
      assert.deepEqual(calls[1].authority, { lease, page: current, operation_id: "current-operation", command_sequence: "12" });
      assert.equal(calls[1].action.text, "선택한 탭");
    }
  }
});

test("absent or malformed current identity never falls back to the first available tab", async () => {
  for (const page of [undefined, null, { ...current, page_id: "gone" }, { ...current, document_revision: "8" }, { ...current, document_revision: "07" }, { ...current, document_revision: "18446744073709551616" }, ...["resource_id", "generation", "workspace_id"].map((key) => ({ ...current, resource: { ...resource, [key]: "other" } }))]) {
    const { run, calls } = fixture({ observed: { ...control, current_page: page } });
    const result = await run(["fill", resource.resource_id, "#value", "text", ...authority]);
    assert.equal(result.error.code, page == null ? "browser_page_required" : "browser_response_invalid", JSON.stringify(result));
    assert.deepEqual(calls.map((call) => call.kind), ["observe"]);
  }
});

test("explicit pages and encoded references retain their targets regardless of the current page", async () => {
  const reference = encodeRef({ page: first, revision: "17" }, "e1");
  for (const args of [["fill", resource.resource_id, "#value", "text", "--page", first.page_id], ["fill", resource.resource_id, reference, "text"]]) {
    const { run, calls } = fixture({ observed: { ...control, current_page: null } });
    assert.equal((await run([...args, ...authority])).ok, true);
    assert.deepEqual(calls[1].authority.page, first);
  }
  for (const page of ["gone", ""]) {
    const { run, calls } = fixture();
    assert.equal((await run(["fill", resource.resource_id, "#value", "text", "--page", page, ...authority])).error.code, "browser_page_required");
    assert.equal(calls.length, 1);
  }
  const { run, calls } = fixture();
  assert.equal((await run(["fill", resource.resource_id, reference, "text", "--page", current.page_id, ...authority])).error.code, "browser_reference_page_mismatch");
  assert.equal(calls.length, 1);
});

test("default input rejects a stale controller and never retries a lost action response", async () => {
  const stale = fixture({ observed: { ...control, controller: { ...lease, epoch: "9" } } });
  assert.equal((await stale.run(["fill", resource.resource_id, "#value", "text", ...authority])).error.code, "browser_controller_changed");
  assert.equal(stale.calls.length, 1);
  const lost = fixture({ loseResponse: true });
  const result = await lost.run(["fill", resource.resource_id, "#value", "text", ...authority]);
  assert.equal(result.error.code, "browser_response_lost");
  assert.equal(result.operation_id, "current-operation");
  assert.deepEqual(lost.calls.map((call) => call.kind), ["observe", "action"]);
});

test("tab list and current expose one Host target across two profiles; show remains an observation", async () => {
  const { run, calls } = fixture();
  const listed = await run(["tab", "list", resource.resource_id]);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.result.tabs.map((row) => [row.page.page_id, row.active]), [[first.page_id, false], [current.page_id, true]]);
  const selected = await run(["tab", "current", resource.resource_id]);
  assert.deepEqual(selected.result.tab.page, current);
  const shown = await run(["tab", "show", resource.resource_id, "--page", first.page_id]);
  assert.deepEqual(shown.result.tab.page, first);
  assert.equal(shown.result.tab.active, false);
  assert.deepEqual(calls.map((call) => call.kind), ["observe", "observe", "observe"]);
});

test("tab listing permits no current target while current lookup fails closed", async () => {
  const { run } = fixture({ observed: { ...control, current_page: null } });
  assert.equal((await run(["tab", "list", resource.resource_id])).result.tabs.some((row) => row.active), false);
  assert.equal((await run(["tab", "current", resource.resource_id])).error.code, "browser_page_required");
});

test("grouped tab creation and closing use the selected authority and switching accepts an exact index", async () => {
  for (const [args, page, action] of [
    [["tab", "create", resource.resource_id], current, { kind: "new_page", url: "about:blank" }],
    [["tab", "create", resource.resource_id, "--url", "https://example.test"], current, { kind: "new_page", url: "https://example.test" }],
    [["tab", "create", resource.resource_id, "https://example.test/path"], current, { kind: "new_page", url: "https://example.test/path" }],
    [["tab", "close", resource.resource_id], current, { kind: "close_page" }],
    [["tab", "switch", resource.resource_id, "--index", "0"], first, { kind: "select_page" }],
    [["tab", "switch", resource.resource_id, "--page", first.page_id], first, { kind: "select_page" }],
  ]) {
    const { run, calls } = fixture();
    const result = await run([...args, ...authority]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(calls[1].authority.page, page);
    assert.deepEqual(calls[1].action, action);
  }
});

test("ambiguous or missing tab selection never dispatches a mutation", async () => {
  for (const [flags, error, observed] of [
    [[], "browser_page_required", false],
    [["--index", "00"], "browser_tab_index_invalid", false],
    [["--index", "-1"], "browser_tab_index_invalid", false],
    [["--index", "128"], "browser_tab_index_invalid", false],
    [["--index", "2"], "browser_tab_index_invalid", true],
    [["--index", "0", "--page", current.page_id], "browser_tab_target_mismatch", true],
  ]) {
    const { run, calls } = fixture();
    assert.equal((await run(["tab", "switch", resource.resource_id, ...flags, ...authority])).error.code, error);
    assert.deepEqual(calls.map((call) => call.kind), observed ? ["observe"] : []);
  }
});

test("default console, capture and interception resolve the exact page without ordinary observation", async () => {
  for (const [args, stateKind, mutates] of [
    [["console", resource.resource_id], "console", false],
    [["console", resource.resource_id, "clear", ...authority], "console", true],
    [["capture", resource.resource_id, "status"], "network_capture_state", false],
    [["capture", resource.resource_id, "start", ...authority], "network_capture_state", true],
    [["intercept", resource.resource_id, "list"], "interception_state", false],
    [["intercept", resource.resource_id, "enable", ...authority], "interception_state", true],
  ]) {
    const { run, calls } = fixture();
    const result = await run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(calls.map((call) => call.kind), ["control_state", stateKind, ...(mutates ? ["action"] : [])]);
    assert.equal(calls[1].page_id, current.page_id);
    if (mutates) assert.deepEqual(calls[2].authority.page, current);
  }
});

test("default dialog response can answer a suspended input without waiting on renderer observation", async () => {
  const { run, calls } = fixture({ observed: { ...control, in_flight: "pending-click" } });
  const result = await run(["dialog", resource.resource_id, "accept", "한글", ...authority]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.map((call) => call.kind), ["control_state", "dialog_state", "dialog_respond"]);
  assert.equal(calls[1].page_id, current.page_id);
  assert.deepEqual(calls[2].authority, { lease, page: current, operation_id: "current-operation", command_sequence: "12" });
  assert.deepEqual(calls[2].dialog, { page: current, revision: "20" });
  assert.deepEqual(calls[2].response, { kind: "accept", text: "한글" });
});

test("fast control-state consumers reject changed document identity before input", async () => {
  for (const args of [["console", resource.resource_id, "clear"], ["capture", resource.resource_id, "start"], ["intercept", resource.resource_id, "disable"], ["dialog", resource.resource_id, "dismiss"]]) {
    const { run, calls } = fixture({ replyPage: { ...current, document_revision: "8" } });
    assert.equal((await run([...args, ...authority])).error.code, "browser_response_invalid");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].kind, "control_state");
    assert.equal(calls.some((call) => ["action", "dialog_respond", "observe"].includes(call.kind)), false);
  }
});

test("an explicitly empty page cannot be ignored in favor of an encoded reference", async () => {
  const { run, calls } = fixture();
  const reference = encodeRef({ page: first, revision: "17" }, "e1");
  const result = await run(["fill", resource.resource_id, reference, "text", "--page", "", ...authority]);
  assert.equal(result.error?.code, "browser_reference_page_mismatch");
  assert.deepEqual(calls.map((call) => call.kind), ["observe"]);
});
