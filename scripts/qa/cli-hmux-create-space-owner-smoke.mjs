#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const targetWindowLabel = "win-100-2";

const result = spawnSync(
	"/bin/sh",
	[path.join(repoRoot, "scripts/qa/lib/tauri-app-runner.sh")],
	{
		cwd: repoRoot,
		env: {
			...process.env,
			DURE_QA_CLIENT: "scripts/qa/cli-hmux-create-space-owner-client.mjs",
			DURE_QA_NAME: "CLI Hmux Space owner smoke",
			DURE_QA_ARTIFACT_NAME: "cli-hmux-space-owner",
			DURE_QA_LAYER: "control_plane",
			DURE_QA_UNIQUE_APP_CHANNEL: "1",
			DURE_QA_TARGET_WINDOW_LABEL: targetWindowLabel,
			DURE_QA_WINDOW_PLAN_JSON: JSON.stringify([
				{
					label: "main",
					title: "Dure CLI coordinator QA",
					url: "index.html?panel=source-control",
					width: 720,
					height: 480,
					x: -4000,
					y: -2000,
					visible: false,
					focus: false,
					focusable: false,
				},
				{
					label: targetWindowLabel,
					title: "Dure CLI Space owner QA",
					url: "index.html?desktop=desk-1",
					width: 960,
					height: 640,
					x: -4000,
					y: -2000,
					visible: true,
					focus: false,
					focusable: false,
				},
			]),
		},
		stdio: "inherit",
	},
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
