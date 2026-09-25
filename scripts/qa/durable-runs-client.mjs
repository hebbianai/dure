import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";
import { readDescriptor, requestDevLaunchRestart } from "../lib/dev-launch-client.mjs";
import { observeRestartApp } from "./pane-app-restart-client.mjs";
const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
assert.equal(home, path.join(root, "home"));
assert(path.basename(root).startsWith("dure-durable-runs."));
const cliPath = fileURLToPath(new URL("../../cli/dure.mjs", import.meta.url));
const environment = { ...process.env };
delete environment.HMUX_SESSION_ID;
delete environment.HMUX_WORKSPACE_ID;
const cli = (...args) => {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    cwd: home, env: environment, encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
};
let descriptor;
async function waitForWindows() {
  for (const windowLabel of ["main", "win-run-peer"]) {
    const deadline = Date.now() + 180_000;
    for (;;) {
      try {
        descriptor = JSON.parse(fs.readFileSync(process.env.DURE_QA_SERVER_DESCRIPTOR, "utf8"));
        await requestAppControl({ descriptor, path: "/diagnostics", body: { windowLabel }, timeoutMs: 2_000 });
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await delay(100);
      }
    }
  }
}
await waitForWindows();
const repo = path.join(home, "repo");
fs.mkdirSync(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, env: withoutLocalGitOverrides(), encoding: "utf8" });
git("init", "--initial-branch=main");
git("-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "--allow-empty", "-m", "Fixture");
cli("projects", "register", "durable-runs-qa", "--path", repo);
const space = cli("client", "space", "create", "--name", "Run recovery QA").space.spaceId;
fs.writeFileSync(path.join(root, "provider-capture", "enable-transcript"), "");
const launched = cli("run", "--project", "durable-runs-qa", "--name", "headless-qa", "--worktree", "headless-qa", "ok");
assert.equal(launched.presentation.state, "headless");
assert.equal(launched.registration.state, "registered");
assert.equal(launched.receipt.plan.request.executionProfile.kind, "provider_default");
const agentId = launched.receipt.plan.agentId;
const catalog = cli("runs", "list");
assert(catalog.runs.some((run) => run.agentId === agentId && run.name === "headless-qa"));
const before = cli("runs", "show", "headless-qa");
const originalSession = before.runtime.receipt.authority.authority.binding.sessionId;
const environmentPath = path.join(root, "provider-capture", `${originalSession}-launch.json`);
const evidenceDeadline = Date.now() + 10_000;
while (!fs.existsSync(environmentPath)) {
  assert(Date.now() < evidenceDeadline, "fake provider did not publish launch evidence");
  await delay(50);
}
const environmentEvidence = fs.readFileSync(environmentPath, "utf8");
const launchedEnvironment = JSON.parse(environmentEvidence);
assert.equal(launchedEnvironment.DURE_APP_CHANNEL, environment.DURE_APP_CHANNEL);
for (const key of ["DURE_BUILD_ID", "DURE_DEV_LAUNCH_GENERATION", "DURE_BACKEND_RUNTIME_FINGERPRINT", "HEBBIAN_HMUX_BIN", "TAURI_CONFIG"]) assert.equal(launchedEnvironment[key], null, key);
assert.equal(launchedEnvironment.DURE_HOME, environment.DURE_HOME);
assert.equal(launchedEnvironment.HMUX_DISCOVERY_ROOT, environment.HMUX_DISCOVERY_ROOT);
const registered = cli("inspect", originalSession, "--workspace", before.run.workspaceId);
assert.equal(registered.session.clientProjection.agents[0].name, "headless-qa");
cli("send", originalSession, "--workspace", before.run.workspaceId, "ok");
await delay(1500);
const opened = [];
for (let attempt = 0; attempt < 5; attempt++) {
  const report = cli("runs", "open", agentId, "--space", space);
  assert.equal(report.presentation.state, "opened");
  assert.equal(report.presentation.pane.sessionId, originalSession);
  opened.push(report.presentation.pane);
}
assert.equal(new Set(opened.map((pane) => pane.panelId)).size, 1);
// Repeated presentation must neither deliver the initial prompt nor create a provider.
const shown = cli("runs", "show", agentId);
assert.equal(shown.runtime.receipt.authority.authority.binding.sessionId, originalSession);
const recovery = cli("runs", "resume", agentId, "--confirm-restart");
assert.equal(recovery.recovery.publication, "published");
const after = cli("runs", "show", agentId);
const successor = after.runtime.receipt.authority.authority.binding.sessionId;
assert.notEqual(successor, originalSession);
const reopened = cli("runs", "open", agentId, "--space", space);
assert.equal(reopened.presentation.pane.sessionId, successor);
assert.equal(cli("runs", "list").runs.filter((run) => run.agentId === agentId).length, 1);
// Retire the owned test Agent while its Host can publish an exited tombstone,
// before the runner freezes the application group during cleanup.
cli("stop", agentId, "--yes");
// Keep another Run headless throughout provider exit and native app restart.
// Its catalog and exact continuation must survive without a pane owning them.
const exitedLaunch = cli("run", "--project", "durable-runs-qa", "--name", "exited-headless-qa",
  "--worktree", "exited-headless-qa", "crash-after-ready");
assert.equal(exitedLaunch.presentation.state, "headless");
const exitedAgentId = exitedLaunch.receipt.plan.agentId;
const exitedBefore = cli("runs", "show", exitedAgentId);
const exitedSession = exitedBefore.runtime.receipt.authority.authority.binding.sessionId;
const exitedWorkspace = exitedBefore.run.workspaceId;
// This fixture selects its scripted scenario from terminal input, not argv.
cli("send", exitedSession, "--workspace", exitedWorkspace, "crash-after-ready");
const hostSessions = () => JSON.parse(execFileSync(process.env.DURE_HMUX_BIN,
  ["--discovery-root", process.env.HMUX_DISCOVERY_ROOT, "--json", "ls"],
  { env: environment, encoding: "utf8", timeout: 10_000 }));
const exitDeadline = Date.now() + 30_000;
while (!hostSessions().some((session) => session.session_id === exitedSession && session.lifecycle === "exited")) {
  assert(Date.now() < exitDeadline, "headless provider did not publish its exited tombstone");
  await delay(100);
}
const appBeforeRestart = await observeRestartApp(descriptor, { channel: environment.DURE_APP_CHANNEL, stateRoot: root });
const worktreeRoot = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const { value: supervisor } = readDescriptor({ home, channel: environment.DURE_APP_CHANNEL, worktreeRoot });
assert.equal(supervisor.state, "ready");
const restart = await requestDevLaunchRestart({ root: worktreeRoot, home,
  channel: environment.DURE_APP_CHANNEL, expectedAuthority: supervisor });
await waitForWindows();
const appAfterRestart = await observeRestartApp(descriptor, { channel: environment.DURE_APP_CHANNEL, stateRoot: root });
assert.notEqual(appAfterRestart.processIdentity, appBeforeRestart.processIdentity);
assert.notEqual(appAfterRestart.generation, appBeforeRestart.generation);
assert.equal(cli("runs", "list").runs.filter((run) => run.agentId === exitedAgentId).length, 1);
assert.equal(cli("runs", "show", exitedAgentId).runtime.receipt.authority.authority.binding.sessionId, exitedSession);
const exitedRecovery = cli("runs", "resume", exitedAgentId, "--confirm-restart");
assert.equal(exitedRecovery.recovery.publication, "published");
const recoveredSession = cli("runs", "show", exitedAgentId).runtime.receipt.authority.authority.binding.sessionId;
assert.notEqual(recoveredSession, exitedSession);
let recoveredPane;
try {
  const recoveredInspection = JSON.parse(execFileSync(process.env.DURE_HMUX_BIN,
    ["--discovery-root", process.env.HMUX_DISCOVERY_ROOT, "--json", "session", "show", recoveredSession,
      "--workspace", exitedWorkspace], { env: environment, encoding: "utf8", timeout: 10_000 }));
  assert.equal(recoveredInspection.providerConversationIdentity.conversation_id, exitedSession);
  recoveredPane = cli("runs", "open", exitedAgentId, "--space", space);
  assert.equal(recoveredPane.presentation.pane.sessionId, recoveredSession);
} finally {
  cli("stop", exitedAgentId, "--yes");
}
fs.writeFileSync(path.join(root, "evidence", "durable-runs.json"), JSON.stringify({
  catalog, launchedEnvironment, originalSession, opened, recovery, successor, reopened,
  exitedLaunch, exitedSession, restart, appBeforeRestart, appAfterRestart, exitedRecovery, recoveredSession, recoveredPane,
  evidence: "Native macOS app with two WebViews and a disposable fake-provider PTY; no provider account used.",
}, null, 2));
console.log("Durable Runs: headless discovery, repeated multi-window open, live recovery, provider exit, native app restart and exact conversation resume passed.");
