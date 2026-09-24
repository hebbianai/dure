import { inspectAgentRuntimeProjection } from "@/lib/agents/agentRuntimeProjectionInspection";
import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import { sameAgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import {
	failCliManagedRunPresentation,
	type ManagedRunProjectionInput,
} from "@/lib/cli/managedRunPresentationModel";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const defaults = {
	readAgents: (): readonly Agent[] => useStore.getState().agents,
	inspect: inspectAgentRuntimeProjection,
	project: projectAgentRuntimeTransition,
};

/** Reconcile an already registered Run after a backend-owned rehost. Never
 * turn a caller's presentation request into authority to replace a Session. */
export async function refreshManagedRunProjection(
	request: ManagedRunProjectionInput,
	dependencies = defaults,
): Promise<void> {
	const current = dependencies
		.readAgents()
		.find((agent) => agent.id === request.agentId);
	const spawn = current?.canonicalSpawn;
	if (
		!current ||
		!spawn ||
		spawn.backendProfileId !== request.backendProfileId ||
		spawn.operationId !== request.operationId
	)
		return;
	const binding = current.runtimeBinding;
	if (
		binding?.runtime === "hmux_managed_v1" &&
		binding.sessionId === request.sessionId &&
		binding.workspaceId === request.workspaceId &&
		binding.stopFence &&
		sameHmuxManagedGeneration(binding.stopFence, request.generation)
	)
		return;

	const selected = await dependencies.inspect({
		agentId: request.agentId,
		backendProfileId: spawn.backendProfileId,
	});
	if (
		selected.state !== "stable" ||
		selected.interactionProfile !== "native_cli" ||
		selected.agentId !== request.agentId ||
		selected.backendProfileId !== spawn.backendProfileId ||
		selected.providerId !== request.providerId ||
		selected.sessionId !== request.sessionId ||
		selected.workspaceId !== request.workspaceId ||
		selected.launchIdempotencyKey !== request.launchIdempotencyKey ||
		selected.providerConversationRef !==
			(request.providerConversationRef ?? null) ||
		!sameHmuxManagedGeneration(selected.stopFence, request.generation) ||
		!request.executionProfile ||
		!sameAgentExecutionProfileV1(
			selected.executionProfile,
			request.executionProfile,
		) ||
		dependencies.readAgents().find((agent) => agent.id === request.agentId) !==
			current
	) {
		failCliManagedRunPresentation(
			"client_agent_runtime_transition_conflict",
			"managed Run runtime changed before presentation; inspect it and open again",
		);
	}
	// The shared writer validates the backend project/route and commits the
	// complete selected runtime, including retired terminal and account state.
	dependencies.project(request.agentId, selected);
}
