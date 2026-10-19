import { snapshotAppState as invokeSnapshotAppState } from "@/lib/ipc/persistence";
import { DURABLE_APP_STORE_NAME } from "@/lib/persistence/durableAppStoreName";

let lastSnapshotTime = 0;
const MIN_SNAPSHOT_INTERVAL_MS = 600_000; // 10 minutes

/**
 * Take a rolling snapshot of the agent-ide localStorage value.
 * Throttled to ≤1 per 10 minutes, with automatic rotation keeping last ~20.
 */
export async function snapshotAppState(): Promise<void> {
	const now = Date.now();
	if (now - lastSnapshotTime < MIN_SNAPSHOT_INTERVAL_MS) {
		return;
	}

	try {
		const raw = localStorage.getItem(DURABLE_APP_STORE_NAME);
		if (!raw) return;

		await invokeSnapshotAppState(raw);
		lastSnapshotTime = now;
	} catch (error) {
		console.error("[app-state-snapshot] Failed to snapshot app state:", error);
	}
}

/**
 * Take a snapshot on startup (once).
 */
export function snapshotAppStateOnStartup(): void {
	void snapshotAppState();
}

/**
 * Take a snapshot on quit (bypassing throttle).
 */
export async function snapshotAppStateOnQuit(): Promise<void> {
	try {
		const raw = localStorage.getItem(DURABLE_APP_STORE_NAME);
		if (!raw) return;

		await invokeSnapshotAppState(raw);
	} catch (error) {
		console.error("[app-state-snapshot] Failed to snapshot app state on quit:", error);
	}
}
