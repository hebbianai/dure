#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { inspectMacosSigning } from "./lib/macos-signing-readiness.mjs";

try {
	if (process.argv.length !== 2)
		throw new Error("usage: check-macos-signing.mjs");
	if (process.platform !== "darwin")
		throw new Error("macos_signing_requires_macos");
	const identities = execFileSync(
		"security",
		["find-identity", "-v", "-p", "codesigning"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	let apiKeyReadable = false;
	if (process.env.APPLE_API_KEY_PATH) {
		try {
			accessSync(process.env.APPLE_API_KEY_PATH, constants.R_OK);
			apiKeyReadable = statSync(process.env.APPLE_API_KEY_PATH).isFile();
		} catch {
			/* Readiness only; do not read or print key contents. */
		}
	}
	const result = inspectMacosSigning({
		identities,
		environment: process.env,
		apiKeyReadable,
	});
	console.log(JSON.stringify(result, null, 2));
	if (!result.ready) process.exitCode = 1;
} catch {
	console.error(
		"macos_signing_readiness_unavailable: use macOS with an accessible signing keychain; no build was started",
	);
	process.exitCode = 1;
}
