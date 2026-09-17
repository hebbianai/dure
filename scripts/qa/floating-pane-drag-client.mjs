import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";
import { resolveQaLogPath } from "./lib/qa-log-receipt.mjs";

const APP_READY_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const FIXTURE_SPACE_NAME = "Floating pane drag QA";
const FIXTURE_PANE_TITLE = "Floating drag fixture";

const sleep = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForAppControl(descriptorPath) {
	const deadline = Date.now() + APP_READY_TIMEOUT_MS;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
			await requestAppControl({
				descriptor,
				path: "/diagnostics",
				timeoutMs: 2_000,
			});
			return descriptor;
		} catch (error) {
			lastError = error;
			await sleep(POLL_INTERVAL_MS);
		}
	}
	throw new Error(
		`timed out waiting for app control: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

function probeRecords(logPath, startOffset) {
	let contents = "";
	try {
		contents = fs.readFileSync(logPath).subarray(startOffset).toString("utf8");
	} catch {
		return [];
	}
	const records = [];
	for (const line of contents.split("\n")) {
		const payloadStart = line.indexOf("] ");
		if (payloadStart < 0) continue;
		const payload = line.slice(payloadStart + 2);
		try {
			const parsed = JSON.parse(payload);
			if (parsed?.[0] === "floatingPaneDrag" && parsed[1]) {
				records.push(parsed[1]);
			}
		} catch {
			// Ignore concurrent diagnostics that are not complete JSON records yet.
		}
	}
	return records;
}

async function waitForReadyRecord(logPath, startOffset) {
	const deadline = Date.now() + PROBE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const records = probeRecords(logPath, startOffset);
		const failure = records.find((record) => record.phase === "failed");
		if (failure) throw new Error(`floating fixture failed: ${JSON.stringify(failure)}`);
		const ready = records.find((record) => record.phase === "ready");
		if (ready) return ready;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error("timed out waiting for the floating pane fixture");
}

function finitePosition(value) {
	return (
		value &&
		(Number.isFinite(value.left) || Number.isFinite(value.right)) &&
		(Number.isFinite(value.top) || Number.isFinite(value.bottom)) &&
		Number.isFinite(value.width) &&
		Number.isFinite(value.height)
	);
}

async function waitForMovedPosition(logPath, startOffset, initialPosition) {
	const initial = JSON.stringify(initialPosition);
	const deadline = Date.now() + PROBE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const records = probeRecords(logPath, startOffset);
		const failure = records.find((record) => record.phase === "failed");
		if (failure) throw new Error(`floating fixture failed: ${JSON.stringify(failure)}`);
		const persisted = records
			.filter(
				(record) => record.phase === "layout" && finitePosition(record.position),
			)
			.at(-1)?.position;
		if (persisted && JSON.stringify(persisted) !== initial) return persisted;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error("the first drag produced no changed serialized floating bounds");
}

const descriptorPath = process.env.DURE_QA_SERVER_DESCRIPTOR;
const windowTitle = process.env.DURE_QA_WINDOW_TITLE;
const swiftBin = process.env.DURE_QA_SWIFT_BIN;
if (!descriptorPath || !windowTitle || !swiftBin) {
	throw new Error("floating pane drag QA environment is incomplete");
}

const qaLogPath = resolveQaLogPath();
const qaLogOffset = fs.existsSync(qaLogPath) ? fs.statSync(qaLogPath).size : 0;
const descriptor = await waitForAppControl(descriptorPath);
const created = await requestAppControl({
	descriptor,
	path: "/space/create",
	body: { name: FIXTURE_SPACE_NAME },
});
if (created.ok !== true || typeof created.space?.spaceId !== "string") {
	throw new Error(`fixture Space creation failed: ${JSON.stringify(created)}`);
}

const ready = await waitForReadyRecord(qaLogPath, qaLogOffset);
if (!finitePosition(ready.position)) {
	throw new Error(`fixture did not serialize floating bounds: ${JSON.stringify(ready)}`);
}

const preflight = spawnSync(
	process.execPath,
	[path.resolve("scripts/qa/lib/exclusive-focus-preflight.mjs")],
	{ encoding: "utf8", timeout: 5_000 },
);
if (preflight.error) throw preflight.error;
if (preflight.status !== 0) {
	throw new Error(
		`floating pane drag QA lost its idle window: ${String(preflight.stderr || preflight.stdout).trim()}`,
	);
}

const native = spawnSync(
	swiftBin,
	[
		path.resolve("scripts/qa/floating-pane-drag.swift"),
		windowTitle,
		FIXTURE_PANE_TITLE,
		"140",
		"90",
	],
	{ encoding: "utf8", timeout: 60_000 },
);
if (native.error) throw native.error;
if (native.status !== 0) {
	throw new Error(
		`first native floating-pane drag failed: ${String(native.stderr || native.stdout).trim()}`,
	);
}

const persisted = await waitForMovedPosition(
	qaLogPath,
	qaLogOffset,
	ready.position,
);

console.log(
	`Floating pane drag smoke: ${ready.panelId} moved on its first visible-header drag in WKWebView; bounds ${JSON.stringify(ready.position)} -> ${JSON.stringify(persisted)}; native=${native.stdout.trim()}`,
);
