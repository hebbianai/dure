import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const ARTIFACT_SCHEMA = "dure-claude-runtime-artifact/v1";
const EXECUTABLE_FILE = "claude";
const MANIFEST_FILE = "manifest.json";
const MAX_EXECUTABLE_BYTES = 512n * 1024n * 1024n;
const MAX_MANIFEST_BYTES = 16n * 1024n;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const capabilities = new WeakMap();

function runtimeError(reason) {
	const error = new Error(`dure_claude_runtime_${reason}`);
	error.code = "DURE_CLAUDE_RUNTIME_CONTRACT";
	error.eligibility = "chat_ineligible";
	error.reason = reason;
	return error;
}

function exactVersion(value, reason) {
	if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
		throw runtimeError(reason);
	}
	return value;
}

function exactTarget(value) {
	if (
		typeof value !== "string" ||
		!/^(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)-(?:gnu|musl))$/u.test(value)
	) {
		throw runtimeError("target_invalid");
	}
	return value;
}

function absolutePath(value, reason) {
	if (
		typeof value !== "string" ||
		value.includes("\0") ||
		!path.isAbsolute(value) ||
		path.normalize(value) !== value
	) {
		throw runtimeError(reason);
	}
	return value;
}

function currentUserId() {
	return typeof process.geteuid === "function" ? process.geteuid() : null;
}

function ownerDirectory(target, reason, missingReason = reason) {
	let metadata;
	try {
		metadata = fs.lstatSync(target, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT") throw runtimeError(missingReason);
		throw runtimeError(reason);
	}
	const userId = currentUserId();
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		(userId !== null && metadata.uid !== BigInt(userId)) ||
		(metadata.mode & 0o077n) !== 0n
	) {
		throw runtimeError(reason);
	}
	return target;
}

function ensureOwnerDirectory(target, reason) {
	try {
		fs.mkdirSync(target, { mode: 0o700 });
	} catch (error) {
		if (error?.code !== "EEXIST") throw runtimeError(reason);
	}
	return ownerDirectory(target, reason);
}

function exactKeys(value, expected, reason) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw runtimeError(reason);
	}
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (
		actual.length !== sortedExpected.length ||
		actual.some((key, index) => key !== sortedExpected[index])
	) {
		throw runtimeError(reason);
	}
	return value;
}

function tuplePaths({ claudeCodeVersion, runtimeRoot, sdkVersion, target }) {
	runtimeRoot = absolutePath(runtimeRoot, "root_invalid");
	sdkVersion = exactVersion(sdkVersion, "sdk_version_invalid");
	claudeCodeVersion = exactVersion(claudeCodeVersion, "claude_code_version_invalid");
	target = exactTarget(target);
	const sdkDirectory = path.join(runtimeRoot, `sdk-${sdkVersion}`);
	const versionDirectory = path.join(sdkDirectory, `cli-${claudeCodeVersion}`);
	const tupleDirectory = path.join(versionDirectory, target);
	return Object.freeze({
		executablePath: path.join(tupleDirectory, EXECUTABLE_FILE),
		manifestPath: path.join(tupleDirectory, MANIFEST_FILE),
		runtimeRoot,
		sdkDirectory,
		tupleDirectory,
		versionDirectory,
	});
}

function executableMetadata(metadata, { managed, reason }) {
	const userId = currentUserId();
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		metadata.size < 1n ||
		metadata.size > MAX_EXECUTABLE_BYTES ||
		(metadata.mode & 0o111n) === 0n ||
		(metadata.mode & 0o022n) !== 0n ||
		(userId !== null && metadata.uid !== 0n && metadata.uid !== BigInt(userId)) ||
		(managed && (metadata.uid !== BigInt(userId) || metadata.nlink !== 1n))
	) {
		throw runtimeError(reason);
	}
	return metadata;
}

function fileIdentity(metadata, sha256) {
	return Object.freeze({
		changedNanoseconds: (metadata.ctimeNs % 1_000_000_000n).toString(),
		changedSeconds: (metadata.ctimeNs / 1_000_000_000n).toString(),
		device: metadata.dev.toString(),
		inode: metadata.ino.toString(),
		modifiedNanoseconds: (metadata.mtimeNs % 1_000_000_000n).toString(),
		modifiedSeconds: (metadata.mtimeNs / 1_000_000_000n).toString(),
		sha256,
		size: metadata.size.toString(),
	});
}

function sameFileIdentity(left, right) {
	return [
		"changedNanoseconds",
		"changedSeconds",
		"device",
		"inode",
		"modifiedNanoseconds",
		"modifiedSeconds",
		"sha256",
		"size",
	].every((key) => left[key] === right[key]);
}

function sameOpenFile(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.nlink === right.nlink
	);
}

async function hashExecutable(target, { managed, reason }) {
	let handle;
	try {
		handle = await fs.promises.open(
			target,
			fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
		);
		const before = executableMetadata(await handle.stat({ bigint: true }), {
			managed,
			reason,
		});
		const digest = createHash("sha256");
		for await (const chunk of handle.createReadStream({ autoClose: false })) {
			digest.update(chunk);
		}
		const after = executableMetadata(await handle.stat({ bigint: true }), {
			managed,
			reason,
		});
		const linked = executableMetadata(fs.lstatSync(target, { bigint: true }), {
			managed,
			reason,
		});
		if (!sameOpenFile(before, after) || !sameOpenFile(after, linked)) {
			throw runtimeError(reason);
		}
		return fileIdentity(after, `sha256:${digest.digest("hex")}`);
	} catch (error) {
		if (error?.code === "DURE_CLAUDE_RUNTIME_CONTRACT") throw error;
		throw runtimeError(reason);
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function readManifest(target) {
	let handle;
	try {
		handle = await fs.promises.open(
			target,
			fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
		);
		const before = await handle.stat({ bigint: true });
		const userId = currentUserId();
		if (
			!before.isFile() ||
			before.isSymbolicLink() ||
			before.size < 1n ||
			before.size > MAX_MANIFEST_BYTES ||
			before.nlink !== 1n ||
			(userId !== null && before.uid !== BigInt(userId)) ||
			(before.mode & 0o077n) !== 0n
		) {
			throw runtimeError("manifest_unsafe");
		}
		const source = await handle.readFile({ encoding: "utf8" });
		const after = await handle.stat({ bigint: true });
		const linked = fs.lstatSync(target, { bigint: true });
		if (!sameOpenFile(before, after) || !sameOpenFile(after, linked)) {
			throw runtimeError("manifest_replaced");
		}
		let manifest;
		try {
			manifest = JSON.parse(source);
		} catch {
			throw runtimeError("manifest_invalid");
		}
		return exactKeys(
			manifest,
			[
				"claudeCodeVersion",
				"executable",
				"executableSha256",
				"schema",
				"sdkVersion",
				"target",
			],
			"manifest_invalid",
		);
	} catch (error) {
		if (error?.code === "DURE_CLAUDE_RUNTIME_CONTRACT") throw error;
		throw runtimeError("manifest_unsafe");
	} finally {
		await handle?.close().catch(() => {});
	}
}

function validateTupleDirectories(paths) {
	ownerDirectory(paths.runtimeRoot, "root_unsafe", "root_unavailable");
	ownerDirectory(paths.sdkDirectory, "sdk_directory_unsafe", "artifact_unavailable");
	ownerDirectory(paths.versionDirectory, "version_directory_unsafe", "artifact_unavailable");
	ownerDirectory(paths.tupleDirectory, "tuple_directory_unsafe", "artifact_unavailable");
}

async function loadDescriptor(configuration) {
	const paths = tuplePaths(configuration);
	validateTupleDirectories(paths);
	const manifest = await readManifest(paths.manifestPath);
	if (
		manifest.schema !== ARTIFACT_SCHEMA ||
		manifest.sdkVersion !== configuration.sdkVersion ||
		manifest.claudeCodeVersion !== configuration.claudeCodeVersion ||
		manifest.target !== configuration.target ||
		manifest.executable !== EXECUTABLE_FILE ||
		typeof manifest.executableSha256 !== "string" ||
		!DIGEST_PATTERN.test(manifest.executableSha256)
	) {
		throw runtimeError("manifest_mismatch");
	}
	const executableIdentity = await hashExecutable(paths.executablePath, {
		managed: true,
		reason: "executable_unsafe",
	});
	if (executableIdentity.sha256 !== manifest.executableSha256) {
		throw runtimeError("executable_digest_mismatch");
	}
	return Object.freeze({
		claudeCodeVersion: configuration.claudeCodeVersion,
		executableIdentity,
		executablePath: paths.executablePath,
		manifestPath: paths.manifestPath,
		runtimeRoot: paths.runtimeRoot,
		schema: ARTIFACT_SCHEMA,
		sdkVersion: configuration.sdkVersion,
		target: configuration.target,
	});
}

function capability(descriptor) {
	const value = Object.freeze({
		claudeCodeVersion: descriptor.claudeCodeVersion,
		executablePath: descriptor.executablePath,
		executableSha256: descriptor.executableIdentity.sha256,
		sdkVersion: descriptor.sdkVersion,
		target: descriptor.target,
	});
	capabilities.set(value, descriptor);
	return value;
}

function safeRemoveStaging(target) {
	let metadata;
	try {
		metadata = fs.lstatSync(target, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw runtimeError("staging_cleanup_failed");
	}
	const userId = currentUserId();
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		(userId !== null && metadata.uid !== BigInt(userId))
	) {
		throw runtimeError("staging_cleanup_unsafe");
	}
	fs.rmSync(target, { recursive: true });
}

function syncDirectory(target) {
	const descriptor = fs.openSync(target, fs.constants.O_RDONLY);
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

function exactVersionOutput(source, claudeCodeVersion, runtimeRoot) {
	const verificationRoot = path.join(
		runtimeRoot,
		`.verify-${process.pid}-${randomBytes(8).toString("hex")}`,
	);
	ensureOwnerDirectory(verificationRoot, "verification_directory_unsafe");
	try {
		const environment = {
			CLAUDE_CONFIG_DIR: path.join(verificationRoot, "config"),
			DISABLE_AUTOUPDATER: "1",
			HOME: verificationRoot,
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			XDG_CACHE_HOME: path.join(verificationRoot, "cache"),
			XDG_CONFIG_HOME: path.join(verificationRoot, "xdg-config"),
			XDG_DATA_HOME: path.join(verificationRoot, "data"),
		};
		const result = spawnSync(source, ["--version"], {
			cwd: verificationRoot,
			encoding: "utf8",
			env: environment,
			maxBuffer: 64 * 1024,
			shell: false,
			timeout: 15_000,
		});
		if (
			result.error ||
			result.status !== 0 ||
			result.signal !== null ||
			result.stderr !== "" ||
			result.stdout.trim() !== `${claudeCodeVersion} (Claude Code)`
		) {
			throw runtimeError("source_version_mismatch");
		}
	} finally {
		safeRemoveStaging(verificationRoot);
	}
}

export function claudeRuntimeTarget({ architecture = process.arch, platform = process.platform } = {}) {
	if (platform === "darwin" && ["arm64", "x64"].includes(architecture)) {
		return `darwin-${architecture}`;
	}
	if (platform === "linux" && ["arm64", "x64"].includes(architecture)) {
		const usesGlibc = Boolean(process.report?.getReport?.()?.header?.glibcVersionRuntime);
		return `linux-${architecture}-${usesGlibc ? "gnu" : "musl"}`;
	}
	throw runtimeError("target_unsupported");
}

export async function resolveClaudeRuntimeArtifact(configuration) {
	configuration = exactKeys(
		configuration,
		["claudeCodeVersion", "runtimeRoot", "sdkVersion", "target"],
		"configuration_invalid",
	);
	const normalized = Object.freeze({
		claudeCodeVersion: exactVersion(
			configuration.claudeCodeVersion,
			"claude_code_version_invalid",
		),
		runtimeRoot: absolutePath(configuration.runtimeRoot, "root_invalid"),
		sdkVersion: exactVersion(configuration.sdkVersion, "sdk_version_invalid"),
		target: exactTarget(configuration.target),
	});
	return capability(await loadDescriptor(normalized));
}

export function claudeRuntimeArtifactDescriptor(artifact) {
	const descriptor = capabilities.get(artifact);
	if (!descriptor) throw runtimeError("capability_invalid");
	return descriptor;
}

export function attestClaudeRuntimeArtifact(artifact) {
	const descriptor = claudeRuntimeArtifactDescriptor(artifact);
	let metadata;
	try {
		metadata = executableMetadata(fs.lstatSync(descriptor.executablePath, { bigint: true }), {
			managed: true,
			reason: "executable_replaced",
		});
	} catch (error) {
		if (error?.code === "DURE_CLAUDE_RUNTIME_CONTRACT") throw error;
		throw runtimeError("executable_replaced");
	}
	const observed = fileIdentity(metadata, descriptor.executableIdentity.sha256);
	if (!sameFileIdentity(observed, descriptor.executableIdentity)) {
		throw runtimeError("executable_replaced");
	}
	return descriptor;
}

export async function installClaudeRuntimeArtifact(configuration) {
	const configurationKeys = [
		"claudeCodeVersion",
		"runtimeRoot",
		"sdkVersion",
		"sourceExecutable",
		"target",
	];
	if (configuration?.sourceSha256 !== undefined) {
		configurationKeys.push("sourceSha256");
	}
	configuration = exactKeys(
		configuration,
		configurationKeys,
		"configuration_invalid",
	);
	const normalized = Object.freeze({
		claudeCodeVersion: exactVersion(
			configuration.claudeCodeVersion,
			"claude_code_version_invalid",
		),
		runtimeRoot: absolutePath(configuration.runtimeRoot, "root_invalid"),
		sdkVersion: exactVersion(configuration.sdkVersion, "sdk_version_invalid"),
		target: exactTarget(configuration.target),
	});
	const sourcePath = absolutePath(configuration.sourceExecutable, "source_invalid");
	let source;
	try {
		source = fs.realpathSync(sourcePath);
	} catch {
		throw runtimeError("source_invalid");
	}
	const paths = tuplePaths(normalized);
	fs.mkdirSync(paths.runtimeRoot, { mode: 0o700, recursive: true });
	ownerDirectory(paths.runtimeRoot, "root_unsafe");
	const sourceBefore = await hashExecutable(source, {
		managed: false,
		reason: "source_unsafe",
	});
	if (
		configuration.sourceSha256 !== undefined &&
		(!DIGEST_PATTERN.test(configuration.sourceSha256) ||
			sourceBefore.sha256 !== configuration.sourceSha256)
	) {
		throw runtimeError("source_digest_mismatch");
	}
	exactVersionOutput(source, normalized.claudeCodeVersion, paths.runtimeRoot);
	const sourceAfter = await hashExecutable(source, {
		managed: false,
		reason: "source_replaced",
	});
	if (!sameFileIdentity(sourceBefore, sourceAfter)) throw runtimeError("source_replaced");

	ensureOwnerDirectory(paths.sdkDirectory, "sdk_directory_unsafe");
	ensureOwnerDirectory(paths.versionDirectory, "version_directory_unsafe");
	try {
		ownerDirectory(paths.tupleDirectory, "tuple_directory_unsafe", "artifact_unavailable");
		return resolveClaudeRuntimeArtifact(normalized);
	} catch (error) {
		if (error?.reason !== "artifact_unavailable") throw error;
	}

	const staging = path.join(
		paths.versionDirectory,
		`.${normalized.target}.${process.pid}.${randomBytes(8).toString("hex")}.stage`,
	);
	ensureOwnerDirectory(staging, "staging_directory_unsafe");
	try {
		const stagedExecutable = path.join(staging, EXECUTABLE_FILE);
		fs.copyFileSync(source, stagedExecutable, fs.constants.COPYFILE_EXCL);
		fs.chmodSync(stagedExecutable, 0o500);
		const stagedIdentity = await hashExecutable(stagedExecutable, {
			managed: true,
			reason: "staged_executable_unsafe",
		});
		if (stagedIdentity.sha256 !== sourceBefore.sha256) {
			throw runtimeError("staged_executable_digest_mismatch");
		}
		const manifest = {
			claudeCodeVersion: normalized.claudeCodeVersion,
			executable: EXECUTABLE_FILE,
			executableSha256: stagedIdentity.sha256,
			schema: ARTIFACT_SCHEMA,
			sdkVersion: normalized.sdkVersion,
			target: normalized.target,
		};
		const stagedManifest = path.join(staging, MANIFEST_FILE);
		fs.writeFileSync(stagedManifest, `${JSON.stringify(manifest)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		const manifestDescriptor = fs.openSync(stagedManifest, fs.constants.O_RDONLY);
		try {
			fs.fsyncSync(manifestDescriptor);
		} finally {
			fs.closeSync(manifestDescriptor);
		}
		syncDirectory(staging);
		try {
			fs.renameSync(staging, paths.tupleDirectory);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
		}
		syncDirectory(paths.versionDirectory);
	} catch (error) {
		if (error?.code === "DURE_CLAUDE_RUNTIME_CONTRACT") throw error;
		throw runtimeError("install_failed");
	} finally {
		safeRemoveStaging(staging);
	}
	return resolveClaudeRuntimeArtifact(normalized);
}
