// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	OVERFLOW_REVEAL_DELAY_MS,
	OverflowRevealText,
} from "@/components/ui/overflow-reveal-text";

function renderMeasuredText(
	text: string,
	{
		viewportWidth,
		contentWidth,
	}: { viewportWidth: number; contentWidth: number },
) {
	render(<OverflowRevealText text={text} className="flex-1" />);
	const content = screen.getByText(text);
	const viewport = content.parentElement;
	if (!viewport) throw new Error("overflow text viewport is missing");
	Object.defineProperty(viewport, "clientWidth", {
		configurable: true,
		value: viewportWidth,
	});
	Object.defineProperty(content, "scrollWidth", {
		configurable: true,
		value: contentWidth,
	});
	return { content, viewport };
}

afterEach(() => {
	cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("OverflowRevealText", () => {
	it("moves by the exact clipped distance only after the hover delay", () => {
		vi.useFakeTimers();
		const { content, viewport } = renderMeasuredText(
			"a deliberately long path",
			{
				viewportWidth: 100,
				contentWidth: 240,
			},
		);

		fireEvent.pointerEnter(viewport, { pointerType: "mouse" });
		act(() => vi.advanceTimersByTime(OVERFLOW_REVEAL_DELAY_MS - 1));
		expect(content.style.transform).toBe("");

		act(() => vi.advanceTimersByTime(1));
		expect(content.style.transform).toBe("translateX(-140px)");

		fireEvent.pointerLeave(viewport, { pointerType: "mouse" });
		expect(content.style.transform).toBe("");
	});

	it("keeps text still when it fits", () => {
		vi.useFakeTimers();
		const { content, viewport } = renderMeasuredText("short path", {
			viewportWidth: 100,
			contentWidth: 90,
		});

		fireEvent.pointerEnter(viewport, { pointerType: "mouse" });
		act(() => vi.advanceTimersByTime(OVERFLOW_REVEAL_DELAY_MS));
		expect(content.style.transform).toBe("");
	});

	it("does not move text when reduced motion is requested", () => {
		vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
		vi.useFakeTimers();
		const { content, viewport } = renderMeasuredText(
			"a deliberately long path",
			{
				viewportWidth: 100,
				contentWidth: 240,
			},
		);

		fireEvent.pointerEnter(viewport, { pointerType: "mouse" });
		act(() => vi.advanceTimersByTime(OVERFLOW_REVEAL_DELAY_MS));
		expect(content.style.transform).toBe("");
	});
});
