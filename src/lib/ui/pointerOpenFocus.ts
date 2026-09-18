import { lastInputWasKeyboard } from "@/lib/ui/inputModality";

// Where focus goes when a dialog or popover opens.
//
// Radix hands it to the first tabbable control. After a keyboard open that is
// right. After a click it lit up whichever icon button came first — a focus
// ring and its tooltip on Refresh or Close, in every dialog and popover
// (owner report 2026-09-18). Radix's own menus already draw this line: opened
// by pointer they focus the menu, opened by keyboard the first item. Surfaces
// follow it, except where the first control takes text — a form opened by
// mouse should still be ready to type into.

const NON_TEXT_INPUT_TYPES = new Set([
	"button",
	"checkbox",
	"color",
	"file",
	"image",
	"radio",
	"range",
	"reset",
	"submit",
]);

function takesText(element: HTMLElement) {
	const editable = element.getAttribute("contenteditable");
	if (editable !== null && editable !== "false") return true;
	if (element.tagName === "TEXTAREA") return true;
	return (
		element.tagName === "INPUT" &&
		!NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type)
	);
}

function isRendered(element: HTMLElement, surface: HTMLElement) {
	const view = element.ownerDocument.defaultView;
	if (!view) return true;
	if (view.getComputedStyle(element).visibility === "hidden") return false;
	for (
		let node: HTMLElement | null = element;
		node && node !== surface;
		node = node.parentElement
	) {
		if (view.getComputedStyle(node).display === "none") return false;
	}
	return true;
}

/** The control Radix's FocusScope would focus: first tabbable, links aside. */
function firstTabbable(surface: HTMLElement) {
	const walker = surface.ownerDocument.createTreeWalker(surface, 1); // SHOW_ELEMENT
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const element = node as HTMLElement & { disabled?: boolean; type?: string };
		if (element.disabled || element.hidden) continue;
		if (element.tagName === "INPUT" && element.type === "hidden") continue;
		if (element.tagName === "A" || element.tabIndex < 0) continue;
		if (isRendered(element, surface)) return element;
	}
	return null;
}

/**
 * `onOpenAutoFocus` for Radix dialogs and popovers: after a pointer open the
 * surface takes focus itself unless its first control takes text. Tab still
 * walks into the controls from there, and focus is still trapped and restored
 * by Radix.
 */
export function keepPointerOpenFocusOnSurface(event: Event) {
	if (event.defaultPrevented) return;
	const surface = event.currentTarget as HTMLElement;
	if (lastInputWasKeyboard(surface.ownerDocument)) return;
	const first = firstTabbable(surface);
	if (first && takesText(first)) return;
	event.preventDefault();
	surface.focus({ preventScroll: true });
}
