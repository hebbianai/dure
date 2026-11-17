import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRunPresentationOrder,
	parseRequestedRunStartedAtMs,
} from "@/lib/agents/runPresentationOrder";

const lead = { sessionId: "session-lead", workspaceId: "workspace-1" };
const otherLead = { sessionId: "session-other", workspaceId: "workspace-1" };

function worker(
	operationId: string,
	startedAtMs: number,
	parent: typeof lead = lead,
) {
	return { operationId, startedAtMs, parent };
}

/** Run each presentation to its commit in the order its preparation finishes
 * (`ready`), recording the order the commits happen in. */
async function commitOrder(
	enter: ReturnType<typeof createRunPresentationOrder>,
	keys: readonly ReturnType<typeof worker>[],
	ready: readonly string[],
) {
	const turns = new Map(keys.map((key) => [key.operationId, enter(key)]));
	const committed: string[] = [];
	await Promise.all(
		ready.map(async (operationId, index) => {
			const turn = turns.get(operationId)!;
			await new Promise((resolve) => setTimeout(resolve, index));
			try {
				await turn.wait();
				committed.push(operationId);
			} finally {
				turn.leave();
			}
		}),
	);
	return committed;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Run presentation start order", () => {
	it("commits one lead's concurrent workers in start order, not preparation order", async () => {
		const enter = createRunPresentationOrder();
		const keys = [
			worker("spawn-c", 3_000),
			worker("spawn-a", 1_000),
			worker("spawn-d", 4_000),
			worker("spawn-b", 2_000),
		];
		expect(
			await commitOrder(enter, keys, [
				"spawn-d",
				"spawn-c",
				"spawn-b",
				"spawn-a",
			]),
		).toEqual(["spawn-a", "spawn-b", "spawn-c", "spawn-d"]);
	});

	it("breaks a start-time tie by operation and never orders another lead's workers", async () => {
		const enter = createRunPresentationOrder();
		const keys = [
			worker("spawn-b", 1_000),
			worker("spawn-a", 1_000),
			worker("spawn-x", 500, otherLead),
		];
		expect(
			await commitOrder(enter, keys, ["spawn-b", "spawn-x", "spawn-a"]),
		).toEqual(["spawn-x", "spawn-a", "spawn-b"]);
	});

	it("leaves a Run without a parent or start time unordered", async () => {
		const enter = createRunPresentationOrder();
		const earlier = enter(worker("spawn-a", 1_000));
		for (const key of [
			{ operationId: "spawn-b", parent: lead },
			{ operationId: "spawn-c", startedAtMs: 2_000 },
			{ parent: lead, startedAtMs: 2_000 },
		]) {
			await expect(enter(key).wait()).resolves.toBeUndefined();
		}
		earlier.leave();
	});

	it("lets a later worker go once an earlier one fails, and re-checks arrivals while waiting", async () => {
		const enter = createRunPresentationOrder();
		const second = enter(worker("spawn-b", 2_000));
		const third = enter(worker("spawn-c", 3_000));
		let thirdCommitted = false;
		const thirdWait = third.wait().then(() => {
			thirdCommitted = true;
		});
		// spawn-a started first but reaches this client only now.
		const first = enter(worker("spawn-a", 1_000));
		second.leave(); // failed before its commit
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(thirdCommitted).toBe(false);
		first.leave();
		await thirdWait;
		expect(thirdCommitted).toBe(true);
		third.leave();
		third.leave();
	});

	it("bounds the wait for an earlier presentation that stalls", async () => {
		vi.useFakeTimers();
		const enter = createRunPresentationOrder(5_000);
		const stalled = enter(worker("spawn-a", 1_000));
		const later = enter(worker("spawn-b", 2_000));
		let committed = false;
		const waiting = later.wait().then(() => {
			committed = true;
		});
		await vi.advanceTimersByTimeAsync(4_999);
		expect(committed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(committed).toBe(true);
		later.leave();
		stalled.leave();
	});
});

describe("requested Run start time", () => {
	const refuse = (message: string): never => {
		throw new Error(message);
	};

	it("accepts a millisecond time and keeps an absent one absent", () => {
		expect(parseRequestedRunStartedAtMs(1_794_899_263_000, refuse)).toBe(
			1_794_899_263_000,
		);
		expect(parseRequestedRunStartedAtMs(0, refuse)).toBe(0);
		expect(parseRequestedRunStartedAtMs(undefined, refuse)).toBeUndefined();
	});

	it.each([-1, 1.5, Number.NaN, "1000", null, 2 ** 53])(
		"refuses %s",
		(value) => {
			expect(() => parseRequestedRunStartedAtMs(value, refuse)).toThrow(
				"startedAtMs is invalid",
			);
		},
	);
});
