import type { Conversation } from "@/lib/ipc";
import {
	executeManagedAgentRehost,
	executeUnavailableManagedAgentRecovery,
	inspectDisconnectedManagedAgentRecovery,
	inspectManagedAgentRehost,
	type ManagedAgentRehostInspection,
} from "@/lib/sessions/managed/managedAgentRehost";

/** Never infer between multiple conversations that share one cwd. */
export function selectExactExitedConversation(
	storedConversationId: string | undefined,
	selectedConversationId: string | null,
	conversations: Conversation[],
): string | undefined {
	return (
		storedConversationId?.trim() ||
		selectedConversationId?.trim() ||
		(conversations.length === 1 ? conversations[0]?.id.trim() : undefined)
	);
}

export function inspectManagedAgentRecoveryRequest(
	name: string,
	panelId: string | undefined,
	conversationId: string | undefined,
) {
	return conversationId
		? inspectDisconnectedManagedAgentRecovery(name, conversationId, panelId)
		: inspectManagedAgentRehost(name, panelId);
}

export function executeManagedAgentRecoveryRequest(
	inspection: ManagedAgentRehostInspection,
) {
	return inspection.sourceLifecycle === "ready"
		? executeManagedAgentRehost(inspection)
		: executeUnavailableManagedAgentRecovery(inspection);
}
