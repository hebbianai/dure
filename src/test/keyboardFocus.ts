import { act, fireEvent } from "@testing-library/react";
import { trackInputModality } from "@/lib/ui/inputModality";

// Focus as the user brings it about: the components ask what the last input
// was (src/lib/ui/inputModality.ts), so the helpers give that input for real
// rather than stubbing an answer.

/** Focus the way Tab does. */
export function focusByKeyboard(element: HTMLElement) {
	pressKey(element.ownerDocument);
	act(() => element.focus());
}

/** Focus the way a surface hands it over after a click somewhere else. */
export function focusWithoutKeyboard(element: HTMLElement) {
	pressPointer(element.ownerDocument);
	act(() => element.focus());
}

// A document other than the app's own (a test iframe) is only listened to
// once something asks about it; start before the input, not after.

/** The user's last input was a key: Tab walks focus, Enter opens a surface. */
export function pressKey(doc: Document = document, key = "Tab") {
	trackInputModality(doc);
	fireEvent.keyDown(doc.body, { key });
}

/** The user's last input was a press: what follows is a pointer open. */
export function pressPointer(doc: Document = document) {
	trackInputModality(doc);
	fireEvent.pointerDown(doc.body);
}
