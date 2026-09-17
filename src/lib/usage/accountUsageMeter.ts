import type { CodexUsageSnapshot, UsageRecentReport } from "@/lib/ipc";
import {
	claudeAccountRateLimit,
	codexAccountUsage,
	type ClaudeAccountRateLimit,
	type CodexAccountUsage,
} from "@/lib/usage/usageAccounts";
import {
	applyCodexSnapshot,
	codexSnapshotForCredential,
} from "@/lib/usage/codexUsageSnapshots";
import {
	claudeMeter,
	codexMeter,
	type CodexMeter,
	type ProviderUsage,
} from "@/lib/usage/usageMeter";
import type { Provider } from "@/types";

const EMPTY_USAGE: ProviderUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	usedPercent: null,
	usedPercentWeekly: null,
	resetsAt: null,
	weeklyResetsAt: null,
	usedPercentCapturedAt: null,
	rateLimits: [],
};

/** Provider-observed limit for one Claude profile. Missing profiles stay
 * absent instead of borrowing the active or aggregate account's limit. */
export function claudeAccountMeter(
	accounts: ClaudeAccountRateLimit[] | undefined,
	dir: string | undefined | null,
	nowSec: number,
): CodexMeter | null {
	const entry = claudeAccountRateLimit(accounts, dir);
	if (!entry) return null;
	return claudeMeter(
		{
			...EMPTY_USAGE,
			usedPercent: entry.usedPercent,
			usedPercentWeekly: entry.usedPercentWeekly,
			resetsAt: entry.resetsAt,
			weeklyResetsAt: entry.weeklyResetsAt,
			usedPercentCapturedAt: entry.usedPercentCapturedAt,
		},
		nowSec,
	);
}

/** Provider-observed limit for one Codex credential. App Server snapshots
 * override session-log limits without changing the account's token ledger. */
export function codexAccountMeter(
	accounts: CodexAccountUsage[] | undefined,
	snapshots: readonly CodexUsageSnapshot[] | undefined,
	credentialId: string | undefined | null,
	nowSec: number,
): CodexMeter | null {
	const logged = codexAccountUsage(accounts, credentialId)?.usage;
	const snapshot = codexSnapshotForCredential(snapshots, credentialId);
	if (!logged && !snapshot) return null;
	return codexMeter(applyCodexSnapshot(logged ?? EMPTY_USAGE, snapshot), nowSec);
}

type ProviderAccountMeterResolver = (
	report: UsageRecentReport,
	credentialId: string | undefined,
	dir: string | undefined,
	nowSec: number,
) => CodexMeter | null;

const ACCOUNT_METER_RESOLVERS: Partial<
	Record<Provider, ProviderAccountMeterResolver>
> = {
	claude: (report, _credentialId, dir, nowSec) =>
		claudeAccountMeter(report.claudeAccounts, dir, nowSec),
	codex: (report, credentialId, _dir, nowSec) =>
		codexAccountMeter(
			report.codexAccounts,
			report.codexAccountSnapshots,
			credentialId,
			nowSec,
		),
};

export function supportsProviderAccountMeter(provider: Provider): boolean {
	return ACCOUNT_METER_RESOLVERS[provider] != null;
}

/** Resolves provider-observed account limits through one capability map so UI
 * surfaces do not duplicate concrete-provider branches. */
export function providerAccountMeter(
	provider: Provider,
	report: UsageRecentReport,
	credentialId: string | undefined,
	dir: string | undefined,
	nowSec: number,
): CodexMeter | null {
	return (
		ACCOUNT_METER_RESOLVERS[provider]?.(
			report,
			credentialId,
			dir,
			nowSec,
		) ?? null
	);
}
