import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import type { DureAgentRuntimeSourceStopPolicyV1 } from "@/lib/ipc/dureAgentRuntime";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import type { Agent } from "@/types";

/** Conversation-qualified command recipient, separate from runtime-local UI state. */
export function agentRuntimePaneActionOwnerKey(agent: Agent): string {
	return JSON.stringify([
		agentRuntimePresentationOwnerKey(agent),
		managedConversationId(agent),
	]);
}

type RuntimeSwitch = (
	sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1,
	expectedSourceRevision?: number,
) => Promise<void>;

/** A named pane action is already an explicit request to replace the current
 * surface. Preserve an idle source when possible, then use the backend's exact
 * retained revision as replacement authority. Interactive UI controls keep
 * their confirmation dialog before granting the same authority. */
export async function runAgentRuntimePaneAction(
	switchRuntime: RuntimeSwitch,
): Promise<void> {
	try {
		await switchRuntime("preserve");
	} catch (error) {
		if (!(error instanceof DureAgentRuntimeSourceActiveError)) throw error;
		await switchRuntime("discard", error.expectedSourceRevision);
	}
}
