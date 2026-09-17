import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import type { Agent } from "@/types";

/** Saved references are review candidates, not proof of concurrent writers or
 * shared provider history directories. Hmux still owns runtime admission. */
export function conversationRegistrationPeers(
	agents: readonly Agent[],
	agentId: string,
): readonly Agent[] {
	const agent = agents.find((candidate) => candidate.id === agentId);
	const binding = agent?.runtimeBinding;
	if (
		!agent ||
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local" ||
		agent.interactionProfile?.kind === "structured_protocol"
	)
		return [];
	const conversationId = managedConversationId(agent);
	if (!conversationId) return [];
	const backendProfileId =
		binding.backendProfileId ?? agent.canonicalSpawn?.backendProfileId;
	return agents.filter((candidate) => {
		const other = candidate.runtimeBinding;
		return (
			candidate.id !== agent.id &&
			candidate.provider === agent.provider &&
			candidate.interactionProfile?.kind !== "structured_protocol" &&
			other?.runtime === "hmux_managed_v1" &&
			other.source === "local" &&
			(other.backendProfileId ?? candidate.canonicalSpawn?.backendProfileId) ===
				backendProfileId &&
			(other.workspaceId !== binding.workspaceId ||
				other.sessionId !== binding.sessionId) &&
			managedConversationId(candidate) === conversationId
		);
	});
}
