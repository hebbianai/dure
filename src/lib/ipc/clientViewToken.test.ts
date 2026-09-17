import { describe, expect, it } from "vitest";
import { validClientViewToken } from "@/lib/ipc/clientViewToken";

describe("validClientViewToken", () => {
	it("accepts ordinary opaque tokens", () => {
		expect(validClientViewToken("pane-1")).toBe(true);
		expect(validClientViewToken("group:main.0_left")).toBe(true);
	});

	it("bounds the token by UTF-8 bytes, not code units", () => {
		expect(validClientViewToken("a".repeat(512))).toBe(true);
		expect(validClientViewToken("a".repeat(513))).toBe(false);
		// U+AC00 is 3 UTF-8 bytes: 170 chars = 510 bytes, 171 chars = 513 bytes.
		expect(validClientViewToken("가".repeat(170))).toBe(true);
		expect(validClientViewToken("가".repeat(171))).toBe(false);
	});

	it("rejects ASCII control characters including DEL", () => {
		expect(validClientViewToken("pane\tid")).toBe(false);
		expect(validClientViewToken("pane\nid")).toBe(false);
		expect(validClientViewToken("pane\u0000id")).toBe(false);
		expect(validClientViewToken("pane\u007fid")).toBe(false);
		// U+0080 is outside the ASCII control range this contract rejects.
		expect(validClientViewToken("pane\u0080id")).toBe(true);
	});

	it("rejects empty and non-string values", () => {
		expect(validClientViewToken("")).toBe(false);
		expect(validClientViewToken(null)).toBe(false);
		expect(validClientViewToken(undefined)).toBe(false);
		expect(validClientViewToken(42)).toBe(false);
		expect(validClientViewToken(["pane-1"])).toBe(false);
	});
});
