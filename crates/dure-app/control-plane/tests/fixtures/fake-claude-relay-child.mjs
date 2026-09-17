#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function fixtureArguments(arguments_) {
	if (
		arguments_.length !== 6 ||
		arguments_[0] !== "--state-dir" ||
		arguments_[2] !== "--mode" ||
		!["echo", "wait"].includes(arguments_[3]) ||
		arguments_[4] !== "--exit-code"
	) {
		throw new Error("fake_claude_relay_child_invalid_arguments");
	}
	const stateDirectory = path.resolve(arguments_[1]);
	const metadata = fs.lstatSync(stateDirectory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mode & 0o077) {
		throw new Error("fake_claude_relay_child_unsafe_state_directory");
	}
	const exitCode = Number(arguments_[5]);
	if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
		throw new Error("fake_claude_relay_child_invalid_exit_code");
	}
	return { exitCode, mode: arguments_[3], stateDirectory };
}

function writeMarker(stateDirectory, mode) {
	const target = path.join(stateDirectory, "child.json");
	const staging = path.join(stateDirectory, `.child.${process.pid}.tmp`);
	fs.writeFileSync(
		staging,
		`${JSON.stringify({ role: "fake-claude-relay-child", mode, pid: process.pid, parentPid: process.ppid })}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	fs.renameSync(staging, target);
}

const { exitCode, mode, stateDirectory } = fixtureArguments(process.argv.slice(2));
writeMarker(stateDirectory, mode);

if (mode === "wait") {
	setInterval(() => {}, 300_000);
} else {
	process.stderr.write(`stderr-start-${"x".repeat(3_000)}-stderr-end`);
	process.stdin.on("data", (chunk) => {
		if (!process.stdout.write(chunk)) {
			process.stdin.pause();
			process.stdout.once("drain", () => process.stdin.resume());
		}
	});
	process.stdin.on("end", () => {
		process.exitCode = exitCode;
	});
}
