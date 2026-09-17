import { describe, expect, it, vi } from "vitest";
import { observeRuntimeConvergence } from "@/lib/agents/agentRuntimeConvergence";

const backend = { id: "backend-1", generation: "generation-1" };
const base = { agentId: "agent-1", backend, backendProfileId: "local" };

describe("agent runtime convergence", () => {
	it("returns the same repair revision when authorization never reached the backend", async () => {
		const oldRepair = {
			...base,
			state: "repair_required" as const,
			operationId: "operation-1",
			journalRevision: 3,
			targetInteractionProfile: "structured_protocol" as const,
			targetExecutionProfile: { kind: "provider_default" as const },
			failureKind: "launch_failed" as const,
		};
		const inspect = vi.fn().mockResolvedValueOnce(oldRepair);

		await expect(
			observeRuntimeConvergence({ inspect }, "agent-1", {
				wait: vi.fn().mockResolvedValue(undefined),
			}),
		).resolves.toEqual(oldRepair);
		expect(inspect).toHaveBeenCalledOnce();
	});

	it("projects stable without another mutation", async () => {
		const stable = {
			...base,
			state: "stable" as const,
			providerId: "claude" as const,
			interactionProfile: "structured_protocol" as const,
			interactionSessionId: "interaction-1",
			executionProfile: { kind: "provider_default" as const },
			providerConversationRef: "conversation-1",
			launchSelection: {
				model: null,
				effort: null,
				permissionMode: "default" as const,
			},
		};
		const inspect = vi
			.fn()
			.mockResolvedValueOnce({
				...base,
				state: "transitioning",
				operationId: "operation-1",
				stage: "target_started",
				journalRevision: 4,
				targetInteractionProfile: "structured_protocol",
				targetExecutionProfile: { kind: "provider_default" },
			})
			.mockResolvedValueOnce(stable);

		await expect(
			observeRuntimeConvergence({ inspect }, "agent-1", {
				wait: vi.fn().mockResolvedValue(undefined),
			}),
		).resolves.toEqual(stable);
	});

	it("follows a concurrent winner through transitioning to its stable snapshot", async () => {
		const winner = {
			...base,
			state: "stable" as const,
			providerId: "claude" as const,
			interactionProfile: "structured_protocol" as const,
			interactionSessionId: "interaction-b",
			executionProfile: { kind: "provider_default" as const },
			providerConversationRef: "conversation-1",
			launchSelection: {
				model: "claude-fable-5",
				effort: null,
				permissionMode: "default" as const,
			},
		};
		const inspect = vi
			.fn()
			.mockResolvedValueOnce({
				...base,
				state: "transitioning",
				operationId: "operation-b",
				stage: "source_stopped",
				journalRevision: 2,
				targetInteractionProfile: "structured_protocol",
				targetExecutionProfile: { kind: "provider_default" },
			})
			.mockResolvedValueOnce(winner);

		await expect(
			observeRuntimeConvergence({ inspect }, "agent-1", {
				target: {
					interactionProfile: "native_cli",
					executionProfile: { kind: "provider_default" },
				},
				wait: vi.fn().mockResolvedValue(undefined),
			}),
		).resolves.toEqual(winner);
		expect(inspect).toHaveBeenCalledTimes(2);
	});

	it("bounds an explicit read when the backend remains transitioning", async () => {
		const inspect = vi.fn().mockResolvedValue({
			...base,
			state: "transitioning",
			operationId: "operation-stuck",
			stage: "target_started",
			journalRevision: 4,
			targetInteractionProfile: "structured_protocol",
			targetExecutionProfile: { kind: "provider_default" },
		});

		await expect(
			observeRuntimeConvergence({ inspect }, "agent-1", {
				maxInspections: 3,
				wait: vi.fn().mockResolvedValue(undefined),
			}),
		).resolves.toBeUndefined();
		expect(inspect).toHaveBeenCalledTimes(3);
	});
});
