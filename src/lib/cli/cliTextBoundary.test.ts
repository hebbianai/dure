import { describe, expect, it } from "vitest";
import { containsCliControlCharacter } from "@/lib/cli/cliTextBoundary";

describe("CLI text boundary", () => {
	it("rejects C0 and DEL while optionally preserving prompt layout", () => {
		expect(containsCliControlCharacter("safe\u0000text")).toBe(true);
		expect(containsCliControlCharacter("safe\u007ftext")).toBe(true);
		expect(containsCliControlCharacter("line\nnext")).toBe(true);
		expect(
			containsCliControlCharacter("line\nnext\tvalue", { allowLayout: true }),
		).toBe(false);
	});

	it("rejects C1 only when the external contract requests it", () => {
		expect(containsCliControlCharacter("safe\u0080text")).toBe(false);
		expect(
			containsCliControlCharacter("safe\u0080text", { rejectC1: true }),
		).toBe(true);
	});
});
