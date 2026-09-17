import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "resource:labels", generation: "generation:one", workspace_id: "workspace:one" };
const first = { resource, page_id: "page:1", document_revision: "2" };
const docs = { resource, page_id: "page:2", document_revision: "4" };
const lease = { resource, controller_id: "agent:labels", epoch: "8" };
const control = { resource, current_page: first, controller: lease, next_command_sequence: "12" };
const flags = ["--resource", resource.resource_id, "--controller", lease.controller_id, "--epoch", lease.epoch, "--idempotency-key", "label-once"];

function fixture(fault) {
  const calls = []; let resolutions = 0;
  const pages = [{ page: first, ...(fault === "duplicate" ? { label: "docs" } : {}) }, { page: docs, label: "docs" }];
  const run = (args) => collectBrowserCommand({ args: [...flags, ...args], sourceEnvironment: {}, cwd: "/task",
    resolveBackend: async () => { resolutions++; return { profile: { id: "selected" } }; },
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control: fault === "lease" ? { ...control, controller: { ...lease, epoch: "9" } } : control, pages } } };
      assert.ok(["action", "profile_new_page"].includes(body.kind));
      if (fault === "response") throw Error("browser_response_lost");
      return { result: { result: { response: { success: true, data: { page: docs, label: "docs" } } } } };
    },
  });
  return { calls, run, resolutions: () => resolutions };
}

test.each([
  [["tab", "create", "--label", "docs", "--url", "https://example.test"], "action"],
  [["exec", "--command", "tab new --label docs https://example.test"], "action"],
  [["exec", "--command", "tab new https://example.test --label docs"], "action"],
  [["tab", "create", "--label", "docs", "--profile", "profile:docs", "--url", "https://example.test"], "profile_new_page"],
])("named creation %j retains the label in its single admitted operation", async (args, kind) => {
  const f = fixture(); const result = await f.run(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.map(call => call.kind), ["observe", kind]);
  const body = f.calls[1];
  assert.deepEqual(body.authority, { lease, page: first, command_sequence: "12", operation_id: "label-once" });
  assert.equal((body.action ?? body).label, "docs");
  assert.equal((body.action ?? body).url, "https://example.test");
  if (kind === "profile_new_page") assert.equal(body.profile_id, "profile:docs");
});

test.each([
  ["tab docs", ["tab", "switch", "--label", "docs"], "select_page"],
  ["tab close docs", ["tab", "close", "--label", "docs"], "close_page"],
])("exec %s resolves the Host label to the same exact page and authority", async (command, direct, kind) => {
  const canonical = fixture(); const expected = await canonical.run(direct);
  const f = fixture(); const result = await f.run(["exec", "--command", command]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result, expected); assert.deepEqual(f.calls, canonical.calls);
  assert.deepEqual(f.calls[1].authority.page, docs); assert.equal(f.calls[1].action.kind, kind);
  const matching = fixture();
  assert.equal((await matching.run(["exec", "--command", command, "--page", docs.page_id])).ok, true);
  for (const args of [direct, ["exec", "--command", command]]) {
    const conflict = fixture(); const rejected = await conflict.run([...args, "--page", first.page_id]);
    assert.equal(rejected.error?.code, "browser_tab_target_mismatch");
    assert.deepEqual(conflict.calls.map(call => call.kind), ["observe"]);
  }
});

test("named tab show/list keep labels as Host observations without acquiring control", async () => {
  const f = fixture(); const shown = await f.run(["tab", "show", "--label", "docs"]);
  assert.equal(shown.ok, true, JSON.stringify(shown));
  assert.equal(shown.result.tab.label, "docs"); assert.deepEqual(shown.result.tab.page, docs);
  const listed = await f.run(["tab", "list"]);
  assert.equal(listed.ok, true); assert.equal(listed.result.tabs[1].label, "docs");
  assert.deepEqual(f.calls.map(call => call.kind), ["observe", "observe"]);
});

test("labels cannot select a missing or ambiguous page or bypass a stale lease", async () => {
  for (const [fault, label, code] of [[undefined, "missing", "browser_tab_label_missing"], ["duplicate", "docs", "browser_response_invalid"], ["lease", "docs", "browser_controller_changed"]]) {
    const f = fixture(fault); const result = await f.run(["tab", "switch", "--label", label]);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, code);
    assert.deepEqual(f.calls.map(call => call.kind), ["observe"]);
  }
  const f = fixture("response"); const lost = await f.run(["exec", "--command", "tab close docs"]);
  assert.equal(lost.ok, false); assert.equal(lost.operation_id, "label-once");
  assert.equal(f.calls.filter(call => call.kind === "action").length, 1);
});

test("native named creation without a URL uses the existing blank-page default", async () => {
  const f = fixture(); const result = await f.run(["exec", "--command", "tab new --label named"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls[1].action, { kind: "new_page", url: "about:blank", label: "named" });
});

test("invalid labels and conflicting selectors are refused before backend contact", async () => {
  for (const label of ["", "0", "with space", "../outside", "page:2", "한글", "a".repeat(161)]) {
    const f = fixture(); const result = await f.run(["tab", "create", "--label", label]);
    assert.equal(result.ok, false, label); assert.equal(f.resolutions(), 0); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); const result = await f.run(["tab", "switch", "--label", "docs", "--index", "1"]);
  assert.equal(result.ok, false); assert.equal(f.resolutions(), 0);
});
