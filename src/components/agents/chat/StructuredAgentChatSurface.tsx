import { AgentChatSurface } from "@/components/agents/chat/AgentChatSurface";
import type { IDockviewPanelProps } from "dockview-react";
import { AgentPendingRequestCard } from "@/components/agents/chat/AgentPendingRequestCard";
import type { ChatTurnFailureRecovery } from "@/components/agents/chat/ChatComposer";
import { useApprovedPlanPermissionSelection } from "@/components/agents/chat/useApprovedPlanPermissionSelection";
import { useChatContentTypography } from "@/components/agents/chat/useChatContentTypography";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";

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
}) {
	const typography = useChatContentTypography();
	useApprovedPlanPermissionSelection(session, launchSelection);
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
