import type {
	AgentTimelinePageV1,
	AgentTimelineRowV1,
} from "@/lib/agents/chat/agentConversationContract";
import { nativeAgentChatPage } from "@/lib/agents/chat/nativeAgentChat";
import type { ProviderConversationActivity } from "@/lib/ipc/conversations";
import {
	type NativeAgentTranscriptSource,
	nativeTranscriptProvider,
} from "../../../../cli/lib/agent-transcript.mjs";

/** The pages of one provider transcript a view loaded on request, next to
 * the history it already shows. The one paging owner for every surface that
 * shows a provider transcript: the conversation view of a terminal Agent,
 * above its newest read, and Chat, above the history its timeline seeded and
 * into each gap its timeline skips.
 *
 * The provider transcript reader answers whole records and names where older
 * records begin (`olderCursor`); a page read `before` that cursor ends exactly
 * where the newer one starts, and no page reads before the `floor`. Pages
 * never overlap, so joining them needs no matching of messages, only that
 * each answer is the one that was asked for. */
export interface ProviderHistoryPages {
	/** Where the shown history starts: the cursor the first older page reads
	 * before. A view that starts somewhere else starts new pages. */
	readonly anchor: number;
	/** Where the history to page in starts: the transcript's start, or where
	 * the rows above a gap end. */
	readonly floor: number;
	/** Oldest first. */
	readonly pages: readonly ProviderConversationActivity[];
	/** The cursor the next older page reads before; null once the floor is
	 * reached. */
	readonly before: number | null;
}

/** A place in a Chat timeline that provider history the timeline leaves out
 * pages into, at a history boundary placed in the provider's transcript. */
export interface ProviderHistoryAnchor {
	/** Where the seeded history starts (`opening`), or a gap between rows the
	 * timeline held and the history it continued with (`gap`). */
	readonly kind: "opening" | "gap";
	/** The boundary row, where the loaded history joins the timeline. */
	readonly itemId: string;
	/** Where the history after the boundary starts in the transcript. */
	readonly before: number;
	/** Where the history before the boundary ends: 0 at the transcript's
	 * start. */
	readonly after: number;
}

/** The boundaries the Chat runtime seeds where the transcript goes on before
 * its history: before the newest window of a longer history, or at the
 * provider's compaction, whose summary stands in for the records before it.
 * Each names the transcript offset of the oldest record the history shows. */
const OPENING_HISTORY_BOUNDARIES: ReadonlySet<string> = new Set([
	"provider_transcript_window",
	"provider_conversation_compacted",
]);

/** The boundary a continued Chat timeline places between the rows it held
 * and the history it continued with: where the held rows' records end, and
 * where the continued history's start. */
const GAP_HISTORY_BOUNDARY = "provider_transcript_gap";

/** A row that shows none of the conversation, as rows before a seeded
 * history can be. */
function showsNoConversation(row: AgentTimelineRowV1): boolean {
	const type = row.item.body.type;
	return type === "provider_evidence" || type === "lifecycle";
}

/** Where provider history pages into a Chat timeline: where its seeded
 * history starts, once the store has no older rows, and each placed gap. A
 * window or compaction boundary after rows that show the conversation is no
 * start: paging back from it would show those rows again. */
export function providerHistoryAnchors(
	page: AgentTimelinePageV1,
): ProviderHistoryAnchor[] {
	const anchors: ProviderHistoryAnchor[] = [];
	page.rows.forEach((row, index) => {
		const body = row.item.body;
		if (body.type !== "history_boundary") return;
		const before = body.droppedThroughProviderSequence;
		if (body.reason === GAP_HISTORY_BOUNDARY) {
			const after = body.requestedAfterProviderSequence;
			if (validCursor(before) && validCursor(after) && after < before) {
				anchors.push({ kind: "gap", itemId: row.item.itemId, before, after });
			}
			return;
		}
		if (
			!page.hasMore &&
			OPENING_HISTORY_BOUNDARIES.has(body.reason) &&
			validCursor(before) &&
			page.rows.slice(0, index).every(showsNoConversation)
		) {
			anchors.push({
				kind: "opening",
				itemId: row.item.itemId,
				before,
				after: 0,
			});
		}
	});
	return anchors;
}

/** A Chat timeline with the provider history loaded at its anchors. Where its
 * seeded history starts, the boundary gives way to the loaded rows and, while
 * older records remain, to the timeline's own "load older". A gap keeps its
 * row above the loaded rows until they reach the rows above it. A view that
 * cannot read the transcript passes no pages and keeps the boundaries. */
export function chatPageWithProviderHistory(
	page: AgentTimelinePageV1,
	loaded: ReadonlyMap<string, ProviderHistoryPages>,
): AgentTimelinePageV1 {
	const provider = page.binding.providerId;
	const conversationId = page.binding.providerConversationRef;
	if (!conversationId || !nativeTranscriptProvider(provider)) return page;
	let hasMore = page.hasMore;
	let changed = false;
	const anchors = new Map(
		providerHistoryAnchors(page).map((anchor) => [anchor.itemId, anchor]),
	);
	const rows = page.rows.flatMap((row) => {
		const anchor = anchors.get(row.item.itemId);
		const pages = anchor && loaded.get(anchor.itemId);
		if (
			!anchor ||
			!pages ||
			pages.anchor !== anchor.before ||
			pages.floor !== anchor.after
		) {
			return [row];
		}
		changed = true;
		const history = loadedRows(
			page,
			{
				kind: "local",
				agentId: page.binding.agentId,
				provider,
				conversationId,
			},
			anchor,
			pages,
		);
		if (anchor.kind === "opening") {
			hasMore = pages.before !== null;
			return history;
		}
		return pages.before === null ? history : [row, ...history];
	});
	return changed ? { ...page, rows, hasMore } : page;
}

/** The rows of an anchor's loaded pages. A gap's rows are named after its
 * boundary, so they never share a turn, an item or a place in the timeline
 * with another anchor's. */
function loadedRows(
	page: AgentTimelinePageV1,
	source: NativeAgentTranscriptSource,
	anchor: ProviderHistoryAnchor,
	pages: ProviderHistoryPages,
): AgentTimelineRowV1[] {
	const newest = pages.pages[pages.pages.length - 1];
	if (!newest) return [];
	const rows = nativeAgentChatPage({
		source,
		transcript: newest,
		older: pages.pages.slice(0, -1),
		canLoadOlder: true,
		terminalEpoch: page.binding.runtime.runtimeGeneration,
		working: false,
	}).rows;
	if (anchor.kind === "opening") return rows;
	const named = (id: string | null) => id && `${anchor.itemId}:${id}`;
	return rows.map((row) => ({
		cursor: { ...row.cursor, epoch: `${anchor.itemId}:${row.cursor.epoch}` },
		item: {
			...row.item,
			itemId: `${anchor.itemId}:${row.item.itemId}`,
			turnId: named(row.item.turnId),
			clientMessageId: named(row.item.clientMessageId),
		},
	}));
}

export function providerHistoryPages(
	anchor: number,
	floor = 0,
): ProviderHistoryPages {
	if (!validCursor(anchor) || !validCursor(floor) || floor > anchor) {
		throw new Error("provider_history_cursor_invalid");
	}
	return { anchor, floor, pages: [], before: floor < anchor ? anchor : null };
}

/** Adds the page read `before`. An answer to any other request (a repeat, or
 * one that arrives after the view moved on) changes nothing, so a page is
 * never shown twice. A page must move back, and never past the floor, or
 * paging could never end or would show what the view already holds. */
export function withOlderProviderPage(
	state: ProviderHistoryPages,
	before: number,
	page: ProviderConversationActivity,
): ProviderHistoryPages {
	if (state.before !== before) return state;
	const older = page.olderCursor;
	if (
		older !== undefined &&
		!(validCursor(older) && older < before && older > state.floor)
	) {
		throw new Error("provider_history_cursor_invalid");
	}
	return {
		...state,
		pages: [page, ...state.pages],
		before: older ?? null,
	};
}

function validCursor(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
