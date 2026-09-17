import assert from "node:assert/strict";
import test from "node:test";

import { loadPinnedClaudeSdk, loadPinnedClaudeSdkRuntime } from "./sdk-runtime.mjs";

test("the pinned Agent SDK module is loaded once and exposes immutable host metadata", async () => {
	const first = await loadPinnedClaudeSdkRuntime();
	const second = await loadPinnedClaudeSdkRuntime();
	const metadata = await loadPinnedClaudeSdk();
	assert.equal(first, second);
	assert.equal(first.metadata, metadata);
	assert.equal(Object.isFrozen(first), true);
	assert.equal(Object.isFrozen(metadata), true);
	assert.equal(typeof first.getSessionMessages, "function");
	assert.equal(Object.isFrozen(first.runtimeSource), true);
	assert.equal(typeof first.query, "function");
	assert.equal(typeof first.startup, "function");
	assert.match(first.runtimeSource.binary, /^claude(?:\.exe)?$/u);
	assert.match(first.runtimeSource.executableSha256, /^sha256:[0-9a-f]{64}$/u);
	assert.equal(first.runtimeSource.executableSize > 0, true);
	assert.equal(first.runtimeSource.packageName, metadata.nativePackage);
	assert.match(
		first.runtimeSource.target,
		/^(?:darwin|win32)-(?:arm64|x64)$|^linux-(?:arm64|x64)-(?:gnu|musl)$/u,
	);
	assert.deepEqual(
		{
			claudeCodeVersion: metadata.claudeCodeVersion,
			nativePackagePresent: metadata.nativePackagePresent,
			queryExportPresent: metadata.queryExportPresent,
			sdkImported: metadata.sdkImported,
			sdkVersion: metadata.sdkVersion,
			startupExportPresent: metadata.startupExportPresent,
		},
		{
			claudeCodeVersion: "2.1.234",
			nativePackagePresent: false,
			queryExportPresent: true,
			sdkImported: true,
			sdkVersion: "0.3.234",
			startupExportPresent: true,
		},
	);
});
