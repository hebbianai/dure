import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

function contractError(reason) {
	const error = new Error(`dure_claude_sdk_${reason}`);
	error.code = "DURE_CLAUDE_SDK_CONTRACT";
	return error;
}

function readJsonObject(file, label) {
	const value = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw contractError(`${label}_metadata_invalid`);
	}
	return value;
}

function nativeRuntimeCoordinate() {
	const architecture = process.arch;
	if (!["arm64", "x64"].includes(architecture)) {
		throw contractError("unsupported_architecture");
	}
	if (process.platform === "darwin" || process.platform === "win32") {
		const target = `${process.platform}-${architecture}`;
		return {
			packageName: `${SDK_PACKAGE}-${target}`,
			packageTarget: target,
			runtimeTarget: target,
		};
	}
	if (process.platform === "linux") {
		const report = process.report?.getReport?.();
		const usesGlibc = Boolean(report?.header?.glibcVersionRuntime);
		const packageTarget = `linux-${architecture}${usesGlibc ? "" : "-musl"}`;
		return {
			packageName: `${SDK_PACKAGE}-${packageTarget}`,
			packageTarget,
			runtimeTarget: `linux-${architecture}-${usesGlibc ? "gnu" : "musl"}`,
		};
	}
	throw contractError("unsupported_platform");
}

function nativeRuntimeSource(sdkDirectory, sdkManifest, coordinate) {
	const manifest = readJsonObject(
		path.join(sdkDirectory, "manifest.json"),
		"runtime",
	);
	const source = manifest.platforms?.[coordinate.packageTarget];
	if (
		manifest.version !== sdkManifest.claudeCodeVersion ||
		!source ||
		typeof source !== "object" ||
		Array.isArray(source) ||
		!/^claude(?:\.exe)?$/u.test(source.binary ?? "") ||
		!/^[0-9a-f]{64}$/u.test(source.checksum ?? "") ||
		!Number.isSafeInteger(source.size) ||
		source.size < 1 ||
		source.size > 512 * 1024 * 1024
	) {
		throw contractError("runtime_metadata_invalid");
	}
	return Object.freeze({
		binary: source.binary,
		executableSha256: `sha256:${source.checksum}`,
		executableSize: source.size,
		packageName: coordinate.packageName,
		target: coordinate.runtimeTarget,
	});
}

function packagePresent(packageName) {
	try {
		require.resolve(packageName);
		return true;
	} catch (error) {
		if (error?.code === "MODULE_NOT_FOUND") {
			return false;
		}
		throw error;
	}
}

let pinnedRuntime;

async function loadRuntime() {
	const driverManifest = readJsonObject(
		fileURLToPath(new URL("./package.json", import.meta.url)),
		"driver",
	);
	const expectedSdkVersion = driverManifest.dependencies?.[SDK_PACKAGE];
	if (typeof expectedSdkVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedSdkVersion)) {
		throw contractError("version_not_exactly_pinned");
	}
	if (driverManifest.engines?.node !== process.versions.node) {
		throw contractError("node_version_mismatch");
	}

	const sdkEntry = require.resolve(SDK_PACKAGE);
	const sdkManifest = readJsonObject(path.join(path.dirname(sdkEntry), "package.json"), "sdk");
	if (sdkManifest.version !== expectedSdkVersion) {
		throw contractError("installed_version_mismatch");
	}
	if (typeof sdkManifest.claudeCodeVersion !== "string") {
		throw contractError("claude_code_version_missing");
	}

	const coordinate = nativeRuntimeCoordinate();
	const nativePackage = coordinate.packageName;
	const nativePackagePresent = packagePresent(nativePackage);
	if (nativePackagePresent) {
		throw contractError("bundled_native_package_present");
	}
	const runtimeSource = nativeRuntimeSource(
		path.dirname(sdkEntry),
		sdkManifest,
		coordinate,
	);

	const startedAt = performance.now();
	const sdk = await import(SDK_PACKAGE);
	const importDurationMs = performance.now() - startedAt;
	if (
		typeof sdk.getSessionMessages !== "function" ||
		typeof sdk.query !== "function" ||
		typeof sdk.startup !== "function"
	) {
		throw contractError("required_exports_missing");
	}

	const metadata = Object.freeze({
		claudeCodeVersion: sdkManifest.claudeCodeVersion,
		importDurationMs,
		nativePackage,
		nativePackagePresent,
		queryExportPresent: true,
		sdkImported: true,
		sdkVersion: sdkManifest.version,
		startupExportPresent: true,
	});
	return Object.freeze({
		metadata,
		getSessionMessages: sdk.getSessionMessages,
		query: sdk.query,
		runtimeSource,
		startup: sdk.startup,
		// The CLI's own usage-limit result texts (@alpha export); handed to the
		// query driver so its classification never drifts from the pinned SDK.
		usageLimitErrorPrefixes: Object.freeze(
			Array.isArray(sdk.USAGE_LIMIT_ERROR_PREFIXES)
				? [...sdk.USAGE_LIMIT_ERROR_PREFIXES]
				: [],
		),
	});
}

export function loadPinnedClaudeSdkRuntime() {
	pinnedRuntime ??= loadRuntime();
	return pinnedRuntime;
}

export async function loadPinnedClaudeSdk() {
	return (await loadPinnedClaudeSdkRuntime()).metadata;
}
