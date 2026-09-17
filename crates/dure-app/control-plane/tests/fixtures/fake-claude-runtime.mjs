#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function fixtureArguments(arguments_) {
	if (
		arguments_.length !== 4 ||
		arguments_[0] !== "--state-dir" ||
		arguments_[2] !== "--role" ||
		!["claude", "mcp"].includes(arguments_[3])
	) {
		throw new Error("fake_claude_runtime_invalid_arguments");
	}
	return {
		stateDirectory: path.resolve(arguments_[1]),
		role: arguments_[3],
	};
}

function writeMarker(stateDirectory, role) {
	const target = path.join(stateDirectory, `${role}.json`);
	const staging = path.join(stateDirectory, `.${role}.${process.pid}.tmp`);
	fs.writeFileSync(
		staging,
		`${JSON.stringify({ role: `fake-${role}`, pid: process.pid, parentPid: process.ppid })}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	fs.renameSync(staging, target);
}

const { stateDirectory, role } = fixtureArguments(process.argv.slice(2));
writeMarker(stateDirectory, role);

if (role === "claude") {
	spawn(
		process.execPath,
		[
			fileURLToPath(import.meta.url),
			"--state-dir",
			stateDirectory,
			"--role",
			"mcp",
		],
		{ env: process.env, shell: false, stdio: "ignore" },
	);
}

setInterval(() => {}, 300_000);
