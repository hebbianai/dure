import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { hmuxSession } from "./lib/dure-session-test-fixture.mjs";

const sourceEnvironment = {
  HMUX_SESSION_ID: "session-1", HMUX_WORKSPACE_ID: "workspace-1",
  HMUX_RUNNER_PRINCIPAL: "runner", HMUX_RUNNER_INSTANCE: "runner-1",
  HMUX_CHANNEL_EPOCH: "7", HMUX_HOST_INSTANCE_ID: "host-1", HMUX_TERMINAL_EPOCH: "terminal-1",
};
const controller = `session-v1:${createHash("sha256").update(JSON.stringify(Object.values(sourceEnvironment))).digest("hex")}`;
const resource = { resource_id: "browser:one", generation: "generation:one", workspace_id: "workspace:browser" };
const page = { resource, page_id: "page:one", document_revision: "3" };
const selfLease = { resource, controller_id: controller, epoch: "8" };
const humanLease = { ...selfLease, controller_id: "view:human", epoch: "9" };
const operation = "session-action:once";

function client({ session = hmuxSession(), lease = null, env = sourceEnvironment, failAt, race, transport = "local" } = {}) {
  const calls = [];
  const control = { resource, phase: "ready", controller: lease, requested_controller: null, current_page: page, next_command_sequence: "12" };
  let snapshotRevision = "1";
  return { calls, control, run: (args) => collectBrowserCommand({
    args: [...args, "--idempotency-key", operation], sourceEnvironment: env,
    resolveBackend: async () => ({ profile: { id: "selected", transport: { kind: transport } } }),
    requestBackend: async (profile, request) => {
      const { body } = request;
      calls.push(structuredClone({ profile, ...request }));
      if (request.operation === "sessions.show") {
        assert.equal(profile.id, "selected");
        assert.deepEqual(body, { schemaVersion: 1, sessionId: "session-1", workspaceId: "workspace-1" });
        if (failAt === "sessions.show") throw new Error("backend unavailable");
        return { backend: { id: "selected", generation: "backend:one" }, result: { schemaVersion: 1, session } };
      }
      if (body.kind === "control") {
        assert.deepEqual(body.resource, resource);
        assert.deepEqual(body.expected, control.controller);
        control.controller = { resource, controller_id: body.controller_id, epoch: String(BigInt(control.controller?.epoch ?? "7") + 1n) };
        snapshotRevision = String(BigInt(snapshotRevision) + 1n);
      }
      if (body.kind === failAt) throw new Error("browser_response_lost");
      if (body.kind === "observe" && race) race(control);
      if (["action", "profile_set", "profile_clone", "dialog_respond"].includes(body.kind)) {
        assert.deepEqual(body.authority.lease, control.controller);
        assert.equal(body.caller, control.controller.controller_id);
        assert.equal(body.authority.operation_id, operation);
        assert.equal(body.authority.command_sequence, control.next_command_sequence);
      }
      let result = { response: { success: true } };
      if (["control_state", "control"].includes(body.kind)) result = structuredClone(control);
      if (body.kind === "observe") result = { control: structuredClone(control), pages: [{ page }] };
      if (body.kind === "snapshot") result = { snapshot: { page, revision: snapshotRevision }, data: { refs: { e1: { role: "textbox" } } } };
      if (["network_capture_state", "interception_state", "console"].includes(body.kind)) result = { page };
      if (body.kind === "dialog_state") result = { control: structuredClone(control), page, dialog: { identity: { page, sequence: "1" } } };
      return { result: { result } };
    },
  }) };
}

const inputs = [
  ["fill", resource.resource_id, "input", "한글"],
  ["keydown", resource.resource_id, "Shift"], ["keyup", resource.resource_id, "Shift"],
  ["mouse", resource.resource_id, "wheel", "1"],
  ["clipboard", resource.resource_id, "read"],
  ["clipboard", resource.resource_id, "copy"],
  ["clipboard", resource.resource_id, "paste"],
  ["cookie", resource.resource_id, "set", "name", "value"],
  ["storage", resource.resource_id, "local", "set", "key", "value"],
  ["viewport", resource.resource_id, "640", "480"],
  ["wait", resource.resource_id, "function", "true"],
  ["find", resource.resource_id, "text", "Name", "click"],
  ["tab", "switch", resource.resource_id, "--page", page.page_id],
  ["tab", "profile", "set", resource.resource_id, "--profile", "default", "--page", page.page_id],
  ["dialog", resource.resource_id, "accept"],
  ["console", resource.resource_id, "clear"],
  ["capture", resource.resource_id, "start"],
  ["intercept", resource.resource_id, "enable"],
];

test.each(inputs.map((args) => [args]))("verified session defaults feed the existing consumer: %j", async (args) => {
  const c = client();
  const report = await c.run(args);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(c.calls[0].operation, "sessions.show");
  assert.equal(c.calls.filter(({ body }) => body.kind === "control").length, 1);
  const handoff = c.calls.find(({ body }) => body.kind === "control").body;
  assert.equal(handoff.controller_id, controller);
  assert.equal(handoff.expected, null);
  assert.notEqual(handoff.operation_id, operation);
  assert.equal(report.session_controller.controller_id, controller);
  assert.equal(report.session_controller.control_operation_id, handoff.operation_id);
  assert.equal(c.calls.filter(({ body }) => body.authority).length, 1);
});

test("successive commands reuse observed self authority and snapshots claim before producing references", async () => {
  const c = client();
  const snapshot = await c.run(["snapshot", resource.resource_id]);
  assert.equal(snapshot.ok, true);
  assert.deepEqual(c.calls.map(({ body, operation: op }) => body.kind ?? op), ["sessions.show", "control_state", "control", "observe", "snapshot"]);
  const ref = Object.keys(snapshot.references)[0];
  const before = c.calls.length;
  const fill = await c.run(["fill", ref, "한글"]);
  assert.equal(fill.ok, true, JSON.stringify(fill));
  assert.equal(c.calls.slice(before).some(({ body }) => body.kind === "control"), false);
  assert.equal(c.calls.at(-1).body.action.target.reference.snapshot.revision, "2");
});

test.each(inputs.map((args) => [args]))("a human lease is never implicitly taken by %j", async (args) => {
  const c = client({ lease: humanLease });
  const result = await c.run(args);
  assert.equal(result.error.code, "browser_controller_changed");
  assert.equal(c.calls.some(({ body }) => body.kind === "control" || body.authority), false);
});

test("human observation stays passive, explicit handoff takes control once, and Return control resumes at its new epoch", async () => {
  const c = client({ lease: humanLease });
  assert.equal((await c.run(["snapshot", resource.resource_id])).ok, true);
  assert.equal(c.calls.some(({ body }) => body.kind === "control"), false);
  assert.equal((await c.run(["control", resource.resource_id])).ok, true);
  const transfers = c.calls.filter(({ body }) => body.kind === "control");
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].body.operation_id, operation);
  assert.deepEqual(transfers[0].body.expected, humanLease);
  c.control.controller = { ...selfLease, epoch: "14" };
  assert.equal((await c.run(inputs[0])).ok, true);
  assert.equal(c.calls.at(-1).body.authority.lease.epoch, "14");
  assert.equal(c.calls.filter(({ body }) => body.kind === "control").length, 1);
});

test.each(Object.keys(sourceEnvironment))("incomplete or changed source %s cannot authorize input", async (field) => {
  for (const value of [undefined, "wrong", "", "line\nbreak"]) {
    const c = client({ env: { ...sourceEnvironment, [field]: value } });
    const result = await c.run(inputs[0]);
    assert.equal(result.ok, false);
    assert.equal(c.calls.some(({ body }) => body.kind === "control" || body.authority), false);
  }
});

test.each(["unprobed", "stale_transport", "generation_changed", "exited", "incompatible_protocol"])("%s session cannot supply a controller", async (health) => {
  const c = client({ session: hmuxSession(1, { health }) });
  assert.equal((await c.run(inputs[0])).ok, false);
  assert.equal(c.calls.some(({ body }) => body.kind === "control" || body.authority), false);
});

test.each(["manifestLifecycle", "effectiveLifecycle"])("a contradictory %s cannot certify a live caller", async (field) => {
  const c = client({ session: hmuxSession(1, { [field]: "exited" }) });
  assert.equal((await c.run(inputs[0])).ok, false);
  assert.equal(c.calls.some(({ body }) => body.kind === "control" || body.authority), false);
});

test("a failed session lookup does not fall back to environment or Browser ownership", async () => {
  const c = client({ lease: selfLease, failAt: "sessions.show" });
  assert.equal((await c.run(inputs[0])).error.code, "browser_session_unavailable");
  assert.equal(c.calls.length, 1);
});

test.each([
  { controller: undefined }, { controller: { ...selfLease, epoch: "01" } },
  { controller: { ...selfLease, epoch: "18446744073709551616" } },
  { controller: { ...selfLease, resource: { ...resource, generation: "other" } } },
  { resource: { ...resource, resource_id: "other" } }, { phase: "outcome_unknown" },
])("malformed or unavailable Host control cannot authorize input: %j", async (override) => {
  const c = client();
  Object.assign(c.control, override);
  assert.equal((await c.run(inputs[0])).ok, false);
  assert.equal(c.calls.some(({ body }) => body.kind === "control" || body.authority), false);
});

test.each(["local", "ssh"])("caller verification is against the selected %s backend", async (transport) => {
  const c = client({ transport, lease: selfLease });
  assert.equal((await c.run(inputs[0])).ok, true);
  assert.equal(c.calls[0].profile.transport.kind, transport);
  assert.deepEqual(c.calls[0].requiredCapabilities, ["sessions.show"]);
});

test("explicit, incomplete and stale authority flags never get repaired from the session", async () => {
  for (const flags of [["--controller", controller, "--epoch", "8"], ["--controller", controller], ["--epoch", "8"], ["--controller", controller, "--epoch", "1"]]) {
    const c = client({ lease: selfLease });
    const result = await c.run([...inputs[0], ...flags]);
    assert.equal(result.ok, flags.length === 4 && flags[3] === "8");
    assert.equal(c.calls.some(({ operation: op, body }) => op === "sessions.show" || body.kind === "control"), false);
  }
});

test("ordinary reads and missing session context preserve existing behavior", async () => {
  for (const args of [["get", resource.resource_id, "url"], ["wait", resource.resource_id, "text", "Ready"], ["show", resource.resource_id], ["console", resource.resource_id]]) {
    const c = client({ env: { HMUX_SESSION_ID: "incomplete" } });
    assert.equal((await c.run(args)).ok, true);
    assert.equal(c.calls.some(({ operation: op, body }) => op === "sessions.show" || body.kind === "control"), false);
  }
  const c = client({ env: {} });
  assert.equal((await c.run(inputs[0])).ok, false);
  assert.equal(c.calls.some(({ body }) => body.kind === "control"), false);
});

test.each(["control", "action"])("lost %s response reports both recovery identities without replaying", async (failAt) => {
  const c = client({ failAt });
  const result = await c.run(inputs[0]);
  assert.equal(result.error.code, "browser_response_lost");
  assert.equal(result.operation_id, operation);
  assert.equal(result.session_controller.control_operation_id, c.calls.find(({ body }) => body.kind === "control").body.operation_id);
  assert.equal(c.calls.filter(({ body }) => body.kind === failAt).length, 1);
  if (failAt === "control") assert.equal(c.calls.some(({ body }) => body.authority), false);
});

test("post-claim human takeover, resource replacement and pending transfer fence input without retry", async () => {
  for (const race of [
    (control) => { control.controller = humanLease; },
    (control) => { control.resource = { ...resource, generation: "replacement" }; },
  ]) {
    const c = client({ race });
    assert.equal((await c.run(inputs[0])).ok, false);
    assert.equal(c.calls.filter(({ body }) => body.kind === "control").length, 1);
    assert.equal(c.calls.some(({ body }) => body.authority), false);
  }
  const pending = client({ lease: selfLease });
  pending.control.requested_controller = "view:human";
  assert.equal((await pending.run(inputs[0])).ok, false);
  assert.equal(pending.calls.some(({ body }) => body.kind === "control" || body.authority), false);
});
