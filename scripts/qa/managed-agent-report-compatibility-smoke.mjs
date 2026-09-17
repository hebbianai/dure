import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { managedRuntimeOperation } from "./lib/managed-runtime-rpc.mjs";

const root = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
const discovery = fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT);
assert(path.basename(root).startsWith("dure-hmux-test.") && discovery.startsWith(`${root}/`));
const current = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
assert.equal(process.argv.length, 3, "Supply one actual pre-causality runtime binary");
const legacy = fs.realpathSync(process.argv[2]);
assert.notEqual(legacy, current);
for (const directory of ["home", "dure", "tmp"]) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
const environment = {
  PATH: "/usr/bin:/bin", HOME: path.join(root, "home"), DURE_HOME: path.join(root, "dure"),
  HMUX_DISCOVERY_ROOT: discovery, TMPDIR: path.join(root, "tmp"),
  DURE_HMUX_TEST_STATE_ROOT: root, LANG: "en_US.UTF-8", TERM: "xterm-256color",
};
const evidence = fs.mkdtempSync(path.join(path.dirname(root), "dure-report-compatibility-evidence-"));
console.log(JSON.stringify({ evidence }));
const receipts = [];
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const operation = (runtime, name, request) => managedRuntimeOperation({ runtime, cwd: root, environment }, name, request);
const command = args => JSON.parse(execFileSync(cli, ["--discovery-root", discovery, "--json", ...args],
  { env: environment, cwd: root, timeout: 10000, encoding: "utf8" }));
const capability = "agent_state_report_causality_v1";

for (const [kind, runtime] of [["legacy", legacy], ["current", current]]) {
  const sessionId = `report-compatibility-${kind}`;
  const workspaceId = "report-compatibility";
  const created = await operation(runtime, "create", {
    schema: "hmux-managed-create-v1", schemaVersion: 1, idempotencyKey: sessionId,
    sessionId, workspaceId, providerId: "claude", permissionMode: "default", providerCwd: root,
    command: ["/bin/cat"], initialRows: 24, initialColumns: 80,
  });
  assert.equal(created.state, "completed", JSON.stringify(created));
  const session = command(["ls"]).find(item => item.session_id === sessionId);
  assert(session);
  const snapshot = () => command(["session", "snapshot", sessionId, "--workspace", workspaceId]);
  const fence = Object.fromEntries(["workspace_id", "session_id", "runner_principal", "runner_instance",
    "channel_epoch", "host_instance_id", "terminal_epoch"].map(key => [key, session[key]]));
  const report = (activity, causality, completed = false) => ({
    schema: "hmux-managed-agent-state-report-v1", schemaVersion: causality ? 2 : 1,
    expectedFence: fence,
    report: { request_id: "compatibility-report", identity_only: false, activity, attention: "none",
      turn_completed: completed, ...(completed ? { turn_completion_id: causality.work_id } : {}),
      ...(causality ? { causality } : {}), ...(activity === "working" ? { working_ttl_ms: "86400000" } : {}) },
  });
  const send = async (broker, request) => {
    const receipt = await operation(broker, "agent-state-report", request);
    receipts.push({ host: kind, broker: broker === legacy ? "legacy" : "current", request, receipt });
    fs.writeFileSync(path.join(evidence, "receipts.json"), JSON.stringify(receipts, null, 2), { mode: 0o600 });
    return receipt;
  };
  const begin = report("working", { sequence: "20", work_id: "current-work" });
  // Capture these envelopes before newer work, then deliver them afterwards.
  // No receiver-created timestamp or metadata rewriting can hide the ordering.
  const delayedBegin = report("working", { sequence: "10", work_id: "old-work" });
  const delayedStop = report("waiting", { sequence: "11", work_id: "old-work" }, true);
  assert.equal((await send(legacy, report("working"))).state, "completed");
  const before = snapshot().agentRuntimeState;
  assert.equal(before.activity, "working");
  const refusedByOldBroker = await send(legacy, begin);
  assert.equal(refusedByOldBroker.state, "refused");
  assert.equal(refusedByOldBroker.payload.code, "hmux_managed_agent_state_report_request_invalid");
  assert.deepEqual(snapshot().agentRuntimeState, before);
  if (kind === "legacy") {
    const refused = await send(current, begin);
    assert.equal(refused.state, "refused");
    assert.equal(refused.payload.code, "hmux_capability_missing");
    assert(refused.payload.message.includes(capability));
    assert.deepEqual(snapshot().agentRuntimeState, before);
    assert.equal((await send(current, report("waiting"))).state, "completed");
  } else {
    assert.equal((await send(current, report("waiting", { sequence: "1" }))).state, "completed");
    assert.deepEqual(snapshot().agentRuntimeState, before, "A delayed first bootstrap ended existing work");
    assert.equal((await send(current, begin)).state, "completed");
    const admitted = snapshot().agentRuntimeState;
    for (const delayed of [delayedBegin, delayedStop]) {
      assert.equal((await send(current, delayed)).state, "completed");
    }
    await delay(2000);
    assert.deepEqual(snapshot().agentRuntimeState, admitted);
    assert.equal((await send(current, report("waiting", { sequence: "21", work_id: "current-work" }, true))).state, "completed");
    await delay(2000);
  }
  const settled = snapshot();
  assert.equal(settled.agentRuntimeState.activity, "waiting");
  assert.equal(settled.agentRuntimeState.turn_completed_count, kind === "current" ? "1" : "0");
  const stopped = await operation(current, "stop", {
    schema: "hmux-managed-stop-v1", schemaVersion: 5, stopId: `compatibility-stop-${kind}`,
    sessionId, workspaceId, expectedRunnerPrincipal: session.runner_principal,
    expectedRunnerInstance: session.runner_instance, expectedChannelEpoch: Number(session.channel_epoch),
    expectedHostInstanceId: session.host_instance_id, expectedTerminalEpoch: session.terminal_epoch,
    expectedQuiescence: { terminalEpoch: settled.agentRuntimeState.terminal_epoch,
      runtimeRevision: Number(settled.agentRuntimeState.revision), observedThroughOutputSeq: Number(settled.sequenceThrough) },
    expectedConversation: { providerId: "claude", conversationId: null },
  });
  assert.equal(stopped.state, "completed", JSON.stringify(stopped));
  assert.equal(stopped.payload.outcome, "stopped");
}
const result = { ok: true, receipts, legacyRuntimeSha256: digest(legacy), currentRuntimeSha256: digest(current),
  caveat: "Actual two-version Host/broker and encoded transport; shell provider fixture, not native provider or live stability proof." };
fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ok: true, evidence, legacyRuntimeSha256: result.legacyRuntimeSha256, currentRuntimeSha256: result.currentRuntimeSha256 }));
