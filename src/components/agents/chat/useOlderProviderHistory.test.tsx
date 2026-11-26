// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOlderProviderHistory } from "@/components/agents/chat/useOlderProviderHistory";
import type { ProviderConversationActivity } from "@/lib/ipc/conversations";

function page(
	text: string,
	olderCursor?: number,
): ProviderConversationActivity {
	return {
		schemaVersion: 1,
		provider: "claude",
		conversationId: "conversation-one",
		historyComplete: olderCursor === undefined,
		finalResponse: null,
		entries: [{ role: "user", text }],
		...(olderCursor === undefined ? {} : { olderCursor }),
	};
}

const source = { provider: "claude", conversationId: "conversation-one" };

describe("older provider history", () => {
	it("loads older pages on request until the transcript's start", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce(page("two", 400))
			.mockResolvedValueOnce(page("one"));
		const { result } = renderHook(() =>
			useOlderProviderHistory(source, 900, read),
		);
		expect(result.current.pages).toEqual({
			anchor: 900,
			pages: [],
			before: 900,
		});

		await act(() => result.current.loadOlder());
		await act(() => result.current.loadOlder());
		// Nothing older is left to ask for.
		await act(() => result.current.loadOlder());

		expect(read.mock.calls).toEqual([[900], [400]]);
		expect(
			result.current.pages?.pages.map((loaded) => loaded.entries[0]?.text),
		).toEqual(["one", "two"]);
		expect(result.current.pages?.before).toBeNull();
	});

	it("starts again from a new anchor and drops an answer for the old one", async () => {
		let answer: (value: ProviderConversationActivity) => void = () => {};
		const read = vi.fn(
			() =>
				new Promise<ProviderConversationActivity>((resolve) => {
					answer = resolve;
				}),
		);
		const { result, rerender } = renderHook(
			({ anchor }) => useOlderProviderHistory(source, anchor, read),
			{ initialProps: { anchor: 900 } },
		);
		let loading: Promise<void> = Promise.resolve();
		act(() => {
			loading = result.current.loadOlder();
		});
		expect(result.current.loading).toBe(true);

		rerender({ anchor: 1_500 });
		await act(async () => {
			answer(page("for the old anchor", 400));
			await loading;
		});

		expect(result.current.pages).toEqual({
			anchor: 1_500,
			pages: [],
			before: 1_500,
		});
		expect(result.current.loading).toBe(false);
	});

	it("reports a failed read and lets it be tried again", async () => {
		const read = vi
			.fn()
			.mockRejectedValueOnce(new Error("provider transcript changed"))
			.mockResolvedValueOnce(page("two"));
		const { result } = renderHook(() =>
			useOlderProviderHistory(source, 900, read),
		);

		await act(() => result.current.loadOlder());
		expect(result.current.failed).toBe(true);
		expect(result.current.pages?.pages).toEqual([]);

		await act(() => result.current.loadOlder());
		expect(result.current.failed).toBe(false);
		expect(result.current.pages?.before).toBeNull();
	});

	it("never shows another conversation's page", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce({ ...page("other"), conversationId: "other" })
			.mockResolvedValueOnce({ ...page("codex"), provider: "codex" });
		const { result } = renderHook(() =>
			useOlderProviderHistory(source, 900, read),
		);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			await act(() => result.current.loadOlder());
			expect(result.current.failed).toBe(true);
			expect(result.current.pages?.pages).toEqual([]);
		}
	});

	it("stops asking a reader that cannot read older history", async () => {
		const read = vi.fn().mockResolvedValue(null);
		const { result } = renderHook(() =>
			useOlderProviderHistory(source, 900, read),
		);

		await act(() => result.current.loadOlder());
		await act(() => result.current.loadOlder());

		expect(read.mock.calls).toEqual([[900]]);
		expect(result.current.unavailable).toBe(true);
		expect(result.current.failed).toBe(false);
		expect(result.current.loading).toBe(false);
		expect(result.current.pages?.pages).toEqual([]);
	});

	it("has nothing to load without an anchor", async () => {
		const read = vi.fn();
		const { result } = renderHook(() =>
			useOlderProviderHistory(source, undefined, read),
		);
		await act(() => result.current.loadOlder());
		expect(result.current.pages).toBeUndefined();
		expect(read).not.toHaveBeenCalled();
	});
});
