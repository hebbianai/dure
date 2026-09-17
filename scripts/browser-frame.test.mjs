import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { encodeRef } from "../cli/lib/browser-reference.mjs";

const resource = { resource_id: "browser:frames", generation: "generation:one", workspace_id: "workspace:one" };
const page = { resource, page_id: "page:one", document_revision: "2" };
const lease = { resource, controller_id: "agent:one", epoch: "8" };
const snapshot = { page, revision: "9" };
const ref = encodeRef(snapshot, "e5");
function fixture(fault) {
  const calls = []; const resolutions = [];
  return { calls, resolutions, run: (args) => collectBrowserCommand({ args: ["--controller", lease.controller_id, "--epoch", lease.epoch, "--idempotency-key", "frame-once", ...args], sourceEnvironment: {}, cwd: "/task",
    resolveBackend: async (selection) => { resolutions.push(selection); return { profile: { id: "chosen", transport: { kind: "local" } } }; },
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control: { resource, current_page: page, controller: fault === "lease" ? { ...lease, epoch: "10" } : lease, next_command_sequence: "12" }, pages: [{ page }] } } };
      assert.equal(body.kind, "action");
      if (fault === "response") throw new Error("browser_response_lost");
      return { result: { operation_id: body.authority.operation_id, result: { response: { success: true, data: { frame: null } } } } };
    },
  }) };
}

test.each([
  [["frame", resource.resource_id, "iframe[name=child]"], { kind: "frame", target: { kind: "css", selector: "iframe[name=child]" } }],
  [["--resource", resource.resource_id, "frame", "main"], { kind: "main_frame" }],
  [["frame", ref], { kind: "frame", target: { kind: "reference", reference: { snapshot, element: "e5" } } }],
  [["frame", resource.resource_id, "--selector", "iframe[name=child]"], { kind: "frame", target: { kind: "css", selector: "iframe[name=child]" } }],
  [["exec", resource.resource_id, "--command", "frame 'iframe[name=child]'"], { kind: "frame", target: { kind: "css", selector: "iframe[name=child]" } }],
  [["exec", resource.resource_id, "--command", "frame main"], { kind: "main_frame" }],
])("frame syntax %j retains the existing lease, exact page and journal", async (args, action) => {
  const f = fixture(); const result = await f.run(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  const actions = f.calls.filter((call) => call.kind === "action");
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].action, action);
  assert.deepEqual(actions[0].authority, { lease, page, command_sequence: "12", operation_id: "frame-once" });
});

test("frame selection refuses a stale controller and never retries an uncertain response", async () => {
  const args = ["frame", resource.resource_id, "iframe"];
  const stale = fixture("lease"); const denied = await stale.run(args);
  assert.equal(denied.ok, false); assert.deepEqual(stale.calls.map(call => call.kind), ["observe"]);
  const lost = fixture("response"); const failed = await lost.run(args);
  assert.equal(failed.ok, false); assert.equal(failed.operation_id, "frame-once");
  assert.equal(lost.calls.filter(call => call.kind === "action").length, 1);
});

test("frame syntax cannot inject resource selection or discard an extra argument", async () => {
  for (const args of [
    ["frame", resource.resource_id], ["frame", resource.resource_id, "main", "extra"],
    ["exec", resource.resource_id, "--command", "frame iframe extra"],
    ["exec", resource.resource_id, "--command", "frame iframe --backend peer"],
    ["frame", resource.resource_id, "@e1"],
  ]) {
    const f = fixture(); const result = await f.run(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.deepEqual(f.resolutions, []); assert.deepEqual(f.calls, []);
  }
});
