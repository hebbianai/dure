import { AgentPendingRequestCard } from "@/components/agents/chat/AgentPendingRequestCard";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentPendingRequestV1 } from "@/lib/agents/chat/agentConversationContract";

/** A Chat Agent's pending request, answered through its session. The
 * controller answers one request at a time, so every card waits while any
 * answer is in flight. Every surface that shows the conversation (the pane,
 * its large window, a shared conversation, the Work view) answers here. */
export function AgentChatPendingAnswer({
	session,
	pending,
}: {
	session: AgentChatSessionView;
	pending: AgentPendingRequestV1;
}) {
	return (
		<AgentPendingRequestCard
			pending={pending}
			busy={session.answeringRequestId !== undefined}
			onAnswer={(answer) => {
				void session
					.answerPending(pending.request.requestId, answer)
					.catch(() => {});
			}}
		/>
	);
}
