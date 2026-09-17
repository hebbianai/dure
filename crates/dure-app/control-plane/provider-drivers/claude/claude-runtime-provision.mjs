import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
	installClaudeRuntimeArtifact,
	resolveClaudeRuntimeArtifact,
} from "./claude-runtime-artifact.mjs";

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
const TAR = "/usr/bin/tar";

function provisionError(reason, cause) {
	const error = new Error(`dure_claude_runtime_provision_${reason}`, { cause });
	error.code = "DURE_CLAUDE_RUNTIME_PROVISION";
	error.eligibility = "chat_ineligible";
	error.reason = reason;
	return error;
}

function tarballUrl(packageName, sdkVersion) {
	const packageLeaf = packageName.slice(packageName.lastIndexOf("/") + 1);
	return `https://registry.npmjs.org/${packageName}/-/${packageLeaf}-${sdkVersion}.tgz`;
}

async function downloadArchive(url, target, maximumBytes, fetchRequest) {
	let response;
	try {
		response = await fetchRequest(url, {
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
	} catch (cause) {
		throw provisionError("download_failed", cause);
	}
	if (!response.ok || !response.body) {
		throw provisionError("download_failed");
	}

	let receivedBytes = 0;
	const limit = new Transform({
		transform(chunk, _encoding, callback) {
			receivedBytes += chunk.byteLength;
			if (receivedBytes > maximumBytes) {
				callback(provisionError("archive_too_large"));
				return;
			}
			callback(null, chunk);
		},
	});
	try {
		await pipeline(
			Readable.fromWeb(response.body),
			limit,
			fs.createWriteStream(target, { flags: "wx", mode: 0o600 }),
		);
	} catch (cause) {
		if (cause?.code === "DURE_CLAUDE_RUNTIME_PROVISION") throw cause;
		throw provisionError("download_failed", cause);
	}
}

async function extractExecutable(archive, target, entry, expectedSize) {
	const child = spawn(TAR, ["-xOf", archive, entry], {
		shell: false,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	let extractedBytes = 0;
	const limit = new Transform({
		transform(chunk, _encoding, callback) {
			extractedBytes += chunk.byteLength;
			if (extractedBytes > expectedSize) {
				child.kill();
				callback(provisionError("source_size_mismatch"));
				return;
			}
			callback(null, chunk);
		},
	});
	try {
		const [, result] = await Promise.all([
			pipeline(
				child.stdout,
				limit,
				fs.createWriteStream(target, { flags: "wx", mode: 0o600 }),
			),
			exited,
		]);
		if (result.code !== 0 || result.signal !== null) {
			throw provisionError("extract_failed");
		}
		if (extractedBytes !== expectedSize) {
			throw provisionError("source_size_mismatch");
		}
		fs.chmodSync(target, 0o500);
	} catch (cause) {
		if (child.exitCode === null && !child.killed) child.kill();
		await exited.catch(() => {});
		if (cause?.code === "DURE_CLAUDE_RUNTIME_PROVISION") throw cause;
		throw provisionError("extract_failed", cause);
	}
}

export async function ensureClaudeRuntimeArtifact(configuration, dependencies = {}) {
	const tuple = {
		claudeCodeVersion: configuration.claudeCodeVersion,
		runtimeRoot: configuration.runtimeRoot,
		sdkVersion: configuration.sdkVersion,
		target: configuration.runtimeSource.target,
	};
	try {
		return await resolveClaudeRuntimeArtifact(tuple);
	} catch (error) {
		if (error?.reason !== "artifact_unavailable") throw error;
	}

	const staging = fs.mkdtempSync(path.join(configuration.runtimeRoot, ".provision-"));
	fs.chmodSync(staging, 0o700);
	try {
		const archive = path.join(staging, "runtime.tgz");
		await downloadArchive(
			tarballUrl(configuration.runtimeSource.packageName, configuration.sdkVersion),
			archive,
			configuration.runtimeSource.executableSize + 1024 * 1024,
			dependencies.fetchRequest ?? globalThis.fetch,
		);
		const sourceExecutable = path.join(staging, "claude-source");
		await extractExecutable(
			archive,
			sourceExecutable,
			`package/${configuration.runtimeSource.binary}`,
			configuration.runtimeSource.executableSize,
		);
		return await installClaudeRuntimeArtifact({
			...tuple,
			sourceExecutable,
			sourceSha256: configuration.runtimeSource.executableSha256,
		});
	} finally {
		fs.rmSync(staging, { force: true, recursive: true });
	}
}
