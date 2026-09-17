// Shared recent-usage polling — UsageBadge and settings > stats read the same
// source (usage_recent) on the same 2-minute cadence. Extracted from the
// duplicated effect in UsageBadge.tsx / StatsPage.tsx: if each screen polled
// with its own copy, one screen could drift when only the other was updated.
import { useEffect, useRef, useState } from "react";
import {
	type ClaudeCollectorState,
	claudeCollectorStatus,
	codexUsageProfilesSync,
	type UsageRecentReport,
	usageRecent,
	usageRefresh,
} from "@/lib/ipc";
import {
	clearMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import { codexUsageProfiles } from "@/lib/usage/codexUsageSnapshots";
import type { UsageRefreshProvider } from "@/lib/usage/recentUsageClient";
import type { AccountProfile } from "@/types";

/** 5h/24h usage windows plus the Claude collector state, refreshed every
 *  2 minutes. `setCollector` stays exposed because the install flows differ
 *  per screen (the badge shows an error dialog, settings stays silent), so
 *  installs live at the call sites. */
export function useRecentUsage(accounts: readonly AccountProfile[]) {
	const [u5, setU5] = useState<UsageRecentReport | null>(null);
	const [u24, setU24] = useState<UsageRecentReport | null>(null);
	const [collector, setCollector] = useState<ClaudeCollectorState | null>(null);
	const [refreshing, setRefreshing] = useState<UsageRefreshProvider | null>(
		null,
	);
	const [refreshError, setRefreshError] = useState<UsageRefreshProvider | null>(
		null,
	);
	const refresh = useRef<(provider: UsageRefreshProvider) => Promise<void>>(
		async () => {},
	);

	useEffect(() => {
		let stop = false;
		let refreshing = false;
		setRefreshing(null);
		setRefreshError(null);
		const load = () => {
			if (stop) return;
			usageRecent(5)
				.then((u) => !stop && setU5(u))
				.catch(() => {});
			usageRecent(24)
				.then((u) => !stop && setU24(u))
				.catch(() => {});
		};
		// Sync the codex collection catalog first so the report covers every
		// registered account; load runs regardless of sync failure.
		const catalog = codexUsageProfilesSync(codexUsageProfiles(accounts));
		void catalog.catch(() => {}).then(load);
		refresh.current = async (provider) => {
			if (stop || refreshing) return;
			refreshing = true;
			setRefreshing(provider);
			setRefreshError(null);
			try {
				if (provider === "codex") {
					await codexUsageProfilesSync(codexUsageProfiles(accounts));
				}
				if (stop) return;
				const next = await usageRefresh(provider);
				if (!stop) {
					setU5(next.fiveHours);
					setU24(next.twentyFourHours);
				}
			} catch {
				if (!stop) setRefreshError(provider);
			} finally {
				refreshing = false;
				if (!stop) setRefreshing(null);
			}
		};
		claudeCollectorStatus()
			.then((s) => !stop && setCollector(s))
			.catch(() => {});
		const timer = setMaintenanceLaneInterval(
			load,
			2 * 60 * 1000,
			"usage-refresh",
		);
		return () => {
			stop = true;
			clearMaintenanceLaneInterval(timer);
		};
	}, [accounts]);

	return {
		u5,
		u24,
		collector,
		setCollector,
		refreshing,
		refreshError,
		refresh: (provider: UsageRefreshProvider) => refresh.current(provider),
	};
}
