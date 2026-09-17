// Shared minute tick for relative timestamps in list rows. One interval feeds
// every subscribed row via useSyncExternalStore, so "3m ago" advances instead
// of freezing at render time — without a per-row timer or a parent-level state
// that would rerender the whole pane tree from a single prop. Each tick fans
// out re-renders across every subscribed row, so it runs on the maintenance
// lane and stays out of interaction frames; a coarse label can wait.
import { useSyncExternalStore } from "react";
import {
	clearMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import { spacesLocalDayStart } from "@/lib/spaces/spacesViewProjection";

const TICK_MS = 30_000;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (!timer) {
		// The clock may have been idle since the last unmount — refresh before
		// the first interval so a fresh subscriber never reads a stale "now".
		now = Date.now();
		timer = setMaintenanceLaneInterval(
			() => {
				now = Date.now();
				for (const notify of listeners) notify();
			},
			TICK_MS,
			"now-tick",
		);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer) {
			clearMaintenanceLaneInterval(timer);
			timer = undefined;
		}
	};
}

function doNotSubscribe(): () => void {
	return () => {};
}

/** Current time, refreshed every 30s while an enabled subscriber is mounted. */
export function useNowTick(enabled = true): number {
	return useSyncExternalStore(
		enabled ? subscribe : doNotSubscribe,
		() => now,
		() => now,
	);
}

/** Local calendar day, updated by the shared clock only when the day changes. */
export function useLocalDayTick(enabled = true): number {
	return useSyncExternalStore(
		enabled ? subscribe : doNotSubscribe,
		() => spacesLocalDayStart(now),
		() => spacesLocalDayStart(now),
	);
}
