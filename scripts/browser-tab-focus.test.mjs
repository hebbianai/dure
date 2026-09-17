import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "browser:focus", generation: "generation:one", workspace_id: "workspace:one" };
const first = { resource, page_id: "page:first", document_revision: "2" };
const second = { resource, page_id: "page:second", document_revision: "4" };
const lease = { resource, controller_id: "agent:focus", epoch: "8" };
const control = { resource, current_page: first, controller: lease, next_command_sequence: "12" };
const authority = ["--controller", lease.controller_id, "--epoch", lease.epoch];
function fixture(fault) {
  const requests = [];
  const presentation = [];
  const registry = { state: "available", clientPresentation: { schemaVersion: 3, complete: true,
    spaces: [{ id: "space:chosen", name: "Chosen", kind: "desktop", windowLabel: "main", panes: [] }],
    limits: { maxSpaces: 64, maxPanesPerSpace: 128, maxTotalPanes: 512 },
    truncation: { spaces: false, panes: false, omittedSpaceCount: 0, omittedPaneCount: 0 } } };
  const appControl = { directory: "/unused", descriptor: { port: 1234, token: "private", generation: "app:one" }, registry,
    request: async ({ path, body }) => {
      presentation.push({ path, body });
      if (fault === body.kind) throw Object.assign(new Error("Space unavailable"), { code: "browser_presentation_window_changed" });
      return { ok: true, presentation: { state: body.kind === "prepare" ? "ready" : "requested", spaceId: body.spaceId,
        windowLabel: body.windowLabel, resource: body.resource, ...(body.kind === "present" ? { pageId: body.pageId, panelId: "browser:view" } : {}) } };
    },
  };
  const resolveBackend = async () => ({ profile: { id: "local", transport: { kind: "local" }, expected: { backendId: "backend:one", generation: "generation:one" } } });
  const requestBackend = async (_profile, { body }) => {
    requests.push(body);
    let result;
    if (body.kind === "list") result = { workspace_id: resource.workspace_id, resources: [{ resource }] };
    else if (body.kind === "observe") result = { control: fault === "generation" && presentation.length ? { ...control, resource: { ...resource, generation: "changed" } } : control,
      pages: [first, second].map((page) => ({ page, title: page.page_id, url: "https://example.test/" + page.page_id, profile_id: "default", ...(page === second ? { label: "docs" } : {}) })) };
    else if (body.kind === "action") {
      if (fault === "action") throw new Error("browser_response_lost");
      result = { control: { ...control, current_page: fault === "page" ? { ...body.authority.page, resource: { ...resource, generation: "changed" } } : fault === "target" ? first : body.authority.page }, response: { success: true } };
    } else throw new Error(`unexpected ${body.kind}`);
    return { result: { result } };
  };
  return { requests, presentation, run: (args) => collectBrowserCommand({ args: [...args, "--idempotency-key", "focus-once"], resolveBackend, requestBackend, appControl, sourceEnvironment: {}, cwd: "/task" }) };
}
const focused = ["tab", "switch", resource.resource_id, "--focus", "--space", "space:chosen", ...authority];

test.each([["--page", second.page_id], ["--index", "1"], ["--label", "docs"]])("tab switch --focus admits one switch for %s and presents its exact completed page", async (flag, value) => {
  const f = fixture(); const result = await f.run([...focused, flag, value]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.requests.map((r) => r.kind), ["observe", "observe", "action"]);
  assert.deepEqual(f.requests[2], { kind: "action", caller: lease.controller_id, authority: { lease, page: second, operation_id: "focus-once", command_sequence: "12" }, action: { kind: "select_page" } });
  assert.deepEqual(f.presentation.map((r) => [r.path, r.body.kind]), [["/browser/present", "prepare"], ["/browser/present", "present"]]);
  assert.equal(result.presentation.pageId, second.page_id); assert.equal(result.presentation.spaceId, "space:chosen");
  assert.deepEqual(result.result.control.controller, lease);
});

test("without --focus the existing switch neither contacts the app nor adds presentation state", async () => {
  const f = fixture("prepare"); const result = await f.run(["tab", "switch", resource.resource_id, "--page", second.page_id, ...authority]);
  assert.equal(result.ok, true); assert.deepEqual(f.requests.map((r) => r.kind), ["observe", "action"]);
  assert.deepEqual(f.presentation, []); assert.equal(Object.hasOwn(result, "presentation"), false);
});

test("workspace selection is resolved once before presenting and switching the exact resource", async () => {
  const f = fixture(); const result = await f.run(["tab", "switch", "--workspace", resource.workspace_id, "--focus", "--space", "Chosen", "--index", "0", ...authority]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.requests.filter((r) => r.kind === "list").length, 1);
  assert.deepEqual(f.requests[0], { kind: "list", workspace_id: resource.workspace_id });
  assert.equal(result.presentation.pageId, first.page_id);
});

test("a refused app preflight or changed resource cannot switch the Host", async () => {
  for (const [fault, code] of [["prepare", "browser_presentation_window_changed"], ["generation", "browser_resource_mismatch"]]) {
    const f = fixture(fault); const result = await f.run([...focused, "--page", second.page_id]);
    assert.equal(result.ok, false); assert.equal(result.error.code, code, JSON.stringify(result));
    assert.equal(f.requests.some((r) => r.kind === "action"), false);
    assert.equal(f.presentation.some((r) => r.body.kind === "present"), false);
  }
});

test("a failed presentation retains the successful switch receipt and does not switch again", async () => {
  const f = fixture("present"); const result = await f.run([...focused, "--page", second.page_id]);
  assert.equal(result.ok, false); assert.equal(result.presentation.state, "failed");
  assert.equal(result.runtime.ok, true); assert.equal(result.runtime.operation_id, "focus-once");
  assert.deepEqual(result.runtime.result.control.current_page, second);
  assert.equal(f.requests.filter((r) => r.kind === "action").length, 1);
});

test.each(["action", "page", "target"])("a %s failure cannot present another page or repeat a switch", async (fault) => {
  const f = fixture(fault); const result = await f.run([...focused, "--page", second.page_id]);
  assert.equal(result.ok, false);
  assert.equal(f.requests.filter((r) => r.kind === "action").length, 1);
  assert.equal(f.presentation.some((r) => r.body.kind === "present"), false);
});

test("a missing app Space does not become an implicit global presentation target", async () => {
  const f = fixture(); const result = await f.run(["tab", "switch", resource.resource_id, "--focus", "--page", second.page_id, ...authority]);
  assert.equal(result.ok, false); assert.equal(result.error.code, "browser_space_required");
  assert.deepEqual(f.requests, []); assert.deepEqual(f.presentation, []);
});

test("malformed targets and misplaced focus/Space options fail before any contact", async () => {
  for (const args of [
    ["tab", "switch", resource.resource_id, "--focus"], [...focused, "--index", "128"], [...focused, "--index", "00"],
    [...focused, "--label", "bad label"], [...focused, "--label", "docs", "--index", "1"],
    [...focused, "--page", ""], [...focused, "--page", second.page_id, "--focus"],
    ["tab", "switch", resource.resource_id, "--focus=false", "--page", second.page_id],
    ["tab", "switch", resource.resource_id, "--page", second.page_id, "--space", "space:chosen"],
    ["tab", "list", resource.resource_id, "--focus"], ["goto", resource.resource_id, "https://example.test", "--focus"],
  ]) {
    const f = fixture(); const result = await f.run(args);
    assert.equal(result.ok, false, JSON.stringify(args)); assert.deepEqual(f.requests, [], JSON.stringify(args)); assert.deepEqual(f.presentation, [], JSON.stringify(args));
  }
});
