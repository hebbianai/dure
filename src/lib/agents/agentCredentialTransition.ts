import { switchAgentRuntimeCredential } from "@/lib/agents/agentRuntimeTransitionAction";
import { supportsStructuredChat } from "@/lib/agents/providers";
import {
	DureAgentRuntimeSourceActiveError,
	type DureAgentRuntimeTransitionResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import {
	requestManagedCredentialSwitch,
	scheduleBusyAgentCredentialSwitch,
} from "@/lib/sessions/credentials/deferredCredentialSwitchRuntime";
import { withManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import { useStore } from "@/store";

export type AgentCredentialTransitionResult =
	| {
			kind: "completed";
			conversationId: string | null;
			runtime?: DureAgentRuntimeTransitionResultV1;
	  }
	| { kind: "scheduled"; conversationId: string };

/** Route credential changes to the runtime authority owning the Agent. */
export function requestAgentCredentialTransition({
	agentId,
	targetCredentialId,
	sourcePanelId,
}: {
	agentId: string;
	targetCredentialId: string | null;
	sourcePanelId: string;
}): Promise<AgentCredentialTransitionResult> {
	return withManagedCredentialSwitchTransition(agentId, async () => {
		const agent = useStore
			.getState()
			.agents.find((candidate) => candidate.id === agentId);
		if (!agent) {
			throw new Error("client_agent_runtime_transition_unavailable");
		}
		const binding = agent.runtimeBinding;
		const nativeSsh =
			agent.interactionProfile === undefined &&
			binding?.runtime === "hmux_managed_v1" &&
			binding.source === "ssh" &&
			binding.backendProfileId === undefined;
		if (supportsStructuredChat(agent.provider) && !nativeSsh) {
			let result: Awaited<ReturnType<typeof switchAgentRuntimeCredential>>;
			try {
				result = await switchAgentRuntimeCredential(
					agentId,
					targetCredentialId,
				);
			} catch (error) {
				if (!(error instanceof DureAgentRuntimeSourceActiveError)) throw error;
				if (error.expectedSourceRevision !== undefined) {
					const scheduled = await scheduleBusyAgentCredentialSwitch(
						agentId,
						targetCredentialId,
						sourcePanelId,
						error.expectedSourceRevision,
					);
					if (scheduled) return scheduled;
				}
				// Selecting an account never authorizes interrupting active work.
				throw error;
			}
			return {
				kind: "completed",
				conversationId: result.providerConversationRef,
				runtime: result,
			};
		}
		if (agent.runtimeBinding?.runtime !== "hmux_managed_v1") {
			throw new Error("client_agent_runtime_transition_unavailable");
		}
		return requestManagedCredentialSwitch(
			agentId,
			targetCredentialId,
			sourcePanelId,
		);
	});
}
