import { describe, expect, it } from "vitest";
import { compareWaitStart, hasResult } from "@/lib/agents/agentResult";

describe("hasResult", () => {
	const finished = { state: "waiting" as const, turnFinished: true, resultAtMs: 5_000 };

	it("needs a finished turn that work has not resumed past", () => {
		expect(hasResult(finished, { unread: true })).toBe(true);
		expect(hasResult({ ...finished, turnFinished: false }, { unread: true })).toBe(
			false,
		);
		expect(hasResult({ ...finished, state: "working" }, { unread: true })).toBe(
			false,
		);
		// An agent that went unobserved or exited still has its result.
		expect(hasResult({ ...finished, state: "unknown" }, { unread: true })).toBe(true);
		expect(hasResult({ ...finished, state: "exited" }, { unread: true })).toBe(true);
	});

	it("keeps an unread result for a surface that lists what nobody looked at", () => {
		expect(hasResult(finished, { unread: false })).toBe(false);
		// Its time is unknown when it finished unseen; unread still lists it.
		const unseen = { state: "waiting" as const, turnFinished: true };
		expect(hasResult(unseen, { unread: true })).toBe(true);
	});

	it("keeps a result inside a surface's own time window", () => {
		expect(hasResult(finished, { sinceMs: 5_000 })).toBe(true);
		expect(hasResult(finished, { sinceMs: 5_001 })).toBe(false);
		// With no known time a result cannot be placed inside a window.
		const unseen = { state: "waiting" as const, turnFinished: true };
		expect(hasResult(unseen, { sinceMs: 0 })).toBe(false);
	});
});

describe("compareWaitStart", () => {
	it("orders oldest first, with unseen starts ahead and ties left alone", () => {
		const items = [
			{ id: "late", sinceMs: 3 },
			{ id: "unseen-1" },
			{ id: "early", sinceMs: 1 },
			{ id: "unseen-2" },
			{ id: "tie", sinceMs: 1 },
		];
		expect([...items].sort(compareWaitStart).map((item) => item.id)).toEqual([
			"unseen-1",
			"unseen-2",
			"early",
			"tie",
			"late",
		]);
	});
});
