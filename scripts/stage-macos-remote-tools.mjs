#!/usr/bin/env node

// Stages what a Mac needs in order to be an SSH session host: the Hmux runtime
// tree and the Git checkout helper. Only an Apple silicon build can produce
// them, so every other platform leaves the bundle as it was and a Mac host
// then gets a plain "this build does not carry it" refusal.
//
// The tree gets its own `<base>.aarch64-apple-darwin.release` build id rather
// than reusing the app's sidecars. A second Mac can run Dure itself, and the
// desktop activates its sidecar runtime under `versions/<sidecar build id>` in
// the same store an SSH install writes to; one id for both would make the
// immutable store refuse the install on exactly those machines.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	isDeveloperIdSigned,
	signMacosExecutables,
} from "./lib/macos-executable-signing.mjs";

const target = "aarch64-apple-darwin";
const helperName = "dure-git-checkout-helper";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options) {
	execFileSync(command, args, { stdio: "inherit", ...options });
}

export function stageMacosRemoteTools({
	root = repositoryRoot,
	profile = "debug",
	platform = process.platform,
	architecture = process.arch,
	environment = process.env,
	execute = run,
	isSigned = isDeveloperIdSigned,
	sign = signMacosExecutables,
	log = console.log,
} = {}) {
	if (platform !== "darwin" || architecture !== "arm64") {
		log(`Skipping macOS remote tools on ${platform} ${architecture}`);
		return false;
	}
	execute("sh", ["scripts/stage-hmux-remote-resources.sh", profile], {
		cwd: root,
		env: { ...environment, HMUX_REMOTE_TRIPLES: target },
	});

	const helperTargetRoot = path.join(
		environment.CARGO_TARGET_DIR ?? path.join(root, "crates/dure-app/target"),
		"remote-git-checkout-helper",
	);
	execute("sh", [
		"scripts/with-hmux-build-environment.sh", target, "--",
		"cargo", "build", "--locked", "--manifest-path", "crates/dure-app/Cargo.toml",
		"--release", "--target", target,
		"--package", "dure-session-runtime", "--bin", helperName,
	], {
		cwd: root,
		env: { ...environment, RUSTUP_TOOLCHAIN: "1.97.1", CARGO_TARGET_DIR: helperTargetRoot },
	});

	const identity = environment.APPLE_SIGNING_IDENTITY?.trim() || null;
	if (identity) {
		// Sealing changes bytes under a build id the immutable store treats as
		// final, so a tree reused from an earlier signed stage is left alone.
		const tree = path.join(root, "src-tauri/resources/hmux-remote", target, "bin");
		const unsealed = ["hmux", "hmux-runtime"]
			.map((name) => path.join(tree, name))
			.filter((file) => !isSigned(file));
		if (unsealed.length > 0) sign(unsealed, identity);
	}

	const outputRoot = path.join(root, "src-tauri/resources/remote-git-checkout-helper");
	const output = path.join(outputRoot, target);
	fs.mkdirSync(outputRoot, { recursive: true });
	const stage = fs.mkdtempSync(path.join(outputRoot, `.stage-${target}.`));
	try {
		const helper = path.join(stage, helperName);
		fs.copyFileSync(path.join(helperTargetRoot, target, "release", helperName), helper);
		fs.chmodSync(helper, 0o755);
		// The helper is content-addressed on the host, so a new seal is a new
		// file there rather than a conflict.
		if (identity) sign([helper], identity);
		if (fs.existsSync(output)) {
			if (!fs.lstatSync(output).isDirectory()) {
				throw new Error(`checkout helper output is not a directory: ${output}`);
			}
			fs.rmSync(output, { recursive: true });
		}
		fs.renameSync(stage, output);
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
	return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const [profile = "debug", ...extra] = process.argv.slice(2);
		if (!["debug", "release"].includes(profile) || extra.length > 0) {
			throw new Error("usage: stage-macos-remote-tools.mjs [debug|release]");
		}
		stageMacosRemoteTools({ profile });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
