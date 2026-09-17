import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { armExclusiveNativeInput } from "./lib/exclusive-native-input.mjs";
import { readWorkspacePerformanceDescriptor } from "./lib/workspace-performance-descriptor.mjs";

const TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 100;
const SASH_DELTA_X = 120;

const home = process.env.HOME;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const evidenceDirectory = process.env.DURE_QA_EVIDENCE_DIR;
const descriptorPath = process.env.DURE_QA_SERVER_DESCRIPTOR;
const windowTitle = process.env.DURE_QA_WINDOW_TITLE;
const swiftBin = process.env.DURE_QA_SWIFT_BIN;
const exclusiveInputRequest = process.env.DURE_QA_EXCLUSIVE_INPUT_REQUEST;
const exclusiveInputAck = process.env.DURE_QA_EXCLUSIVE_INPUT_ACK;
let accumulatedEvidence = {};
if (
	!home ||
	!stateRoot ||
	!evidenceDirectory ||
	!descriptorPath ||
	!windowTitle ||
	!swiftBin ||
	!exclusiveInputRequest ||
	!exclusiveInputAck
) {
	throw new Error("terminal sash resize QA isolation is incomplete");
}
const descriptor = await waitForDescriptor();
const ready = await waitForReport((report) => {
	const target = report.qaStatus?.sashTarget;
	return report.qaStatus?.state === "running" &&
		report.qaStatus?.phase === "sash_ready" &&
		Number.isFinite(target?.x) &&
		Number.isFinite(target?.y) &&
		report.terminalGeometry?.surfaces?.length === 2
		? report
		: undefined;
});
await armExclusiveNativeInput({
	stateRoot,
	requestPath: exclusiveInputRequest,
	acknowledgementPath: exclusiveInputAck,
});

const native = spawnSync(
	swiftBin,
	[
		path.resolve("scripts/qa/terminal-sash-resize.swift"),
		windowTitle,
		String(ready.qaStatus.sashTarget.x),
		String(ready.qaStatus.sashTarget.y),
		String(SASH_DELTA_X),
	],
	{ encoding: "utf8", timeout: 60_000 },
);
if (native.error) throw native.error;
if (native.status !== 0) {
	throw new Error(
		`native terminal sash input failed: ${String(native.stderr || native.stdout).trim()}`,
	);
}
const nativeEvidence = JSON.parse(native.stdout);
writeEvidence({ native: nativeEvidence, report: ready });

const completed = await waitForReport((report) =>
	report.qaStatus?.state === "complete" &&
	report.qaStatus?.sashResize?.converged === true
		? report
		: undefined,
);
const evidence = completed.qaStatus.sashResize;
const selection = completed.qaStatus.sashSelection;
if (
	evidence.visibleSurfaceCount !== 2 ||
	evidence.changedSurfaceCount !== 2 ||
	evidence.matchingSurfaceCount !== 2 ||
	evidence.dirtySurfaceCount !== 0 ||
	evidence.transactionGeneration < evidence.baselineGeneration + 2
) {
	throw new Error(
		`terminal sash geometry evidence is incomplete: ${JSON.stringify(evidence)}`,
	);
}
if (
	selection?.captureFallbackInjected !== true ||
	selection.selectStartCount < 1 ||
	selection.blockedSelectStartCount !== selection.selectStartCount ||
	selection.activeSelectionChangeCount !== 0 ||
	selection.finalSelectionTextLength !== 0
) {
	throw new Error(
		`terminal sash selection evidence is incomplete: ${JSON.stringify(selection)}`,
	);
}

writeEvidence({
	native: nativeEvidence,
	sashResize: evidence,
	sashSelection: selection,
	qaStatus: completed.qaStatus,
});
console.log(
	`Terminal sash resize smoke: two native WKWebView sash transitions converged ${evidence.matchingSurfaceCount}/${evidence.visibleSurfaceCount} panes with dirty=${evidence.dirtySurfaceCount}, blocked selection=${selection.blockedSelectStartCount}/${selection.selectStartCount}; native=${native.stdout.trim()}`,
);

async function waitForDescriptor() {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		const descriptor = readWorkspacePerformanceDescriptor({
			descriptorPath,
			home,
			stateRoot,
		});
		if (descriptor) return descriptor;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error("timed out waiting for the isolated terminal sash app");
}

async function waitForReport(predicate) {
	const deadline = Date.now() + TIMEOUT_MS;
	let lastReport;
	let lastError;
	while (Date.now() < deadline) {
		try {
			lastReport = await readReport();
			lastError = undefined;
		} catch (error) {
			lastError = error;
			await sleep(POLL_INTERVAL_MS);
			continue;
		}
		writeEvidence({ report: lastReport });
		if (lastReport.qaStatus?.state === "failed") {
			throw new Error(
				`terminal sash workload failed in ${lastReport.qaStatus.phase}: ${lastReport.qaStatus.error ?? "unknown error"}`,
			);
		}
		const result = predicate(lastReport);
		if (result) return result;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`timed out waiting for terminal sash geometry: ${JSON.stringify(lastReport?.qaStatus ?? null)}${lastError ? `; ${String(lastError)}` : ""}`,
	);
}

async function readReport() {
	const response = await fetch(`http://127.0.0.1:${descriptor.port}/perf/report`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${descriptor.token}`,
			"Content-Type": "application/json",
		},
		body: "{}",
		signal: AbortSignal.timeout(20_000),
	});
	const receipt = await response.json();
	if (!response.ok || receipt.ok !== true || !receipt.report) {
		throw new Error(
			receipt?.error?.message ?? `perf report returned ${response.status}`,
		);
	}
	return {
		...receipt.report,
		terminalGeometry: receipt.terminalGeometry ?? null,
		qaStatus: receipt.qaStatus ?? null,
	};
}

function writeEvidence(value) {
	accumulatedEvidence = { ...accumulatedEvidence, ...value };
	fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
	const destination = path.join(evidenceDirectory, "last-status.json");
	const temporary = `${destination}.${process.pid}.tmp`;
	fs.writeFileSync(
		temporary,
		`${JSON.stringify(accumulatedEvidence, null, 2)}\n`,
		{
			mode: 0o600,
		},
	);
	fs.renameSync(temporary, destination);
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
