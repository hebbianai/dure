import { type ReactNode, useEffect, useRef } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { AgentGoalBar } from "@/components/agents/chat/AgentGoalBar";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import {
	ChatComposer,
	type ChatTurnFailureRecovery,
} from "@/components/agents/chat/ChatComposer";
import { PanelStatus } from "@/components/common/PanelStatus";
import { LoadingRow } from "@/components/common/StatusBlocks";
import { Button } from "@/components/ui/button";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentPendingRequestV1 } from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";

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
}) {
	const readyReported = useRef(false);
	const page = session.page;
	useEffect(() => {
		if (session.phase !== "ready" || !page || readyReported.current) return;
		readyReported.current = true;
		onReady?.();
	}, [onReady, page, session.phase]);

	if (
		!page &&
		(session.phase === "detached" || session.phase === "connecting")
	) {
		return (
			<PanelStatus role="status">{t("agents.chat.connecting")}</PanelStatus>
		);
	}
	if (!page && session.phase === "error") {
		return (
			<PanelStatus role="alert">
				<div className="flex flex-col items-center gap-3">
					<span>{session.error ?? t("agents.chat.loadFailed")}</span>
					<div className="flex flex-wrap items-center justify-center gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={session.retryConnection}
						>
							{t("common.retry")}
						</Button>
					</div>
				</div>
			</PanelStatus>
		);
	}
	if (!page) {
		return (
			<PanelStatus role="alert">{t("agents.chat.loadFailed")}</PanelStatus>
		);
	}
	const shimmerOwner = launchSelection?.switching
		? "composer"
		: session.phase === "ready" && !session.reconnecting && session.activeTurn
			? "transcript"
			: null;

	return (
		<div
			// No surface of its own: the pane group paints glass/pane with the user's
			// surface alpha, and a second copy here compounded into a solid slab
			// (owner report 2026-09-09).
			className="@container/chat flex h-full min-h-0 flex-col"
			style={
				typography && {
					fontSize: typography.fontSize,
					lineHeight: typography.lineHeight,
					backgroundColor: typography.background,
				}
			}
		>
			{session.reconnecting && (
				<LoadingRow className="border-b border-glass-hairline px-3 py-1.5">
					{t("agents.chat.reconnecting")}
				</LoadingRow>
			)}
			<TranscriptContents
				page={page}
				active={Boolean(session.activeTurn)}
				shimmerTurn={
					shimmerOwner === "transcript" ? session.activeTurn : undefined
				}
				loadingOlder={session.loadingOlder}
				olderHistoryError={session.olderHistoryError}
				onLoadOlder={session.loadOlder}
				renderPending={renderPending}
			/>
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
				shimmer={shimmerOwner === "composer"}
				recovery={recovery}
			/>
		</div>
	);
}
