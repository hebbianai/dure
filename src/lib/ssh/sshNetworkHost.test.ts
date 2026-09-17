import { describe, expect, it } from "vitest";
import { canonicalSshNetworkHost } from "./sshNetworkHost";

describe("explicit SSH network host", () => {
	it.each([
		["192.0.2.1", "192.0.2.1"],
		["SERVER.Example.", "server.example"],
		["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"],
	])("canonicalizes %s", (raw, expected) => {
		expect(canonicalSshNetworkHost(raw)).toBe(expected);
	});
	it.each([
		"alias",
		"192.000.2.1",
		"256.0.0.1",
		"127.1",
		"-bad.example",
		"host..example",
		"::not-ip",
		"fe80::1%en0",
		"user@host.example",
		"host.example/path",
	])("leaves unsupported %s to system SSH", (raw) => {
		expect(canonicalSshNetworkHost(raw)).toBeUndefined();
	});
});
