import { act } from "@testing-library/react";
import { vi } from "vitest";

// jsdom cannot tell keyboard focus from any other: its `:focus-visible` is
// true for the first element focused in a file and false afterwards (nwsapi),
// whichever way focus arrived. Components that ask the engine get the answer
// stubbed here instead, and the engines' real one is browser evidence.
function focusAs(element: HTMLElement, focusVisible: boolean) {
	const matches = element.matches.bind(element);
	vi.spyOn(element, "matches").mockImplementation((selector) =>
		selector === ":focus-visible" ? focusVisible : matches(selector),
	);
	act(() => element.focus());
}

/** Focus the way Tab does: the focus ring shows. */
export function focusByKeyboard(element: HTMLElement) {
	focusAs(element, true);
}

/** Focus the way a dialog hands it to its first control after a click. */
export function focusWithoutKeyboard(element: HTMLElement) {
	focusAs(element, false);
}
