import { describe, expect, it } from "vitest";
import { fnv1a32, fnv1a32Hex, fnv1a64Hex } from "./hash";

describe("fnv1a32", () => {
	it("알려진 벡터와 일치한다 — 10곳 복제 통합 전 출력 보존 증명", () => {
		// FNV-1a 32bit 표준 벡터.
		expect(fnv1a32("")).toBe(0x811c9dc5);
		expect(fnv1a32Hex("a")).toBe("e40c292c");
		expect(fnv1a32Hex("foobar")).toBe("bf9cf968");
	});

	it("hex는 8자리 zero-pad, base36 소비자는 코어 값을 그대로 쓴다", () => {
		const value = fnv1a32("dure");
		expect(fnv1a32Hex("dure")).toBe(value.toString(16).padStart(8, "0"));
		expect(Number.isInteger(value) && value >= 0).toBe(true);
	});
});

describe("fnv1a64Hex", () => {
	it("hashes UTF-8 bytes with one shared deterministic implementation", () => {
		expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
		expect(fnv1a64Hex("foobar")).toBe("85944171f73967e8");
		expect(fnv1a64Hex("결정")).toHaveLength(16);
	});
});
