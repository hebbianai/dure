import { describe, expect, it } from "vitest";
import {
	asRecord,
	errorMessage,
	hasOnlyKeys,
	isRecord,
	nonEmptyString,
	nonNegativeInteger,
	positiveInteger,
} from "./payloadGuards";

describe("payloadGuards", () => {
	it("asRecord accepts plain objects only", () => {
		expect(asRecord({ a: 1 })).toEqual({ a: 1 });
		expect(asRecord([])).toBeUndefined();
		expect(asRecord(null)).toBeUndefined();
		expect(asRecord("x")).toBeUndefined();
	});

	it("isRecord mirrors asRecord as a predicate", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
	});

	it("nonEmptyString refuses empty and non-strings", () => {
		expect(nonEmptyString("a")).toBe(true);
		expect(nonEmptyString("")).toBe(false);
		expect(nonEmptyString(1)).toBe(false);
	});

	it("hasOnlyKeys is a subset check — missing keys pass, extras fail", () => {
		expect(hasOnlyKeys({ a: 1 }, ["a", "b"])).toBe(true);
		expect(hasOnlyKeys({}, ["a"])).toBe(true);
		expect(hasOnlyKeys({ c: 1 }, ["a", "b"])).toBe(false);
	});

	it("integer guards pin zero and float boundaries", () => {
		expect(positiveInteger(1)).toBe(true);
		expect(positiveInteger(0)).toBe(false);
		expect(positiveInteger(1.5)).toBe(false);
		expect(nonNegativeInteger(0)).toBe(true);
		expect(nonNegativeInteger(-1)).toBe(false);
	});

	it("errorMessage unwraps Error and stringifies the rest", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("raw")).toBe("raw");
	});
});
