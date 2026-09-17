import { describe, expect, it } from "vitest";
import {
	compareCliVersions,
	extractCliVersion,
} from "@/lib/agents/providerCliVersion";

describe("extractCliVersion", () => {
	it("extracts from claude --version output", () => {
		expect(extractCliVersion("2.1.252 (Claude Code)")).toEqual({
			raw: "2.1.252",
			segments: [2, 1, 252],
		});
	});
	it("extracts from codex --version output", () => {
		expect(extractCliVersion("codex-cli 0.151.0")).toEqual({
			raw: "0.151.0",
			segments: [0, 151, 0],
		});
	});
	it("extracts a bare registry version", () => {
		expect(extractCliVersion("0.152.1")?.segments).toEqual([0, 152, 1]);
	});
	it("returns null for unparsable or empty input", () => {
		expect(extractCliVersion("not a version")).toBeNull();
		expect(extractCliVersion(undefined)).toBeNull();
		expect(extractCliVersion(null)).toBeNull();
		expect(extractCliVersion("")).toBeNull();
	});
});

describe("compareCliVersions", () => {
	const v = (input: string) => {
		const parsed = extractCliVersion(input);
		if (!parsed) throw new Error(`fixture must parse: ${input}`);
		return parsed;
	};
	it("orders numerically, not lexicographically", () => {
		expect(compareCliVersions(v("2.1.252"), v("2.1.258"))).toBeLessThan(0);
		expect(compareCliVersions(v("10.0.0"), v("9.9.9"))).toBeGreaterThan(0);
	});
	it("treats missing segments as zero", () => {
		expect(compareCliVersions(v("1.2"), v("1.2.0"))).toBe(0);
		expect(compareCliVersions(v("1.2"), v("1.2.1"))).toBeLessThan(0);
	});
	it("returns zero for equal versions", () => {
		expect(compareCliVersions(v("0.151.0"), v("0.151.0"))).toBe(0);
	});
});
