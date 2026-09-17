/**
 * Whether a modal dialog is on screen.
 *
 * A modal is a claim on the whole window: it dims what is behind it, traps
 * focus, and says "this, before anything else". A notice that floats above it
 * breaks that claim twice over — it takes the eye first when it is the
 * brightest thing on screen, and its action cannot be reached anyway, because
 * the modal is in front of whatever the notice wants the reader to go do
 * (owner report 2026-09-08).
 *
 * Presence is counted, not a boolean: nested dialogs exist, and the second one
 * closing must not unhide anything while the first is still up.
 *
 * The count lives here rather than in a component tree because the two sides
 * are far apart — DialogContent is portalled out of the app, and the Toaster
 * mounts once at the window root.
 */

import { useSyncExternalStore } from "react";

let openModals = 0;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

/** Count one open modal; call the returned function when it leaves. */
export function registerOpenModal(): () => void {
	openModals += 1;
	emit();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		openModals -= 1;
		emit();
	};
}

function subscribeModalPresence(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function isModalOpen(): boolean {
	return openModals > 0;
}

/** Server snapshot: nothing is open before hydration. */
function serverSnapshot(): boolean {
	return false;
}

export function useModalOpen(): boolean {
	return useSyncExternalStore(
		subscribeModalPresence,
		isModalOpen,
		serverSnapshot,
	);
}
