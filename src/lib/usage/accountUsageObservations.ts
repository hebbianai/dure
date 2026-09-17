/** Projects the recent-usage report onto the per-account observations the
 * usage-limit handoff policy consumes. Keys differ per provider — Claude
 * readings are keyed by the profile directory leaf the statusLine collector
 * writes, Codex readings by credential id from the app-server poller — and
 * this is the one place that mapping lives. A reading that is absent, has
 * no capture time, or is not fresh comes back with observedAtSec null, so
 * the policy can distinguish observed headroom from an unobserved account. */

import type { AccountUsageObservation } from "@/lib/agents/usageLimitHandoffPolicy";
import type { UsageRecentReport } from "@/lib/ipc";
import {
	codexSnapshotForCredential,
	codexSnapshotFreshness,
} from "@/lib/usage/codexUsageSnapshots";
import { claudeAccountRateLimit } from "@/lib/usage/usageAccounts";
import type { AccountProfile, Provider } from "@/types";

function earliestReset(
	...candidates: readonly (number | null | undefined)[]
): number | null {
	const known = candidates.filter(
		(value): value is number => typeof value === "number",
	);
	return known.length === 0 ? null : Math.min(...known);
}

type AccountReading = Omit<AccountUsageObservation, "credentialId">;

/** One reader per provider that reports usage at all: a table, so adding a
 * provider is an entry here and nothing else, and a provider absent from it
 * reports nothing rather than a wrong reading. */
const READINGS: Partial<
	Record<
		Provider,
		(
			report: UsageRecentReport,
			account: AccountProfile,
			nowSec: number,
		) => AccountReading
	>
> = {
	claude: (report, account) => {
		const entry = claudeAccountRateLimit(report.claudeAccounts, account.dir);
		return {
			usedPercent: entry?.usedPercent ?? null,
			usedPercentWeekly: entry?.usedPercentWeekly ?? null,
			resetsAtSec: earliestReset(entry?.resetsAt, entry?.weeklyResetsAt),
			observedAtSec: entry?.usedPercentCapturedAt ?? null,
		};
	},
	codex: (report, account, nowSec) => {
		const snapshot = codexSnapshotForCredential(
			report.codexAccountSnapshots,
			account.id,
		);
		const general = snapshot?.rateLimits.find(
			(limit) => limit.limitId === "codex",
		);
		const fresh = codexSnapshotFreshness(snapshot, nowSec) === "fresh";
		return {
			usedPercent: general?.usedPercent ?? null,
			usedPercentWeekly: general?.usedPercentWeekly ?? null,
			resetsAtSec: earliestReset(general?.resetsAt, general?.weeklyResetsAt),
			observedAtSec: fresh ? (snapshot?.capturedAt ?? null) : null,
		};
	},
};

export function accountUsageObservations(
	provider: Provider,
	report: UsageRecentReport | undefined,
	pool: readonly AccountProfile[],
	nowSec: number,
): AccountUsageObservation[] {
	const read = READINGS[provider];
	return pool.map((account) => ({
		credentialId: account.id,
		...(read && report
			? read(report, account, nowSec)
			: {
					usedPercent: null,
					usedPercentWeekly: null,
					resetsAtSec: null,
					observedAtSec: null,
				}),
	}));
}
