#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeRelaySpawner } from "../../provider-drivers/claude/relay-spawned-process.mjs";
import { fixtureClaudeExecutableIdentity } from "./claude-executable-identity.mjs";

function fixtureArguments(arguments_) {
	const values = new Map();
	for (let index = 0; index < arguments_.length; index += 2) {
		const key = arguments_[index];
		const value = arguments_[index + 1];
		if (
			!value ||
			![
				"--endpoint",
				"--capability-file",
				"--state-dir",
				"--runtime-generation",
				"--query-epoch",
				"--relay-id",
			].includes(key) ||
			values.has(key)
		) {
			throw new Error("claude_process_relay_host_fixture_invalid_arguments");
		}
		values.set(key, value);
	}
	if (values.size !== 6) {
		throw new Error("claude_process_relay_host_fixture_invalid_arguments");
	}
	const stateDirectory = path.resolve(values.get("--state-dir"));
	const stateMetadata = fs.lstatSync(stateDirectory);
	if (
		!stateMetadata.isDirectory() ||
		stateMetadata.isSymbolicLink() ||
		stateMetadata.mode & 0o077
	) {
		throw new Error("claude_process_relay_host_fixture_unsafe_state_directory");
	}
	const capabilityFile = path.resolve(values.get("--capability-file"));
	const capabilityMetadata = fs.lstatSync(capabilityFile);
	if (
		!capabilityMetadata.isFile() ||
		capabilityMetadata.isSymbolicLink() ||
		capabilityMetadata.mode & 0o077
	) {
		throw new Error("claude_process_relay_host_fixture_unsafe_capability_file");
	}
	const launchCapability = fs.readFileSync(capabilityFile, "utf8");
	if (
		launchCapability.length < 16 ||
		launchCapability.length > 256 ||
		/[\u0000-\u001f\u007f]/u.test(launchCapability)
	) {
		throw new Error("claude_process_relay_host_fixture_invalid_capability");
	}
	fs.rmSync(capabilityFile);
	return {
		endpoint: path.resolve(values.get("--endpoint")),
		identity: {
			runtimeGeneration: values.get("--runtime-generation"),
			queryEpoch: values.get("--query-epoch"),
			relayId: values.get("--relay-id"),
		},
		launchCapability,
		stateDirectory,
	};
}

function writeMarker(stateDirectory, value) {
	const target = path.join(stateDirectory, "host.json");
	const staging = path.join(stateDirectory, `.host.${process.pid}.tmp`);
	fs.writeFileSync(staging, `${JSON.stringify(value)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	fs.renameSync(staging, target);
}

const { endpoint, identity, launchCapability, stateDirectory } = fixtureArguments(
	process.argv.slice(2),
);
const fakeClaude = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fake-claude-relay-child.mjs",
);
const spawn = createClaudeRelaySpawner({ endpoint, identity, launchCapability });
const child = spawn({
	command: process.execPath,
	commandIdentity: fixtureClaudeExecutableIdentity(process.execPath),
	args: [
		fakeClaude,
		"--state-dir",
		stateDirectory,
		"--mode",
		"wait",
		"--exit-code",
		"0",
	],
	cwd: process.cwd(),
	env: { ...process.env },
	signal: new AbortController().signal,
});
child.stdin.on("error", () => {});
child.stdout.on("error", () => {});
child.stdout.resume();

writeMarker(stateDirectory, {
	role: "claude-sdk-host-fixture",
	pid: process.pid,
	parentPid: process.ppid,
});

await new Promise((resolve) => {
	child.once("error", resolve);
	child.once("exit", resolve);
});
