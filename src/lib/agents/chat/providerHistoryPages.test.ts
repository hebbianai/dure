import { describe, expect, it } from "vitest";
import { projectAgentChatTranscript } from "@/lib/agents/chat/agentChatProjection";
import type {
	AgentTimelinePageV1,
	AgentTimelineRowV1,
} from "@/lib/agents/chat/agentConversationContract";
import {
	chatPageWithProviderHistory,
	type ProviderHistoryPages,
	providerHistoryAnchors,
	providerHistoryPages,
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

/** Where the seeded history starts, if it pages from there. */
function seededProviderHistoryCursor(
	page: AgentTimelinePageV1,
): number | undefined {
	return providerHistoryAnchors(page).find(
		(anchor) => anchor.kind === "opening",
	)?.before;
}

/** The page with `pages` loaded where its seeded history starts. */
function chatPageWithOlderProviderHistory(
	page: AgentTimelinePageV1,
	pages: ProviderHistoryPages,
): AgentTimelinePageV1 {
	return chatPageWithProviderHistory(page, new Map([["store-2", pages]]));
}

function messages(page: AgentTimelinePageV1): string[] {
	return page.rows.flatMap((row) =>
		row.item.body.type === "message" ? [row.item.body.markdown] : [],
	);
}

describe("provider history pages", () => {
	it("pages back from the anchor until the transcript's start", () => {
		const start = providerHistoryPages(900);
		expect(start).toEqual({ anchor: 900, floor: 0, pages: [], before: 900 });
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

	it("pages a Codex window back from its oldest turn in the rollout", () => {
		const base = seededPage();
		const codex = seededPage({
			binding: { ...base.binding, providerId: "codex" },
		});
		expect(seededProviderHistoryCursor(codex)).toBe(900);
		const pages = withOlderProviderPage(providerHistoryPages(900), 900, {
			...read(["ask before the window", "before the window"]),
			provider: "codex",
		});
		const page = chatPageWithOlderProviderHistory(codex, pages);
		expect(page.hasMore).toBe(false);
		expect(messages(page)).toEqual([
			"ask before the window",
			"before the window",
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

/** A Chat timeline continued after a Terminal session longer than one window:
 * the first Chat session's rows, the boundary where the continued history
 * skips the Terminal turns between, then the newest window. */
function continuedPage(
	boundary: AgentTimelineRowV1["item"]["body"],
	overrides: Partial<AgentTimelinePageV1> = {},
): AgentTimelinePageV1 {
	const rows = [
		storeRow(1, { type: "message", role: "user", markdown: "ask in chat" }),
		storeRow(2, {
			type: "message",
			role: "assistant",
			markdown: "chat answer",
		}),
		storeRow(3, boundary),
		storeRow(4, { type: "message", role: "user", markdown: "ask newest" }),
		storeRow(5, {
			type: "message",
			role: "assistant",
			markdown: "newest answer",
		}),
	];
	return seededPage({
		rows,
		finalCursor: { epoch: EPOCH, sequence: rows.length },
		...overrides,
	});
}

const GAP = {
	type: "history_boundary",
	reason: "provider_transcript_gap",
	requestedAfterProviderSequence: 400,
	droppedThroughProviderSequence: 900,
} as const;

describe("Chat history a continued timeline skips", () => {
	it("never pages a window boundary back over the rows before it", () => {
		// A window that follows rows the timeline held is no start of its
		// history: the records before it include those rows.
		for (const reason of [
			"provider_transcript_window",
			"provider_conversation_compacted",
		]) {
			const page = continuedPage({
				type: "history_boundary",
				reason,
				requestedAfterProviderSequence: 0,
				droppedThroughProviderSequence: 900,
			});
			expect(providerHistoryAnchors(page)).toEqual([]);
			expect(
				chatPageWithProviderHistory(
					page,
					new Map([["store-3", providerHistoryPages(900)]]),
				),
			).toBe(page);
		}
	});

	it("pages a placed gap between its ends, even with older store rows", () => {
		const page = continuedPage(GAP, { hasMore: true });
		expect(providerHistoryAnchors(page)).toEqual([
			{ kind: "gap", itemId: "store-3", before: 900, after: 400 },
		]);
		const unplaced = continuedPage({
			...GAP,
			reason: "provider_history_truncated",
			requestedAfterProviderSequence: 0,
			droppedThroughProviderSequence: 1,
		});
		expect(providerHistoryAnchors(unplaced)).toEqual([]);
	});

	it("loads the skipped turns below the gap until it closes, each once", () => {
		const page = continuedPage(GAP, { hasMore: true });
		let pages = providerHistoryPages(900, 400);
		const open = chatPageWithProviderHistory(
			page,
			new Map([["store-3", pages]]),
		);
		// Before anything loads, the gap offers its history where it is.
		expect(open.rows.map((row) => row.item.itemId)).toEqual(
			page.rows.map((row) => row.item.itemId),
		);

		pages = withOlderProviderPage(
			pages,
			900,
			read(["ask terminal two", "terminal two"], 650),
		);
		const partly = chatPageWithProviderHistory(
			page,
			new Map([["store-3", pages]]),
		);
		expect(partly.rows.map((row) => row.item.body.type)).toContain(
			"history_boundary",
		);
		expect(messages(partly)).toEqual([
			"ask in chat",
			"chat answer",
			"ask terminal two",
			"terminal two",
			"ask newest",
			"newest answer",
		]);

		pages = withOlderProviderPage(
			pages,
			650,
			read(["ask terminal one", "terminal one"]),
		);
		const closed = chatPageWithProviderHistory(
			page,
			new Map([["store-3", pages]]),
		);
		expect(
			closed.rows.some((row) => row.item.body.type === "history_boundary"),
		).toBe(false);
		expect(messages(closed)).toEqual([
			"ask in chat",
			"chat answer",
			"ask terminal one",
			"terminal one",
			"ask terminal two",
			"terminal two",
			"ask newest",
			"newest answer",
		]);
		// The store's own older rows still load from the top.
		expect(closed.hasMore).toBe(true);
		const ids = closed.rows.map((row) => row.item.itemId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("keeps a gap's rows apart from the history loaded above the timeline", () => {
		const seeded = seededPage();
		const rows = [
			...seeded.rows,
			storeRow(5, GAP),
			storeRow(6, { type: "message", role: "user", markdown: "ask newest" }),
		];
		const page = { ...seeded, rows };
		expect(providerHistoryAnchors(page).map((anchor) => anchor.kind)).toEqual([
			"opening",
			"gap",
		]);
		const loaded = new Map([
			[
				"store-2",
				withOlderProviderPage(
					providerHistoryPages(900),
					900,
					read(["ask oldest", "oldest"]),
				),
			],
			[
				"store-5",
				withOlderProviderPage(
					providerHistoryPages(900, 400),
					900,
					read(["ask between", "between"]),
				),
			],
		]);
		const joined = chatPageWithProviderHistory(page, loaded);
		expect(messages(joined)).toEqual([
			"ask oldest",
			"oldest",
			"ask seeded",
			"seeded answer",
			"ask between",
			"between",
			"ask newest",
		]);
		const ids = joined.rows.map((row) => row.item.itemId);
		expect(new Set(ids).size).toBe(ids.length);
		// Rows are keyed by their place in the timeline, too.
		const places = joined.rows.map(
			(row) => `${row.cursor.epoch}:${row.cursor.sequence}`,
		);
		expect(new Set(places).size).toBe(places.length);
		const turns = projectAgentChatTranscript(joined.rows).filter(
			(block) => block.kind === "turn",
		);
		expect(turns).toHaveLength(2);
	});

	it("never reads past a gap's floor", () => {
		const pages = providerHistoryPages(900, 400);
		for (const older of [400, 300]) {
			expect(() =>
				withOlderProviderPage(pages, 900, read(["x"], older)),
			).toThrow("provider_history_cursor_invalid");
		}
		expect(providerHistoryPages(900, 900).before).toBeNull();
		expect(() => providerHistoryPages(400, 900)).toThrow(
			"provider_history_cursor_invalid",
		);
	});
});
