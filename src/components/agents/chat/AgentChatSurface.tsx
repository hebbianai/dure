import type { ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { AgentTeamLine } from "@/components/agents/AgentTeamLine";
import { AgentChatTranscript } from "@/components/agents/chat/AgentChatTranscript";
import { AgentGoalBar } from "@/components/agents/chat/AgentGoalBar";
import {
	ChatComposer,
	type ChatTurnFailureRecovery,
} from "@/components/agents/chat/ChatComposer";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentPendingRequestV1 } from "@/lib/agents/chat/agentConversationContract";

/** A Chat Agent's conversation with its team line, goal and composer below
 * it. The conversation is the same transcript the Work view shows. */
export function AgentChatSurface({
	session,
	paneApi,
	disabled = false,
	typography,
	launchSelection,
	catalogSource,
	attachmentsEnabled,
	renderPending,
	onReady,
	recovery,
	onNewConversation,
}: {
	session: AgentChatSessionView;
	paneApi?: IDockviewPanelProps["api"];
	disabled?: boolean;
	/** Pane-controller projection; this surface never inspects or mutates a
	 * runtime independently. */
	launchSelection?: AgentRuntimeLaunchSelectionView;
	catalogSource?: ProviderCatalogSource;
	attachmentsEnabled?: boolean;
	/** Base font size (px), unitless line-height, and pane background; the
	 * whole transcript and composer scale via em-relative type and
	 * inheritance, and the surface shares the terminal palette's background
	 * so both pane kinds read as one surface. */
	typography?: { fontSize: number; lineHeight: number; background?: string };
	renderPending?: (request: AgentPendingRequestV1) => ReactNode;
	onReady?: () => void;
	/** Credential recoveries offered for a provider-reported turn failure. */
	recovery?: ChatTurnFailureRecovery;
	/** The pane's "new conversation" control, run by `/clear`. */
	onNewConversation?: () => void;
}) {
	// One line shimmers per pane: the composer's while a launch switches,
	// otherwise the active turn's.
	const switching = Boolean(launchSelection?.switching);
	return (
		<AgentChatTranscript
			session={session}
			typography={typography}
			renderPending={renderPending}
			onReady={onReady}
			shimmer={!switching}
		>
			<AgentTeamLine agentId={session.draftIdentity.agentId} />
			<AgentGoalBar
				key={`${session.draftIdentity.backendProfileId}:${session.draftIdentity.agentId}:${session.draftIdentity.interactionSessionId}`}
				session={session}
				disabled={disabled}
			/>
			<ChatComposer
				session={session}
				paneApi={paneApi}
				disabled={disabled}
				launch={launchSelection}
				catalogSource={catalogSource}
				attachmentsEnabled={attachmentsEnabled}
				shimmer={switching}
				recovery={recovery}
				onNewConversation={onNewConversation}
			/>
		</AgentChatTranscript>
	);
}
