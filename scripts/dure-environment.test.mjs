import { it as test } from "vitest";
import assert from "node:assert/strict";
import { parseEnvironmentCommand, runEnvironmentCommand } from "../cli/lib/environment-command.mjs";

test("mutations require exact revision or reviewed recipe digest", () => {
  for (const args of [["create", "--project", "/repo"], ["destroy", "--id", "env-" + "a".repeat(64)],
    ["list", "--backend", "remote"], ["recipes", "--project", "relative"]]) {
    assert.throws(() => parseEnvironmentCommand(args));
  }
  const command = parseEnvironmentCommand(["destroy", "--id", "env-" + "a".repeat(64), "--revision", "4", "--request-id", "stable"]);
  assert.equal(command.body.expectedRevision, 4);
  assert.equal(command.body.idempotencyKey, "stable");
});

test("routes to the local backend and returns retry identity on an uncertain result", async () => {
  const output = [];
  const args = ["create", "--project", "/repo", "--recipe", "vm", "--digest", "sha256:" + "b".repeat(64), "--name", "Task", "--request-id", "create-one"];
  const ok = await runEnvironmentCommand(args, {
    resolveBackend: async (selection) => { assert.deepEqual(selection, { backend: "local", backendSpecified: true }); return { profile: { id: "local" } }; },
    requestBackend: async (_profile, request) => { assert.equal(request.operation, "workspace_environment.invoke"); assert.equal(request.body.idempotencyKey, "create-one"); throw new Error("connection lost"); },
    output: (line) => output.push(JSON.parse(line)),
  });
  assert.equal(ok, false);
  assert.equal(output[0].requestId, "create-one");
});
