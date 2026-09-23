import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { managedRuntimeOperation } from "../lib/managed-runtime-rpc.mjs";

// Native app ingress + installed hook + native Host, with synthetic provider
// events reproducing Claude's observed continued-in transcript transition.
export async function runClaudeConversationContinuation({ ownerRoot, discoveryRoot, cli, runtime,
  hook, appHome, appChannel, evidenceRoot }) {
  ownerRoot = fs.realpathSync(ownerRoot);
  assert(path.basename(ownerRoot).startsWith("dure-") && fs.realpathSync(discoveryRoot).startsWith(`${ownerRoot}/`));
  assert(fs.realpathSync(appHome).startsWith(`${ownerRoot}/`));
  const root = fs.mkdtempSync(path.join(ownerRoot, "claude-continuation-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const environment = { PATH: "/usr/bin:/bin", HOME: home, DURE_HOME: appHome,
    HMUX_DISCOVERY_ROOT: discoveryRoot, DURE_APP_CHANNEL: appChannel, TMPDIR: ownerRoot,
    DURE_HMUX_TEST_STATE_ROOT: ownerRoot, TERM: "xterm-256color", LANG: "en_US.UTF-8" };
  const sessionId = path.basename(root);
  const workspaceId = "claude-continuation-workspace";
  const operation = (name, request) => managedRuntimeOperation({ runtime, cwd: root, environment }, name, request);
  const command = args => JSON.parse(execFileSync(cli, ["--discovery-root", discoveryRoot, "--json", ...args],
    { cwd: root, env: environment, timeout: 10000, encoding: "utf8" }));
  const created = await operation("create", {
    schema: "hmux-managed-create-v1", schemaVersion: 1, idempotencyKey: sessionId,
    sessionId, workspaceId, providerId: "claude", permissionMode: "default", providerCwd: root,
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"], initialRows: 24, initialColumns: 80,
  });
  assert.equal(created.state, "completed");
  const session = command(["ls"]).find(item => item.session_id === sessionId);
  assert(session);
  const fence = Object.fromEntries(["session_id", "workspace_id", "runner_principal", "runner_instance",
    "channel_epoch", "host_instance_id", "terminal_epoch"].map(key => [`HMUX_${key.toUpperCase()}`, String(session[key])]));
  const snapshot = () => command(["session", "snapshot", sessionId, "--workspace", workspaceId]);
  const original = "fixture-original";
  const continued = "fixture-continued";
  for (const id of [original, continued]) fs.writeFileSync(path.join(root, `${id}.jsonl`), "{}\n", { mode: 0o600 });
  const report = (event, conversation) => spawnSync(hook, [], {
    cwd: root, env: { ...environment, ...fence }, timeout: 5000, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: event, session_id: conversation,
      prompt_id: "fixture-parent-turn", transcript_path: path.join(root, `${conversation}.jsonl`),
      background_tasks: [], session_crons: [] }),
  });
  assert.equal(report("UserPromptSubmit", original).status, 0);
  const before = snapshot();
  assert.equal(before.agentRuntimeState.activity, "working");
  assert.equal(report("PreToolUse", continued).status, 1, "An unrelated conversation must be refused");
  fs.appendFileSync(path.join(root, `${original}.jsonl`), JSON.stringify({ type: "continued-in",
    sessionId: original, continuedInSessionId: continued }) + "\n");
  const resumed = report("PreToolUse", continued);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(report("Stop", continued).status, 0);
  await delay(2000);
  const after = snapshot();
  assert.equal(after.agentRuntimeState.activity, "waiting");
  assert.equal(after.agentRuntimeState.turn_completed_count, "1");
  assert.equal(report("UserPromptSubmit", original).status, 1, "The predecessor cannot replace its successor");
  assert.equal(snapshot().agentRuntimeState.activity, "waiting");
  const stopped = await operation("stop", {
    schema: "hmux-managed-stop-v1", schemaVersion: 5, stopId: `${sessionId}-cleanup`, sessionId, workspaceId,
    expectedRunnerPrincipal: session.runner_principal, expectedRunnerInstance: session.runner_instance,
    expectedChannelEpoch: Number(session.channel_epoch), expectedHostInstanceId: session.host_instance_id,
    expectedTerminalEpoch: session.terminal_epoch,
    expectedConversation: { providerId: "claude", conversationId: continued },
    expectedQuiescence: { terminalEpoch: after.agentRuntimeState.terminal_epoch,
      runtimeRevision: Number(after.agentRuntimeState.revision), observedThroughOutputSeq: Number(after.sequenceThrough) },
  });
  assert.equal(stopped.state, "completed", "The exact successor identity must satisfy the stop fence: " + JSON.stringify(stopped));
  const evidence = path.join(evidenceRoot, "claude-conversation-continuation.json");
  fs.writeFileSync(evidence, JSON.stringify({ before, after, stopped,
    evidence: "Native app, installed hook and native Host; synthetic Claude continuation events." }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ conversationContinuation: "passed", evidence }));
}
