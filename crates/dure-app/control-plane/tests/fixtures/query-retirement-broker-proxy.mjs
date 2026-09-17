#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// Test-only fault boundary. The native broker authors every response; only the
// expected Host generation is changed while this owned fixture requests refusal.
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const args = process.argv.slice(3);
let input = fs.readFileSync(0);
assert.ok(input.length <= 1024 * 1024);
const stop = args[1] === "internal-hmux-managed-stop";
const refuse = stop && fs.existsSync(config.refusal);
if (refuse) {
	assert.equal(input.readUInt32BE(), input.length - 4);
	const request = JSON.parse(input.subarray(4));
	assert.equal(typeof request.expectedHostInstanceId, "string");
	request.expectedHostInstanceId = "fixture-refused-host-generation";
	const payload = Buffer.from(JSON.stringify(request));
	input = Buffer.alloc(4 + payload.length);
	input.writeUInt32BE(payload.length);
	payload.copy(input, 4);
}
const result = spawnSync(config.runtime, args, {
	input,
	env: {
		HOME: config.home,
		PATH: process.env.PATH,
		HMUX_DISCOVERY_ROOT: config.discoveryRoot,
	},
	maxBuffer: 1024 * 1024,
	timeout: 15_000,
});
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr.toString());
if (stop) {
	assert.equal(result.stdout.readUInt32BE(), result.stdout.length - 4);
	const response = JSON.parse(result.stdout.subarray(4));
	if (refuse) {
		assert.equal(response.state, "refused");
		assert.equal(response.payload.code, "hmux_managed_stop_unavailable");
		assert.match(response.payload.message, /generation changed before provider stop/);
	}
	fs.appendFileSync(config.events, `${response.payload?.code ?? response.state}\n`, {
		mode: 0o600,
	});
}
process.stdout.write(result.stdout);
