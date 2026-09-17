import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

afterEach(() => vi.restoreAllMocks());
const workspaces = Array.from({ length: 129 }, (_, i) => ({ workspace_id: `w:${String(i).padStart(3, "0")}`, project_name: "Project", root_path: `/remote/${i}` }));
const resources = [0, 1, 128].map((i) => ({ workspace_id: workspaces[i].workspace_id, resource_id: `r:${i}`, generation: "g" }));
const page = (resource, id) => ({ resource, page_id: id, document_revision: "7" });
const views = resources.map((resource) => {
  const pages = ["first", "current"].map((id) => ({ page: page(resource, id), title: id, url: "about:blank", profile_id: "default" }));
  return { control: { resource, current_page: pages[1].page, controller: null }, pages };
});

function fixture(change = (_body, value) => value) {
  const calls = [];
  const run = (args = ["tab", "current", "--worktree", "all"]) => collectBrowserCommand({
    args, cwd: "/client/path/must/not/be/sent", sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "remote", transport: { kind: "ssh" } } }),
    requestBackend: async (profile, request) => {
      assert.equal(profile.id, "remote");
      const body = request.body; calls.push(body);
      let value;
      if (body.kind === "workspaces") {
        const rows = workspaces.filter((row) => body.after === undefined || row.workspace_id > body.after).slice(0, 128);
        value = { workspaces: rows, next: rows.length === 128 ? rows.at(-1).workspace_id : null };
      } else if (body.kind === "list") {
        const found = resources.filter((resource) => resource.workspace_id === body.workspace_id);
        value = { workspace_id: body.workspace_id, resources: found.map((resource) => ({ resource })), target: { workspace_id: body.workspace_id, generation: "g", revision: "1", current_resource: found[0] ?? null } };
      } else if (body.kind === "observe") value = views.find((view) => view.control.resource.resource_id === body.resource_id);
      else throw new Error(`Unexpected write: ${body.kind}`);
      return { result: { result: change(body, structuredClone(value)) } };
    },
  });
  return { run, calls };
}

test("all-worktree current returns the first Host current tab in full catalog order", async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { tab: { ...views[0].pages[1], active: true } });
  assert.deepEqual(f.calls.filter((body) => body.kind === "workspaces"), [{ kind: "workspaces" }, { kind: "workspaces", after: "w:127" }]);
  assert.equal(f.calls.filter((body) => body.kind === "list").length, 129);
  assert.deepEqual(f.calls.filter((body) => body.kind === "observe").map((body) => body.resource_id), ["r:0", "r:1", "r:128"]);
});

test("current skips resources without Host selection and retains a later workspace identity", async () => {
  const f = fixture((body, value) => body.kind === "observe" && body.resource_id !== "r:128" ? { ...value, control: { ...value.control, current_page: null } } : value);
  const result = await f.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result.tab, { ...views[2].pages[1], active: true });
});

test("no Host current tab or an empty catalog never falls back to an arbitrary page", async () => {
  for (const empty of [false, true]) {
    const f = fixture((body, value) => empty && body.kind === "workspaces" ? { workspaces: [], next: null }
      : body.kind === "observe" ? { ...value, control: { ...value.control, current_page: null }, pages: value.pages.map((row) => ({ ...row, active: true })) } : value);
    const result = await f.run();
    assert.equal(result.error?.code, "browser_page_required", JSON.stringify(result));
    assert.equal(result.result, undefined);
  }
});

test("a later catalog or observation failure rejects the read despite an earlier current candidate", async () => {
  for (const fault of ["cursor", "generation", "renderer"]) {
    const f = fixture((body, value) => {
      if (fault === "cursor" && body.kind === "workspaces" && body.after) return { workspaces: [], next: body.after };
      if (body.kind !== "observe" || body.resource_id !== "r:128") return value;
      if (fault === "generation") return { ...value, control: { ...value.control, resource: { ...value.control.resource, generation: "replaced" } } };
      if (fault === "renderer") return { ...value, observation_error: "browser_cdp_response_timeout" };
      return value;
    });
    const result = await f.run();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.result, undefined);
    assert.equal(result.error.code, { cursor: "browser_response_invalid", generation: "browser_resource_mismatch", renderer: "browser_cdp_response_timeout" }[fault]);
  }
});

test("all-worktree current keeps the single aggregate deadline", async () => {
  let now = 1000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture((body, value) => { if (body.kind === "workspaces") now += 45_001; return value; });
  const result = await f.run();
  assert.equal(result.error?.code, "browser_tab_list_timeout", JSON.stringify(result));
  assert.deepEqual(f.calls, [{ kind: "workspaces" }]);
});

test("all-worktree current cannot accept another target, page, profile display or mutation flags", async () => {
  for (const extra of [["r:0"], ["--resource", "r:0"], ["--workspace", "w:000"], ["--page", "current"], ["--show-profile"], ["--controller", "agent"], ["--epoch", "1"], ["--index", "0"]]) {
    const f = fixture(); const result = await f.run(["tab", "current", "--worktree", "all", ...extra]);
    assert.equal(result.error?.code, "browser_command_invalid", JSON.stringify({ extra, result }));
    assert.deepEqual(f.calls, []);
  }
});
