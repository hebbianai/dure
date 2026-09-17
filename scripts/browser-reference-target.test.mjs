import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { encodeRef } from "../cli/lib/browser-reference.mjs";

const resource = { resource_id: "clear", generation: "generation:one", workspace_id: "workspace:one" };
const page = { resource, page_id: "page:original", document_revision: "3" };
const current = { ...page, page_id: "page:current", document_revision: "7" };
const lease = { resource, controller_id: "agent", epoch: "8" };
const control = { resource, controller: lease, next_command_sequence: "12", current_page: current };
const ref = encodeRef({ page, revision: "17" }, "e1");
const flags = ["--controller", lease.controller_id, "--epoch", lease.epoch];

function fixture({ controller = lease, loseResponse = false } = {}) {
  const calls = [];
  let resolved = 0;
  const run = (args) => collectBrowserCommand({
    args: ["--idempotency-key", "reference-operation", ...args],
    resolveBackend: async () => { resolved++; return { profile: { id: "chosen-backend" } }; },
    requestBackend: async (profile, request) => {
      assert.equal(profile.id, "chosen-backend");
      const body = request.body;
      calls.push(body);
      const observed = { ...control, controller };
      if (body.kind === "observe") return { result: { result: { control: observed, pages: [page, current].map((page) => ({ page, title: page.page_id, url: "about:blank", profile_id: "default" })) } } };
      if (body.kind === "control_state") return { result: { result: observed } };
      if (body.kind === "console") return { result: { result: { page: current, entries: [] } } };
      if (loseResponse) throw new Error("browser_response_lost");
      return { result: { result: { response: { success: true } } } };
    },
  });
  return { run, calls, resolved: () => resolved };
}

test("named resources reach the same existing request contract across command families", async () => {
  for (const [prefix, values, options] of [
    [["show"], [], []], [["get"], ["title"], []], [["get"], ["value", "#value"], []],
    [["is"], ["enabled", "#value"], []], [["snapshot"], [], []],
    [["fill"], ["#value", "한글"], flags], [["click"], ["#button"], flags],
    [["key"], ["Control+a"], flags], [["mouse"], ["move", "2", "3"], flags],
    [["cookie"], ["get"], []], [["storage"], ["local", "get", "key"], []],
    [["viewport"], ["800", "600"], flags], [["wait"], ["text", "ready"], []],
    [["console"], [], []], [["console"], ["clear"], flags],
    [["tab", "list"], [], []], [["tab", "create"], ["about:blank"], flags],
    [["tab", "switch"], [], [...flags, "--page", page.page_id]],
    [["tab", "profile", "show"], [], ["--page", page.page_id]],
    [["tab", "profile", "set"], [], [...flags, "--page", page.page_id, "--profile", "profile:two"]],
  ]) {
    const legacy = fixture();
    const named = fixture();
    const before = await legacy.run([...prefix, resource.resource_id, ...values, ...options]);
    assert.equal(before.ok, true, JSON.stringify({ prefix, before }));
    const result = await named.run([...prefix, "--resource", resource.resource_id, ...values, ...options]);
    assert.equal(result.ok, true, JSON.stringify({ prefix, result }));
    assert.deepEqual(named.calls, legacy.calls);
  }
});

test("reference-only input retains the referenced document instead of the current tab", async () => {
  for (const [name, values] of [
    ["tap", []], ["click", []], ["dblclick", []], ["fill", ["한글"]], ["select", ["choice"]],
    ["check", []], ["uncheck", []], ["focus", []], ["clear", []],
    ["select-all", []], ["hover", []], ["highlight", []], ["scrollintoview", []],
    ["drag", ["#destination"]],
  ]) {
    const { run, calls } = fixture();
    const result = await run([name, ref, ...values, ...flags]);
    assert.equal(result.ok, true, JSON.stringify({ name, result }));
    assert.deepEqual(calls.map((call) => call.kind), ["observe", "action"]);
    assert.equal(calls[0].resource_id, resource.resource_id);
    assert.deepEqual(calls[1].authority, { page, lease, operation_id: "reference-operation", command_sequence: "12" });
    const element = name === "drag" ? calls[1].action.source : calls[1].action.target;
    assert.deepEqual(element.reference, { snapshot: { page, revision: "17" }, element: "e1" });
  }
});

test("reference-only queries do not acquire control and retain attribute arguments", async () => {
  for (const args of [["get", "value", ref], ["get", "attr", ref, "data-label"], ["is", "enabled", ref]]) {
    const { run, calls } = fixture({ controller: null });
    const result = await run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(calls.map((call) => call.kind), ["observe", "query"]);
    assert.deepEqual(calls[1].page, page);
    assert.equal(calls[1].query.target.reference.element, "e1");
    if (args[1] === "attr") assert.equal(calls[1].query.name, "data-label");
  }
});

test("a drag destination reference can identify the resource of its CSS source", async () => {
  const { run, calls } = fixture();
  const result = await run(["drag", "#source", ref, ...flags]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.map((call) => call.kind), ["observe", "action"]);
  assert.deepEqual(calls[1].authority.page, page);
  assert.deepEqual(calls[1].action.source, { kind: "css", selector: "#source" });
  assert.equal(calls[1].action.target.reference.element, "e1");
});

test("an explicit named resource retains reference page checks and literal argument bytes", async () => {
  const { run, calls } = fixture();
  const result = await run(["fill", "--resource", resource.resource_id, ...flags, "--", ref, "--help"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls[1].action.text, "--help");
  assert.deepEqual(calls[1].authority.page, page);
  const conflicting = fixture();
  const mismatch = await conflicting.run(["fill", "--resource", "other", ref, "text", ...flags]);
  assert.equal(mismatch.ok, false);
  assert.equal(conflicting.calls.some((call) => call.kind === "action"), false);
});

test("references cannot borrow a controller or replay input after response loss", async () => {
  const stale = fixture({ controller: { ...lease, epoch: "9" } });
  assert.equal((await stale.run(["fill", ref, "text", ...flags])).error.code, "browser_controller_changed");
  assert.deepEqual(stale.calls.map((call) => call.kind), ["observe"]);
  const lost = fixture({ loseResponse: true });
  const result = await lost.run(["fill", ref, "text", ...flags]);
  assert.equal(result.error.code, "browser_response_lost");
  assert.equal(result.operation_id, "reference-operation");
  assert.deepEqual(lost.calls.map((call) => call.kind), ["observe", "action"]);
});

test("named resources never reinterpret an opaque legacy resource named clear", async () => {
  const legacy = fixture();
  assert.equal((await legacy.run(["console", "clear"])).ok, true);
  assert.deepEqual(legacy.calls.map((call) => call.kind), ["control_state", "console"]);
  const named = fixture();
  assert.equal((await named.run(["console", "--resource", "clear", "clear", ...flags])).ok, true);
  assert.deepEqual(named.calls.map((call) => call.kind), ["control_state", "console", "action"]);
});

test("invalid or unsupported explicit selectors fail before backend discovery", async () => {
  for (const args of [
    ["show", "--resource", ""], ["show", "--resource", "x", "--resource", "y"],
    ["create", "--resource", "x"], ["list", "--resource", "x"],
    ["receipt", "--resource", "x"], ["artifact", "--resource", "x", "--output", "out"],
    ["tab", "profile", "list", "--resource", "x"],
    ["click", "@br1.invalid", ...flags],
  ]) {
    const f = fixture();
    assert.equal((await f.run(args)).ok, false, JSON.stringify(args));
    assert.equal(f.resolved(), 0, JSON.stringify(args));
    assert.deepEqual(f.calls, []);
  }
});
