/**
 * Whether this window's content has painted for the first time — the moment
 * its boot is over.
 *
 * Every window loads the same entry, so every window starts the boot splash.
 * One authority ends it per window, at the post-paint moment of what that
 * window exists to show: Workspace.tsx for a window that hosts a workspace
 * (the same moment it hands workspacePerformance its paint milestone), and
 * WindowContentPainted for every other root main.tsx mounts. A window whose
 * content never announces this keeps the splash animating behind it.
 */

/** Also dispatched on `document` so a script that ran before the app bundle
 *  (the boot splash) can hear it without sharing a module instance. */
export const WINDOW_CONTENT_PAINTED_EVENT = "dure:window-content-painted";

let painted = false;
const listeners = new Set<() => void>();

export function windowContentPainted(): boolean {
	return painted;
}

export function markWindowContentPainted(): void {
	if (painted) return;
	painted = true;
	for (const listener of listeners) listener();
	if (typeof document !== "undefined") {
		document.dispatchEvent(new Event(WINDOW_CONTENT_PAINTED_EVENT));
	}
}

export function subscribeWindowBoot(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Tests boot the window more than once. */
export function resetWindowBootForTest(): void {
	painted = false;
}
