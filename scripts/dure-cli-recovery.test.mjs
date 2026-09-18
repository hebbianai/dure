import assert from "node:assert/strict";
import { test } from "vitest";
import { parseRecoveryCommand, runRecoveryCommand } from "../cli/lib/recovery-command.mjs";

const profile = { schemaVersion: 1, providerId: "codex", referenceId: "team",
  credentialGeneration: "registered-generation" };
const accounts = [{ profile, name: "Team account" }];

function fixture(requestBackend) {
  const output = [];
  const routes = [];
  return { output, routes, options: {
    resolveBackend: async (selection) => {
      routes.push(selection);
      return { profile: { id: "shared", transport: { kind: "ssh_stdio" } },
        transportOptions: { deadlineMs: 5000 } };
    }, requestBackend, output: (text) => output.push(JSON.parse(text)),
  } };
}

test("recovery settings use the selected backend and exact policy revision without registering accounts", async () => {
  const requests = [];
  const f = fixture(async (route, request, options) => {
    requests.push({ route, request, options });
    return { result: { schemaVersion: 1, policy: { revision: 4 } } };
  });
  assert.equal(await runRecoveryCommand(["put", "codex", "--enabled", "true", "--accounts",
    JSON.stringify(accounts), "--expected-revision", "3", "--idempotency-key", "same-request",
    "--backend", "shared", "--json"], f.options), true);
  assert.deepEqual(f.routes, [{ backend: "shared", backendSpecified: true }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route.id, "shared");
  assert.deepEqual(requests[0].request, { operation: "provider_recovery.put",
    requiredCapabilities: ["account_recovery.v1"], body: {
      schemaVersion: 1, providerId: "codex", expectedRevision: 3,
      idempotencyKey: "same-request", enabled: true, accounts,
    } });
  assert.equal(f.output[0].policy.revision, 4);
});

test("a lost mutation response exposes the same retry identity and does not retry or change accounts", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error("connection closed"); });
  assert.equal(await runRecoveryCommand(["put", "codex", "--enabled", "false", "--accounts", "[]",
    "--expected-revision", "4", "--idempotency-key", "retain-key"], f.options), false);
  assert.equal(calls, 1);
  assert.equal(f.output[0].idempotencyKey, "retain-key");
});

test("status is read only and returns the backend outcome unchanged", async () => {
  const result = { schemaVersion: 1, recovery: { attemptId: "attempt-a", failureItemId: "failure-a",
    target: accounts[0], stopped: null, turnState: "uncertain", createdAtMs: 123 } };
  const f = fixture(async (_, request) => {
    assert.equal(request.operation, "agent_recovery.read");
    assert.deepEqual(request.body, { schemaVersion: 1, agentId: "agent-a" });
    return { result };
  });
  assert.equal(await runRecoveryCommand(["status", "agent-a"], f.options), true);
  assert.deepEqual(f.output, [result]);
});

test("optional unknown telemetry reaches the backend without a credential availability probe", async () => {
  const observations = [{ profile, usedPercent: null, observedAtMs: 123 }];
  const f = fixture(async (_, request) => {
    assert.equal(request.operation, "provider_recovery.observe_usage");
    assert.deepEqual(request.body, { schemaVersion: 1, observations });
    return { result: { schemaVersion: 1 } };
  });
  assert.equal(await runRecoveryCommand(["observe", "--observations", JSON.stringify(observations)], f.options), true);
});

test("policy edits require an explicit revision, setting and account pool", () => {
  for (const args of [
    ["put", "codex"],
    ["put", "codex", "--enabled", "true", "--accounts", "[]"],
    ["put", "codex", "--enabled", "true", "--expected-revision", "0"],
    ["get", "codex", "--accounts", "[]"],
  ]) assert.throws(() => parseRecoveryCommand(args));
});
