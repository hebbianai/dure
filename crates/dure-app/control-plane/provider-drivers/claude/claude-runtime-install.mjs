#!/usr/bin/env node

import path from "node:path";

import {
	claudeRuntimeArtifactDescriptor,
	claudeRuntimeTarget,
	installClaudeRuntimeArtifact,
} from "./claude-runtime-artifact.mjs";
import { loadPinnedClaudeSdkRuntime } from "./sdk-runtime.mjs";

function argumentsFrom(values) {
	if (values.length !== 4) throw new Error("dure_claude_runtime_install_arguments_invalid");
	const parsed = new Map();
	for (let index = 0; index < values.length; index += 2) {
		const key = values[index];
		const value = values[index + 1];
		if (!["--runtime-root", "--source"].includes(key) || parsed.has(key)) {
			throw new Error("dure_claude_runtime_install_arguments_invalid");
		}
		parsed.set(key, value);
	}
	if (!["--runtime-root", "--source"].every((key) => parsed.has(key))) {
		throw new Error("dure_claude_runtime_install_arguments_invalid");
	}
	return Object.freeze({
		runtimeRoot: path.resolve(parsed.get("--runtime-root")),
		sourceExecutable: path.resolve(parsed.get("--source")),
	});
}

const options = argumentsFrom(process.argv.slice(2));
const sdk = await loadPinnedClaudeSdkRuntime();
const artifact = await installClaudeRuntimeArtifact({
	claudeCodeVersion: sdk.metadata.claudeCodeVersion,
	runtimeRoot: options.runtimeRoot,
	sdkVersion: sdk.metadata.sdkVersion,
	sourceExecutable: options.sourceExecutable,
	target: claudeRuntimeTarget(),
});
const descriptor = claudeRuntimeArtifactDescriptor(artifact);
process.stdout.write(
	`${JSON.stringify({
		claudeCodeVersion: descriptor.claudeCodeVersion,
		executablePath: descriptor.executablePath,
		executableSha256: descriptor.executableIdentity.sha256,
		manifestPath: descriptor.manifestPath,
		sdkVersion: descriptor.sdkVersion,
		target: descriptor.target,
	})}\n`,
);
