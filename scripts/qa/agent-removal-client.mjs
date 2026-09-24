import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { assertIsolatedCleanupBoundary } from "./lib/isolated-hmux-session-cleanup.mjs";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";

const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
assertIsolatedCleanupBoundary(root, process.env.HMUX_DISCOVERY_ROOT);
assert.equal(home, path.join(root, "home"));
const file = path.join(home, "agent-removal-result.json");
const deadline = Date.now() + 120_000;
const removalRequest = path.join(home, "remove-fixture-worktree.json");
let removedFixtureWorktree = false;
while (!fs.existsSync(file)) {
	assert(Date.now() < deadline, "No frontend removal report");
	if (!removedFixtureWorktree && fs.existsSync(removalRequest)) {
		const request = JSON.parse(fs.readFileSync(removalRequest, "utf8"));
		assert.equal(request.runId, process.env.VITE_DURE_AGENT_REMOVAL_QA_RUN_ID);
		const repo = path.join(home, "repo");
		const worktree = path.join(repo, ".worktrees", "already-absent");
		assert.equal(request.worktree, worktree);
		assert.equal(fs.realpathSync(worktree), worktree);
		// Only this empty, disposable checkout is removed externally to model a
		// stale registration. Runtime cleanup remains owned by the real dialog.
		execFileSync(process.env.DURE_QA_REAL_GIT, ["-C", repo, "worktree", "remove", "--force", worktree], {
			cwd: home, env: withoutLocalGitOverrides(), timeout: 10_000,
		});
		assert.equal(fs.existsSync(worktree), false);
		fs.writeFileSync(path.join(home, "fixture-worktree-removed.json"), request.runId, { flag: "wx", mode: 0o600 });
		removedFixtureWorktree = true;
	}
	await delay(100);
}
const result = JSON.parse(fs.readFileSync(file, "utf8"));
fs.writeFileSync(
	path.join(root, "evidence", "agent-removal.json"),
	JSON.stringify(result, null, 2),
	{ flag: "wx", mode: 0o600 },
);
assert.equal(result.runId, process.env.VITE_DURE_AGENT_REMOVAL_QA_RUN_ID);
const queries = fs.readFileSync(path.join(root, "git-queries.jsonl"), "utf8")
	.trim().split("\n").map((line) => JSON.parse(line));
const refreshCase = result.cases.find((entry) => entry.scenario === "refresh");
const overlap = queries.filter((query) =>
	query.status === 0 && query.args.includes(refreshCase?.worktree) &&
	refreshCase.refreshTimes.some((time) =>
		time >= query.startedAt && time <= query.finishedAt));
assert(overlap.length > 0, "Projection refresh never overlapped a real Git query");
fs.writeFileSync(
	path.join(root, "evidence", "git-query-overlap.json"),
	JSON.stringify(overlap, null, 2),
	{ flag: "wx", mode: 0o600 },
);
assert.equal(result.result, "passed", JSON.stringify(result));
assert.deepEqual(result.paneStops.map((entry) => entry.scenario), ["exact", "exact-cleanup-retry", "exact-stale-binding-retry", "exact-fenceless-retry", "chain-cleanup-retry", "exact-archived-cleanup-retry", "chain-archived-cleanup-retry"]);
assert(result.paneStops.every((entry) => entry.stopCalls === 1));
assert(result.paneStops.every((entry) => entry.cleanupCalls === 1), "Completed stop retried discovery archival");
for (const entry of result.paneStops) {
	const exactStop = entry.first.stop.stopReceipt ?? entry.first.stop;
	assert.equal(exactStop.terminalEpoch, entry.runtimeTerminalEpoch);
	if (entry.scenario !== "chain-cleanup-retry" && entry.scenario !== "chain-archived-cleanup-retry") {
		assert.equal(entry.retirement.kind, "finalized");
		assert.deepEqual(entry.retirement.receipt, exactStop);
	}
	if (entry.scenario === "exact-stale-binding-retry") {
		assert.notEqual(entry.registeredTerminalEpoch, entry.runtimeTerminalEpoch);
	} else if (entry.scenario === "exact-fenceless-retry" || entry.scenario === "exact-archived-cleanup-retry") {
		assert.equal(entry.registeredTerminalEpoch, null);
	}
	if (entry.scenario === "exact-archived-cleanup-retry" || entry.scenario === "chain-archived-cleanup-retry") {
		assert.equal(entry.archival.outcome, "retired");
		assert.equal(entry.archival.sessionId, entry.sessionId);
		assert.equal(entry.archival.workspaceId, exactStop.workspaceId);
		assert.deepEqual(entry.archival.generation.fence, {
			sessionId: exactStop.sessionId,
			workspaceId: exactStop.workspaceId,
			runnerPrincipal: exactStop.runnerPrincipal,
			runnerInstance: exactStop.runnerInstance,
			channelEpoch: String(exactStop.channelEpoch),
			hostInstanceId: exactStop.hostInstanceId,
			terminalEpoch: exactStop.terminalEpoch,
		});
		assert.equal(entry.discoveryAbsentBeforeReplay, true);
		assert.equal(entry.sourceLifecycle, "absent");
	}
}
for (const replayedStop of result.paneStops.filter((entry) => entry.scenario !== "exact")) {
	assert.equal(replayedStop.first.ok, false);
	assert.equal(replayedStop.preparedReplayKind, "completed");
	assert.deepEqual(replayedStop.preparedReplayReceipt, replayedStop.first.stop);
	assert.equal(replayedStop.replay.ok, true);
	assert.deepEqual(replayedStop.replay.stop, replayedStop.first.stop);
}
const [absent, refresh, newcomer] = result.cases;
assert.equal(absent.scenario, "already-absent");
assert.equal(absent.outcome, "removed");
assert.equal(fs.existsSync(absent.worktree), false);
assert.equal(refresh.outcome, "removed");
assert.equal(fs.existsSync(refresh.worktree), false, "Dedicated checkout was not physically removed");
assert.equal(newcomer.outcome, "scope-changed");
assert.equal(fs.existsSync(newcomer.worktree), true, "Changed scope lost its checkout");
const hmux = (...args) => JSON.parse(execFileSync(
	process.env.DURE_QA_HMUX_CLI,
	["--discovery-root", process.env.HMUX_DISCOVERY_ROOT, "--json", ...args],
	{ cwd: home, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
));
for (const sessionId of [absent.absentPeerSessionId, newcomer.sessionId, newcomer.newcomerSessionId]) {
	const session = hmux("session", "show", sessionId);
	assert.equal(session.lifecycle, "ready", "Changed scope stopped a running session");
}
assert(!hmux("ls").some((session) => (session.session_id ?? session.sessionId) === refresh.sessionId), "Removed session is still discoverable");
assert(!hmux("ls").some((session) => (session.session_id ?? session.sessionId) === absent.sessionId), "Already-absent checkout left its selected session behind");
console.log("Real Remove dialog: projection refresh removed exact session/checkout; new user retained both sessions and checkout.");
console.log("Native CLI handler: neutral pane exact/chain cleanup replay, including stale and missing binding fences, passed without a second stop.");

// Exercise the public CLI against this disposable app and a canonical native
// Run. The fake provider is a real owned PTY process, with no provider login.
const cli = fileURLToPath(new URL("../../cli/dure.mjs", import.meta.url));
const runCli = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, "--json"], {
	cwd: home, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
}));
const space = runCli("client", "space", "create", "--name", "Canonical stop QA");
assert(space.space?.spaceId, "The app did not create the QA Space");
runCli("projects", "register", "qa-canonical-stop", "--path", path.join(home, "repo"));
const created = runCli("run", "--project", "qa-canonical-stop", "--provider", "claude",
	"--name", "canonical-stop-qa", "--worktree", "canonical-stop-qa", "--space", space.space.spaceId,
	"--idempotency-key", `stop-cli-${result.runId}`, "ok");
assert.equal(created.receipt?.state, "succeeded", JSON.stringify(created));
assert.equal(created.presentation?.state, "opened", "Canonical Run did not open its Agent pane");
const agentId = created.receipt.plan.agentId;
const session = created.receipt.completed.find((stage) => stage.stage === "runtime_launch")?.evidence?.session;
assert(session?.sessionId, "Canonical native Run did not publish a Session");
const checkout = created.receipt.checkoutRegistration.instance.canonicalPath;
assert(checkout.startsWith(path.join(home, "repo") + path.sep));
const retainedFile = path.join(checkout, "keep-after-stop.txt");
fs.writeFileSync(retainedFile, "uncommitted QA work\n");
const stopped = runCli("stop", agentId, "--yes");
assert.equal(stopped.apiVersion, "dure.agent-stop/v1");
assert.equal(stopped.ok, true, JSON.stringify(stopped));
assert.equal(stopped.dispatchStop.agentId, agentId);
assert.equal(stopped.dispatchStop.status, "workspace_preserved");
assert.equal(fs.readFileSync(retainedFile, "utf8"), "uncommitted QA work\n");
const registryPath = path.join(path.dirname(process.env.DURE_QA_SERVER_DESCRIPTOR), "agents.json");
const cleanupDeadline = Date.now() + 10_000;
while (JSON.parse(fs.readFileSync(registryPath, "utf8")).agents.some((entry) => entry.id === agentId)) {
	assert(Date.now() < cleanupDeadline, "Stopped Agent remained in the client registry");
	await delay(100);
}
const observed = hmux("ls").find((entry) => (entry.session_id ?? entry.sessionId) === session.sessionId);
assert(!observed || !["ready", "working"].includes(observed.lifecycle), "Stopped native provider remains live");
const presentation = runCli("client", "observe").presentation;
assert(presentation?.spaces, "The app did not return its pane observation");
assert(!presentation.spaces.some((space) => space.panes.some((pane) => pane.id === created.presentation.pane.panelId)),
	"Stopped Agent pane remained in the app");
fs.writeFileSync(path.join(root, "evidence", "canonical-cli-stop.json"), JSON.stringify({
	agentId, sessionId: session.sessionId, stopped, worktreePreserved: true, registrationRemoved: true, paneRemoved: true,
}, null, 2), { flag: "wx", mode: 0o600 });
console.log("Canonical dure stop: native provider stopped, registration removed, uncommitted worktree preserved.");
// The outer runner owns generation-verified Host/provider/root retirement.
