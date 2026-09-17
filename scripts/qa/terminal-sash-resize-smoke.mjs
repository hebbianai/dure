#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const swiftBin = "/usr/bin/swift";

if (process.platform !== "darwin") {
	throw new Error("Terminal sash resize smoke: macOS is required");
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
	console.error(`Terminal sash resize smoke: SKIP ${preflightOutput}`);
	process.exitCode = process.env.DURE_QA_REQUIRE_EXECUTION === "1" ? 22 : 0;
} else if (preflight.status !== 0) {
	throw new Error(
		`Terminal sash resize smoke: native-input preflight failed: ${preflightOutput}`,
	);
} else {
	const windowTitle = "Dure Terminal Sash Resize QA";
	const windowUrl =
		"index.html?qaWorkspacePerformance=1&scenario=sash_2&phase=sash";
	const environment = {
		...process.env,
		DURE_QA_CLIENT: "scripts/qa/terminal-sash-resize-client.mjs",
		DURE_QA_NAME: "Terminal sash resize smoke",
		DURE_QA_ARTIFACT_NAME: "terminal-sash-resize",
		DURE_QA_LAYER: "exclusive_focus_terminal_sash_resize",
		DURE_QA_UNIQUE_APP_CHANNEL: "1",
		DURE_QA_WINDOW_TITLE: windowTitle,
		DURE_QA_WINDOW_URL: windowUrl,
		DURE_QA_WINDOW_PLAN_JSON: JSON.stringify([
			{
				label: "main",
				title: windowTitle,
				url: windowUrl,
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
		DURE_QA_PERFORMANCE_SCENARIO: "sash_2",
		DURE_QA_PERFORMANCE_PHASE: "sash",
		DURE_QA_HOME_SETUP: path.join(
			repoRoot,
			"scripts/qa/workspace-performance-home-setup.mjs",
		),
		VITE_DURE_WORKSPACE_PERFORMANCE_QA: "1",
		SHELL: "/bin/zsh",
	};
	const result = spawnSync(
		"/bin/sh",
		[path.join(repoRoot, "scripts/qa/lib/tauri-app-runner.sh")],
		{ cwd: repoRoot, env: environment, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
