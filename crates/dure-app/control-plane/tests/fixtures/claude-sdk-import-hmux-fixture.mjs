#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadPinnedClaudeSdk } from "../../provider-drivers/claude/sdk-runtime.mjs";

const startedAt = performance.now();

function fixtureArguments(arguments_) {
	if (
		arguments_.length !== 4 ||
		arguments_[0] !== "--state-dir" ||
		arguments_[2] !== "--mode" ||
		!["empty", "sdk-import"].includes(arguments_[3])
	) {
		throw new Error("claude_sdk_import_fixture_invalid_arguments");
	}
	const stateDirectory = path.resolve(arguments_[1]);
	const metadata = fs.lstatSync(stateDirectory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mode & 0o077) {
		throw new Error("claude_sdk_import_fixture_unsafe_state_directory");
	}
	return { mode: arguments_[3], stateDirectory };
}

function writeMarker(stateDirectory, value) {
	const target = path.join(stateDirectory, "driver.json");
	const staging = path.join(stateDirectory, `.driver.${process.pid}.tmp`);
	fs.writeFileSync(staging, `${JSON.stringify(value)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	fs.renameSync(staging, target);
}

const { mode, stateDirectory } = fixtureArguments(process.argv.slice(2));
const memoryBefore = process.memoryUsage();
const sdk =
	mode === "sdk-import"
		? await loadPinnedClaudeSdk()
		: {
				claudeCodeVersion: null,
				importDurationMs: 0,
				nativePackage: null,
				nativePackagePresent: false,
				queryExportPresent: false,
				sdkImported: false,
				sdkVersion: null,
				startupExportPresent: false,
			};
const memoryAfter = process.memoryUsage();

writeMarker(stateDirectory, {
	role: "dure-claude-driver",
	pid: process.pid,
	parentPid: process.ppid,
	mode,
	nodeVersion: process.versions.node,
	readyDurationMs: performance.now() - startedAt,
	memoryBefore,
	memoryAfter,
	...sdk,
});

setInterval(() => {}, 300_000);
