import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import { Button } from "@/components/ui/button";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import { presentProviderExit } from "@/lib/agents/chat/agentChatRuntimeRecovery";
import type { ObservedProviderExit } from "@/lib/agents/chat/observedRuntimeFacts";

/** The composer's notice for a conversation whose provider exited: what
 * ended, that the draft stays, and Resume, which restarts the provider on
 * the same conversation. */
export function ChatProviderExitNotice({
	exit,
	session,
	disabled,
}: {
	exit: ObservedProviderExit;
	session: Pick<AgentChatSessionView, "providerResume" | "resumeProvider">;
	/** Nothing can be asked of the backend right now. */
	disabled: boolean;
}) {
	const notice = presentProviderExit(exit, session.providerResume);
	return (
		<ChatAlert
			tone="warn"
			role="status"
			className="mb-2"
			action={
				<Button
					type="button"
					size="xs"
					variant="outline"
					disabled={disabled || notice.pending}
					onClick={() => void session.resumeProvider().catch(() => {})}
				>
					{notice.action}
				</Button>
			}
		>
			{notice.message}
			{notice.outcome && (
				<span className="mt-1 block">
					{notice.outcome.text}
					{notice.outcome.detail && (
						<code className="ml-1.5 text-[0.85em] opacity-70">
							{notice.outcome.detail}
						</code>
					)}
				</span>
			)}
		</ChatAlert>
	);
}
