import { describe, expect, it, vi } from "vitest";
import {
	AutomaticManagedRehostCoordinator,
	type AutomaticManagedRehostCoordinatorDependencies,
} from "@/lib/sessions/managed/automaticManagedRehostRuntime";

const idleReplacementGuard = {
	runtimeRevision: "9",
	outputSequence: "42",
	providerId: "codex" as const,
	conversationId: "conversation-1",
};

function dependencies(): AutomaticManagedRehostCoordinatorDependencies {
	const payload = { schemaVersion: 1 };
	return {
		now: () => 20_000,
		findEligible: vi.fn().mockResolvedValue([
			{
				eligible: true,
				identity: "old-generation",
				agentId: "agent-1",
				desktopId: "desktop-offscreen",
				panelId: "agent:agent-1",
				source: "local",
				hostId: "local",
				idleReplacementGuard,
			},
		]),
		inspect: vi.fn().mockResolvedValue({
			agentId: "agent-1",
			desktopId: "desktop-offscreen",
			panelId: "agent:agent-1",
			sourceBinding: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
			},
		}),
		assertStillEligible: vi.fn().mockResolvedValue(idleReplacementGuard),
		execute: vi.fn().mockResolvedValue({ recovery: {} }),
		payload: vi.fn().mockReturnValue(payload),
		synchronize: vi.fn().mockResolvedValue(payload),
		emit: vi.fn().mockResolvedValue(undefined),
		onError: vi.fn(),
	};
}

describe("automatic managed rehost coordinator", () => {
	it("coalesces overlapping passes and executes globally one at a time", async () => {
		const deps = dependencies();
		let release!: () => void;
		vi.mocked(deps.inspect).mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () =>
						resolve({
							agentId: "agent-1",
							desktopId: "desktop-offscreen",
							panelId: "agent:agent-1",
							sourceBinding: {
								sessionId: "session-old",
								workspaceId: "workspace-1",
							},
						});
				}),
		);
		const coordinator = new AutomaticManagedRehostCoordinator(deps, {
			eligibilityDwellMs: 0,
			failureCooldownMs: 1000,
		});

		const first = coordinator.runPass();
		const second = coordinator.runPass();
		await vi.waitFor(() => expect(deps.inspect).toHaveBeenCalledOnce());
		release();
		await Promise.all([first, second]);

		expect(deps.execute).toHaveBeenCalledOnce();
		expect(deps.synchronize).toHaveBeenCalledOnce();
	});

	it("runs the final async race gate immediately before the journaled transaction", async () => {
		const deps = dependencies();
		const coordinator = new AutomaticManagedRehostCoordinator(deps, {
			eligibilityDwellMs: 0,
			failureCooldownMs: 1000,
		});

		await coordinator.runPass();

		expect(deps.execute).toHaveBeenCalledOnce();
		const options = vi.mocked(deps.execute).mock.calls[0]?.[1];
		expect(options?.beforeStop).toBeTypeOf("function");
		await expect(options?.beforeStop()).resolves.toEqual(idleReplacementGuard);
		expect(deps.assertStillEligible).toHaveBeenCalledOnce();
	});

	it("retries a receipt-driven CAS without executing a second provider replacement", async () => {
		const deps = dependencies();
		const canonicalPayload = { schemaVersion: 1, conversationId: "fresh-1" };
		vi.mocked(deps.synchronize)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(canonicalPayload);
		const coordinator = new AutomaticManagedRehostCoordinator(deps, {
			eligibilityDwellMs: 0,
			failureCooldownMs: 1000,
		});

		await coordinator.runPass();
		await coordinator.runPass();

		expect(deps.execute).toHaveBeenCalledOnce();
		expect(deps.payload).toHaveBeenCalledOnce();
		expect(deps.synchronize).toHaveBeenCalledTimes(2);
		expect(deps.emit).toHaveBeenCalledOnce();
		expect(deps.emit).toHaveBeenCalledWith(canonicalPayload);
	});

	it("finishes interrupted reboot convergence before considering a healthy replacement", async () => {
		const deps = dependencies();
		deps.convergeInterrupted = vi.fn().mockResolvedValue(true);
		const coordinator = new AutomaticManagedRehostCoordinator(deps, {
			eligibilityDwellMs: 0,
			failureCooldownMs: 1000,
		});

		await expect(coordinator.runPass()).resolves.toBe(true);

		expect(deps.convergeInterrupted).toHaveBeenCalledOnce();
		expect(deps.findEligible).not.toHaveBeenCalled();
		expect(deps.execute).not.toHaveBeenCalled();
	});
});
