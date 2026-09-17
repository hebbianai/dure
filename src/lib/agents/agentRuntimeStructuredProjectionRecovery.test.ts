import { describe, expect, it, vi } from "vitest";
import { createStructuredAgentRuntimeProjectionRecovery } from "@/lib/agents/agentRuntimeStructuredProjectionRecovery";
import { stopFenceFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const routeAuthority = testDureBackendRouteAuthority(
	"backend-1",
	"generation-1",
);
const replacementRouteAuthority = testDureBackendRouteAuthority(
	"backend-2",
	"generation-2",
);

function stable(
	selectionRevision: number,
	interactionSessionId = "interaction-1",
	observedRouteAuthority = routeAuthority,
) {
	const bindingRevision = selectionRevision;
	return {
		state: "stable" as const,
		backend: observedRouteAuthority.backend,
		backendProfileId: observedRouteAuthority.profileId,
		routeAuthority: observedRouteAuthority,
		agentId: "agent-1",
		selectionRevision,
		providerId: "claude" as const,
		executionProfile: { kind: "provider_default" as const },
		providerConversationRef: `conversation-${selectionRevision}`,
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "default" as const,
		},
		interactionProfile: "structured_protocol" as const,
		interactionSessionId,
		binding: {
			schemaVersion: 1 as const,
			interactionSessionId,
			agentId: "agent-1",
			providerId: "claude" as const,
			executionProfile: { kind: "provider_default" as const },
			providerConversationRef: `conversation-${selectionRevision}`,
			runtime: {
				runtimeGeneration: `runtime-${selectionRevision}`,
				providerEpoch: `provider-${selectionRevision}`,
			},
			timelineEpoch: `timeline-${selectionRevision}`,
			bindingRevision,
			historyComplete: true,
			createdAtMs: 1,
			updatedAtMs: selectionRevision,
		},
	};
}

function generation(revision: number, observedRouteAuthority = routeAuthority) {
	return {
		routeAuthority: observedRouteAuthority,
		bindingRevision: revision,
		runtimeGeneration: `runtime-${revision}`,
		providerEpoch: `provider-${revision}`,
	};
}

function observedGeneration(
	revision: number,
	observedRouteAuthority = routeAuthority,
) {
	return {
		kind: "observed_generation" as const,
		generation: generation(revision, observedRouteAuthority),
	};
}

describe("structured runtime projection recovery", () => {
	it("reuses the acknowledged initial attach for the controller's first generation", async () => {
		const inspect = vi.fn().mockResolvedValue(stable(2));
		const project = vi.fn();
		const recover = createStructuredAgentRuntimeProjectionRecovery({
			inspect,
			isCurrentSource: () => true,
			project,
			currentOwnerKey: () => "owner-2",
		});
		const source = {
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		};

		await recover(source, {
			kind: "initial_attach",
			signal: new AbortController().signal,
		});
		await expect(recover(source, observedGeneration(2))).resolves.toMatchObject(
			{
				ownerKey: "owner-2",
				selectionRevision: 2,
			},
		);

		expect(inspect).toHaveBeenCalledOnce();
		expect(project).toHaveBeenCalledOnce();
	});

	it("shares an in-flight initial attach with the same controller generation", async () => {
		let resolveInspection!: (value: ReturnType<typeof stable>) => void;
		const inspect = vi.fn(
			() =>
				new Promise<ReturnType<typeof stable>>((resolve) => {
					resolveInspection = resolve;
				}),
		);
		const recover = createStructuredAgentRuntimeProjectionRecovery({
			inspect,
			isCurrentSource: () => true,
			project: vi.fn(),
			currentOwnerKey: () => "owner-2",
		});
		const source = {
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		};
		const attach = recover(source, {
			kind: "initial_attach",
			signal: new AbortController().signal,
		});
		await Promise.resolve();
		const invalidation = recover(source, observedGeneration(2));

		expect(inspect).toHaveBeenCalledOnce();
		resolveInspection(stable(2));
		await expect(Promise.all([attach, invalidation])).resolves.toHaveLength(2);
		expect(inspect).toHaveBeenCalledOnce();
	});

	it("accepts a replacement backend route when its revision restarts lower", async () => {
		const project = vi.fn();
		const recover = createStructuredAgentRuntimeProjectionRecovery({
			inspect: vi
				.fn()
				.mockResolvedValueOnce(stable(9))
				.mockResolvedValueOnce(
					stable(1, "interaction-1", replacementRouteAuthority),
				),
			isCurrentSource: () => true,
			project,
			currentOwnerKey: () => "owner-current",
		});
		const source = {
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		};

		await recover(source, observedGeneration(9));
		await recover(source, observedGeneration(1, replacementRouteAuthority));

		expect(project).toHaveBeenCalledTimes(2);
		expect(project.mock.calls[1]?.[1].routeAuthority).toEqual(
			replacementRouteAuthority,
		);
	});

	it("waits for a transitioning replacement and projects its native successor", async () => {
		const transitioning = {
			state: "transitioning" as const,
			agentId: "agent-1",
			operationId: "runtime-transition-1",
			stage: "source_stopped" as const,
			journalRevision: 2,
			targetInteractionProfile: "native_cli" as const,
			targetExecutionProfile: { kind: "provider_default" as const },
			backend: routeAuthority.backend,
			backendProfileId: routeAuthority.profileId,
			routeAuthority,
		};
		const native = {
			state: "stable" as const,
			backend: routeAuthority.backend,
			backendProfileId: routeAuthority.profileId,
			routeAuthority,
			agentId: "agent-1",
			selectionRevision: 2,
			providerId: "claude" as const,
			executionProfile: { kind: "provider_default" as const },
			providerConversationRef: "conversation-1",
			launchSelection: {
				model: null,
				effort: null,
				permissionMode: "default" as const,
			},
			interactionProfile: "native_cli" as const,
			sessionId: "session-native-1",
			workspaceId: "workspace-1",
			launchIdempotencyKey: "launch-native-1",
			stopFence: stopFenceFixture(),
		};
		const inspect = vi
			.fn()
			.mockResolvedValueOnce(transitioning)
			.mockResolvedValueOnce(native);
		const project = vi.fn();
		const recover = createStructuredAgentRuntimeProjectionRecovery({
			inspect,
			isCurrentSource: () => true,
			project,
			currentOwnerKey: () => "owner-native-1",
		});

		const source = {
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		};
		const firstAttach = new AbortController();
		const secondAttach = new AbortController();
		const first = recover(source, {
			kind: "initial_attach",
			signal: firstAttach.signal,
		});
		const second = recover(source, {
			kind: "initial_attach",
			signal: secondAttach.signal,
		});

		expect(second).toBe(first);
		firstAttach.abort();
		await expect(first).resolves.toMatchObject({
			ownerKey: "owner-native-1",
			selectionRevision: 2,
		});
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(project).toHaveBeenCalledWith("agent-1", native);
	});

	it("stops initial-attach convergence when its last mounted view releases", async () => {
		let resolveInspection!: (value: {
			state: "transitioning";
			agentId: string;
			operationId: string;
			stage: "source_stopped";
			journalRevision: number;
			targetInteractionProfile: "native_cli";
			targetExecutionProfile: { kind: "provider_default" };
			backend: typeof routeAuthority.backend;
			backendProfileId: string;
			routeAuthority: typeof routeAuthority;
		}) => void;
		const inspect = vi.fn(
			() =>
				new Promise<Parameters<typeof resolveInspection>[0]>((resolve) => {
					resolveInspection = resolve;
				}),
		);
		const project = vi.fn();
		const recover = createStructuredAgentRuntimeProjectionRecovery({
			inspect,
			isCurrentSource: () => true,
			project,
			currentOwnerKey: () => "owner-1",
		});
		const attach = new AbortController();
		const pending = recover(
			{
				agentId: "agent-1",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			},
			{ kind: "initial_attach", signal: attach.signal },
		);
		await Promise.resolve();

		attach.abort();
		resolveInspection({
			state: "transitioning",
			agentId: "agent-1",
			operationId: "runtime-transition-1",
			stage: "source_stopped",
			journalRevision: 2,
			targetInteractionProfile: "native_cli",
			targetExecutionProfile: { kind: "provider_default" },
			backend: routeAuthority.backend,
			backendProfileId: routeAuthority.profileId,
			routeAuthority,
		});

		await expect(pending).resolves.toBeUndefined();
		expect(inspect).toHaveBeenCalledOnce();
		expect(project).not.toHaveBeenCalled();
	});

	it("prevents delayed revision 2 from overwriting projected revision 3", async () => {
		const resolvers: Array<(value: ReturnType<typeof stable>) => void> = [];
		const projected: number[] = [];
		const recover = createStructuredAgentRuntimeProjectionRecovery({
			inspect: vi.fn(
				() =>
					new Promise<ReturnType<typeof stable>>((resolve) => {
						resolvers.push(resolve);
					}),
			),
			isCurrentSource: () => true,
			project: (_agentId, observation) => {
				projected.push(observation.selectionRevision);
			},
			currentOwnerKey: () => "owner-1",
		});
		const source = {
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		};

		const revision2 = recover(source, observedGeneration(2));
		const revision3 = recover(source, observedGeneration(3));
		await Promise.resolve();
		expect(resolvers).toHaveLength(2);
		resolvers[1]?.(stable(3));
		await revision3;
		resolvers[0]?.(stable(2));
		await revision2;

		expect(projected).toEqual([3]);
	});

	it("discards a delayed observation after its exact source is replaced", async () => {
		let resolve!: (value: ReturnType<typeof stable>) => void;
		let current = true;
		const project = vi.fn();
		const recover = createStructuredAgentRuntimeProjectionRecovery({
			inspect: () =>
				new Promise<ReturnType<typeof stable>>((complete) => {
					resolve = complete;
				}),
			isCurrentSource: () => current,
			project,
			currentOwnerKey: () => "owner-1",
		});
		const pending = recover(
			{
				agentId: "agent-1",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			},
			observedGeneration(2),
		);
		await Promise.resolve();

		current = false;
		resolve(stable(2));

		await expect(pending).resolves.toBeUndefined();
		expect(project).not.toHaveBeenCalled();
	});

	it("forgets committed authority after its exact source is replaced", async () => {
		let currentInteractionSessionId = "interaction-1";
		const project = vi.fn();
		const recover = createStructuredAgentRuntimeProjectionRecovery({
			inspect: async (source, expected) => {
				if (!expected) throw new Error("expected generation");
				return stable(expected.bindingRevision, source.interactionSessionId);
			},
			isCurrentSource: (source) =>
				source.interactionSessionId === currentInteractionSessionId,
			project,
			currentOwnerKey: () => "owner-1",
		});
		const source = (interactionSessionId: string) => ({
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId,
		});

		await recover(source("interaction-1"), observedGeneration(3));
		currentInteractionSessionId = "interaction-2";
		await recover(source("interaction-2"), observedGeneration(1));
		currentInteractionSessionId = "interaction-1";
		await recover(source("interaction-1"), observedGeneration(1));

		expect(
			project.mock.calls.map(
				([, observation]) => observation.selectionRevision,
			),
		).toEqual([3, 1, 1]);
	});
});
