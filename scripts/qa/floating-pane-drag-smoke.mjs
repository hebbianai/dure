#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const swiftBin = "/usr/bin/swift";

if (process.platform !== "darwin") {
	throw new Error("Floating pane drag smoke: macOS is required");
}
fs.accessSync(swiftBin, fs.constants.X_OK);

const preflight = spawnSync(
	process.execPath,
	[path.join(repoRoot, "scripts/qa/lib/exclusive-focus-preflight.mjs")],
	{ cwd: repoRoot, encoding: "utf8", env: process.env },
);
if (preflight.error) throw preflight.error;
const preflightOutput = String(preflight.stderr || preflight.stdout).trim();
if (preflight.status === 20) {
	console.error(`Floating pane drag smoke: SKIP ${preflightOutput}`);
	process.exitCode = process.env.DURE_QA_REQUIRE_EXECUTION === "1" ? 22 : 0;
} else if (preflight.status !== 0) {
	throw new Error(
		`Floating pane drag smoke: native-input preflight failed: ${preflightOutput}`,
	);
} else {
	const environment = {
		...process.env,
		DURE_QA_CLIENT: "scripts/qa/floating-pane-drag-client.mjs",
		DURE_QA_NAME: "Floating pane drag smoke",
		DURE_QA_ARTIFACT_NAME: "floating-pane-drag",
		DURE_QA_LAYER: "native_input_floating_pane_drag",
		DURE_QA_UNIQUE_APP_CHANNEL: "1",
		DURE_QA_WINDOW_TITLE: "Dure Floating Pane Drag QA",
		DURE_QA_WINDOW_URL: "index.html?qaFloatingPaneDrag=1",
		DURE_QA_WINDOW_PLAN_JSON: JSON.stringify([
			{
				label: "main",
				title: "Dure Floating Pane Drag QA",
				url: "index.html?qaFloatingPaneDrag=1",
				width: 1200,
				height: 800,
				x: 80,
				y: 80,
				visible: true,
				focus: false,
				focusable: true,
			},
		]),
		DURE_QA_SWIFT_BIN: swiftBin,
	};
	const result = spawnSync(
		"/bin/sh",
		[path.join(repoRoot, "scripts/qa/lib/tauri-app-runner.sh")],
		{ cwd: repoRoot, env: environment, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
