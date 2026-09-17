import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspectSessionsExact: vi.fn() }));

vi.mock("@/lib/ipc", () => ({
	hmux: { inspectSessionsExact: mocks.inspectSessionsExact },
}));

import {
	EXACT_HMUX_INSPECTION_BATCH_LIMIT,
	inspectHmuxSessionExact,
	inspectHmuxSessionsExact,
} from "./exactHmuxSessionInspection";

const target = (index: number) => ({
	sessionId: `session-${index}`,
	workspaceId: `workspace-${index}`,
});

const found = (index: number) => ({
	outcome: "found" as const,
	session: {
		...target(index),
		lifecycle: "ready" as const,
		terminalEpoch: `epoch-${index}`,
		outputSeq: "0",
		capabilities: [],
	},
});

describe("exact Hmux session inspection", () => {
	beforeEach(() => {
		mocks.inspectSessionsExact.mockReset();
	});

	it("sends 45 exact targets in one native batch", async () => {
		mocks.inspectSessionsExact.mockImplementation(
			async (targets: ReturnType<typeof target>[]) =>
				targets.map((item) => {
					const index = Number(item.sessionId.slice("session-".length));
					return found(index);
				}),
		);
		const targets = Array.from({ length: 45 }, (_, index) => target(index));

		const results = await inspectHmuxSessionsExact(targets);

		expect(mocks.inspectSessionsExact).toHaveBeenCalledOnce();
		expect(mocks.inspectSessionsExact).toHaveBeenCalledWith(targets);
		expect(results.map((result) => result.outcome)).toEqual(
			targets.map(() => "found"),
		);
	});

	it("keeps 129 exact targets ordered across the 128-target boundary", async () => {
		mocks.inspectSessionsExact.mockImplementation(
			async (targets: ReturnType<typeof target>[]) =>
				targets.map((item) => {
					const index = Number(item.sessionId.slice("session-".length));
					return found(index);
				}),
		);
		const targets = Array.from(
			{ length: 129 },
			(_, index) => target(index),
		);

		const results = await inspectHmuxSessionsExact(targets);

		expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
		expect(
			mocks.inspectSessionsExact.mock.calls.map(([batch]) => batch.length),
		).toEqual([EXACT_HMUX_INSPECTION_BATCH_LIMIT, 1]);
		expect(mocks.inspectSessionsExact.mock.calls[0]?.[0]).toEqual(
			targets.slice(0, EXACT_HMUX_INSPECTION_BATCH_LIMIT),
		);
		expect(mocks.inspectSessionsExact.mock.calls[1]?.[0]).toEqual(
			targets.slice(EXACT_HMUX_INSPECTION_BATCH_LIMIT),
		);
		expect(results.map((result) => result.outcome)).toEqual(
			targets.map(() => "found"),
		);
		expect(
			results.map((result) =>
				result.outcome === "found"
					? {
							sessionId: result.session.sessionId,
							workspaceId: result.session.workspaceId,
						}
					: undefined,
			),
		).toEqual(targets);
	});

	it("only exact not_found becomes absence", async () => {
		mocks.inspectSessionsExact.mockResolvedValue([
			{ outcome: "not_found", ...target(1) },
		]);
		await expect(inspectHmuxSessionExact(target(1))).resolves.toBeUndefined();

		mocks.inspectSessionsExact.mockResolvedValue([
			{ outcome: "unprobed", ...target(1) },
		]);
		await expect(inspectHmuxSessionExact(target(1))).rejects.toThrow(
			"hmux_exact_inspection_unprobed",
		);
	});

	it("rejects a truncated native result batch", async () => {
		mocks.inspectSessionsExact.mockResolvedValue([]);

		await expect(inspectHmuxSessionsExact([target(1)])).rejects.toThrow(
			"hmux_exact_inspection_result_count_mismatch",
		);
	});

	it("rejects a result for a different workspace generation identity", async () => {
		mocks.inspectSessionsExact.mockResolvedValue([found(2)]);
		await expect(inspectHmuxSessionExact(target(1))).rejects.toThrow(
			"hmux_exact_inspection_result_identity_mismatch",
		);
	});
});
