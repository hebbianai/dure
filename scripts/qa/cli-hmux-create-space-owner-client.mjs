import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";

const APP_READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 100;
const TARGET_SPACE_ID = "desk-1";
const cliPath = fileURLToPath(new URL("../../cli/dure.mjs", import.meta.url));

const required = (name) => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const sleep = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForAppControl(descriptorPath, windowLabel) {
	const deadline = Date.now() + APP_READY_TIMEOUT_MS;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
			await requestAppControl({
				descriptor,
				path: "/diagnostics",
				body: windowLabel ? { windowLabel } : {},
				timeoutMs: 2_000,
			});
			return descriptor;
		} catch (error) {
			lastError = error;
			await sleep(POLL_INTERVAL_MS);
		}
	}
	throw new Error(
		`timed out waiting for ${windowLabel ?? "main"} app control: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	);
}

function listedSessions(hmuxCli, discoveryRoot) {
	const output = execFileSync(
		hmuxCli,
		["--json", "--discovery-root", discoveryRoot, "session", "list", "--no-probe"],
		{ encoding: "utf8", timeout: 10_000 },
	);
	const sessions = JSON.parse(output);
	if (!Array.isArray(sessions)) {
		throw new Error("session list did not return a JSON array");
	}
	return sessions;
}

function cli(args, { code = 0, environment = {} } = {}) {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		env: { ...process.env, ...environment },
		encoding: "utf8", timeout: 30_000,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, code, `${args.join(" ")}: ${result.stderr || result.stdout}`);
	return args.includes("--json")
		? JSON.parse(result.stdout || result.stderr)
		: result.stdout;
}

// Poll observations only. A timed-out create or input is never resubmitted.
async function waitForObservation(label, observe, accepts) {
	const deadline = Date.now() + 20_000;
	let last;
	while (Date.now() < deadline) {
		last = await observe();
		if (accepts(last)) return last;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

const descriptorPath = required("DURE_QA_SERVER_DESCRIPTOR");
const targetWindowLabel = required("DURE_QA_TARGET_WINDOW_LABEL");
const hmuxCli = required("DURE_QA_HMUX_CLI");
const discoveryRoot = required("HMUX_DISCOVERY_ROOT");
fs.accessSync(hmuxCli, fs.constants.X_OK);

await waitForAppControl(descriptorPath);
await waitForAppControl(descriptorPath, targetWindowLabel);
// The coordinator deliberately has no workspace root or registry publisher.
// Name/invoking-pane selection is covered by the CLI/MCP projection fixtures;
// this path proves explicit IDs and app defaults do not require that projection.
const plainCwd = path.join(required("DURE_QA_STATE_ROOT"), "plain folder");
fs.mkdirSync(plainCwd);
assert.equal(fs.existsSync(path.join(plainCwd, ".git")), false);
const before = listedSessions(hmuxCli, discoveryRoot);
const shown = cli(["client", "space", "show", TARGET_SPACE_ID, "--json"]);
assert.equal(shown.space.spaceId, TARGET_SPACE_ID);
assert.equal(shown.space.active, true);
assert.equal(shown.space.windowLabel, targetWindowLabel, "Exact Space selection must execute in its owning window");
assert.deepEqual(listedSessions(hmuxCli, discoveryRoot), before, "Showing a Space must not start sessions");

const projectStartedAt = Date.now();
const added = cli(["client", "project", "add", plainCwd, "--space-id", TARGET_SPACE_ID, "--json"]);
assert.equal(added.registration.scope, "app");
assert.equal(added.registration.persisted, true);
assert.equal(added.registration.spaceId, TARGET_SPACE_ID);
assert.equal(added.registration.hostId, "local");
assert.equal(added.registration.project.path, plainCwd);
assert.equal(added.registration.project.isRepo, false);
const addedAgain = cli(["client", "project", "add", `${plainCwd}/`, "--json"]);
assert.deepEqual(addedAgain.registration, added.registration, "equivalent folder registration must reuse its project identity");
assert.deepEqual(listedSessions(hmuxCli, discoveryRoot), before, "project registration must not create a session");
for (const options of [
	[path.join(plainCwd, "does-not-exist")],
	[plainCwd, "--space-id", "missing"],
	["/remote", "--host", "ssh-missing"],
]) {
	const refused = cli(["client", "project", "add", ...options, "--json"], { code: 2 });
	assert.ok(refused.error.code);
}
assert.deepEqual(listedSessions(hmuxCli, discoveryRoot), before);
console.log(`CLI project: add → canonical duplicate → invalid directory/Space/host refusal passed (${Date.now() - projectStartedAt} ms)`);

for (const [options, code] of [
	[["--space-id", "desk-missing"], "pane_not_found"],
	[["--space-id", TARGET_SPACE_ID, "--host", "ssh-missing"], "remote_hmux_host_not_registered"],
]) {
	const refused = cli(["client", "pane", "create", ...options, "--json"], { code: 2 });
	assert.equal(refused.error.code, code);
	if (code === "remote_hmux_host_not_registered") assert.ok(refused.error.nextAction);
	assert.deepEqual(listedSessions(hmuxCli, discoveryRoot), before, "refused selection created a local session");
}

for (const [name, options] of [
	["explicit-id", ["--space-id", TARGET_SPACE_ID]],
	["app-default", []],
]) {
	const startedAt = Date.now();
	const sessionsBeforeCreate = listedSessions(hmuxCli, discoveryRoot);
	const created = cli(["client", "pane", "create", ...options, "--cwd", plainCwd, "--json"]);
	const pane = created.pane;
	const expectedOwnerId = `window:${targetWindowLabel}:desktop:${TARGET_SPACE_ID}:pane:${pane?.panelId}`;
	assert.equal(pane.spaceId, TARGET_SPACE_ID);
	assert.equal(pane.cwd, plainCwd);
	assert.match(pane.panelId, /^pane-[A-Za-z0-9_-]+$/);
	assert.notEqual(pane.panelId, pane.sessionId);
	assert.equal(pane.attachment.state, "attached");
	assert.equal(pane.attachment.sessionId, pane.sessionId);
	assert.equal(pane.attachment.workspaceId, pane.workspaceId);
	assert.equal(pane.attachment.ownerId, expectedOwnerId);
	const sessionsAfterCreate = listedSessions(hmuxCli, discoveryRoot);
	assert.equal(sessionsAfterCreate.length, sessionsBeforeCreate.length + 1);
	assert.equal(sessionsAfterCreate.filter((session) => session.session_id === pane.sessionId && session.workspace_id === pane.workspaceId).length, 1);

	await waitForObservation("terminal.input action", () => cli(["client", "pane", "state", pane.panelId, "--json"]),
		(value) => value.pane.actions.includes("terminal.input"));
	// The expected output is absent from the input echo; the shell must execute it.
	const expectedOutput = `CLI_TERMINAL_${name}`;
	const expectedCwd = `CLI_CWD_${name}`;
	const quotedCwd = `'${plainCwd.replaceAll("'", "'\\''")}'`;
	const input = ["client", "pane", "act", pane.panelId, "terminal.input", "--args-json", JSON.stringify({
		text: `printf 'CLI_%s_%s\\n' TERMINAL '${name}'; test . -ef ${quotedCwd} && printf 'CLI_%s_%s\\n' CWD '${name}'`, appendEnter: true,
	}), "--idempotency-key", `terminal-create-${name}`, "--json"];
	const applied = cli(input);
	assert.equal(applied.pane.result.outcome, "applied");
	assert.deepEqual(cli(input), applied, "identical input must replay its receipt");
	const screen = await waitForObservation("shell output", () => cli(["read", pane.sessionId, "--workspace", pane.workspaceId, "-n", "100"]),
		(value) => value.includes(expectedOutput) && value.includes(expectedCwd));
	assert.equal(screen.split(expectedOutput).length - 1, 1, "replayed input executed twice");
	const closed = cli(["client", "pane", "close", pane.panelId, "--space-id", TARGET_SPACE_ID, "--yes", "--json"]);
	assert.equal(closed.pane.panelId, pane.panelId);
	assert.equal(closed.pane.desktopId, TARGET_SPACE_ID);
	assert.equal(closed.pane.mode, "live");
	assert.notEqual(closed.pane.departure?.reason, "not_attached");
	console.log(`CLI terminal ${name}: create → input/replay → output/cwd → exact close passed (${Date.now() - startedAt} ms)`);
}

console.log("CLI Hmux Space owner smoke: all terminal cycles passed without foreground focus or OS input");
