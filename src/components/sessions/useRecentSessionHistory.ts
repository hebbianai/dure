import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { startRecentSessionHistoryLiveRefresh } from "@/lib/sessions/recentSessionHistoryLiveRefresh";
import {
	ensureRecentSessionHistory,
	recentSessionHistoryScopeKey,
	recentSessionHistorySnapshot,
	refreshRecentSessionHistory,
	subscribeRecentSessionHistory,
} from "@/lib/sessions/recentSessionHistoryResource";
import { useStore } from "@/store";
import type { SshHostConfig } from "@/types";

// One live-refresh subscription serves every mounted consumer; the last one
// to unmount stops it.
let liveRefreshConsumers = 0;
let stopLiveRefresh: (() => void) | null = null;

function retainLiveRefresh(): () => void {
	if (liveRefreshConsumers++ === 0) {
		stopLiveRefresh = startRecentSessionHistoryLiveRefresh({
			store: useStore,
			refresh: refreshRecentSessionHistory,
		});
	}
	return () => {
		if (--liveRefreshConsumers === 0) {
			stopLiveRefresh?.();
			stopLiveRefresh = null;
		}
	};
}

export function useRecentSessionHistory(hosts: readonly SshHostConfig[]) {
	const scopeKey = useMemo(() => recentSessionHistoryScopeKey(hosts), [hosts]);
	const getSnapshot = useCallback(
		() => recentSessionHistorySnapshot(scopeKey),
		[scopeKey],
	);
	const snapshot = useSyncExternalStore(
		subscribeRecentSessionHistory,
		getSnapshot,
		getSnapshot,
	);

	useEffect(() => {
		void ensureRecentSessionHistory(hosts);
	}, [hosts, scopeKey]);
	useEffect(retainLiveRefresh, []);

	return snapshot;
}
