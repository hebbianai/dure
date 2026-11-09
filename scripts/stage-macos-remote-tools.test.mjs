import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { stageMacosRemoteTools } from "./stage-macos-remote-tools.mjs";

const target = "aarch64-apple-darwin";
const helperName = "dure-git-checkout-helper";
const identity = "Developer ID Application: Fixture (TEAM123456)";
const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-remote-tools-"));
	roots.push(root);
	return root;
}

const helperOutput = (root) =>
	path.join(root, "src-tauri/resources/remote-git-checkout-helper", target, helperName);

// Stands in for the compiler and the Hmux stage: what they would leave on disk
// is the input the code under test works from.
function builder(root, bytes = "built-helper") {
	return vi.fn((_command, args) => {
		if (args[0] === "scripts/stage-hmux-remote-resources.sh") {
			const bin = path.join(root, "src-tauri/resources/hmux-remote", target, "bin");
			fs.mkdirSync(bin, { recursive: true });
			for (const name of ["hmux", "hmux-runtime"]) fs.writeFileSync(path.join(bin, name), name);
			return;
		}
		const release = path.join(root, "crates/dure-app/target/remote-git-checkout-helper", target, "release");
		fs.mkdirSync(release, { recursive: true });
		fs.writeFileSync(path.join(release, helperName), bytes);
	});
}

const stage = (root, overrides = {}) =>
	stageMacosRemoteTools({
		root,
		platform: "darwin",
		architecture: "arm64",
		environment: {},
		log: () => {},
		execute: builder(root),
		isSigned: () => false,
		sign: vi.fn(),
		...overrides,
	});

test.each([
	["linux", "x64"], ["linux", "arm64"], ["win32", "x64"], ["darwin", "x64"],
])("leaves the bundle untouched on %s %s", (platform, architecture) => {
	const root = fixture();
	const execute = vi.fn();
	expect(stage(root, { platform, architecture, execute })).toBe(false);
	expect(execute).not.toHaveBeenCalled();
	expect(fs.readdirSync(root)).toEqual([]);
});

test("stages only the macOS tree and builds the helper natively", () => {
	const root = fixture();
	const execute = builder(root);
	expect(stage(root, { execute, profile: "release", environment: { PATH: "/bin" } })).toBe(true);
	const [treeCall, helperCall] = execute.mock.calls;
	expect(treeCall[1]).toEqual(["scripts/stage-hmux-remote-resources.sh", "release"]);
	expect(treeCall[2].env.HMUX_REMOTE_TRIPLES).toBe(target);
	expect(helperCall[1]).toEqual(expect.arrayContaining([
		"--release", "--target", target, "--package", "dure-session-runtime", "--bin", helperName,
	]));
	expect(helperCall[2].env.RUSTUP_TOOLCHAIN).toBe("1.97.1");
	expect(fs.readFileSync(helperOutput(root), "utf8")).toBe("built-helper");
	expect(fs.statSync(helperOutput(root)).mode & 0o777).toBe(0o755);
	expect(fs.readdirSync(path.dirname(path.dirname(helperOutput(root))))).toEqual([target]);
});

test("does not sign without an identity, so local builds keep the linker signature", () => {
	const root = fixture();
	const sign = vi.fn();
	stage(root, { sign });
	expect(sign).not.toHaveBeenCalled();
});

test("seals all three executables for a signed build", () => {
	const root = fixture();
	const sign = vi.fn();
	stage(root, { sign, environment: { APPLE_SIGNING_IDENTITY: identity } });
	const files = sign.mock.calls.flatMap(([batch]) => batch).map((file) => path.basename(file));
	expect(files.sort()).toEqual(["dure-git-checkout-helper", "hmux", "hmux-runtime"]);
	for (const [, used] of sign.mock.calls) expect(used).toBe(identity);
});

test("a tree reused from an earlier signed stage keeps its bytes", () => {
	const root = fixture();
	const sign = vi.fn();
	stage(root, { sign, isSigned: () => true, environment: { APPLE_SIGNING_IDENTITY: identity } });
	const files = sign.mock.calls.flatMap(([batch]) => batch).map((file) => path.basename(file));
	expect(files).toEqual([helperName]);
});

test("a refused signature keeps the previous helper and leaves no stage behind", () => {
	const root = fixture();
	stage(root);
	const refused = stage.bind(null, root, {
		execute: builder(root, "new-helper"),
		isSigned: () => true,
		environment: { APPLE_SIGNING_IDENTITY: identity },
		sign: () => { throw new Error("fixture signing refused"); },
	});
	expect(refused).toThrow("fixture signing refused");
	expect(fs.readFileSync(helperOutput(root), "utf8")).toBe("built-helper");
	expect(fs.readdirSync(path.dirname(path.dirname(helperOutput(root))))).toEqual([target]);
});

// The real stage script, with only the build and packaging steps replaced.
function runRealStage(extra) {
	const root = fixture();
	const scripts = path.join(root, "scripts");
	fs.mkdirSync(scripts, { recursive: true });
	fs.copyFileSync("scripts/stage-hmux-remote-resources.sh", path.join(scripts, "stage-hmux-remote-resources.sh"));
	fs.writeFileSync(path.join(scripts, "build-hmux-product-runtime.sh"), "#!/bin/sh\nexit 0\n");
	fs.writeFileSync(path.join(scripts, "package-hmux-prebuilt.sh"), '#!/bin/sh\nmkdir -p "$2"\n');
	const environment = withoutLocalGitOverrides({ ...process.env, HMUX_BUILD_ID: "fixture", ...extra });
	if (!("HMUX_REMOTE_TRIPLES" in extra)) delete environment.HMUX_REMOTE_TRIPLES;
	const git = (...args) => execFileSync("git", args, { cwd: root, env: environment, stdio: "pipe" });
	git("init", "-q");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture");
	const result = spawnSync("sh", ["scripts/stage-hmux-remote-resources.sh", "release"], {
		cwd: root, env: environment, encoding: "utf8", timeout: 20_000,
	});
	expect(result.status, result.stderr).toBe(0);
	return fs.readdirSync(path.join(root, "src-tauri/resources/hmux-remote")).sort();
}

test.skipIf(process.platform === "win32")("the Linux stage is unchanged unless a caller names its targets", () => {
	expect(runRealStage({})).toEqual(["aarch64-unknown-linux-musl", "x86_64-unknown-linux-musl"]);
	expect(runRealStage({ HMUX_REMOTE_TRIPLES: target })).toEqual([target]);
});
