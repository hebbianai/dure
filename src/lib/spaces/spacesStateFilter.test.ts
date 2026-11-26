import { describe, expect, it } from "vitest";
import {
	countProgramStatusRows,
	countsTowardNeedsPersonRollup,
} from "@/lib/spaces/spacesStateFilter";

describe("spacesStateFilter", () => {
	it("counts a program's waiting report only where the needs-person authority has not already spoken", () => {
		expect(
			countProgramStatusRows([
				{ programStatusKind: "permission" },
				{ programStatusKind: "question" },
				{ needsPerson: "approval", programStatusKind: "permission" },
				{ needsPerson: "error", programStatusKind: "auth" },
				{ needsPerson: "unexpected_exit", programStatusKind: "auth" },
				{},
			]),
		).toBe(2);
	});

	it("rolls up exactly the rows the needs-person authority flagged", () => {
		expect(countsTowardNeedsPersonRollup({ needsPerson: "input" })).toBe(true);
		expect(countsTowardNeedsPersonRollup({ needsPerson: "unexpected_exit" })).toBe(
			true,
		);
		expect(countsTowardNeedsPersonRollup({})).toBe(false);
	});
});
