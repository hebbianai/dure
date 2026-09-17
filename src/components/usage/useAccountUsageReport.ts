import { useEffect, useState } from "react";
import { type UsageRecentReport, usageRecent } from "@/lib/ipc";
import { supportsProviderAccountMeter } from "@/lib/usage/accountUsageMeter";
import type { Provider } from "@/types";

/** Read the existing shared snapshot only when a supported local menu opens.
 * No new collector, per-account request, cache or polling loop. */
export function useAccountUsageReport(provider: Provider, enabled: boolean) {
	const [snapshot, setSnapshot] = useState<{
		provider: Provider;
		report: UsageRecentReport;
	} | null>(null);
	useEffect(() => {
		setSnapshot(null);
		if (!enabled || !supportsProviderAccountMeter(provider)) return;
		let current = true;
		usageRecent(5)
			.then((report) => {
				if (current) setSnapshot({ provider, report });
			})
			.catch(() => {
				// Usage is advisory; account selection remains available.
			});
		return () => {
			current = false;
		};
	}, [provider, enabled]);
	return enabled && snapshot?.provider === provider ? snapshot.report : null;
}
