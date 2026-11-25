import type {
	AgentTimelinePageV1,
	AgentTimelineRowV1,
} from "@/lib/agents/chat/agentConversationContract";
import { nativeAgentChatPage } from "@/lib/agents/chat/nativeAgentChat";
import type { ProviderConversationActivity } from "@/lib/ipc/conversations";
import { nativeTranscriptProvider } from "../../../../cli/lib/agent-transcript.mjs";

/** The older pages of one provider transcript a view loaded on request, above
 * the history it already shows. The one paging owner for every surface that
 * shows a provider transcript: the conversation view of a terminal Agent,
 * above its newest read, and Chat, above the history its timeline seeded.
 *
 * The provider transcript reader answers whole records and names where older
 * records begin (`olderCursor`); a page read `before` that cursor ends exactly
 * where the newer one starts. Pages never overlap, so joining them needs no
 * matching of messages, only that each answer is the one that was asked for. */
export interface ProviderHistoryPages {
	/** Where the shown history starts: the cursor the first older page reads
	 * before. A view that starts somewhere else starts new pages. */
	readonly anchor: number;
	/** Oldest first. */
	readonly pages: readonly ProviderConversationActivity[];
	/** The cursor the next older page reads before; null once the
	 * transcript's start is reached. */
	readonly before: number | null;
}

/** The boundaries the Chat runtime seeds where the transcript goes on before
 * its history: before the newest window of a longer history, or at the
 * provider's compaction, whose summary stands in for the records before it.
 * Each names the transcript offset of the oldest record the history shows. */
const PLACED_HISTORY_BOUNDARIES: ReadonlySet<string> = new Set([
	"provider_transcript_window",
	"provider_conversation_compacted",
]);

function seededBoundaryCursor(row: AgentTimelineRowV1): number | undefined {
	const body = row.item.body;
	return body.type === "history_boundary" &&
		PLACED_HISTORY_BOUNDARIES.has(body.reason) &&
		validCursor(body.droppedThroughProviderSequence)
		? body.droppedThroughProviderSequence
		: undefined;
}

/** The transcript cursor where a seeded Chat timeline's history starts, once
 * the store has no older rows left to page. */
export function seededProviderHistoryCursor(
	page: AgentTimelinePageV1,
): number | undefined {
	if (page.hasMore) return undefined;
	for (const row of page.rows) {
		const cursor = seededBoundaryCursor(row);
		if (cursor !== undefined) return cursor;
	}
	return undefined;
}

/** A seeded Chat timeline with the older provider history loaded above it.
 * The seeded boundary gives way to the loaded rows and, while older records
 * remain, to the timeline's own "load older"; a view that cannot read the
 * transcript passes no pages and keeps the boundary. */
export function chatPageWithOlderProviderHistory(
	page: AgentTimelinePageV1,
	older: ProviderHistoryPages,
): AgentTimelinePageV1 {
	const provider = page.binding.providerId;
	const conversationId = page.binding.providerConversationRef;
	const at = page.hasMore
		? -1
		: page.rows.findIndex((row) => seededBoundaryCursor(row) === older.anchor);
	if (at === -1 || !conversationId || !nativeTranscriptProvider(provider)) {
		return page;
	}
	const newest = older.pages[older.pages.length - 1];
	const loaded = newest
		? nativeAgentChatPage({
				source: {
					kind: "local",
					agentId: page.binding.agentId,
					provider,
					conversationId,
				},
				transcript: newest,
				older: older.pages.slice(0, -1),
				canLoadOlder: true,
				terminalEpoch: page.binding.runtime.runtimeGeneration,
				working: false,
			}).rows
		: [];
	return {
		...page,
		rows: [...page.rows.slice(0, at), ...loaded, ...page.rows.slice(at + 1)],
		hasMore: older.before !== null,
	};
}

export function providerHistoryPages(anchor: number): ProviderHistoryPages {
	if (!validCursor(anchor)) throw new Error("provider_history_cursor_invalid");
	return { anchor, pages: [], before: anchor };
}

/** Adds the page read `before`. An answer to any other request (a repeat, or
 * one that arrives after the view moved on) changes nothing, so a page is
 * never shown twice. A page must move back, or paging could never end. */
export function withOlderProviderPage(
	state: ProviderHistoryPages,
	before: number,
	page: ProviderConversationActivity,
): ProviderHistoryPages {
	if (state.before !== before) return state;
	const older = page.olderCursor;
	if (older !== undefined && !(validCursor(older) && older < before)) {
		throw new Error("provider_history_cursor_invalid");
	}
	return {
		anchor: state.anchor,
		pages: [page, ...state.pages],
		before: older ?? null,
	};
}

function validCursor(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
