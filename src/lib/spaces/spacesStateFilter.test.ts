import { describe, expect, it } from "vitest";
import {
	ATTENTION_DISPLAY_STATES,
	countAttentionDisplayStates,
	countProgramStatusRows,
} from "@/lib/spaces/spacesStateFilter";

describe("spacesStateFilter", () => {
	it("counts a program's waiting report only where Host attention has not already spoken", () => {
		expect(
			countProgramStatusRows([
				{ displayState: "waiting", programStatusKind: "permission" },
				{ programStatusKind: "question" },
				{ displayState: "blocked", programStatusKind: "permission" },
				{ displayState: "error", programStatusKind: "auth" },
				{ displayState: "waiting" },
			]),
		).toBe(2);
	});

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
