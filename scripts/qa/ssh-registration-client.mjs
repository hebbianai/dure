import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { resolveQaLogPath } from "./lib/qa-log-receipt.mjs";

const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
assert.equal(home, path.join(root, "home"));
assert(path.basename(root).startsWith("dure-ssh-registration."));
const fixture = JSON.parse(
	fs.readFileSync(path.join(root, "qa.autorun"), "utf8"),
);
assert.equal(fixture.runId, process.env.VITE_DURE_SSH_REGISTRATION_QA_RUN_ID);
assert.equal(fs.realpathSync(fixture.home), home);
assert.equal(fixture.host, "127.0.0.1");
const descriptor = JSON.parse(
	fs.readFileSync(process.env.DURE_QA_SERVER_DESCRIPTOR, "utf8"),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reports = [];
const log = resolveQaLogPath();
let offset = fs.existsSync(log)
	? Math.max(0, fs.statSync(log).size - 256 * 1024)
	: 0;
let remainder = "";
let readBytes = 0;
function readReports() {
	let size;
	try {
		size = fs.statSync(log).size;
	} catch (error) {
		// Native readiness can precede the first WebView QA log event.
		if (error.code === "ENOENT" && offset === 0) return;
		throw error;
	}
	assert(size >= offset, "QA log replaced during execution");
	if (size === offset) return;
	readBytes += size - offset;
	assert(readBytes <= 1024 * 1024, "QA log budget exceeded");
	const buffer = Buffer.alloc(size - offset);
	const file = fs.openSync(log, "r");
	try {
		offset += fs.readSync(file, buffer, 0, buffer.length, offset);
	} finally {
		fs.closeSync(file);
	}
	const lines = (remainder + buffer.toString("utf8")).split("\n");
	remainder = lines.pop();
	for (const line of lines) {
		let value;
		try {
			value = JSON.parse(line.slice(line.indexOf("] ") + 2));
		} catch {
			continue;
		}
		if (value?.[0] !== "ssh-registration" || value[1]?.runId !== fixture.runId)
			continue;
		reports.push(value[1]);
		if (value[1].event === "failed") throw new Error(value[1].error);
	}
}
async function waitFor(label, predicate, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		readReports();
		const result = await predicate();
		if (result) return result;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}
async function post(route, body) {
	const response = await fetch(`http://127.0.0.1:${descriptor.port}${route}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${descriptor.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(80_000),
	});
	return { status: response.status, body: await response.json() };
}
async function ok(route, body) {
	const result = await post(route, body);
	assert.equal(result.body.ok, true, `${route}: ${JSON.stringify(result)}`);
	return result.body;
}
function hmux(args, discovery = process.env.HMUX_DISCOVERY_ROOT) {
	return JSON.parse(
		execFileSync(
			process.env.DURE_QA_HMUX_CLI,
			["--discovery-root", discovery, "--json", ...args],
			{ encoding: "utf8", timeout: 15_000, maxBuffer: 512 * 1024, cwd: home },
		),
	);
}
const ownerRoot = path.join(root, "sshd-owner");
const sshLog = fs.openSync(path.join(root, "sshd.log"), "wx", 0o600);
const sshd = spawn(
	process.execPath,
	[
		path.resolve("scripts/qa/lib/bounded-owned-process-group.mjs"),
		"run",
		ownerRoot,
		"--timeout-seconds",
		"180",
		"--",
		"/usr/sbin/sshd",
		"-D",
		"-e",
		"-f",
		path.join(root, "sshd.conf"),
	],
	{ cwd: root, stdio: ["ignore", sshLog, sshLog] },
);
fs.closeSync(sshLog);
const sshdExit = new Promise((resolve, reject) => {
	sshd.once("error", reject);
	sshd.once("exit", (code, signal) => resolve({ code, signal }));
});
let pane;
let handoff;
let remoteProcesses;
let directPane;
let directProcesses;
let directPaneClosed = false;
let evidence;
let lostRemote;
try {
	await waitFor("native workspace", () =>
		reports.find((report) => report.event === "ready"),
	);
	pane = (await ok("/hmux/create", { cwd: home })).pane;
	assert.equal(pane.runtime, "hmux_standalone_v1");
	fs.writeFileSync(
		path.join(root, "qa.autorun"),
		JSON.stringify({ ...fixture, sourcePane: pane }),
		{ mode: 0o600 },
	);
	const argv = ["-p", String(fixture.port), `${fixture.user}@${fixture.host}`];
	const request = {
		sourceSessionId: pane.sessionId,
		sourceWorkspaceId: pane.workspaceId,
		argv,
		destination: { user: fixture.user, host: fixture.host, port: fixture.port },
	};
	for (const action of ["decline", "expire"]) {
		const receipt = post("/hmux/remote-shell", request);
		await waitFor(`${action} dialog`, () =>
			reports.find(
				(report) => report.event === "prompt" && report.action === action,
			),
		);
		// This ordinary frontend request must complete while SSH is awaiting a person.
		await ok("/pane/state", { targetPanelId: pane.panelId });
		const result = await receipt;
		assert.equal(result.status, 409);
		assert.deepEqual(result.body, { ok: false, fallback: true });
		assert.equal(hmux(["session", "show", pane.sessionId]).lifecycle, "ready");
	}
	// The registered destination really creates a Host, but the disposable SSH
	// gateway loses its first answer before the native pending-pane registration.
	const lost = await post("/hmux/remote-shell", request);
	assert.equal(lost.body.ok, false);
	assert.notEqual(lost.body.fallback, true);
	const lostReceipt = JSON.parse(fs.readFileSync(path.join(root, "lost-create-receipt.json"), "utf8"));
	lostRemote = hmux(["session", "show", lostReceipt.sessionId], path.join(root, "remote-discovery"));
	assert.equal(lostRemote.lifecycle, "ready");
	assert.equal(hmux(["session", "show", pane.sessionId]).lifecycle, "ready");
	// Retry through the real local Host PTY; its installed ssh shim invokes the
	// channel-pinned Dure CLI, which traverses HTTP -> WebView -> native SSH.
	const input = hmux([
		"command-input",
		"--target",
		pane.sessionId,
		"--workspace",
		pane.workspaceId,
		"--text",
		`ssh -p ${fixture.port} ${fixture.user}@127.0.0.1`,
		"--submit",
	]);
	assert(input, "missing semantic input receipt");
	handoff = await waitFor(
		"same-pane remote handoff",
		() => reports.find((report) => report.event === "handoff"),
		60_000,
	);
	assert.equal(handoff.panelId, pane.panelId);
	assert.equal(handoff.desktopId, pane.desktopId);
	assert.notEqual(handoff.binding.sessionId, pane.sessionId);
	const remoteRoot = path.join(root, "remote-discovery");
	const remote = hmux(
		["session", "show", handoff.binding.sessionId],
		remoteRoot,
	);
	remoteProcesses = [remote.host_process, remote.provider_process];
	assert.equal(remote.session_id, lostRemote.session_id, "response-loss retry created a second remote Host");
	assert.equal(remote.workspace_id, lostRemote.workspace_id);
	assert.deepEqual(remoteProcesses, [lostRemote.host_process, lostRemote.provider_process]);
	for (const process of remoteProcesses)
		assert(
			process?.process_id && process.start_marker,
			"missing exact remote process generation",
		);
	assert.equal(remote.lifecycle, "ready");
	assert.equal(remote.workspace_id, handoff.binding.workspaceId);
	assert.equal(handoff.promptCount, 3);
	const marker = `HMUX_WINDOW_QA_${fixture.runId.replaceAll("-", "").slice(0, 12).toUpperCase()}_S_0001`;
	const remoteScreen = hmux(
		["read", handoff.binding.sessionId, "-n", "30"],
		remoteRoot,
	);
	assert.equal(
		remoteScreen.lines.filter((line) => line.includes(marker)).length,
		1,
		"the exact remote Host must contain the rendered marker once",
	);
	fs.writeFileSync(
		path.join(root, "qa.autorun"),
		JSON.stringify({
			...fixture,
			sourcePane: pane,
			recovery: {
				desktopId: pane.desktopId,
				panelId: pane.panelId,
				previousRealmId: handoff.realmId,
				binding: handoff.binding,
			},
		}),
		{ mode: 0o600 },
	);
	const recovered = await waitFor(
		"SSH WebView recovery",
		() => reports.find((report) => report.event === "recovered"),
		45_000,
	);
	assert.notEqual(recovered.realmId, handoff.realmId);
	assert.equal(recovered.previousRealmId, handoff.realmId);
	assert.equal(recovered.panelId, pane.panelId);
	assert.equal(recovered.desktopId, pane.desktopId);
	assert.deepEqual(recovered.binding, handoff.binding);
	assert.equal(recovered.hostCount, 1);
	assert.equal(recovered.pendingDecisions, 0);
	assert.equal(reports.filter((report) => report.event === "prompt").length, 3);
	assert.notEqual(
		recovered.observation.receipt.attachmentIdentity,
		handoff.observation.receipt.attachmentIdentity,
	);
	// Request numbers are realm-local. A fresh attachment scopes the new receipt.
	assert.equal(recovered.observation.receipt.state, "written_to_pty");
	const reconnectedHost = hmux(["session", "show", handoff.binding.sessionId], remoteRoot);
	assert.deepEqual([reconnectedHost.host_process, reconnectedHost.provider_process], remoteProcesses);
	const afterScreen = hmux(["read", handoff.binding.sessionId, "-n", "30"], remoteRoot);
	for (const sequence of ["0001", "0002"]) {
		const expectedMarker = marker.replace(/0001$/, sequence);
		assert.equal(afterScreen.lines.filter((line) => line.includes(expectedMarker)).length, 1);
	}
	// A direct remote open uses the same GUI transaction as the CLI, but has no
	// source pane to borrow. Its view identity must be independent from the Host.
	const hostCommand = ["client", "host", "add", "--hostname", fixture.host,
		"--user", fixture.user, "--port", String(fixture.port),
		"--identity-file", path.join(home, ".ssh/id_ed25519"), "--name", "CLI SSH registration", "--json"];
	const registerHost = (args) => JSON.parse(execFileSync(
		process.execPath, [path.resolve("cli/dure.mjs"), ...args],
		{ encoding: "utf8", timeout: 15_000, env: {
			...process.env, DURE_HOME: path.join(home, ".dure"), DURE_APP_CHANNEL: descriptor.channel,
		} },
	)).registration;
	const registeredHost = registerHost(hostCommand);
	assert.equal(registeredHost.created, true);
	assert.equal(registeredHost.persisted, true);
	const repeatedHost = registerHost(hostCommand);
	assert.equal(repeatedHost.created, false);
	assert.equal(repeatedHost.host.id, registeredHost.host.id);
	fs.appendFileSync(path.join(home, ".ssh/config"),
		`Host qa-cli-host\n  HostName ${fixture.host}\n  User ${fixture.user}\n  Port ${fixture.port}\n  IdentityFile "${path.join(home, ".ssh/id_ed25519")}"\n`);
	const importedHost = registerHost(["client", "host", "add", "qa-cli-host", "--name", "CLI SSH registration", "--json"]);
	assert.equal(importedHost.created, false);
	assert.equal(importedHost.host.id, registeredHost.host.id);
	assert.equal(importedHost.host.sshConfigAlias, "qa-cli-host");
	directPane = (await ok("/hmux/create", {
		hostId: registeredHost.host.id,
		spaceId: pane.desktopId,
	})).pane;
	assert.match(directPane.panelId, /^pane-[A-Za-z0-9_-]+$/);
	assert.notEqual(directPane.panelId, pane.panelId);
	assert.notEqual(directPane.panelId, directPane.sessionId);
	assert.notEqual(directPane.sessionId, handoff.binding.sessionId);
	assert.equal(directPane.source, "ssh");
	assert.equal(directPane.hostId, registeredHost.host.id);
	assert.equal(directPane.desktopId, pane.desktopId);
	assert.equal(directPane.readiness.pane, "mounted");
	const directHost = hmux(["session", "show", directPane.sessionId], remoteRoot);
	assert.equal(directHost.workspace_id, directPane.workspaceId);
	directProcesses = [directHost.host_process, directHost.provider_process];
	for (const process of directProcesses)
		assert(process?.process_id && process.start_marker, "missing direct-open process generation");
	await waitFor("direct remote input action", async () => {
		const state = await post("/pane/state", { targetPanelId: directPane.panelId });
		return state.body.pane?.actions.includes("terminal.input");
	});
	const directInput = {
		targetPanelId: directPane.panelId,
		actionId: "terminal.input",
		arguments: { text: "printf 'REMOTE_DIRECT_%s\\n' 'PANE'", appendEnter: true },
		idempotencyKey: `direct-pane-${fixture.runId}`,
	};
	const applied = await ok("/pane/act", directInput);
	assert.equal(applied.pane.result.outcome, "applied");
	assert.deepEqual(await ok("/pane/act", directInput), applied);
	await waitFor("direct remote output", () => {
		const screen = hmux(["read", directPane.sessionId, "-n", "30"], remoteRoot);
		return screen.lines.filter((line) => line.includes("REMOTE_DIRECT_PANE")).length === 1;
	});
	const sourceAfterOpen = hmux(["session", "show", handoff.binding.sessionId], remoteRoot);
	assert.deepEqual([sourceAfterOpen.host_process, sourceAfterOpen.provider_process], remoteProcesses);
	// Direct SSH panes have no local-shell handoff record. A provider started by
	// their command bridge must still take over this pane, then return to it.
	await ok("/pane/act", {
		targetPanelId: directPane.panelId,
		actionId: "terminal.input",
		arguments: { text: "codex resume", appendEnter: true },
		idempotencyKey: `direct-codex-${fixture.runId}`,
	});
	const providerSession = await waitFor("remote Codex fixture start", () => {
		const file = path.join(root, "codex-bridge-session");
		return fs.existsSync(file) && fs.readFileSync(file, "utf8").trim();
	});
	const provider = hmux(["session", "show", providerSession], remoteRoot);
	assert.equal(provider.provider_id, "codex");
	assert.equal(provider.session_class, "managed");
	let bridgeObservation;
	const waitForPresentedSession = (sessionId) => waitFor(`pane presenting ${sessionId}`, async () => {
		const registry = JSON.parse(fs.readFileSync(path.join(
			home, ".dure", "channels", descriptor.channel, "agents.json",
		), "utf8"));
		const space = registry.clientPresentation.spaces.find((candidate) => candidate.id === directPane.desktopId);
		const pane = space?.panes.find((candidate) => candidate.id === directPane.panelId);
		const state = await post("/pane/state", { targetPanelId: directPane.panelId });
		bridgeObservation = { binding: pane?.binding, status: state.body.pane?.status, error: state.body.error };
		return state.body.pane?.status === "attached" &&
			pane?.binding?.sessionId === sessionId &&
			state.body.pane.actions.includes("terminal.input");
	}).catch((error) => {
		console.error(JSON.stringify({ event: "command-bridge-presentation", expectedSession: sessionId, ...bridgeObservation }));
		console.error(JSON.stringify(hmux(["read", directPane.sessionId, "-n", "10"], remoteRoot)));
		throw error;
	});
	await waitForPresentedSession(providerSession);
	assert(hmux(["read", providerSession, "-n", "30"], remoteRoot).lines.some(
		(line) => line.includes("SSH_CODEX_BRIDGE_READY"),
	));
	await ok("/pane/act", {
		targetPanelId: directPane.panelId,
		actionId: "terminal.input",
		arguments: { text: "exit", appendEnter: true },
		idempotencyKey: `direct-codex-exit-${fixture.runId}`,
	});
	await waitForPresentedSession(directPane.sessionId);
	assert.equal(fs.readFileSync(path.join(root, "codex-bridge-input"), "utf8").trim(), "exit");
	const restoredShell = hmux(["session", "show", directPane.sessionId], remoteRoot);
	assert.deepEqual([restoredShell.host_process, restoredShell.provider_process], directProcesses);
	const flagPath = path.join(root, "qa.autorun");
	fs.writeFileSync(flagPath, JSON.stringify({
		...JSON.parse(fs.readFileSync(flagPath, "utf8")),
		repeatedClose: directPane,
	}), { mode: 0o600 });
	const repeatedClose = await waitFor("repeated SSH pane close", () => reports.find(
		(report) => report.event === "repeated-close" && report.panelId === directPane.panelId,
	));
	assert.deepEqual(repeatedClose.receipts[0], repeatedClose.receipts[1]);
	directPaneClosed = true;
	evidence = {
		schemaVersion: 1,
		runId: fixture.runId,
		transport: "real-loopback-ssh",
		inputSource: "host-command-input",
		dialogAction: "synthetic-dom-click",
		reports,
		sourcePane: pane.panelId,
		remoteSessionId: remote.session_id,
		responseLoss: { boundary: "ssh-before-native-receipt", sameHostAndProviderGeneration: true },
		directOpen: {
			panelId: directPane.panelId,
			sessionId: directPane.sessionId,
			workspaceId: directPane.workspaceId,
			inputReplay: true,
			sourceGenerationPreserved: true,
			repeatedClose: true,
			commandBridge: { provider: "codex-fixture", providerSession, samePane: true, restoredShell: true },
		},
	};
} catch (error) {
	console.error(`SSH registration primary failure: ${String(error)}`);
	if (pane) {
		try {
			console.error(JSON.stringify(hmux(["read", pane.sessionId, "-n", "20"])));
		} catch {
			/* The source may already have retired. */
		}
	}
	throw error;
} finally {
	try {
		try {
			if (directPane) {
				if (!directPaneClosed) await ok("/pane/close", {
					targetPanelId: directPane.panelId,
					spaceId: directPane.desktopId,
					confirm: true,
				});
				if (directProcesses)
					await waitFor("direct remote Host retirement", () =>
						directProcesses.every((process) => hmux([
							"process", "probe", String(process.process_id), process.start_marker,
						]).status === "absent"), 15_000);
			}
		} finally {
			if (pane) {
				const closeStartedAtMs = Date.now();
				const closed = await ok("/pane/close", {
					targetPanelId: pane.panelId,
					spaceId: pane.desktopId,
					confirm: true,
				});
				console.log(JSON.stringify({
					event: "owned-pane-close",
					closeStartedAtMs,
					closeCompletedAtMs: Date.now(),
					receipt: closed,
				}));
				// A discovery manifest can remain ready after exit. Probe the exact owned
				// kernel generations; this fixture's SSH destination is on this machine.
				if (remoteProcesses) {
					try {
						await waitFor(
							"owned remote Host retirement",
							() =>
								remoteProcesses.every(
									(process) =>
										hmux([
											"process",
											"probe",
											String(process.process_id),
											process.start_marker,
										]).status === "absent",
								),
							15_000,
						);
					} catch (error) {
						const processes = remoteProcesses.map((process) => hmux([
							"process", "probe", String(process.process_id), process.start_marker,
						]));
						console.error(JSON.stringify({ event: "owned-retirement-processes", processes }));
						// Preview uses retirement-admin admission, which does not register a
						// client or cancel the Host's timer. Never apply a sweep to make QA green.
						try {
							const preview = hmux([
								"session", "retirement", "sweep", handoff.binding.sessionId,
								"--workspace", handoff.binding.workspaceId,
							], path.join(root, "remote-discovery"));
							console.error(JSON.stringify({ event: "owned-retirement-preview", preview }));
						} catch (observationError) {
							console.error(`Retirement preview unavailable: ${String(observationError)}`);
						}
						throw error;
					}
				}
			}
		}
	} finally {
		// Failure cleanup cannot turn a failed identity assertion into success.
		// Abandon only the exact unpresented creation whose private proof the
		// disposable gateway retained; never sweep the remote catalog.
		const cleanupFile = path.join(root, "lost-create-cleanup.json");
		let cleanupFailure;
		try {
			if (!evidence && fs.existsSync(cleanupFile)) {
				const payload = fs.readFileSync(cleanupFile);
				const header = Buffer.alloc(4);
				header.writeUInt32BE(payload.length);
				execFileSync(process.env.DURE_QA_HMUX_CLI, [
					"--discovery-root", path.join(root, "remote-discovery"),
					"mobile-gateway", "--allow-create",
				], {
					input: Buffer.concat([header, payload]), timeout: 10_000, maxBuffer: 64 * 1024,
					env: {
						...process.env,
						HOME: path.join(root, "remote-home"),
						HMUX_DISCOVERY_ROOT: path.join(root, "remote-discovery"),
					},
				});
			}
			if (lostRemote) {
				await waitFor("lost-response Host cleanup", () =>
					[lostRemote.host_process, lostRemote.provider_process].every(
						(process) => hmux([
							"process", "probe", String(process.process_id), process.start_marker,
						]).status === "absent",
					), 10_000);
			}
		} catch {
			cleanupFailure = new Error("isolated lost-create cleanup could not be verified");
		}
		fs.writeFileSync(path.join(ownerRoot, "cancel"), "", {
			flag: "wx",
			mode: 0o600,
		});
		await sshdExit;
		assert.equal(
			JSON.parse(
				fs.readFileSync(path.join(ownerRoot, "completion.json"), "utf8"),
			).cleanup,
			"verified",
		);
		if (cleanupFailure) throw cleanupFailure;
	}
}
fs.writeFileSync(
	path.join(process.env.DURE_QA_EVIDENCE_DIR, "ssh-registration.json"),
	JSON.stringify(evidence, null, 2),
	{ flag: "wx", mode: 0o600 },
);
// Publish success only after the fixture's exact processes have retired.
const output = process.env.DURE_QA_SSH_REGISTRATION_RECEIPT;
if (output)
	fs.writeFileSync(output, JSON.stringify(evidence, null, 2), {
		flag: "wx",
		mode: 0o600,
	});
console.log(
	"SSH registration: native decline/expiry, concurrent HTTP, real pane/CLI/SSH handoff, WebView recovery and owned cleanup passed",
);
