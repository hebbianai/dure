import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

// Disposable SSH fixture only. Consume one bounded request without logging
// its private proof, and lose the first successful create answer on the wire.
const [rootArgument, executable, ...args] = process.argv.slice(2);
const root = fs.realpathSync(rootArgument);
assert(path.basename(root).startsWith("dure-ssh-registration."));
assert.equal(fs.realpathSync(process.env.HOME), path.join(root, "remote-home"));
assert.equal(
	fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT),
	path.join(root, "remote-discovery"),
);
function readExact(size) {
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const count = fs.readSync(0, buffer, offset, size - offset, null);
		assert(count > 0, "fixture request ended before its frame");
		offset += count;
	}
	return buffer;
}
const header = readExact(4);
const length = header.readUInt32BE();
assert(length > 0 && length <= 64 * 1024, "fixture request exceeded its bound");
const payload = readExact(length);
const request = JSON.parse(payload.toString("utf8"));
const frame = Buffer.concat([header, payload]);
if (request.request?.create_standalone) {
	const output = execFileSync(executable, args, {
		input: frame,
		timeout: 20_000,
		maxBuffer: 64 * 1024,
		stdio: ["pipe", "pipe", "inherit"],
	});
	assert(output.length >= 4);
	assert.equal(output.readUInt32BE(), output.length - 4);
	const receipt = JSON.parse(output.subarray(4).toString("utf8"));
	assert.equal(receipt.session?.lifecycle, "ready");
	const marker = path.join(root, "lost-create-receipt.json");
	if (!fs.existsSync(marker)) {
		// Private cleanup authority for this fixture's unpresented Host only.
		// The runner does not promote this disposable file into diagnostics.
		fs.writeFileSync(
			path.join(root, "lost-create-cleanup.json"),
			JSON.stringify({
				gateway_request_version: 3,
				request: {
					abandon_unpresented_creation: {
						request_id: "qa-lost-create-cleanup",
						session_id: receipt.session.session_id,
						workspace_id: receipt.session.workspace_id,
						launch_owner_proof:
							request.request.create_standalone.launch_owner_proof,
					},
				},
			}),
			{ flag: "wx", mode: 0o600 },
		);
		fs.writeFileSync(
			marker,
			JSON.stringify({
				requestId: receipt.request_id,
				sessionId: receipt.session.session_id,
				workspaceId: receipt.session.workspace_id,
			}),
			{ flag: "wx", mode: 0o600 },
		);
	} else {
		process.stdout.write(output);
	}
} else {
	const child = spawn(executable, args, {
		stdio: ["pipe", "inherit", "inherit"],
	});
	child.stdin.write(frame);
	process.stdin.pipe(child.stdin);
	child.once("error", () => {
		process.exitCode = 1;
	});
	child.once("exit", (code) => {
		process.exitCode = code ?? 1;
	});
}
