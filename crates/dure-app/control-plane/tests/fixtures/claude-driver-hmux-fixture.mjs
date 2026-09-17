#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runSingleClaudeRuntime } from "../../provider-drivers/claude/process-owner.mjs";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const fakeRuntime = path.join(fixtureDirectory, "fake-claude-runtime.mjs");

function stateDirectoryFromArguments(arguments_) {
	if (arguments_.length !== 2 || arguments_[0] !== "--state-dir") {
		throw new Error("claude_driver_fixture_invalid_arguments");
	}
	const stateDirectory = path.resolve(arguments_[1]);
	const metadata = fs.lstatSync(stateDirectory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mode & 0o077) {
		throw new Error("claude_driver_fixture_unsafe_state_directory");
	}
	return stateDirectory;
}

function writeMarker(stateDirectory, name, value) {
	const target = path.join(stateDirectory, `${name}.json`);
	const staging = path.join(stateDirectory, `.${name}.${process.pid}.tmp`);
	fs.writeFileSync(staging, `${JSON.stringify(value)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	fs.renameSync(staging, target);
}

const stateDirectory = stateDirectoryFromArguments(process.argv.slice(2));
writeMarker(stateDirectory, "driver", {
	role: "dure-claude-driver",
	pid: process.pid,
	parentPid: process.ppid,
});

try {
	const result = await runSingleClaudeRuntime({
		launch: () => {
			const child = spawn(
				process.execPath,
				[fakeRuntime, "--state-dir", stateDirectory, "--role", "claude"],
				{
					env: process.env,
					shell: false,
					stdio: "ignore",
				},
			);
			const completion = new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", (code, signal) => resolve({ code, signal }));
			});
			return { child, completion };
		},
	});
	process.exitCode = result.code ?? (result.signal ? 1 : 0);
} catch (error) {
	process.stderr.write(
		`dure_claude_driver_fixture_failed: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 70;
}
