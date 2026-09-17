import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	claudeRuntimeArtifactDescriptor,
	claudeRuntimeTarget,
} from "./claude-runtime-artifact.mjs";
import { ensureClaudeRuntimeArtifact } from "./claude-runtime-provision.mjs";

const TARGET = claudeRuntimeTarget();

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-provision-test-"));
	fs.chmodSync(root, 0o700);
	const runtimeRoot = path.join(root, "managed");
	fs.mkdirSync(runtimeRoot, { mode: 0o700 });
	const sourceRoot = path.join(root, "source");
	const packageRoot = path.join(sourceRoot, "package");
	fs.mkdirSync(packageRoot, { mode: 0o700, recursive: true });
	const executable = path.join(packageRoot, "claude");
	fs.writeFileSync(
		executable,
		'#!/usr/bin/env node\nif (process.argv[2] === "--version") process.stdout.write("2.1.234 (Claude Code)\\n");\n',
		{ flag: "wx", mode: 0o700 },
	);
	const archive = path.join(root, "runtime.tgz");
	const packed = spawnSync(
		"/usr/bin/tar",
		["-czf", archive, "-C", sourceRoot, "package/claude"],
		{ encoding: "utf8", shell: false },
	);
	assert.equal(packed.error, undefined);
	assert.equal(packed.status, 0, packed.stderr);
	return {
		archive: fs.readFileSync(archive),
		configuration: {
			claudeCodeVersion: "2.1.234",
			runtimeRoot,
			runtimeSource: {
				binary: "claude",
				executableSha256: `sha256:${createHash("sha256")
					.update(fs.readFileSync(executable))
					.digest("hex")}`,
				executableSize: fs.statSync(executable).size,
				packageName: `@anthropic-ai/claude-agent-sdk-${TARGET.replace(/-gnu$/u, "")}`,
				target: TARGET,
			},
			sdkVersion: "0.3.234",
		},
		root,
	};
}

test("a missing SDK-pinned Claude runtime is materialized once and then reused", async () => {
	const { archive, configuration, root } = fixture();
	let fetches = 0;
	try {
		const artifact = await ensureClaudeRuntimeArtifact(configuration, {
			async fetchRequest(url) {
				fetches += 1;
				assert.equal(
					url,
					`https://registry.npmjs.org/${configuration.runtimeSource.packageName}/-/claude-agent-sdk-${TARGET.replace(/-gnu$/u, "")}-0.3.234.tgz`,
				);
				return new Response(archive, { status: 200 });
			},
		});
		assert.equal(fetches, 1);
		assert.equal(
			claudeRuntimeArtifactDescriptor(artifact).executableIdentity.sha256,
			configuration.runtimeSource.executableSha256,
		);

		const reused = await ensureClaudeRuntimeArtifact(configuration, {
			fetchRequest() {
				throw new Error("an installed tuple must not download again");
			},
		});
		assert.equal(
			claudeRuntimeArtifactDescriptor(reused).executablePath,
			claudeRuntimeArtifactDescriptor(artifact).executablePath,
		);
		assert.equal(fetches, 1);
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});
