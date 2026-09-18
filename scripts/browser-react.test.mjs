import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "browser:react", workspace_id: "workspace:react", generation: "generation:react" };
const page = { resource, page_id: "page:one", document_revision: "4" };
const lease = { resource, controller_id: "agent:react", epoch: "2" };
const control = { resource, controller: lease, current_page: page, next_command_sequence: "7" };

function fixture({ controlled = true, lost = false, environment = {} } = {}) {
  const calls = [];
  return { calls, run: args => collectBrowserCommand({
    args: ["--idempotency-key", "react-once", ...(controlled ? ["--controller", lease.controller_id, "--epoch", lease.epoch] : []), ...args],
    sourceEnvironment: environment, cwd: "/fixture",
    resolveBackend: async () => ({ profile: { id: "selected", transport: { kind: "ssh" } } }),
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control, pages: [{ page }] } } };
      if (lost) throw new Error("browser_response_lost");
      return { result: { result: { response: { success: true, data: { nodes: [{ id: 3, name: "Counter" }] } } } } };
    },
  }) };
}

test.each([
  [["react", resource.resource_id, "tree"], { kind: "tree" }],
  [["react", resource.resource_id, "inspect", "3"], { kind: "inspect", fiber_id: 3 }],
  [["react", resource.resource_id, "renders"], { kind: "renders_start" }],
  [["react", resource.resource_id, "renders", "start"], { kind: "renders_start" }],
  [["react", resource.resource_id, "renders", "stop"], { kind: "renders_stop" }],
  [["react", resource.resource_id, "suspense"], { kind: "suspense", only_dynamic: false }],
  [["react", resource.resource_id, "suspense", "--only-dynamic"], { kind: "suspense", only_dynamic: true }],
  [["exec", resource.resource_id, "--command", "react tree --json"], { kind: "tree" }],
  [["exec", resource.resource_id, "--command", "react inspect 3 --json"], { kind: "inspect", fiber_id: 3 }],
  [["exec", resource.resource_id, "--command", "react renders"], { kind: "renders_start" }],
  [["exec", resource.resource_id, "--command", "react renders stop --json"], { kind: "renders_stop" }],
  [["exec", resource.resource_id, "--command", "react suspense --only-dynamic --json"], { kind: "suspense", only_dynamic: true }],
])("React command %j retains the selected controller, document and journal", async (args, action) => {
  const f = fixture(); const result = await f.run(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.map(call => call.kind), ["observe", "action"]);
  assert.deepEqual(f.calls[1], {
    kind: "action", caller: lease.controller_id,
    authority: { lease, page, operation_id: "react-once", command_sequence: "7" },
    action: { kind: "react", action },
  });
  assert.deepEqual(result.result.response.data.nodes, [{ id: 3, name: "Counter" }]);
});

test("React hook installation is explicit creation input, including the upstream environment alias", async () => {
  for (const [args, environment] of [
    [["create", "--enable", "react-devtools"], {}],
    [["create", "--enable=react"], {}],
    [["create"], { AGENT_BROWSER_ENABLE: "react-devtools" }],
  ]) {
    const f = fixture({ environment }); const result = await f.run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.calls, [{ kind: "create", operation_id: "react-once", features: ["react_devtools"] }]);
  }
});

test("React introspection cannot acquire foreign control or replay after response loss", async () => {
  const denied = fixture({ controlled: false });
  assert.equal((await denied.run(["react", resource.resource_id, "tree"])).ok, false);
  assert.equal(denied.calls.filter(call => call.kind === "action").length, 0);
  const lost = fixture({ lost: true });
  const result = await lost.run(["react", resource.resource_id, "renders", "start"]);
  assert.equal(result.ok, false);
  assert.equal(result.operation_id, "react-once");
  assert.equal(lost.calls.filter(call => call.kind === "action").length, 1);
});

test.each([
  ["react", resource.resource_id, "inspect"],
  ["react", resource.resource_id, "inspect", "3;alert(1)"],
  ["react", resource.resource_id, "inspect", "9007199254740992"],
  ["react", resource.resource_id, "tree", "--only-dynamic"],
  ["react", resource.resource_id, "renders", "reset"],
  ["exec", resource.resource_id, "--command", "react tree --page foreign"],
  ["create", "--enable", "unknown-feature"],
  ["react", resource.resource_id, "tree", "--enable", "react-devtools"],
].map(args => [args]))("invalid React request %j fails before backend contact", async args => {
  const f = fixture(); assert.equal((await f.run(args)).ok, false); assert.deepEqual(f.calls, []);
});
