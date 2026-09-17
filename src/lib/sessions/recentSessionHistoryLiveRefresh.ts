import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import type { SshHostConfig } from "@/types";

/** Quiet time after the last observed event before one refresh runs. */
const RECENT_SESSION_HISTORY_LIVE_DEBOUNCE_MS = 1_500;

export interface RecentSessionHistoryLiveState {
	readonly sessionActivity: Record<string, { text: string; at?: number }>;
	readonly sessionAgentRuntimeState: Record<string, HmuxAgentRuntimeState>;
	readonly sshHosts: readonly SshHostConfig[];
}

interface RecentSessionHistoryLiveStore {
	getState(): RecentSessionHistoryLiveState;
	subscribe(listener: () => void): () => void;
}

/** A submitted prompt or a completed turn is when a provider rewrites the
 * conversation title it stores on disk (Codex names a thread after its first
 * prompt and renames it once a summary exists; Claude rewrites its summary).
 * Both are already projected into the store, so the history snapshot the
 * unopened rows read is refreshed from those transitions instead of on a
 * timer. Returns true when the transition warrants a refresh. */
export function recentSessionHistoryTitleTransition(
	previous: RecentSessionHistoryLiveState,
	next: RecentSessionHistoryLiveState,
): boolean {
	if (previous.sessionActivity !== next.sessionActivity) {
		for (const [sessionId, entry] of Object.entries(next.sessionActivity)) {
			const before = previous.sessionActivity[sessionId];
			if (!before || before.text !== entry.text || before.at !== entry.at) {
				return true;
			}
		}
	}
	if (previous.sessionAgentRuntimeState !== next.sessionAgentRuntimeState) {
		for (const [sessionId, state] of Object.entries(
			next.sessionAgentRuntimeState,
		)) {
			const before = previous.sessionAgentRuntimeState[sessionId];
			if (!before) continue;
			if (before.activity === "working" && state.activity === "waiting") {
				return true;
			}
			if (
				state.turnCompletedCount !== undefined &&
				before.turnCompletedCount !== state.turnCompletedCount
			) {
				return true;
			}
		}
	}
	return false;
}

/** Subscribe the shared history resource to title-changing transitions. One
 * subscription per app; the returned function stops it. */
export function startRecentSessionHistoryLiveRefresh({
	store,
	refresh,
	debounceMs = RECENT_SESSION_HISTORY_LIVE_DEBOUNCE_MS,
	setTimeout: schedule = globalThis.setTimeout.bind(globalThis),
	clearTimeout: cancel = globalThis.clearTimeout.bind(globalThis),
}: {
	store: RecentSessionHistoryLiveStore;
	refresh: (hosts: readonly SshHostConfig[]) => Promise<void>;
	debounceMs?: number;
	setTimeout?: (
		callback: () => void,
		ms: number,
	) => ReturnType<typeof setTimeout>;
	clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}): () => void {
	let previous = store.getState();
	let pending: ReturnType<typeof setTimeout> | null = null;
	const unsubscribe = store.subscribe(() => {
		const next = store.getState();
		const transition = recentSessionHistoryTitleTransition(previous, next);
		previous = next;
		if (!transition) return;
		if (pending !== null) cancel(pending);
		pending = schedule(() => {
			pending = null;
			void refresh(store.getState().sshHosts).catch(() => {
				// The resource records its own load error; a failed refresh keeps
				// the previous snapshot on screen.
			});
		}, debounceMs);
	});
	return () => {
		unsubscribe();
		if (pending !== null) cancel(pending);
		pending = null;
	};
}
