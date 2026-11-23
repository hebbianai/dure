import { AgentChatSurface } from "@/components/agents/chat/AgentChatSurface";
import type { IDockviewPanelProps } from "dockview-react";
import { AgentPendingRequestCard } from "@/components/agents/chat/AgentPendingRequestCard";
import type { ChatTurnFailureRecovery } from "@/components/agents/chat/ChatComposer";
import { useChatContentTypography } from "@/components/agents/chat/useChatContentTypography";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";

/** A Chat Agent's conversation and composer. Presentation only: the pane, its
 * large window and a shared conversation all render it, so runtime side
 * effects stay with the owner of the session and launch selection. */
export function StructuredAgentChatSurface({
	session,
	paneApi,
	disabled,
	attachmentsEnabled,
	launchSelection,
	catalogSource,
	onReady,
	recovery,
	onNewConversation,
	providerTranscriptReadable,
}: {
	session: AgentChatSessionView;
	paneApi?: IDockviewPanelProps["api"];
	disabled?: boolean;
	attachmentsEnabled?: boolean;
	launchSelection?: AgentRuntimeLaunchSelectionView;
	catalogSource?: ProviderCatalogSource;
	onReady?: () => void;
	recovery?: ChatTurnFailureRecovery;
	onNewConversation?: () => void;
	providerTranscriptReadable?: boolean;
}) {
	const typography = useChatContentTypography();
	return (
		<AgentChatSurface
			session={session}
			paneApi={paneApi}
			disabled={disabled}
			attachmentsEnabled={attachmentsEnabled}
			typography={typography}
			launchSelection={launchSelection}
			catalogSource={catalogSource}
			onReady={onReady}
			recovery={recovery}
			onNewConversation={onNewConversation}
			providerTranscriptReadable={providerTranscriptReadable}
			renderPending={(pending) => (
				<AgentPendingRequestCard
					pending={pending}
					busy={session.answeringRequestId !== undefined}
					onAnswer={(answer) => {
						void session
							.answerPending(pending.request.requestId, answer)
							.catch(() => {});
					}}
				/>
			)}
		/>
	);
}
