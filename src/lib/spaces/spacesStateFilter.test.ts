import { describe, expect, it } from "vitest";
import {
	ATTENTION_DISPLAY_STATES,
	countAttentionDisplayStates,
} from "@/lib/spaces/spacesStateFilter";

describe("spacesStateFilter", () => {
	it("treats error, blocked and input as the states that need a human", () => {
		expect([...ATTENTION_DISPLAY_STATES].sort()).toEqual([
			"blocked",
			"error",
			"input",
		]);
	});

	it("counts only attention states for the rail badge", () => {
		expect(
			countAttentionDisplayStates({
				a: "blocked",
				b: "input",
				c: "working",
				d: "waiting",
				e: "error",
				f: undefined,
			}),
		).toBe(3);
	});
});
