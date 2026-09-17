import { describe, expect, test, vi } from "vitest";
import type { HmuxExactManagedCreateReceipt, hmux } from "@/lib/ipc";
import { workspacePerformanceScenario } from "./scenario";
import { createWorkspacePerformanceSessions } from "./sessionRuntime";

const scenario = workspacePerformanceScenario("baseline_15");

type HmuxManagedCreateRequest = Parameters<typeof hmux.advanceManagedCreate>[0];

const stopFence = {
	runnerPrincipal: "runner",
	runnerInstance: "instance",
	channelEpoch: "1",
	hostInstanceId: "host",
	terminalEpoch: "1",
};

function receipt(
	request: HmuxManagedCreateRequest,
): HmuxExactManagedCreateReceipt {
	return {
		idempotencyKey: request.idempotencyKey,
		outcome: "created",
		session: {
			sessionId: request.sessionId,
			workspaceId: request.workspaceId,
			sessionClass: "managed",
			lifecycle: "ready",
			terminalEpoch: "1",
			stopFence,
			outputSeq: "0",
			capabilities: [],
		},
	};
}

describe("workspace performance managed session runtime", () => {
	test("creates an exact provider-balanced 5 by 3 topology", async () => {
		const create = vi.fn(async (request: HmuxManagedCreateRequest) => ({
			state: "current" as const,
			receipt: receipt(request),
		}));
		const stop = vi.fn();

		const lease = await createWorkspacePerformanceSessions(scenario, {
			create,
			stop,
		});

		expect(lease.sessions).toHaveLength(15);
		expect(create).toHaveBeenCalledTimes(15);
		expect(create.mock.calls[0][0]).toMatchObject({
			idempotencyKey: "dure-perf-claude-d1-p1",
			sessionId: "dure-perf-claude-d1-p1",
			workspaceId: "dure-perf-workspace-d1-p1",
			providerId: "claude",
			command: "claude",
			cwd: "/tmp",
		});
		expect(stop).not.toHaveBeenCalled();
		await lease.release();
		await lease.release();
		expect(stop).toHaveBeenCalledTimes(15);
		expect(stop.mock.calls[0][1]).toBe("dure-perf-claude-d5-p3");
	});

	test("compensates only exact sessions created before a setup failure", async () => {
		let count = 0;
		const create = vi.fn(async (request: HmuxManagedCreateRequest) => {
			count += 1;
			if (count === 3) throw new Error("create failed");
			return { state: "current" as const, receipt: receipt(request) };
		});
		const stop = vi.fn().mockResolvedValue({ outcome: "stopped" });

		await expect(
			createWorkspacePerformanceSessions(scenario, { create, stop }),
		).rejects.toThrow("create failed");
		expect(stop).toHaveBeenCalledTimes(2);
		expect(stop.mock.calls.map((call) => call[1])).toEqual([
			"dure-perf-codex-d1-p2",
			"dure-perf-claude-d1-p1",
		]);
	});

	test("fails closed on an invalid managed create identity", async () => {
		const create = vi.fn(async (request: HmuxManagedCreateRequest) => ({
			state: "current" as const,
			receipt: { ...receipt(request), idempotencyKey: "wrong-id" },
		}));
		await expect(
			createWorkspacePerformanceSessions(scenario, {
				create,
				stop: vi.fn(),
			}),
		).rejects.toThrow("invalid managed Hmux create receipt");
		expect(create).toHaveBeenCalledOnce();
	});
});
