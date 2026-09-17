import { StructuredAgentChatSurface } from "@/components/agents/chat/StructuredAgentChatSurface";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";

export function SharedAgentConversation({
	target,
}: {
	target: SharedAgentConversationTarget;
}) {
	const session = useAgentChatSession(
		target.agentId,
		target.profile,
		undefined,
		target.authority,
	);
	return (
		<StructuredAgentChatSurface session={session} attachmentsEnabled={false} />
	);
}
