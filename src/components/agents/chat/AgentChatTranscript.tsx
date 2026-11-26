import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import {
	type ProviderHistoryGaps,
	ProviderHistoryGapContext,
} from "@/components/agents/chat/ProviderHistoryGapContext";
import {
	type ProviderHistoryPagesState,
	useProviderHistoryPages,
} from "@/components/agents/chat/useOlderProviderHistory";
import { PanelStatus } from "@/components/common/PanelStatus";
import { LoadingRow } from "@/components/common/StatusBlocks";
import { Button } from "@/components/ui/button";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentPendingRequestV1 } from "@/lib/agents/chat/agentConversationContract";
import {
	chatPageWithProviderHistory,
	type ProviderHistoryPages,
	providerHistoryAnchors,
} from "@/lib/agents/chat/providerHistoryPages";
import { t } from "@/lib/i18n";

/** A Chat Agent's committed conversation, with the provider history older
 * than the seeded window and the gaps between its rows loading on request.
 * What follows the conversation is the caller's: the pane and its large
 * window put the team line, goal and composer below it as `children`; the
 * Work view shows it read-only, with nothing below. */
export function AgentChatTranscript({
	session,
	typography,
	renderPending,
	onReady,
	shimmer = true,
	children,
}: {
	session: AgentChatSessionView;
	/** Base font size (px), unitless line-height, and background; the
	 * transcript and what follows it scale via em-relative type and
	 * inheritance. */
	typography?: { fontSize: number; lineHeight: number; background?: string };
	renderPending?: (request: AgentPendingRequestV1) => ReactNode;
	onReady?: () => void;
	/** Whether the active turn's line may shimmer here. One line shimmers per
	 * pane: while the composer owns it (a launch switch), this is false. */
	shimmer?: boolean;
	children?: ReactNode;
}) {
	const readyReported = useRef(false);
	const storePage = session.page;
	const anchors = useMemo(
		() => (storePage ? providerHistoryAnchors(storePage) : []),
		[storePage],
	);
	const conversationRef = storePage?.binding.providerConversationRef;
	// History older than the seeded window, and the history a gap between
	// the timeline's rows leaves out, load on request through the backend
	// that owns the session, which holds the provider transcript.
	const history = useProviderHistoryPages(
		storePage && conversationRef
			? {
					provider: storePage.binding.providerId,
					conversationId: conversationRef,
				}
			: undefined,
		anchors,
		session.readProviderHistory,
	);
	const opening = anchors.find((anchor) => anchor.kind === "opening");
	const older: ProviderHistoryPagesState | undefined =
		opening && history.states.get(opening.itemId);
	const openingItemId = opening?.itemId;
	const loadOlderHistory = useCallback(
		() =>
			openingItemId === undefined
				? Promise.resolve()
				: history.load(openingItemId),
		[openingItemId, history.load],
	);
	const gaps = useMemo<ProviderHistoryGaps>(
		() => ({
			states: new Map(
				anchors.flatMap((anchor) => {
					const state = history.states.get(anchor.itemId);
					return anchor.kind === "gap" && state
						? [[anchor.itemId, state] as const]
						: [];
				}),
			),
			load: history.load,
		}),
		[anchors, history.states, history.load],
	);
	const page = useMemo(() => {
		if (!storePage) return storePage;
		// A backend that cannot read it keeps the boundary where it is.
		const loaded = new Map<string, ProviderHistoryPages>();
		for (const [itemId, state] of history.states) {
			if (!state.unavailable) loaded.set(itemId, state.pages);
		}
		return chatPageWithProviderHistory(storePage, loaded);
	}, [storePage, history.states]);
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
	const shimmerTurn =
		shimmer &&
		session.phase === "ready" &&
		!session.reconnecting &&
		session.activeTurn
			? session.activeTurn
			: undefined;

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
			<ProviderHistoryGapContext.Provider value={gaps}>
				<TranscriptContents
					page={page}
					active={Boolean(session.activeTurn)}
					shimmerTurn={shimmerTurn}
					loadingOlder={session.loadingOlder || (older?.loading ?? false)}
					olderHistoryError={
						session.olderHistoryError ??
						(older?.failed ? t("agents.chat.historyBoundary") : undefined)
					}
					// The store's own older rows come first; past them, the
					// provider transcript's.
					onLoadOlder={
						storePage?.hasMore ? session.loadOlder : loadOlderHistory
					}
					renderPending={renderPending}
				/>
			</ProviderHistoryGapContext.Provider>
			{children}
		</div>
	);
}
