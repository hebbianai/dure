import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";

const APP_READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 100;

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

const descriptorPath = process.env.DURE_QA_SERVER_DESCRIPTOR;
const windowTitle = process.env.DURE_QA_WINDOW_TITLE;
const swiftBin = process.env.DURE_QA_SWIFT_BIN;
if (!descriptorPath || !windowTitle || !swiftBin) {
	throw new Error("native pane-drag QA environment is incomplete");
}

const descriptor = await waitForAppControl(descriptorPath);

const source = await requestAppControl({
	descriptor,
	path: "/space/create",
	body: { name: "Drag source" },
});
const sourceSpaceId = source.space?.spaceId;
if (source.ok !== true || typeof sourceSpaceId !== "string") {
	throw new Error(`source Space creation failed: ${JSON.stringify(source)}`);
}

const target = await requestAppControl({
	descriptor,
	path: "/space/create",
	body: { name: "Drag target" },
});
const targetSpaceId = target.space?.spaceId;
if (target.ok !== true || typeof targetSpaceId !== "string") {
	throw new Error(`target Space creation failed: ${JSON.stringify(target)}`);
}

const activation = await requestAppControl({
	descriptor,
	path: "/space/activate",
	body: { spaceId: sourceSpaceId },
});
if (activation.ok !== true) {
	throw new Error(`source Space activation failed: ${JSON.stringify(activation)}`);
}

const created = await requestAppControl({
	descriptor,
	path: "/hmux/create",
	body: { cwd: process.cwd(), spaceId: sourceSpaceId },
});
if (created.ok !== true) {
	throw new Error(`source pane creation failed: ${JSON.stringify(created)}`);
}

const panelId = created.pane?.panelId;
let referenceSessionId = created.pane?.sessionId;
const createdSpaceId = created.pane?.spaceId ?? created.pane?.desktopId;
if (
	typeof panelId !== "string" ||
	typeof referenceSessionId !== "string" ||
	createdSpaceId !== sourceSpaceId
) {
	throw new Error(`source pane receipt is invalid: ${JSON.stringify(created)}`);
}

const siblingRoot = fs.mkdtempSync("/tmp/dure-space-pane-drag-");
process.on("exit", () => fs.rmSync(siblingRoot, { recursive: true, force: true }));
for (let index = 1; index <= 4; index++) {
	const cwd = path.join(siblingRoot, `sibling-${index}`);
	fs.mkdirSync(cwd);
	const sibling = await requestAppControl({
		descriptor,
		path: "/pane/create",
		body: { referenceSessionId, direction: "right", cwd },
	});
	if (sibling.ok !== true || typeof sibling.pane?.sessionId !== "string") {
		throw new Error(`sibling pane ${index} creation failed: ${JSON.stringify(sibling)}`);
	}
	referenceSessionId = sibling.pane.sessionId;
}

// Native CGEvents reset HIDIdleTime themselves, so take the final admission
// reading immediately before injection instead of using the runner's
// continuous exclusive-focus monitor during the drag.
const preflight = spawnSync(
	process.execPath,
	[path.resolve("scripts/qa/lib/exclusive-focus-preflight.mjs")],
	{ encoding: "utf8", timeout: 5_000 },
);
if (preflight.error) throw preflight.error;
if (preflight.status !== 0) {
	throw new Error(
		`native pane-drag QA lost its idle window: ${String(preflight.stderr || preflight.stdout).trim()}`,
	);
}

const helper = path.resolve("scripts/qa/spaces-pane-drag.swift");
function runNativeDrag(targetTitle, movement) {
	const result = spawnSync(
		swiftBin,
		[helper, windowTitle, path.basename(process.cwd()), targetTitle, movement],
		{
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`native pane ${movement} drag failed: ${String(result.stderr || result.stdout).trim()}`,
		);
	}
	return result.stdout.trim();
}

const outboundDrag = runNativeDrag("Drag target", "down");
const returnDrag = runNativeDrag("Drag source", "up");

const closed = await requestAppControl({
	descriptor,
	path: "/pane/close",
	body: { spaceId: sourceSpaceId, targetPanelId: panelId, confirm: true },
});
if (closed.ok !== true) {
	throw new Error(
		`pane did not return to source Space: ${JSON.stringify({ closed, outboundDrag, returnDrag })}`,
	);
}

console.log(
	`Spaces pane drag smoke: ${panelId} moved ${sourceSpaceId} -> ${targetSpaceId} -> ${sourceSpaceId} among five panes in WKWebView; outbound=${outboundDrag}; return=${returnDrag}`,
);
