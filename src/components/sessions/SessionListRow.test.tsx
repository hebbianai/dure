// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Circle } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionListRow } from "@/components/sessions/SessionListRow";
import { OVERFLOW_REVEAL_DELAY_MS } from "@/components/ui/overflow-reveal-text";

afterEach(() => {
	cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("SessionListRow", () => {
	it("reveals the clipped name on sustained hover and still activates the session", () => {
		vi.useFakeTimers();
		const onActivate = vi.fn();
		render(<SessionListRow icon={<Circle />} name="A long session title" onActivate={onActivate} />);
		const content = screen.getByText("A long session title");
		const viewport = content.parentElement!;
		Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 });
		Object.defineProperty(content, "scrollWidth", { configurable: true, value: 240 });
		fireEvent.pointerEnter(viewport, { pointerType: "mouse" });
		act(() => vi.advanceTimersByTime(OVERFLOW_REVEAL_DELAY_MS - 1));
		expect(content.style.transform).toBe("");
		act(() => vi.advanceTimersByTime(1));
		expect(content.style.transform).toBe("translateX(-140px)");
		fireEvent.click(content);
		expect(onActivate).toHaveBeenCalledOnce();
		fireEvent.pointerLeave(viewport, { pointerType: "mouse" });
		expect(content.style.transform).toBe("");
	});

	it("activates from pointer and keyboard with one accessible row label", () => {
		const onActivate = vi.fn();
		render(
			<SessionListRow
				icon={<Circle />}
				name="Design review"
				metadata="HebbianIDE · uiux"
				activateLabel="이어가기: Design review"
				onActivate={onActivate}
			/>,
		);

		const row = screen.getByRole("button", {
			name: "이어가기: Design review",
		});
		fireEvent.click(row);
		fireEvent.keyDown(row, { key: "Enter" });
		fireEvent.keyDown(row, { key: " " });

		expect(onActivate).toHaveBeenCalledTimes(3);
	});

	it("keeps overflow actions separate from the row's primary action", () => {
		const onActivate = vi.fn();
		const onMenu = vi.fn();
		render(
			<SessionListRow
				icon={<Circle />}
				name="Recover me"
				activateLabel="복구: Recover me"
				onActivate={onActivate}
				menu={
					<button type="button" onClick={onMenu}>
						추가 작업
					</button>
				}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "추가 작업" }));

		expect(onMenu).toHaveBeenCalledOnce();
		expect(onActivate).not.toHaveBeenCalled();
	});
});
