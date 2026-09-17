import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { encodeRef } from "../cli/lib/browser-reference.mjs";

const resource = { resource_id: "clear", generation: "generation:one", workspace_id: "workspace:one" };
const page = { resource, page_id: "page:current", document_revision: "7" };
const lease = { resource, controller_id: "agent", epoch: "8" };
const control = { resource, controller: lease, next_command_sequence: "12", current_page: page };
const flags = ["--controller", "agent", "--epoch", "8"];

test("workspace commands use the explicit target among multiple resources", async () => {
  const target = { workspace_id: resource.workspace_id, generation: resource.generation,
    revision: "2", current_resource: resource };
  const client = fixture({ catalog: { workspace_id: resource.workspace_id, target,
    resources: [{ ...control, resource: { ...resource, resource_id: "another" } }, control] } });
  const report = await client.run(["get", "url", "--worktree", "current"]);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(client.calls[1].resource_id, resource.resource_id);
});

test("an explicit empty or invalid selection cannot fall back to the remaining resource", async () => {
  const selected = { workspace_id: resource.workspace_id, generation: resource.generation,
    revision: "2", current_resource: resource };
  for (const [target, code] of [
    [{ ...selected, current_resource: null }, "browser_resource_missing"],
    [null, "browser_response_invalid"],
    [{ ...selected, revision: "0" }, "browser_response_invalid"],
    [{ ...selected, revision: "02" }, "browser_response_invalid"],
    [{ ...selected, revision: "18446744073709551616" }, "browser_response_invalid"],
    [{ ...selected, workspace_id: "foreign" }, "browser_response_invalid"],
    [{ ...selected, generation: "replacement" }, "browser_response_invalid"],
    [{ ...selected, current_resource: { ...resource, resource_id: "missing" } }, "browser_response_invalid"],
  ]) {
    const client = fixture({ catalog: { workspace_id: resource.workspace_id, resources: [control], target } });
    const report = await client.run(["get", "url", "--worktree", "current"]);
    assert.equal(report.error?.code, code, JSON.stringify({ target, report }));
    assert.deepEqual(client.calls.map((call) => call.kind), ["list"]);
  }
});

function fixture({ kind = "local", catalog = { workspace_id: resource.workspace_id, resources: [control] }, observedResource = resource, controller = lease, failAt } = {}) {
  const calls = [];
  const selections = [];
  const observedPage = { ...page, resource: observedResource };
  const observedControl = { ...control, resource: observedResource, controller, current_page: observedPage };
  return {
    calls, selections,
    run: (args, cwd = "/tasks/한글 project/nested") => collectBrowserCommand({
      args: [...args, "--idempotency-key", "workspace-operation"], cwd,
      resolveBackend: async (selection) => {
        selections.push(selection);
        return { profile: { id: "chosen-backend", transport: { kind } } };
      },
      requestBackend: async (profile, { body }) => {
        assert.equal(profile.id, "chosen-backend");
        calls.push(body);
        if (body.kind === failAt) throw new Error("browser_response_lost");
        let result = { response: { success: true } };
        if (body.kind === "list") result = catalog;
        if (body.kind === "observe") result = { control: observedControl, pages: [{ page: observedPage, title: "Current", url: "about:blank", profile_id: "default" }] };
        if (body.kind === "control_state") result = observedControl;
        if (body.kind === "console") result = { page: observedPage, entries: [] };
        if (body.kind === "network") result = { page: observedPage, requests: [], complete: true, pending: 0, idle: true, quiet_ms: 100, history_truncated: false };
        if (body.kind === "dialog_state") result = { control: observedControl, page: observedPage, dialog: null };
        return { result: { result } };
      },
    }),
  };
}

test.each([
  [["show"], [], []], [["get"], ["url"], []], [["get"], ["value", "input"], []],
  [["is"], ["enabled", "input"], []], [["snapshot"], [], []],
  [["fill"], ["input", "한글"], flags], [["click"], ["button"], flags],
  [["drag"], ["#source", "#target"], flags], [["key"], ["Control+a"], flags],
  [["mouse"], ["move", "2", "3"], flags], [["cookie"], ["get"], []],
  [["storage"], ["local", "get", "key"], []], [["viewport"], ["800", "600"], flags],
  [["wait"], ["text", "ready"], []], [["network"], [], []],
  [["console"], [], []], [["console"], ["clear"], flags], [["dialog"], ["status"], []],
  [["tab", "list"], [], []], [["tab", "current"], [], []],
  [["tab", "create"], ["about:blank"], flags], [["tab", "switch"], [], [...flags, "--page", page.page_id]],
  [["tab", "profile", "show"], [], []],
  [["tab", "profile", "set"], [], [...flags, "--profile", "profile:two"]],
  [["control"], [], ["--controller", "agent"]], [["close"], [], []],
])("workspace target reaches the existing %j contract", async (prefix, values, options) => {
  const explicit = fixture();
  const expected = await explicit.run([...prefix, "--resource", resource.resource_id, ...values, ...options]);
  assert.equal(expected.ok, true, JSON.stringify(expected));
  const scoped = fixture();
  const actual = await scoped.run([...prefix, "--worktree", "current", ...values, ...options]);
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.deepEqual(scoped.calls[0], { kind: "list", workspace_path: "/tasks/한글 project/nested" });
  assert.deepEqual(scoped.calls.slice(1), explicit.calls);
  assert.deepEqual(actual, expected);
  assert.equal(scoped.selections.length, 1);
});

test("explicit workspace IDs and server paths keep their selected backend", async () => {
  for (const kind of ["local", "ssh"]) {
    for (const [selector, target] of [
      [["--workspace", resource.workspace_id], { workspace_id: resource.workspace_id }],
      [["--worktree", `id:${resource.workspace_id}`], { workspace_id: resource.workspace_id }],
      [["--worktree", "path:/srv/a/../한글 project"], { workspace_path: "/srv/a/../한글 project" }],
    ]) {
      const client = fixture({ kind });
      const report = await client.run(["get", "url", ...selector, "--backend", "remote"]);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.deepEqual(client.calls[0], { kind: "list", ...target });
      assert.deepEqual(client.selections, [{ backend: "remote", backendSpecified: true }]);
      assert.deepEqual(client.calls.map((call) => call.kind), ["list", "observe", "query"]);
    }
  }
});

test("remote and unknown transports cannot project local cwd onto a workspace", async () => {
  for (const kind of ["ssh", "unknown"]) {
    for (const selector of ["current", "active"]) {
      const client = fixture({ kind });
      const report = await client.run(["snapshot", "--worktree", selector]);
      assert.equal(report.error?.code, "browser_workspace_required", JSON.stringify(report));
      assert.deepEqual(client.calls, []);
    }
  }
});

test.each([
  [[], "browser_resource_missing"],
  [[control, { ...control, resource: { ...resource, resource_id: "second" } }], "browser_resource_ambiguous"],
])("workspace inventory %j never invents a target", async (resources, code) => {
  const client = fixture({ catalog: { workspace_id: resource.workspace_id, resources } });
  const report = await client.run(["fill", "input", "must not run", "--worktree", "current", ...flags]);
  assert.equal(report.error?.code, code, JSON.stringify(report));
  assert.deepEqual(client.calls.map((call) => call.kind), ["list"]);
});

test("malformed or out-of-workspace inventories cannot reach page input", async () => {
  for (const catalog of [
    null, {}, { resources: [control] }, { workspace_id: "bad id", resources: [control] },
    { workspace_id: resource.workspace_id, resources: null },
    { workspace_id: resource.workspace_id, resources: [null] },
    { workspace_id: resource.workspace_id, resources: [control, control] },
    { workspace_id: resource.workspace_id, resources: [{ ...control, resource: { ...resource, workspace_id: "foreign" } }] },
    { workspace_id: resource.workspace_id, resources: [{ ...control, resource: { ...resource, generation: "" } }] },
    { workspace_id: "different", resources: [{ ...control, resource: { ...resource, workspace_id: "different" } }] },
  ]) {
    const client = fixture({ catalog });
    const report = await client.run(["fill", "input", "must not run", "--workspace", resource.workspace_id, ...flags]);
    assert.equal(report.error?.code, "browser_response_invalid", JSON.stringify({ catalog, report }));
    assert.deepEqual(client.calls.map((call) => call.kind), ["list"]);
  }
});

test("a resource replaced or moved after list cannot redirect any observation family", async () => {
  for (const observedResource of [{ ...resource, generation: "replacement" }, { ...resource, workspace_id: "foreign" }]) {
    for (const args of [["fill", "input", "must not run", ...flags], ["console"], ["dialog", "status", "--page", page.page_id], ["control", "--controller", "agent"]]) {
      const client = fixture({ observedResource });
      const report = await client.run([...args, "--workspace", resource.workspace_id]);
      assert.equal(report.error?.code, "browser_resource_mismatch", JSON.stringify(report));
      assert.equal(client.calls.length, 2);
      assert.equal(client.calls.some((call) => ["action", "control", "dialog_respond"].includes(call.kind)), false);
    }
  }
});

test("workspace selection cannot borrow a controller or retry uncertain input", async () => {
  const stale = fixture({ controller: { ...lease, epoch: "9" } });
  const refusal = await stale.run(["fill", "input", "text", "--worktree", "active", ...flags]);
  assert.equal(refusal.error?.code, "browser_controller_changed", JSON.stringify(refusal));
  assert.deepEqual(stale.calls.map((call) => call.kind), ["list", "observe"]);
  for (const failAt of ["list", "observe", "action"]) {
    const client = fixture({ failAt });
    const report = await client.run(["fill", "input", "text", "--worktree", "current", ...flags]);
    assert.equal(report.error?.code, "browser_response_lost", JSON.stringify(report));
    assert.equal(client.calls.filter((call) => call.kind === failAt).length, 1);
    assert.equal(client.calls.at(-1).kind, failAt);
    assert.equal(report.operation_id, "workspace-operation");
  }
});

test("workspace-targeted references retain the original document and resource checks", async () => {
  const original = { ...page, page_id: "page:original", document_revision: "3" };
  const reference = encodeRef({ page: original, revision: "2" }, "e1");
  const client = fixture();
  const report = await client.run(["fill", reference, "한글", "--worktree", "current", ...flags]);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(client.calls.at(-1).authority.page, original);
  const foreign = encodeRef({ page: { ...original, resource: { ...resource, resource_id: "foreign" } }, revision: "2" }, "e1");
  const conflicting = fixture();
  const refused = await conflicting.run(["fill", foreign, "text", "--worktree", "current", ...flags]);
  assert.equal(refused.error?.code, "browser_reference_page_mismatch", JSON.stringify(refused));
  assert.equal(conflicting.calls.some((call) => call.kind === "action"), false);
});

test("contradictory target grammars and catalog-only commands fail before backend selection", async () => {
  for (const args of [
    ["show", "clear", "--worktree", "current"],
    ["show", "--resource", "clear", "--workspace", resource.workspace_id],
    ["snapshot", "--workspace", resource.workspace_id, "--worktree", "current"],
    ["snapshot", "--worktree", "branch:main"],
    ["tab", "profile", "list", "--worktree", "current"],
    ["workspaces", "--worktree", "current"], ["receipt", "operation", "--worktree", "current"],
    ["artifact", "operation", "--worktree", "current", "--output", "/tmp/must-not-write"],
  ]) {
    const client = fixture();
    const report = await client.run(args);
    assert.equal(report.ok, false, JSON.stringify(args));
    assert.equal(report.error.code, "browser_command_invalid");
    assert.deepEqual(client.selections, []);
    assert.deepEqual(client.calls, []);
  }
});
