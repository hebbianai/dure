import { ActionErrorText } from "@/components/agents/chat/ActionErrorText";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import { Button } from "@/components/ui/button";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { ObservedProviderExit } from "@/lib/agents/chat/observedRuntimeFacts";
import { presentProviderExit } from "@/lib/agents/chat/providerExitPresentation";

/** The strip that heads the composer while its provider has exited: what
 * ended and how, that the draft stays, what became of the last Resume, and
 * Resume, which restarts the provider on the same conversation. */
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
			surface="strip"
			role="status"
			action={
				<Button
					type="button"
					size="xs"
					variant="attention"
					disabled={disabled || notice.pending}
					onClick={() => void session.resumeProvider().catch(() => {})}
				>
					{notice.action}
				</Button>
			}
		>
			<ActionErrorText className="block" presentation={notice.ended} />
			{notice.outcome && (
				<ActionErrorText
					className="block text-muted-foreground"
					presentation={notice.outcome}
				/>
			)}
		</ChatAlert>
	);
}
