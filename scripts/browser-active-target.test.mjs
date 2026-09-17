import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "browser:chosen", workspace_id: "workspace:one", generation: "generation:one" };
const target = { workspace_id: resource.workspace_id, generation: resource.generation, revision: "7", current_resource: null };
const selected = { ...target, revision: "8", current_resource: resource };

function fixture({ expected = target, members = [resource], returned = selected, failAt } = {}) {
  const calls = [];
  return {
    calls,
    run: (args) => collectBrowserCommand({ args: [...args, "--idempotency-key", "select:once"],
      resolveBackend: async () => ({ profile: { id: "remote", transport: { kind: "ssh" } } }),
      requestBackend: async (_, { body }) => {
        calls.push(body);
        if (body.kind === failAt) throw new Error("browser_response_lost");
        const result = body.kind === "control_state" ? { resource }
          : body.kind === "list" ? { workspace_id: resource.workspace_id, resources: members.map((resource) => ({ resource })), target: expected }
          : { target: returned };
        return { result: { result } };
      },
    }),
  };
}

test("use selects the exact resource with the observed workspace revision and no input lease", async () => {
  for (const args of [["use", resource.resource_id], ["use", "--resource", resource.resource_id]]) {
    const client = fixture();
    const report = await client.run(args);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(client.calls, [
      { kind: "control_state", resource_id: resource.resource_id },
      { kind: "list", workspace_id: resource.workspace_id },
      { kind: "select_resource", resource, expected: target, operation_id: "select:once" },
    ]);
    assert.deepEqual(report.result, { target: selected });
  }
});

test("selecting the current resource accepts the unchanged revision", async () => {
  const client = fixture({ expected: selected });
  const report = await client.run(["use", resource.resource_id]);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.result.target, selected);
  assert.deepEqual(client.calls.at(-1).expected, selected);
});

test("use refuses stale membership, malformed selection and changed result identities", async () => {
  for (const options of [
    { members: [] }, { members: [{ ...resource, generation: "replacement" }] },
    { expected: null }, { expected: { ...target, revision: "00" } },
    { returned: { ...selected, current_resource: { ...resource, generation: "replacement" } } },
    { returned: { ...selected, revision: "7" } },
  ]) {
    const client = fixture(options);
    const report = await client.run(["use", resource.resource_id]);
    assert.equal(report.error?.code, "browser_response_invalid", JSON.stringify({ options, report }));
    assert.equal(client.calls.length, options.returned ? 3 : 2);
  }
});

test("uncertain selection is never automatically replayed", async () => {
  const client = fixture({ failAt: "select_resource" });
  const report = await client.run(["use", resource.resource_id]);
  assert.equal(report.error?.code, "browser_response_lost");
  assert.equal(report.operation_id, "select:once");
  assert.equal(client.calls.filter((call) => call.kind === "select_resource").length, 1);
});

test("use requires an explicit choice and rejects input options before dispatch", async () => {
  for (const args of [["use", "--worktree", "current"], ["use", resource.resource_id, "--controller", "agent"], ["use", resource.resource_id, "--page", "page:one"]]) {
    const client = fixture();
    const report = await client.run(args);
    assert.equal(report.error?.code, "browser_command_invalid");
    assert.deepEqual(client.calls, []);
  }
});
