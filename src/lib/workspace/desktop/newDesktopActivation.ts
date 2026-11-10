// Starting a new desktop from somewhere other than the tab strip's '+' and
// its ⌘⇧T chord — today, the search palette's "New desktop" command.
//
// The naming step belongs to DesktopBar: it owns the name input, commits an
// empty desktop under the typed name and marks it to start empty. Other
// triggers must not create a Space behind its back (that skipped the name and
// let the new Space inherit a terminal), so they ask instead. Same
// window-CustomEvent idiom as quickDispatchActivation.ts and
// feedbackActivation.ts: presentation-only signalling, no store, no second
// state authority.

const ACTIVATION_EVENT = "dure:new-desktop-activate";

/** Ask the tab strip to start naming a new desktop — what ⌘⇧T does. */
export function requestNewDesktop(): void {
	window.dispatchEvent(new CustomEvent(ACTIVATION_EVENT));
}

export function onNewDesktopRequest(callback: () => void): () => void {
	const handler = () => callback();
	window.addEventListener(ACTIVATION_EVENT, handler);
	return () => window.removeEventListener(ACTIVATION_EVENT, handler);
}
