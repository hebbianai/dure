import type {
	ClaudeUsageSnapshot,
	CodexUsageSnapshot,
	UsageRecentReport,
} from "@/lib/ipc";
import {
	claudeAccountRateLimit,
	codexAccountUsage,
	type ClaudeAccountRateLimit,
	type CodexAccountUsage,
} from "@/lib/usage/usageAccounts";
import {
	accountSnapshotForCredential,
	applyClaudeSnapshot,
	applyCodexSnapshot,
	claudeSeparateMeters,
} from "@/lib/usage/accountUsageSnapshots";
import {
	claudeMeter,
	codexMeter,
	codexModelMeters,
	type CodexMeter,
	type NamedLimitMeter,
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

/** One account's limits for choosing between accounts: the general meter,
 * and the separate limits (a model's own budget) that are in use beside it.
 * A limit at 0% says nothing about which account to pick. */
export interface AccountUsageMeter extends CodexMeter {
	separate: readonly NamedLimitMeter[];
}

function accountMeter(
	general: CodexMeter,
	separate: readonly NamedLimitMeter[],
): AccountUsageMeter {
	return {
		...general,
		separate: separate.filter((limit) => (limit.pct ?? 0) > 0),
	};
}

/** One Claude account's 5-hour and weekly limits: the statusLine reading of
 * its profile directory, with its account usage check laid over it when the
 * check is newer. Undefined when neither has observed the account — it
 * never borrows the active or aggregate account's limit. */
export function claudeAccountUsage(
	accounts: ClaudeAccountRateLimit[] | undefined,
	snapshots: readonly ClaudeUsageSnapshot[] | undefined,
	credentialId: string | undefined | null,
	dir: string | undefined | null,
	nowSec: number,
): { usage: ProviderUsage; snapshot: ClaudeUsageSnapshot | undefined } | undefined {
	const entry = claudeAccountRateLimit(accounts, dir);
	const snapshot = accountSnapshotForCredential(snapshots, credentialId);
	if (!entry && !snapshot) return undefined;
	const statusLine: ProviderUsage = entry
		? {
				...EMPTY_USAGE,
				usedPercent: entry.usedPercent,
				usedPercentWeekly: entry.usedPercentWeekly,
				resetsAt: entry.resetsAt,
				weeklyResetsAt: entry.weeklyResetsAt,
				usedPercentCapturedAt: entry.usedPercentCapturedAt,
			}
		: EMPTY_USAGE;
	return { usage: applyClaudeSnapshot(statusLine, snapshot, nowSec), snapshot };
}

/** Provider-observed limits for one Claude account, with each model's own
 * weekly window from its account usage check. */
export function claudeAccountMeter(
	accounts: ClaudeAccountRateLimit[] | undefined,
	snapshots: readonly ClaudeUsageSnapshot[] | undefined,
	credentialId: string | undefined | null,
	dir: string | undefined | null,
	nowSec: number,
): AccountUsageMeter | null {
	const observed = claudeAccountUsage(
		accounts,
		snapshots,
		credentialId,
		dir,
		nowSec,
	);
	if (!observed) return null;
	return accountMeter(
		claudeMeter(observed.usage, nowSec),
		claudeSeparateMeters(observed.snapshot, nowSec),
	);
}

/** Provider-observed limit for one Codex credential. App Server snapshots
 * override session-log limits without changing the account's token ledger. */
export function codexAccountMeter(
	accounts: CodexAccountUsage[] | undefined,
	snapshots: readonly CodexUsageSnapshot[] | undefined,
	credentialId: string | undefined | null,
	nowSec: number,
): AccountUsageMeter | null {
	const logged = codexAccountUsage(accounts, credentialId)?.usage;
	const snapshot = accountSnapshotForCredential(snapshots, credentialId);
	if (!logged && !snapshot) return null;
	const usage = applyCodexSnapshot(logged ?? EMPTY_USAGE, snapshot);
	return accountMeter(codexMeter(usage, nowSec), codexModelMeters(usage, nowSec));
}

type ProviderAccountMeterResolver = (
	report: UsageRecentReport,
	credentialId: string | undefined,
	dir: string | undefined,
	nowSec: number,
) => AccountUsageMeter | null;

const ACCOUNT_METER_RESOLVERS: Partial<
	Record<Provider, ProviderAccountMeterResolver>
> = {
	claude: (report, credentialId, dir, nowSec) =>
		claudeAccountMeter(
			report.claudeAccounts,
			report.claudeAccountSnapshots,
			credentialId,
			dir,
			nowSec,
		),
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
): AccountUsageMeter | null {
	return (
		ACCOUNT_METER_RESOLVERS[provider]?.(
			report,
			credentialId,
			dir,
			nowSec,
		) ?? null
	);
}
