import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

afterEach(() => vi.restoreAllMocks());
const workspace = (index) => ({ workspace_id: `workspace:${String(index).padStart(3, "0")}`, project_name: "한글 project", root_path: `/remote/tasks/${index}` });
const resource = (workspaceId, id) => ({ workspace_id: workspaceId, resource_id: id, generation: "generation:one" });
const a = resource(workspace(0).workspace_id, "browser:a");
const b = resource(workspace(0).workspace_id, "browser:b");
const c = resource(workspace(128).workspace_id, "browser:c");
const page = (owner, id, profileId = "default") => ({ page: { resource: owner, page_id: id, document_revision: "7" }, url: `https://example.test/${id}`, title: `Title ${id}`, profile_id: profileId });
const profiles = [
  { profile: { profileId: "default", label: "Default", scope: "default", userAgentMode: "clean" }, state: "active" },
  { profile: { profileId: "profile:two", label: "한글 저장소", scope: "isolated", userAgentMode: "native" }, state: "active" },
];

function fixture({ count = 129, change = (_body, result) => result } = {}) {
  const workspaces = Array.from({ length: count }, (_, i) => workspace(i));
  const rows = new Map([[a.resource_id, [page(a, "page:first"), page(a, "page:second", "profile:two")]], [b.resource_id, [page(b, "page:other")]], [c.resource_id, [page(c, "page:last")]]]);
  const owners = [a, b, c];
  const calls = [], selections = [], deadlines = [];
  const control = (owner) => ({ resource: owner, revision: "5", phase: "ready", current_page: rows.get(owner.resource_id).at(-1).page, controller: null, requested_controller: null, in_flight: null, next_command_sequence: "1" });
  return {
    calls, selections, rows, deadlines,
    run: (args) => collectBrowserCommand({
      args: [...args, "--backend", "remote", "--idempotency-key", "read:tabs"], cwd: "/must/not/project/onto/remote",
      resolveBackend: async (selection) => { selections.push(selection); return { profile: { id: "remote", transport: { kind: "ssh" } }, transportOptions: { fixture: true } }; },
      requestBackend: async (profile, request, options) => {
        assert.equal(profile.id, "remote"); assert.equal(options.fixture, true);
        assert.equal(request.operation, "browser.resource");
        assert.deepEqual(request.requiredCapabilities, ["browser.resource.v1"]);
        assert.ok(options.deadlineMs > 0 && options.deadlineMs <= 45_000);
        deadlines.push(options.deadlineMs);
        const body = request.body; calls.push(body);
        let result;
        if (body.kind === "workspaces") {
          const selected = workspaces.filter((row) => body.after === undefined || row.workspace_id > body.after).slice(0, 128);
          result = { workspaces: selected, next: selected.length === 128 ? selected.at(-1).workspace_id : null };
        } else if (body.kind === "list") {
          const resources = owners.filter((owner) => owner.workspace_id === body.workspace_id).map(control);
          result = { workspace_id: body.workspace_id, resources, target: { workspace_id: body.workspace_id, generation: "generation:one", revision: "2", current_resource: resources[0]?.resource ?? null } };
        } else if (body.kind === "observe") {
          const owner = owners.find((candidate) => candidate.resource_id === body.resource_id);
          result = { control: control(owner), pages: rows.get(owner.resource_id) };
        } else if (body.kind === "profile_list") result = { profiles };
        else throw new Error(`unexpected mutation: ${body.kind}`);
        return { result: { result: change(body, structuredClone(result)) } };
      },
    }),
  };
}

test("all-worktree tab list follows every workspace page and every resource without selecting one", async () => {
  const f = fixture();
  const result = await f.run(["tab", "list", "--worktree", "all"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result.tabs.map((row) => [row.page.resource.resource_id, row.page.page_id, row.active]), [["browser:a", "page:first", false], ["browser:a", "page:second", true], ["browser:b", "page:other", true], ["browser:c", "page:last", true]]);
  assert.deepEqual(f.calls.filter((body) => body.kind === "workspaces"), [{ kind: "workspaces" }, { kind: "workspaces", after: "workspace:127" }]);
  assert.equal(f.calls.filter((body) => body.kind === "list").length, 129);
  assert.deepEqual(f.selections, [{ backend: "remote", backendSpecified: true }]);
  assert.ok(f.calls.every((body) => ["workspaces", "list", "observe"].includes(body.kind)));
  assert.equal(result.operation_id, "read:tabs");
});

test("show-profile joins exact saved labels once for both explicit and all-worktree tab lists", async () => {
  for (const args of [["tab", "list", a.resource_id], ["tab", "list", "--workspace", a.workspace_id], ["tab", "list", "--worktree", "all"]]) {
    const f = fixture();
    const result = await f.run([...args, "--show-profile"]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.calls.filter((body) => body.kind === "profile_list").length, 1);
    assert.deepEqual(result.result.tabs.map((row) => row.profile_label), args.includes("all") ? ["Default", "한글 저장소", "Default", "Default"] : ["Default", "한글 저장소"]);
    assert.deepEqual(f.rows.get(a.resource_id).map((row) => row.profile_label), [undefined, undefined], "formatting cannot mutate cached observations");
  }
});

test("an empty global catalog returns an empty list without cwd resolution or page guesses", async () => {
  const f = fixture({ count: 0 });
  const result = await f.run(["tab", "list", "--worktree=all"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result.tabs, []);
  assert.deepEqual(f.calls, [{ kind: "workspaces" }]);
});

test("all-worktree and profile-display flags cannot redirect other commands or accept conflicting targets", async () => {
  for (const args of [
    ["tab", "list", a.resource_id, "--worktree", "all"],
    ["tab", "list", "--resource", a.resource_id, "--worktree", "all"],
    ["tab", "list", "--workspace", a.workspace_id, "--worktree", "all"],
    ["tab", "switch", "--index", "0", "--worktree", "all"],
    ["fill", "input", "text", "--worktree", "all"],
    ["tab", "list", a.resource_id, "--show-profile", "--show-profile"],
    ["tab", "list", a.resource_id, "--show-profile=false"],
    ["tab", "current", a.resource_id, "--show-profile"],
    ["tab", "profile", "list", "--show-profile"],
    ["tab", "list", "--worktree", "all", "--controller", "unneeded"],
  ]) {
    const f = fixture(); const result = await f.run(args);
    assert.equal(result.error?.code, "browser_command_invalid", JSON.stringify({ args, result }));
    assert.equal(f.selections.length, 0); assert.equal(f.calls.length, 0);
  }
});

test("malformed or non-advancing workspace pages cannot produce a partial global success", async () => {
  for (const malformed of [null, {}, { workspaces: [], next: "workspace:127" }, { workspaces: [workspace(127)], next: null }]) {
    const f = fixture({ change: (body, result) => body.kind === "workspaces" && body.after ? malformed : result });
    const result = await f.run(["tab", "list", "--worktree", "all"]);
    assert.equal(result.error?.code, "browser_response_invalid", JSON.stringify(result));
    assert.equal(result.result, undefined);
    assert.equal(f.calls.filter((body) => body.kind === "workspaces").length, 2);
  }
});

test("resource catalogs must belong to the requested workspace and retain their exact selection generation", async () => {
  for (const mutate of [
    (v) => ({ ...v, workspace_id: "foreign" }),
    (v) => ({ ...v, resources: [v.resources[0], v.resources[0]] }),
    (v) => ({ ...v, target: { ...v.target, generation: "replacement" } }),
    (v) => ({ ...v, resources: [{ resource: { ...a, workspace_id: "foreign" } }] }),
  ]) {
    const f = fixture({ change: (body, value) => body.kind === "list" ? mutate(value) : value });
    const result = await f.run(["tab", "list", "--worktree", "all"]);
    assert.equal(result.error?.code, "browser_response_invalid", JSON.stringify(result));
    assert.ok(!f.calls.some((body) => body.kind === "observe"));
  }
});

test("replaced resources and foreign or stale page projections never enter the global tab list", async () => {
  for (const mutate of [
    (v) => ({ ...v, control: { ...v.control, resource: { ...a, generation: "replacement" } } }),
    (v) => ({ ...v, pages: [{ ...v.pages[0], page: { ...v.pages[0].page, resource: b } }] }),
    (v) => ({ ...v, pages: [v.pages[0], v.pages[0]] }),
    (v) => ({ ...v, control: { ...v.control, current_page: { ...v.control.current_page, document_revision: "8" } } }),
  ]) {
    const f = fixture({ change: (body, value) => body.kind === "observe" ? mutate(value) : value });
    const result = await f.run(["tab", "list", "--worktree", "all"]);
    assert.ok(["browser_resource_mismatch", "browser_response_invalid"].includes(result.error?.code), JSON.stringify(result));
    assert.equal(result.result, undefined);
  }
});

test("renderer observation failure is reported instead of making its resource look empty", async () => {
  const f = fixture({ change: (body, value) => body.kind === "observe" ? { ...value, pages: [], observation_error: "browser_cdp_response_timeout" } : value });
  const result = await f.run(["tab", "list", "--worktree", "all"]);
  assert.equal(result.error?.code, "browser_cdp_response_timeout", JSON.stringify(result));
  assert.equal(result.result, undefined);
});

test("missing or malformed profile joins cannot use another profile label", async () => {
  for (const value of [
    { profiles: [] }, { profiles: [profiles[0]] }, { profiles: [...profiles, profiles[1]] },
    { profiles: [profiles[0], { ...profiles[1], profile: { ...profiles[1].profile, label: "bad\u0085label" } }] },
  ]) {
    const f = fixture({ change: (body, result) => body.kind === "profile_list" ? value : result });
    const result = await f.run(["tab", "list", a.resource_id, "--show-profile"]);
    assert.ok(["browser_profile_missing", "browser_response_invalid"].includes(result.error?.code), JSON.stringify(result));
    assert.equal(result.result, undefined);
  }
});

test("global enumeration spends one overall request budget and stops before another call after expiry", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture({ change: (body, result) => { if (body.kind === "workspaces") now += 45_001; return result; } });
  const result = await f.run(["tab", "list", "--worktree", "all"]);
  assert.equal(result.error?.code, "browser_tab_list_timeout", JSON.stringify(result));
  assert.deepEqual(f.calls, [{ kind: "workspaces" }]);
});
