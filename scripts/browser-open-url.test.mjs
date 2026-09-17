import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "browser:one", generation: "generation:one", workspace_id: "workspace:one" };
const page = { resource, page_id: "page:one", document_revision: "1" };
const created = { ...page, page_id: "page:created" };
const control = { resource, controller: { resource, controller_id: "agent", epoch: "1" }, current_page: page, next_command_sequence: "4" };
const profile = { id: "local", transport: { kind: "local" }, expected: { backendId: "backend:one", generation: "generation:one" } };
function fixture(fault) {
  const events = [];
  const registry = { state: "available", clientPresentation: {
    schemaVersion: 3, complete: true, spaces: [{ id: "space:one", name: "Work", kind: "desktop", windowLabel: "main", panes: [] }],
    limits: { maxSpaces: 64, maxPanesPerSpace: 128, maxTotalPanes: 512 },
    truncation: { spaces: false, panes: false, omittedSpaceCount: 0, omittedPaneCount: 0 },
  } };
  const appControl = { directory: "/unused", descriptor: { token: "private-token", port: 1234, generation: "app:one" }, registry,
    request: async ({ body }) => {
      events.push({ app: body });
      if (fault === body.kind) throw Object.assign(new Error("Space moved"), { code: "browser_presentation_window_changed" });
      return { ok: true, presentation: { state: body.kind === "prepare" ? "ready" : "requested", spaceId: body.spaceId,
        windowLabel: body.windowLabel, resource: body.resource, ...(body.kind === "present" ? { pageId: body.pageId, panelId: "browser:view" } : {}) } };
    },
  };
  const resolveBackend = async () => ({ profile });
  const requestBackend = async (_profile, { body }) => {
    events.push({ backend: body });
    let result;
    if (body.kind === "list") result = { workspace_id: resource.workspace_id, resources: [{ resource }] };
    else if (body.kind === "observe") result = { control: fault === "generation" && events.some((e) => e.app?.kind === "prepare") ? { ...control, resource: { ...resource, generation: "changed" } } : control, pages: [{ page, url: "about:blank", title: "Source", profile_id: "default" }] };
    else if (["action", "profile_new_page"].includes(body.kind)) {
      if (fault === "action") throw Object.assign(new Error("browser_controller_changed"), { code: "browser_controller_changed" });
      result = { control, response: { success: true, data: { page: fault === "page" ? { ...created, resource: { ...resource, generation: "changed" } } : created } } };
    } else throw new Error(`unexpected request ${body.kind}`);
    return { result: { result } };
  };
  return { events, appControl, run: (args = []) => collectBrowserCommand({
    args: ["open-url", "https://example.test/한글", "--resource", resource.resource_id, "--space", "space:one", "--controller", "agent", "--epoch", "1", "--idempotency-key", "open-once", ...args],
    resolveBackend, requestBackend, appControl, sourceEnvironment: {},
  }), raw: (args) => collectBrowserCommand({ args, resolveBackend, requestBackend, appControl, sourceEnvironment: {}, cwd: "/tmp/project" }) };
}

test("open-url preflights the exact Space, creates one typed tab, and presents the receipt's page", async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.operation_id, "open-once");
  assert.deepEqual(f.events.map((e) => e.app?.kind ?? e.backend.kind), ["observe", "prepare", "observe", "action", "present"]);
  assert.deepEqual(f.events.find((e) => e.backend?.kind === "action").backend.action, { kind: "new_page", url: "https://example.test/한글" });
  assert.equal(result.presentation.pageId, created.page_id);
  assert.equal(result.presentation.state, "requested");
  assert.equal(JSON.stringify(result).includes("private-token"), false);
});

test("a rejected preflight performs no control or tab mutation", async () => {
  const f = fixture("prepare"); const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.error.code, "browser_presentation_window_changed");
  assert.deepEqual(f.events.map((e) => e.app?.kind ?? e.backend.kind), ["observe", "prepare"]);
});

test("presentation failure retains the successful page and operation without another mutation", async () => {
  const f = fixture("present"); const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.presentation.state, "failed");
  assert.equal(result.runtime.ok, true); assert.equal(result.runtime.operation_id, "open-once");
  assert.deepEqual(result.runtime.result.response.data.page, created);
  assert.equal(f.events.filter((e) => e.backend?.kind === "action").length, 1);
});

test("a resource generation change after preflight rejects before creating a tab", async () => {
  const f = fixture("generation"); const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.error.code, "browser_resource_mismatch");
  assert.equal(f.events.some((e) => e.backend?.kind === "action" || e.app?.kind === "present"), false);
});

test.each(["action", "page"])("a %s failure never presents an unrelated or uncreated page", async (fault) => {
  const f = fixture(fault); const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(f.events.some((e) => e.app?.kind === "present"), false);
  assert.equal(f.events.filter((e) => e.backend?.kind === "action").length, 1);
});

test("profile and source page options reach the existing profile tab creation authority", async () => {
  const f = fixture(); const result = await f.run(["--profile", "profile:chosen", "--page", page.page_id]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const action = f.events.find((e) => e.backend?.kind === "profile_new_page").backend;
  assert.equal(action.profile_id, "profile:chosen"); assert.deepEqual(action.authority.page, page);
  assert.equal(action.authority.operation_id, "open-once");
  assert.equal(action.authority.lease.controller_id, "agent");
});

test("workspace selectors resolve once and the created tab remains bound to that resource", async () => {
  const f = fixture();
  const result = await f.raw(["open-url", "--url", "https://example.test", "--workspace", resource.workspace_id, "--space", "Work", "--controller", "agent", "--epoch", "1"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.events[0].backend, { kind: "list", workspace_id: resource.workspace_id });
  assert.equal(f.events.filter((e) => e.backend?.kind === "list").length, 1);
  assert.deepEqual(result.presentation.resource, resource);
});

test("ambiguous or absent presentation context never creates a tab", async () => {
  const f = fixture();
  const result = await f.raw(["open-url", "https://example.test", "--resource", resource.resource_id]);
  assert.equal(result.ok, false); assert.equal(result.error.code, "browser_space_required");
  assert.deepEqual(f.events, []);
});

test("invalid URLs, selectors, duplicate and misplaced options fail before any contact", async () => {
  for (const args of [
    ["open-url"], ["open-url", "file:///tmp/private"], ["open-url", "javascript:alert(1)"],
    ["open-url", "https://a", "extra"], ["open-url", "https://a", "--url", "https://b"],
    ["open-url", "https://a", "--worktree", "all"], ["open-url", "https://a", "--worktree", "bad"],
    ["open-url", "https://a", "--workspace", "w", "--resource", "r"],
    ["open-url", "https://a", "--output", "/tmp/x"], ["open-url", "https://a", "--space", ""],
    ["show", "r", "--space", "space:one"],
  ]) {
    const f = fixture(); const result = await f.raw(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.deepEqual(f.events, [], JSON.stringify(args));
  }
});
