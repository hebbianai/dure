import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	attestClaudeRuntimeArtifact,
	claudeRuntimeArtifactDescriptor,
	claudeRuntimeTarget,
	installClaudeRuntimeArtifact,
	resolveClaudeRuntimeArtifact,
} from "./claude-runtime-artifact.mjs";

const TARGET = claudeRuntimeTarget();

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-runtime-test-"));
	fs.chmodSync(root, 0o700);
	const runtimeRoot = path.join(root, "managed");
	return { root, runtimeRoot };
}

function fakeClaude(root, version, name = `claude-${version}`) {
	const executable = path.join(root, name);
	fs.writeFileSync(
		executable,
		`#!/usr/bin/env node\nif (process.argv[2] === "--version") process.stdout.write("${version} (Claude Code)\\n");\n`,
		{ flag: "wx", mode: 0o700 },
	);
	return executable;
}

function configuration(runtimeRoot, sourceExecutable, overrides = {}) {
	return {
		claudeCodeVersion: "2.1.234",
		runtimeRoot,
		sdkVersion: "0.3.234",
		sourceExecutable,
		target: TARGET,
		...overrides,
	};
}

test("an exact user-installed CLI becomes an immutable managed tuple without selecting PATH", async () => {
	const { root, runtimeRoot } = fixture();
	try {
		const globalMismatch = fakeClaude(root, "2.1.221", "global-claude");
		const exactSource = fakeClaude(root, "2.1.234", "exact-claude");
		const artifact = await installClaudeRuntimeArtifact(
			configuration(runtimeRoot, exactSource),
		);
		const descriptor = claudeRuntimeArtifactDescriptor(artifact);

		assert.notEqual(descriptor.executablePath, globalMismatch);
		assert.notEqual(descriptor.executablePath, exactSource);
		assert.equal(descriptor.claudeCodeVersion, "2.1.234");
		assert.equal(descriptor.sdkVersion, "0.3.234");
		assert.equal(descriptor.target, TARGET);
		assert.match(descriptor.executableIdentity.sha256, /^sha256:[0-9a-f]{64}$/u);
		assert.equal(fs.lstatSync(descriptor.executablePath).mode & 0o777, 0o500);
		assert.equal(fs.lstatSync(descriptor.manifestPath).mode & 0o777, 0o600);
		assert.equal(
			claudeRuntimeArtifactDescriptor(
				await resolveClaudeRuntimeArtifact({
					claudeCodeVersion: "2.1.234",
					runtimeRoot,
					sdkVersion: "0.3.234",
					target: TARGET,
				}),
			).executableIdentity.sha256,
			descriptor.executableIdentity.sha256,
		);
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("install rejects a source whose observed Claude Code version does not match the SDK tuple", async () => {
	const { root, runtimeRoot } = fixture();
	try {
		await assert.rejects(
			installClaudeRuntimeArtifact(
				configuration(runtimeRoot, fakeClaude(root, "2.1.221")),
			),
			/dure_claude_runtime_source_version_mismatch/u,
		);
		assert.equal(fs.existsSync(path.join(runtimeRoot, "sdk-0.3.234")), false);
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("automatic installation rejects a source outside the SDK-pinned digest", async () => {
	const { root, runtimeRoot } = fixture();
	try {
		const source = fakeClaude(root, "2.1.234");
		const observed = `sha256:${createHash("sha256")
			.update(fs.readFileSync(source))
			.digest("hex")}`;
		await assert.rejects(
			installClaudeRuntimeArtifact(
				configuration(runtimeRoot, source, {
					sourceSha256: `sha256:${"0".repeat(64)}`,
				}),
			),
			/dure_claude_runtime_source_digest_mismatch/u,
		);
		assert.equal(fs.existsSync(path.join(runtimeRoot, "sdk-0.3.234")), false);

		const artifact = await installClaudeRuntimeArtifact(
			configuration(runtimeRoot, source, { sourceSha256: observed }),
		);
		assert.equal(
			claudeRuntimeArtifactDescriptor(artifact).executableIdentity.sha256,
			observed,
		);
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("a missing exact tuple is a typed Chat-ineligible runtime result", async () => {
	const { root, runtimeRoot } = fixture();
	try {
		fs.mkdirSync(runtimeRoot, { mode: 0o700 });
		await assert.rejects(
			resolveClaudeRuntimeArtifact({
				claudeCodeVersion: "2.1.234",
				runtimeRoot,
				sdkVersion: "0.3.234",
				target: TARGET,
			}),
			(error) =>
				error?.code === "DURE_CLAUDE_RUNTIME_CONTRACT" &&
				error.eligibility === "chat_ineligible" &&
				error.reason === "artifact_unavailable" &&
				error.message === "dure_claude_runtime_artifact_unavailable",
		);
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("a symlink or replacement cannot inherit an admitted runtime capability", async () => {
	const { root, runtimeRoot } = fixture();
	try {
		const source = fakeClaude(root, "2.1.234");
		const artifact = await installClaudeRuntimeArtifact(configuration(runtimeRoot, source));
		const descriptor = claudeRuntimeArtifactDescriptor(artifact);
		const retained = `${descriptor.executablePath}.retained`;
		fs.renameSync(descriptor.executablePath, retained);
		fs.symlinkSync(retained, descriptor.executablePath);
		assert.throws(
			() => attestClaudeRuntimeArtifact(artifact),
			/dure_claude_runtime_executable_replaced/u,
		);
		await assert.rejects(
			resolveClaudeRuntimeArtifact({
				claudeCodeVersion: "2.1.234",
				runtimeRoot,
				sdkVersion: "0.3.234",
				target: TARGET,
			}),
			/dure_claude_runtime_executable_unsafe/u,
		);

		fs.rmSync(descriptor.executablePath);
		const replacement = fakeClaude(root, "2.1.234", "replacement");
		fs.copyFileSync(replacement, descriptor.executablePath);
		fs.chmodSync(descriptor.executablePath, 0o500);
		assert.throws(
			() => attestClaudeRuntimeArtifact(artifact),
			/dure_claude_runtime_executable_replaced/u,
		);
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("current and previous SDK/CLI tuples coexist without a mutable current symlink", async () => {
	const { root, runtimeRoot } = fixture();
	try {
		const previous = await installClaudeRuntimeArtifact(
			configuration(runtimeRoot, fakeClaude(root, "2.1.233"), {
				claudeCodeVersion: "2.1.233",
				sdkVersion: "0.3.233",
			}),
		);
		const current = await installClaudeRuntimeArtifact(
			configuration(runtimeRoot, fakeClaude(root, "2.1.234")),
		);
		const previousDescriptor = claudeRuntimeArtifactDescriptor(previous);
		const currentDescriptor = claudeRuntimeArtifactDescriptor(current);

		assert.notEqual(previousDescriptor.executablePath, currentDescriptor.executablePath);
		assert.equal(fs.existsSync(previousDescriptor.executablePath), true);
		assert.equal(fs.existsSync(currentDescriptor.executablePath), true);
		assert.equal(fs.existsSync(path.join(runtimeRoot, "current")), false);
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});
