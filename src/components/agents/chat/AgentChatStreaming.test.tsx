// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";

vi.mock("@/lib/ipc", () => ({ readChatAttachment: vi.fn() }));

const longAnswer = `## Live answer\n\n${"Paragraph with **Markdown**.\n\n".repeat(300)}`;
const loadOlder = async () => {};

function page(text = longAnswer): AgentTimelinePageV1 {
	return {
		binding: {
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			agentId: "agent-1",
			providerId: "codex",
			executionProfile: { kind: "provider_default" },
			providerConversationRef: null,
			runtime: { runtimeGeneration: "runtime-1", providerEpoch: "provider-1" },
			timelineEpoch: "timeline-1",
			bindingRevision: 1,
			historyComplete: true,
			createdAtMs: 1,
			updatedAtMs: 1,
		},
		rows: [],
		liveText: [
			{
				streamId: "stream-1",
				itemId: "item-1",
				kind: "assistant",
				text,
				turnId: "turn-1",
				clientMessageId: "message-1",
				providerMessageId: "provider-message-1",
				updatedAtMs: 1,
			},
		],
		pendingRequests: [],
		activeTurn: { turnId: "turn-1", clientMessageId: "message-1" },
		goal: null,
		latestFailure: null,
		finalCursor: { epoch: "timeline-1", sequence: 0 },
		hasMore: false,
	};
}

function transcript(value: AgentTimelinePageV1, active = true) {
	return (
		<TranscriptContents
			page={value}
			active={active}
			loadingOlder={false}
			onLoadOlder={loadOlder}
		/>
	);
}

describe("streaming Markdown in the transcript", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// jsdom has no layout; expose a visible viewport to the real virtualizer.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.hasAttribute("data-index") ? 32 : 600;
			},
		);
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("batches the active assistant head but flushes immediately when the turn stops", () => {
		const view = render(transcript(page()));
		view.rerender(transcript(page(`${longAnswer}Pending fragment`)));
		expect(screen.queryByText("Pending fragment")).toBeNull();
		act(() => vi.advanceTimersByTime(250));
		expect(screen.getByText("Pending fragment")).toBeTruthy();
		view.rerender(transcript(page(`${longAnswer}Stopped turn`), false));
		expect(screen.getByText("Stopped turn")).toBeTruthy();
	});

	it("discards pending presentation when canonical history replaces the live head", () => {
		const view = render(transcript(page()));
		view.rerender(transcript(page(`${longAnswer}Stale live ending`)));
		const completed = page();
		completed.activeTurn = null;
		completed.liveText = [];
		completed.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "item-1",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-message-1",
					createdAtMs: 2,
					body: {
						type: "message",
						role: "assistant",
						markdown: `${longAnswer}**Canonical final answer**`,
					},
				},
			},
		];
		completed.finalCursor = { epoch: "timeline-1", sequence: 1 };
		view.rerender(transcript(completed, false));
		expect(screen.getByText("Canonical final answer").tagName).toBe("STRONG");
		act(() => vi.advanceTimersByTime(500));
		expect(screen.queryByText("Stale live ending")).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["interaction", "timeline", "runtime", "provider", "stream"])(
		"immediately replaces a pending head when its %s identity changes",
		(identity) => {
			const view = render(transcript(page()));
			view.rerender(transcript(page(`${longAnswer}Old identity`)));
			const next = page(`${longAnswer}New identity`);
			if (identity === "interaction")
				next.binding.interactionSessionId = "interaction-2";
			if (identity === "timeline") next.binding.timelineEpoch = "timeline-2";
			if (identity === "runtime")
				next.binding.runtime.runtimeGeneration = "runtime-2";
			if (identity === "provider")
				next.binding.runtime.providerEpoch = "provider-2";
			if (identity === "stream") next.liveText[0].streamId = "stream-2";
			view.rerender(transcript(next));
			expect(screen.getByText("New identity")).toBeTruthy();
			act(() => vi.advanceTimersByTime(500));
			expect(screen.queryByText("Old identity")).toBeNull();
		},
	);
});
