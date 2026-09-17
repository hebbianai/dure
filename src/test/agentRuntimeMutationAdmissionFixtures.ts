import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import type { DureBackendInvoke } from "@/lib/ipc/dureBackend";
import { agentFixture } from "@/test/agentFixtures";
import {
	agentRuntimeBackendEnvelope,
	agentRuntimeProjectionContext,
	nativeRuntimeReceipt,
} from "@/test/dureAgentRuntimeFixtures";

/** Transport-only fixture shared by action tests and the hidden native probe. */
export function createRuntimeMutationAdmissionFixture(sourceRevision = 1) {
	const envelope = agentRuntimeBackendEnvelope();
	const agent = agentFixture({
		provider: "claude",
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-current",
		},
		executionProfile: { kind: "provider_default" },
		pendingCmd: "newer user work",
		skipPermissions: true,
	});
	const current = {
		ownerKey: agentRuntimePresentationOwnerKey(agent),
		routeAuthority: envelope.routeAuthority,
		selectionRevision: 2,
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "skip_permissions" as const,
		},
	};
	const requests: string[] = [];
	const handleRequest: DureBackendInvoke = async (command, args) => {
		const request = args as { operation: string; body?: { agentId?: string } };
		requests.push(request.operation ?? command);
		if (command !== "dure_backend_request" || request.body?.agentId !== agent.id)
			throw new Error(`Unexpected fixture command: ${command}`);
		if (request.operation === "agent_runtime.projection.inspect") {
			return {
				...envelope,
				result: {
					schemaVersion: 1,
					state: "stable",
					receipt: nativeRuntimeReceipt(
						{ kind: "provider_default" },
						sourceRevision,
						"fixture-create",
					),
					projectionContext: agentRuntimeProjectionContext(),
				},
			};
		}
		if (request.operation !== "agent_runtime.transition")
			throw new Error(`Unexpected fixture operation: ${request.operation}`);
		return {
			...envelope,
			result: {
				schemaVersion: 1,
				receipt: nativeRuntimeReceipt(
					{ kind: "provider_default" },
					sourceRevision + 1,
					"fixture-create-next",
				),
			},
		};
	};
	return {
		agent,
		current,
		requests,
		handleRequest,
		state: {
			agents: [agent],
			projects: [
				{
					id: "project-1",
					name: "QA",
					path: "/repo",
					kind: "local" as const,
					isRepo: true,
				},
			],
			agentRuntimeLaunchPresentation: { [agent.id]: current },
		},
	};
}
