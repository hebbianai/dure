import { act, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const content = () => document.querySelector("[data-slot='tooltip-content']");

/** Rest the mouse on `trigger` and return the shared tooltip's text once it
 * opens. The tooltip opens 100ms after an intentional hover; under fake timers
 * that delay is advanced explicitly. */
export async function hoverHint(trigger: Element): Promise<string> {
	fireEvent.pointerMove(trigger, { pointerType: "mouse" });
	if (vi.isFakeTimers()) {
		await act(() => vi.advanceTimersByTimeAsync(100));
		return content()?.textContent ?? "";
	}
	const el = await waitFor(() => {
		const node = content();
		if (!node) throw new Error("the shared tooltip did not open");
		return node;
	});
	return el.textContent ?? "";
}
