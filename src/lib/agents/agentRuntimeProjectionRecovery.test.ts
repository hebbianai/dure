import { describe, expect, it, vi } from "vitest";
import {
	inspectSelectedAgentRuntimeProjection,
	inspectStructuredAgentRuntimeProjection,
	inspectStructuredAgentRuntimeProjectionContext,
	isAgentRuntimeProjectionCapabilityMissing,
} from "@/lib/agents/agentRuntimeProjectionRecovery";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { agentRuntimeBackendEnvelope, agentRuntimeProjectionContext } from "@/test/dureAgentRuntimeFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

function stable(
	routeAuthority = testDureBackendRouteAuthority("backend-1", "generation-1"),
) {
	return {
		state: "stable" as const,
		backend: routeAuthority.backend,
		backendProfileId: routeAuthority.profileId,
		routeAuthority,
		agentId: "agent-731",
		selectionRevision: 4,
		providerId: "claude" as const,
		executionProfile: {
			kind: "credential_reference" as const,
			reference_id: "hebbian98",
			credential_generation: "credential-hebbian98-2",
		},
		providerConversationRef: "conversation-731",
		interactionProfile: "structured_protocol" as const,
		interactionSessionId: "interaction-731",
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "default" as const,
		},
		projectionContext: {
			schemaVersion: 1 as const,
			identity: { kind: "registered" as const },
			agent: {
				agentId: "agent-731",
				workspaceId: "workspace-731",
				providerId: "claude" as const,
			},
			workspace: {
				workspaceId: "workspace-731",
				projectId: "project-1",
				rootPath: "/repo/.worktrees/agent-731",
			},
			project: {
				projectId: "project-1",
				rootPath: "/repo",
			},
		},
	};
}

describe("route-less Agent runtime projection recovery", () => {
	it("retries an old-route rejection through the shared selected-snapshot fence", async () => {
		const routeA = testDureBackendRouteAuthority("backend-a", "generation-a");
		const routeB = testDureBackendRouteAuthority("backend-b", "generation-b");
		let rejectOld!: (error: unknown) => void;
		const oldPending = new Promise<ReturnType<typeof stable>>((_, reject) => {
			rejectOld = reject;
		});
		const replacement = stable(routeB);
		const inspect = vi
			.fn()
			.mockReturnValueOnce(oldPending)
			.mockResolvedValueOnce(replacement)
			.mockResolvedValueOnce(replacement);
		const source = {
			agentId: replacement.agentId,
			backendProfileId: routeA.profileId,
			interactionSessionId: replacement.interactionSessionId,
		};
		const generation = (routeAuthority: typeof routeA) => ({
			routeAuthority,
			bindingRevision: 4,
			runtimeGeneration: "runtime-4",
			providerEpoch: "provider-4",
		});

		const oldRead = inspectStructuredAgentRuntimeProjection(
			source,
			inspect,
			generation(routeA),
		);
		const newRead = inspectStructuredAgentRuntimeProjection(
			source,
			inspect,
			generation(routeB),
		);
		await expect(newRead).resolves.toEqual(replacement);
		rejectOld(
			new DureBackendRequestError(
				"agent_runtime_transition_backend_changed",
				"backend changed",
				{ kind: "authority_changed" },
			),
		);

		await expect(oldRead).resolves.toEqual(replacement);
		expect(inspect).toHaveBeenCalledTimes(3);
	});

	it.each(["agentId", "backendProfileId", "interactionSessionId"] as const)(
		"rejects a workspace observation for a different %s", async (field) => {
		const routeAuthority = testDureBackendRouteAuthority(
			"backend-1",
			"generation-1",
			"profile-1",
		);
		const observation = stable(routeAuthority);
		const inspect = vi.fn().mockResolvedValue(observation);

		await expect(
			inspectStructuredAgentRuntimeProjectionContext(
				{
					agentId: observation.agentId,
					backendProfileId: routeAuthority.profileId,
					interactionSessionId: observation.interactionSessionId,
					[field]: "different-source",
				},
				{ inspect },
			),
		).rejects.toThrow("client_agent_runtime_transition_conflict");
		expect(inspect).toHaveBeenCalledOnce();
	});

	it("reuses one complete runtime observation for its workspace without a second read", async () => {
		const envelope = agentRuntimeBackendEnvelope();
		const context = agentRuntimeProjectionContext();
		const invokeCommand = vi.fn().mockResolvedValue({
			...envelope,
			result: { ...envelope.result, state: "stable", projectionContext: context },
		});
		const client = createDureAgentRuntimeClient({ invokeCommand });

		const result = await inspectStructuredAgentRuntimeProjectionContext(
			{
				agentId: "agent-1",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			},
			{ inspect: client.inspect },
		);

		expect(result.projectionContext).toEqual(context);
		expect(invokeCommand).toHaveBeenCalledOnce();
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "selected", profileId: "local" },
			operation: "agent_runtime.projection.inspect",
			body: { schemaVersion: 1, agentId: "agent-1" },
		});
	});

	it("recognizes only an exact transport capability miss as rolling compatibility", () => {
		const exact = new DureBackendRequestError(
			"backend_transport_capability_missing",
			"missing",
			{ kind: "transport" },
			{ capability: "agent_runtime.projection.inspect" },
		);
		expect(isAgentRuntimeProjectionCapabilityMissing(exact)).toBe(true);
		expect(
			isAgentRuntimeProjectionCapabilityMissing(
				new DureBackendRequestError(
					"backend_transport_capability_missing",
					"contract failure",
					{ kind: "contract" },
					{ capability: "agent_runtime.projection.inspect" },
				),
			),
		).toBe(false);
		expect(
			isAgentRuntimeProjectionCapabilityMissing(
				new DureBackendRequestError(
					"backend_transport_capability_missing",
					"other capability",
					{ kind: "transport" },
					{ capability: "agent_runtime.inspect" },
				),
			),
		).toBe(false);
	});

	it("carries one selected exact route through Stable discovery", async () => {
		const routeAuthority = testDureBackendRouteAuthority(
			"backend-1",
			"generation-1",
		);
		const inspectExact = vi
			.fn()
			.mockResolvedValue(stable(routeAuthority));
		const resolveSelectedRoute = vi.fn().mockResolvedValue(routeAuthority);

		const observation = await inspectSelectedAgentRuntimeProjection(
			"agent-731",
			{
				dependencies: {
					resolveSelectedRoute,
					createClient: () => ({ inspectExact }),
				},
			},
		);

		expect(observation).toEqual(stable(routeAuthority));
		expect(resolveSelectedRoute).toHaveBeenNthCalledWith(1, undefined);
		expect(resolveSelectedRoute).toHaveBeenNthCalledWith(2, undefined);
		expect(inspectExact).toHaveBeenCalledOnce();
		expect(inspectExact).toHaveBeenCalledWith(
			"agent-731",
			routeAuthority,
		);
	});

	it("returns the selected Unmanaged lifecycle observation", async () => {
		const routeAuthority = testDureBackendRouteAuthority(
			"backend-1",
			"generation-1",
		);
		const unmanaged = {
			state: "unmanaged",
			agentId: "agent-731",
			backend: routeAuthority.backend,
			backendProfileId: routeAuthority.profileId,
			routeAuthority,
		} as const;
		const inspectExact = vi.fn().mockResolvedValue(unmanaged);
		const resolveSelectedRoute = vi.fn().mockResolvedValue(routeAuthority);

		await expect(
			inspectSelectedAgentRuntimeProjection("agent-731", {
				dependencies: {
					resolveSelectedRoute,
					createClient: () => ({ inspectExact }),
				},
			}),
		).resolves.toEqual(unmanaged);
		expect(resolveSelectedRoute).toHaveBeenCalledTimes(2);
	});

	it("rejects a Stable result when the selected route changes in flight", async () => {
		const routeA = testDureBackendRouteAuthority(
			"backend-a",
			"generation-a",
			"profile-a",
		);
		const routeB = testDureBackendRouteAuthority(
			"backend-b",
			"generation-b",
			"profile-b",
		);
		const inspectExact = vi.fn().mockResolvedValue(stable(routeA));

		await expect(
			inspectSelectedAgentRuntimeProjection("agent-731", {
				dependencies: {
					resolveSelectedRoute: vi
						.fn()
						.mockResolvedValueOnce(routeA)
						.mockResolvedValueOnce(routeB),
					createClient: () => ({ inspectExact }),
				},
			}),
		).rejects.toMatchObject({
			code: "agent_runtime_projection_backend_changed",
			failure: { kind: "authority_changed" },
		});
	});

	it("refuses a pinned Transitioning route after the selected backend changes", async () => {
		const routeA = testDureBackendRouteAuthority(
			"backend-a",
			"generation-a",
			"profile-a",
		);
		const routeB = testDureBackendRouteAuthority(
			"backend-b",
			"generation-b",
			"profile-b",
		);
		const inspectExact = vi.fn();

		await expect(
			inspectSelectedAgentRuntimeProjection("agent-731", {
				expectedRouteAuthority: routeA,
				dependencies: {
					resolveSelectedRoute: vi.fn().mockResolvedValue(routeB),
					createClient: () => ({ inspectExact }),
				},
			}),
		).rejects.toMatchObject({
			code: "agent_runtime_projection_backend_changed",
			failure: { kind: "authority_changed" },
		});
		expect(inspectExact).not.toHaveBeenCalled();
	});
});
