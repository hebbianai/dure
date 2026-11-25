import { describe, expect, it } from "vitest";
import { projectAgentChatTranscript } from "@/lib/agents/chat/agentChatProjection";
import type {
	AgentTimelinePageV1,
	AgentTimelineRowV1,
} from "@/lib/agents/chat/agentConversationContract";
import {
	chatPageWithOlderProviderHistory,
	providerHistoryPages,
	seededProviderHistoryCursor,
	withOlderProviderPage,
} from "@/lib/agents/chat/providerHistoryPages";
import type { ProviderConversationActivity } from "@/lib/ipc/conversations";

function read(
	texts: string[],
	olderCursor?: number,
	tools?: unknown,
): ProviderConversationActivity {
	return {
		schemaVersion: 1,
		provider: "claude",
		conversationId: "conversation-one",
		historyComplete: olderCursor === undefined,
		finalResponse: null,
		entries: texts.map((text) => ({
			role: text.startsWith("ask") ? "user" : "agent",
			text,
		})),
		...(tools === undefined ? {} : { tools }),
		...(olderCursor === undefined ? {} : { olderCursor }),
	};
}

const EPOCH = "timeline-one";

function storeRow(
	sequence: number,
	body: AgentTimelineRowV1["item"]["body"],
): AgentTimelineRowV1 {
	return {
		cursor: { epoch: EPOCH, sequence },
		item: {
			itemId: `store-${sequence}`,
			turnId: null,
			clientMessageId: null,
			providerMessageId: null,
			body,
			createdAtMs: 0,
		},
	};
}

/** A Chat timeline the runtime seeded with the newest window of a longer
 * history: hidden session row, boundary, then the window's messages. */
function seededPage(
	overrides: Partial<AgentTimelinePageV1> = {},
	reason = "provider_transcript_window",
): AgentTimelinePageV1 {
	const rows = [
		storeRow(1, { type: "lifecycle", state: "session_ready", detail: null }),
		storeRow(2, {
			type: "history_boundary",
			reason,
			requestedAfterProviderSequence: 0,
			droppedThroughProviderSequence: 900,
		}),
		storeRow(3, { type: "message", role: "user", markdown: "ask seeded" }),
		storeRow(4, {
			type: "message",
			role: "assistant",
			markdown: "seeded answer",
		}),
	];
	return {
		binding: {
			schemaVersion: 1,
			interactionSessionId: "interaction-one",
			agentId: "agent-one",
			providerId: "claude",
			executionProfile: { kind: "provider_default" },
			providerConversationRef: "conversation-one",
			runtime: { runtimeGeneration: "runtime-one", providerEpoch: "epoch-one" },
			timelineEpoch: EPOCH,
			bindingRevision: 1,
			historyComplete: false,
			createdAtMs: 0,
			updatedAtMs: 0,
		},
		rows,
		liveText: [],
		pendingRequests: [],
		activeTurn: null,
		latestFailure: null,
		recovery: null,
		goal: null,
		finalCursor: { epoch: EPOCH, sequence: rows.length },
		hasMore: false,
		...overrides,
	};
}

function messages(page: AgentTimelinePageV1): string[] {
	return page.rows.flatMap((row) =>
		row.item.body.type === "message" ? [row.item.body.markdown] : [],
	);
}

describe("provider history pages", () => {
	it("pages back from the anchor until the transcript's start", () => {
		const start = providerHistoryPages(900);
		expect(start).toEqual({ anchor: 900, pages: [], before: 900 });
		const newer = read(["ask two", "two"], 400);
		const first = withOlderProviderPage(start, 900, newer);
		expect(first.before).toBe(400);
		const oldest = read(["ask one", "one"]);
		const second = withOlderProviderPage(first, 400, oldest);
		expect(second.pages).toEqual([oldest, newer]);
		expect(second.before).toBeNull();
	});

	it("never adds a page twice or an answer to a request it did not make", () => {
		const start = providerHistoryPages(900);
		const loaded = withOlderProviderPage(start, 900, read(["ask two"], 400));
		// The same answer again, and one for an earlier cursor, change nothing.
		expect(withOlderProviderPage(loaded, 900, read(["ask two"], 400))).toBe(
			loaded,
		);
		const reached = withOlderProviderPage(loaded, 400, read(["ask one"]));
		expect(withOlderProviderPage(reached, 400, read(["ask one"]))).toBe(
			reached,
		);
	});

	it("refuses a page that does not move back", () => {
		const start = providerHistoryPages(900);
		expect(() => withOlderProviderPage(start, 900, read(["x"], 900))).toThrow(
			"provider_history_cursor_invalid",
		);
		expect(() => withOlderProviderPage(start, 900, read(["x"], -1))).toThrow(
			"provider_history_cursor_invalid",
		);
	});
});

describe("Chat history older than its seeded window", () => {
	it("starts from the seeded boundary once the store has no older rows", () => {
		expect(seededProviderHistoryCursor(seededPage())).toBe(900);
		expect(
			seededProviderHistoryCursor(seededPage({ hasMore: true })),
		).toBeUndefined();
		// A boundary that does not place its window cannot be paged.
		expect(
			seededProviderHistoryCursor(seededPage({}, "provider_history_truncated")),
		).toBeUndefined();
	});

	it("offers older history in place of the unavailable notice", () => {
		const page = chatPageWithOlderProviderHistory(
			seededPage(),
			providerHistoryPages(900),
		);
		expect(page.hasMore).toBe(true);
		expect(
			page.rows.some((row) => row.item.body.type === "history_boundary"),
		).toBe(false);
		expect(messages(page)).toEqual(["ask seeded", "seeded answer"]);
	});

	it("shows loaded pages once, oldest first, where the boundary was", () => {
		let pages = providerHistoryPages(900);
		pages = withOlderProviderPage(pages, 900, read(["ask two", "two"], 400));
		pages = withOlderProviderPage(pages, 400, read(["ask one", "one"]));
		const page = chatPageWithOlderProviderHistory(seededPage(), pages);
		expect(page.hasMore).toBe(false);
		expect(page.rows[0]?.item.body.type).toBe("lifecycle");
		expect(messages(page)).toEqual([
			"ask one",
			"one",
			"ask two",
			"two",
			"ask seeded",
			"seeded answer",
		]);
		// Loaded pages read as turns; the seeded rows after them stay as the
		// store keeps them.
		expect(
			projectAgentChatTranscript(page.rows).map((block) => block.kind),
		).toEqual(["turn", "turn", "row", "row"]);
	});

	it("pages in the history before the provider's compaction", () => {
		// A compacted conversation seeds a complete history from the summary
		// the provider resumes from; the turns before it stay in the transcript.
		const compacted = seededPage(
			{ binding: { ...seededPage().binding, historyComplete: true } },
			"provider_conversation_compacted",
		);
		expect(seededProviderHistoryCursor(compacted)).toBe(900);
		const pages = withOlderProviderPage(
			providerHistoryPages(900),
			900,
			read(["ask before compaction", "before compaction"]),
		);
		const page = chatPageWithOlderProviderHistory(compacted, pages);
		expect(page.hasMore).toBe(false);
		expect(messages(page)).toEqual([
			"ask before compaction",
			"before compaction",
			"ask seeded",
			"seeded answer",
		]);
	});

	it("keeps the boundary where the pages do not belong to it", () => {
		const unplaced = seededPage({}, "provider_history_truncated");
		expect(
			chatPageWithOlderProviderHistory(unplaced, providerHistoryPages(900)),
		).toBe(unplaced);
		const other = seededPage();
		expect(
			chatPageWithOlderProviderHistory(other, providerHistoryPages(800)),
		).toBe(other);
	});
});
