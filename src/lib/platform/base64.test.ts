import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "./base64";

describe("bytesToBase64", () => {
	it("encodes empty and binary input", () => {
		expect(bytesToBase64(new Uint8Array())).toBe("");
		expect(bytesToBase64(new Uint8Array([0, 1, 2, 253, 254, 255]))).toBe(
			"AAEC/f7/",
		);
	});

	it("encodes past the argument-count limit of a single spread", () => {
		const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 256);

		const encoded = bytesToBase64(bytes);

		expect(atob(encoded).length).toBe(bytes.length);
		expect(atob(encoded).charCodeAt(0x8000)).toBe(bytes[0x8000]);
	});
});
