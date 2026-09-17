/**
 * Whether this window's workspace has painted for the first time.
 *
 * One authority sets it: Workspace.tsx, at the same post-paint moment it hands
 * workspacePerformance its paint milestone. Anything that only makes sense
 * before that moment — the boot splash — reads it from here instead of
 * inventing a readiness flag of its own.
 */

/** Also dispatched on `document` so a script that ran before the app bundle
 *  (the boot splash) can hear it without sharing a module instance. */
export const WORKSPACE_PAINTED_EVENT = "dure:workspace-painted";

let painted = false;
const listeners = new Set<() => void>();

export function workspacePainted(): boolean {
	return painted;
}

export function markWorkspacePainted(): void {
	if (painted) return;
	painted = true;
	for (const listener of listeners) listener();
	if (typeof document !== "undefined") {
		document.dispatchEvent(new Event(WORKSPACE_PAINTED_EVENT));
	}
}

export function subscribeWorkspaceBoot(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Tests boot the window more than once. */
export function resetWorkspaceBootForTest(): void {
	painted = false;
}
