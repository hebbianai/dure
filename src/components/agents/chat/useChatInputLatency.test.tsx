// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatInputLatency } from "@/components/agents/chat/useChatInputLatency";
import { chatInputLatency } from "@/lib/agents/chat/chatInputLatency";

const postPaint = vi.hoisted(() => ({
	callback: null as (() => void) | null,
	onFrame: null as (() => void) | null,
	cancel: vi.fn(),
}));

vi.mock("@/lib/scheduling/postPaint", () => ({
	schedulePostPaint: vi.fn(
		(
			_host: Window,
			callback: () => void,
			options?: { onFrame?: () => void },
		) => {
			postPaint.callback = callback;
			postPaint.onFrame = options?.onFrame ?? null;
			return postPaint.cancel;
		},
	),
}));

afterEach(() => {
	cleanup();
	chatInputLatency.resetMeasurements();
	postPaint.callback = null;
	postPaint.onFrame = null;
	postPaint.cancel.mockReset();
	vi.restoreAllMocks();
});

describe("useChatInputLatency", () => {
	it("joins one draft change to its commit, frame, and post-paint task", () => {
		let now = 10;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const view = renderHook(
			({ draft }: { draft: string }) => useChatInputLatency(draft),
			{ initialProps: { draft: "" } },
		);

		act(() => view.result.current());
		now = 13;
		view.rerender({ draft: "a" });
		now = 19;
		act(() => postPaint.onFrame?.());
		now = 31;
		act(() => postPaint.callback?.());

		expect(chatInputLatency.snapshot()).toMatchObject({
			inFlightCount: 0,
			samples: [
				{
					commitMs: 3,
					commitToFrameMs: 6,
					frameToPostPaintMs: 12,
					commitToPaintMs: 18,
					paintMs: 21,
					outcome: "complete",
				},
			],
		});
	});
});
