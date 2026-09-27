// Read-only by default. An action file requires an explicitly arranged phone
// and desktop test window; the caller owns that coordination.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { devTreeEnvironment } from "./lib/dev-tree-environment.mjs";

if (process.platform !== "darwin")
	throw new Error("iPhone Mirroring requires macOS.");
const args = process.argv.slice(2);
if (
	args.length &&
	(args.length !== 3 ||
		args[0] !== "--arranged-input" ||
		args[1] !== "--action-file")
) {
	throw new Error(
		"Usage: node scripts/qa/iphone-mirroring-smoke.mjs [--arranged-input --action-file PATH]",
	);
}
const root = mkdtempSync(join(tmpdir(), "dure-iphone-smoke-"));
const env = {
	...devTreeEnvironment(join(root, "home"), "iphone-smoke"),
	DURE_QA_APP_CHANNEL: "iphone-smoke",
};
for (const path of [env.HOME, env.HMUX_DISCOVERY_ROOT])
	mkdirSync(path, { recursive: true });
const runner = resolve("scripts/qa/lib/run-isolated-app.sh");
function command(program, argv, input) {
	const result = spawnSync("/bin/sh", [runner, program, ...argv], {
		env,
		input,
		encoding: "utf8",
		timeout: 20000,
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout;
}
function inspect(request = {}) {
	return JSON.parse(
		command(
			"/usr/bin/osascript",
			[
				"-l",
				"JavaScript",
				resolve("src-tauri/src/mobile_simulator/mirroring.js"),
			],
			JSON.stringify(request),
		),
	);
}
function frontmost() {
	return Number(
		command("/usr/bin/osascript", [
			"-l",
			"JavaScript",
			"-e",
			'ObjC.import("AppKit"); Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);',
		]),
	);
}
function capture(observed, name) {
	const path = join(root, name);
	command("/usr/sbin/screencapture", [
		"-x",
		"-o",
		"-l",
		String(observed.windowId),
		path,
	]);
	const png = readFileSync(path);
	assert.equal(png.subarray(1, 4).toString(), "PNG");
	return { path, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
const foreground = frontmost();
const before = inspect();
assert.equal(
	before.ready,
	true,
	"Complete iPhone Mirroring authentication with the phone locked first.",
);
const frame = capture(before, "before.png");
const afterCapture = inspect({ id: before.id });
assert.deepEqual(afterCapture, before, "Mirroring changed during capture.");
let action;
if (args.length) {
	action = JSON.parse(readFileSync(resolve(args[2]), "utf8"));
	// No automatic mutation replay. A returned receipt proves dispatch only;
	// the coordinator must inspect before/after to establish device acceptance.
	inspect({ id: before.id, action });
	await new Promise((resolve) => setTimeout(resolve, 500));
}
const after = capture(inspect({ id: before.id }), "after.png");
assert.equal(
	frontmost(),
	foreground,
	"Input or capture changed desktop focus.",
);
const result = {
	source: "native-bridge-device",
	root,
	frame,
	after,
	action: action?.kind ?? null,
	dispatchReturned: Boolean(action),
	deviceAcceptance: "requires_visual_observation",
	foregroundUnchanged: true,
};
writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
