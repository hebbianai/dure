import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { verifyMacosDistribution } from "./lib/macos-distribution-verification.mjs";

const identity = "Developer ID Application: Fixture (TEAM123456)";
let root;
let assets;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-apple-validation-"));
	assets = { app: path.join(root, "Dure.app"), dmg: path.join(root, "Dure.dmg") };
	fs.mkdirSync(path.join(assets.app, "Contents/Resources"), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const hardened = "CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+1 location=embedded\nTimestamp=Sep 10, 2026 at 12:00:00 PM";

test("requires Apple identity, nested code integrity, runtime protection, ticket and Gatekeeper before acceptance", () => {
	const check = vi.fn(() => hardened);
	expect(verifyMacosDistribution(assets, identity, check)).toEqual({
		appSignature: true, hardenedRuntime: true, appTicket: true, gatekeeper: true, dmgSignature: true,
	});
	expect(check.mock.calls.map(([stage]) => stage)).toEqual([
		"app_signature", "app_identity", "app_ticket", "app_gatekeeper", "dmg_signature",
	]);
	expect(check.mock.calls[0][2]).toEqual([
		"--verify", "--deep", "--strict", "--test-requirement",
		'=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "TEAM123456"',
		assets.app,
	]);
	expect(check.mock.calls[2].slice(1)).toEqual(["xcrun", ["stapler", "validate", assets.app]]);
	expect(check.mock.calls[3].slice(1)).toEqual(["spctl", ["--assess", "--type", "execute", "--verbose=2", assets.app]]);
	expect(check.mock.calls[4][2]).toEqual(["--verify", "--strict", "--test-requirement", check.mock.calls[0][2][4], assets.dmg]);
});

test.each([undefined, "-", "Apple Development: Fixture (TEAM123456)", 'Developer ID Application: Fixture (TEAM123456)" or true'])("refuses non-distribution or malformed identities before command execution", (candidate) => {
	const check = vi.fn();
	expect(() => verifyMacosDistribution(assets, candidate, check)).toThrow("developer_id_required");
	expect(check).not.toHaveBeenCalled();
});

test.each(["app_signature", "app_identity", "app_ticket", "app_gatekeeper", "dmg_signature"])("stops at the actual failed %s authority", (failedStage) => {
	const calls = [];
	const failure = new Error(`${failedStage}: rejected by native tool`);
	expect(() => verifyMacosDistribution(assets, identity, (stage) => {
		calls.push(stage);
		if (stage === failedStage) throw failure;
		return hardened;
	})).toThrow(failure);
	expect(calls.at(-1)).toBe(failedStage);
});

test.each(["", "Signature=adhoc", "CodeDirectory v=20400 flags=0x0(none)"])("refuses absent hardened runtime before consulting notarization", (description) => {
	const check = vi.fn(() => description);
	expect(() => verifyMacosDistribution(assets, identity, check)).toThrow("hardened_runtime_required");
	expect(check).toHaveBeenCalledTimes(2);
});

test("rejects an unsigned Mach-O executable hidden in resources even when outer app verification passes", () => {
	const file = path.join(assets.app, "Contents/Resources/embedded-cli");
	const header = Buffer.alloc(32);
	header.writeUInt32LE(0xfeedfacf, 0);
	header.writeUInt32LE(2, 12); // MH_EXECUTE
	fs.writeFileSync(file, header, { mode: 0o755 });
	const failure = new Error("embedded CLI lacks Developer ID");
	const check = vi.fn((stage, _command, args) => {
		if (args.includes(file)) throw failure;
		return hardened;
	});
	expect(() => verifyMacosDistribution(assets, identity, check)).toThrow(failure);
	expect(check.mock.calls.some(([stage]) => stage === "app_ticket")).toBe(false);
});

test.each([
	["hardened runtime", "CodeDirectory flags=0x0(none)\nTimestamp=Sep 10, 2026", "hardened_runtime_required"],
	["secure timestamp", "CodeDirectory flags=0x10000(runtime)", "secure_timestamp_required"],
])("requires a resource executable's %s before notarization acceptance", (_label, description, error) => {
	const file = path.join(assets.app, "Contents/Resources/embedded-cli");
	const header = Buffer.alloc(32);
	header.writeUInt32BE(0xfeedfacf, 0);
	header.writeUInt32BE(2, 12);
	fs.writeFileSync(file, header);
	const check = vi.fn((stage) => stage === "resource_identity" ? description : hardened);
	expect(() => verifyMacosDistribution(assets, identity, check)).toThrow(error);
	expect(check.mock.calls.some(([stage]) => stage === "app_ticket")).toBe(false);
});

test.each([false, true])("inspects executable slices in a universal Mach-O resource (64-bit table: %s)", (wide) => {
	const file = path.join(assets.app, "Contents/Resources/vendor-node");
	const bytes = Buffer.alloc(96);
	bytes.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
	bytes.writeUInt32BE(1, 4);
	if (wide) bytes.writeBigUInt64BE(64n, 16);
	else bytes.writeUInt32BE(64, 16);
	bytes.writeUInt32LE(0xfeedfacf, 64);
	bytes.writeUInt32LE(2, 76);
	fs.writeFileSync(file, bytes);
	fs.writeFileSync(path.join(assets.app, "Contents/Resources/plain-script"), "#!/bin/sh\nexit 0\n");
	fs.symlinkSync("vendor-node", path.join(assets.app, "Contents/Resources/current-node"));
	const check = vi.fn(() => hardened);
	expect(verifyMacosDistribution(assets, identity, check).appSignature).toBe(true);
	const calls = check.mock.calls.filter(([stage]) => stage.startsWith("resource_"));
	expect(calls.map(([stage]) => stage)).toEqual(["resource_signature", "resource_identity"]);
	expect(calls[0][2]).toContain(file);
	expect(calls[0][2].join(" ")).not.toContain("TEAM123456");
	expect(calls[0][2].join(" ")).toContain("certificate leaf[field.1.2.840.113635.100.6.1.13] exists");
});

test("refuses a truncated Mach-O resource instead of skipping its signature", () => {
	const file = path.join(assets.app, "Contents/Resources/truncated-cli");
	fs.writeFileSync(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
	const check = vi.fn(() => hardened);
	expect(() => verifyMacosDistribution(assets, identity, check)).toThrow("header_invalid");
	expect(check.mock.calls.some(([stage]) => stage === "app_ticket")).toBe(false);
});
