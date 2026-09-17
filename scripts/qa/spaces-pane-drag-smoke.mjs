#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const swiftBin = "/usr/bin/swift";

if (process.platform !== "darwin") {
	throw new Error("Spaces pane drag smoke: macOS is required");
}
try {
	fs.accessSync(swiftBin, fs.constants.X_OK);
} catch {
	throw new Error(`Spaces pane drag smoke: ${swiftBin} is required`);
}

const preflight = spawnSync(
	process.execPath,
	[path.join(repoRoot, "scripts/qa/lib/exclusive-focus-preflight.mjs")],
	{ cwd: repoRoot, encoding: "utf8", env: process.env },
);
if (preflight.error) throw preflight.error;
const preflightOutput = String(preflight.stderr || preflight.stdout).trim();
if (preflight.status === 20) {
	console.error(`Spaces pane drag smoke: SKIP ${preflightOutput}`);
	process.exitCode = process.env.DURE_QA_REQUIRE_EXECUTION === "1" ? 22 : 0;
} else if (preflight.status !== 0) {
	throw new Error(
		`Spaces pane drag smoke: native-input preflight failed: ${preflightOutput}`,
	);
} else {
	const environment = {
		...process.env,
		DURE_QA_CLIENT: "scripts/qa/spaces-pane-drag-client.mjs",
		DURE_QA_NAME: "Spaces pane drag smoke",
		DURE_QA_ARTIFACT_NAME: "spaces-pane-drag",
		DURE_QA_LAYER: "native_input_spaces_pane_drag",
		DURE_QA_UNIQUE_APP_CHANNEL: "1",
		DURE_QA_WINDOW_TITLE: "Dure Spaces Pane Drag QA",
		DURE_QA_WINDOW_URL: "index.html",
		DURE_QA_WINDOW_PLAN_JSON: JSON.stringify([
			{
				label: "main",
				title: "Dure Spaces Pane Drag QA",
				url: "index.html",
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
		DURE_QA_PROVIDER_BIN: path.join(repoRoot, "scripts/qa/fake-provider"),
		PATH: `${path.join(repoRoot, "scripts/qa/fake-provider")}${path.delimiter}${process.env.PATH ?? ""}`,
	};
	const result = spawnSync(
		"/bin/sh",
		[path.join(repoRoot, "scripts/qa/lib/tauri-app-runner.sh")],
		{ cwd: repoRoot, env: environment, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
