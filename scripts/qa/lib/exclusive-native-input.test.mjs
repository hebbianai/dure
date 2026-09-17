import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { armExclusiveNativeInput } from "./exclusive-native-input.mjs";

const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

describe("exclusive native input handshake", () => {
	test("publishes one owner-only request and accepts one regular ACK", async () => {
		const root = temporaryRoot();
		const requestPath = path.join(root, "exclusive-input.request");
		const acknowledgementPath = path.join(root, "exclusive-input.ack");
		let requestExistedBeforeAck = false;
		const publishAck = setTimeout(() => {
			requestExistedBeforeAck = fs.existsSync(requestPath);
			fs.writeFileSync(acknowledgementPath, "", { mode: 0o600 });
		}, 5);

		try {
			await armExclusiveNativeInput({
				stateRoot: root,
				requestPath,
				acknowledgementPath,
			});
		} finally {
			clearTimeout(publishAck);
		}

		expect(requestExistedBeforeAck).toBe(true);
		expect(fs.readFileSync(requestPath, "utf8")).toBe(`${process.pid}\n`);
		expect(fs.statSync(requestPath).mode & 0o077).toBe(0);
	});

	test("rejects an ACK that predates its exact request", async () => {
		const root = temporaryRoot();
		const requestPath = path.join(root, "exclusive-input.request");
		const acknowledgementPath = path.join(root, "exclusive-input.ack");
		fs.writeFileSync(acknowledgementPath, "", { mode: 0o600 });

		await expect(
			armExclusiveNativeInput({
				stateRoot: root,
				requestPath,
				acknowledgementPath,
			}),
		).rejects.toThrow("ACK existed before the request");
		expect(fs.existsSync(requestPath)).toBe(false);
	});

	test("rejects a handshake path outside the isolated state root", async () => {
		const root = temporaryRoot();
		const outside = temporaryRoot();
		const requestPath = path.join(outside, "exclusive-input.request");

		await expect(
			armExclusiveNativeInput({
				stateRoot: root,
				requestPath,
				acknowledgementPath: path.join(root, "exclusive-input.ack"),
			}),
		).rejects.toThrow("escaped its state root");
		expect(fs.existsSync(requestPath)).toBe(false);
	});
});

function temporaryRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "exclusive-input-test-"));
	fs.chmodSync(root, 0o700);
	roots.push(root);
	return root;
}
