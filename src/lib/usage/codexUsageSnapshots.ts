import type { CodexUsageProfileInput, CodexUsageSnapshot } from "@/lib/ipc";
import type { ProviderUsage } from "@/lib/usage/usageMeter";
import type { AccountProfile, Provider } from "@/types";

/** One freshness rule for an observed usage reading, shared by the usage UI
 * and the usage-limit handoff policy so "fresh" means the same thing in both. */
export const USAGE_OBSERVATION_FRESH_FOR_SECONDS = 30 * 60;
const FRESH_FOR_SECONDS = USAGE_OBSERVATION_FRESH_FOR_SECONDS;

/** usage UI와 수집 catalog가 같은 provider 계정 집합을 쓰게 한다. */
function usageAccountsForProvider(
	accounts: readonly AccountProfile[],
	provider: Provider,
): AccountProfile[] {
	return accounts.filter((account) => account.provider === provider);
}

/** 기본 credential까지 포함한 backend 수집 catalog. credential 내용은 보내지 않는다. */
export function codexUsageProfiles(
	accounts: readonly AccountProfile[],
): CodexUsageProfileInput[] {
	return [
		{ credentialId: null, directory: null },
		...usageAccountsForProvider(accounts, "codex")
			.map((account) => ({
				credentialId: account.id,
				directory: account.dir,
			})),
	];
}

export function codexSnapshotForCredential(
	snapshots: readonly CodexUsageSnapshot[] | undefined,
	credentialId: string | null | undefined,
): CodexUsageSnapshot | undefined {
	return snapshots?.find(
		(snapshot) => snapshot.credentialId === (credentialId ?? null),
	);
}

/** App Server 실측 한도만 로그 기반 계정 사용량 위에 덮는다. 토큰 원장은
 * 그대로 보존하며, 실패 snapshot도 마지막 성공 rateLimits를 계속 쓴다. */
export function applyCodexSnapshot(
	usage: ProviderUsage,
	snapshot: CodexUsageSnapshot | undefined,
): ProviderUsage {
	if (!snapshot?.capturedAt || snapshot.rateLimits.length === 0) return usage;
	const general = snapshot.rateLimits.find(
		(limit) => limit.limitId === "codex",
	);
	return {
		...usage,
		usedPercent: general?.usedPercent ?? null,
		usedPercentWeekly: general?.usedPercentWeekly ?? null,
		resetsAt: general?.resetsAt ?? null,
		weeklyResetsAt: general?.weeklyResetsAt ?? null,
		usedPercentCapturedAt: snapshot.capturedAt,
		rateLimits: snapshot.rateLimits,
	};
}

export type CodexSnapshotFreshness = "fresh" | "stale" | "unavailable";

export function codexSnapshotFreshness(
	snapshot: CodexUsageSnapshot | undefined,
	nowSec: number,
): CodexSnapshotFreshness {
	if (!snapshot?.capturedAt) return "unavailable";
	if (snapshot.error || nowSec - snapshot.capturedAt > FRESH_FOR_SECONDS)
		return "stale";
	return "fresh";
}
