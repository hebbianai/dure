import { describe, expect, it } from "vitest";
import {
	compareDecimalStrings,
	isImmediateCanonicalDecimalSuccessor,
} from "@/lib/decimalString";

describe("isImmediateCanonicalDecimalSuccessor", () => {
	it.each([
		["1", "0"],
		["10", "9"],
		["1000", "999"],
		["18446744073709551616", "18446744073709551615"],
	])("accepts %s immediately after %s", (value, previous) => {
		expect(isImmediateCanonicalDecimalSuccessor(value, previous)).toBe(true);
	});

	it.each([
		["0", "0"],
		["12", "10"],
		["9", "10"],
		["01", "0"],
		["1", "00"],
		["x", "1"],
		[undefined, "1"],
	])("rejects %s after %s", (value, previous) => {
		expect(isImmediateCanonicalDecimalSuccessor(value, previous)).toBe(false);
	});
});

describe("compareDecimalStrings", () => {
	it("선행 0을 정규화해 비교한다 — canonical 보장이 없는 id/seq용", () => {
		expect(compareDecimalStrings("007", "8")).toBeLessThan(0);
		expect(compareDecimalStrings("010", "9")).toBeGreaterThan(0);
		expect(compareDecimalStrings("000", "0")).toBe(0);
		expect(compareDecimalStrings("123456789012345678901", "123456789012345678902")).toBeLessThan(0);
	});
});
