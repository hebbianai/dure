/** The app's periodic account usage check, applied to the readings the usage
 * UI shows. Each provider's check keeps one snapshot per account (the last
 * success, beside the latest attempt); this module is the one place that
 * finds an account's snapshot, says how fresh it is, and lays it over what
 * the session logs or the statusLine collector observed. */

import type {
	AccountUsageCheck,
	ClaudeUsageSnapshot,
	CodexUsageSnapshot,
} from "@/lib/ipc";
import {
	fmtReset,
	type NamedLimitMeter,
	type ProviderUsage,
} from "@/lib/usage/usageMeter";

/** One freshness rule for an observed usage reading, shared by the usage UI
 * and the usage-limit handoff policy so "fresh" means the same thing in both. */
export const USAGE_OBSERVATION_FRESH_FOR_SECONDS = 30 * 60;
const FRESH_FOR_SECONDS = USAGE_OBSERVATION_FRESH_FOR_SECONDS;

export function accountSnapshotForCredential<S extends AccountUsageCheck>(
	snapshots: readonly S[] | undefined,
	credentialId: string | null | undefined,
): S | undefined {
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

/** Whether the Claude check's last success describes the account's 5-hour
 * and weekly windows better than the statusLine reading captured at
 * `statusLineCapturedAt`: the newer of the two wins, a tie goes to the check.
 * The control plane and `dure recovery get claude` apply the same rule. */
export function claudeCheckIsNewer(
	snapshot: ClaudeUsageSnapshot | undefined,
	statusLineCapturedAt: number | null | undefined,
): snapshot is ClaudeUsageSnapshot & { capturedAt: number } {
	if (!snapshot?.capturedAt) return false;
	return statusLineCapturedAt == null || snapshot.capturedAt >= statusLineCapturedAt;
}

/** A window of the check that still describes current use: one whose reset
 * has passed since the capture no longer does. */
function currentWindows(
	snapshot: ClaudeUsageSnapshot | undefined,
	nowSec: number,
) {
	if (!snapshot?.capturedAt) return [];
	return snapshot.windows.filter(
		(window) =>
			Number.isFinite(window.usedPercent) &&
			(window.resetsAt == null || window.resetsAt > nowSec),
	);
}

/** The Claude check's 5-hour and weekly windows over every model laid over
 * the statusLine reading, when the check is the newer of the two. Tokens
 * stay as the session logs counted them. */
export function applyClaudeSnapshot(
	usage: ProviderUsage,
	snapshot: ClaudeUsageSnapshot | undefined,
	nowSec: number,
): ProviderUsage {
	if (!claudeCheckIsNewer(snapshot, usage.usedPercentCapturedAt)) return usage;
	const windows = currentWindows(snapshot, nowSec);
	const general = (kind: "fiveHour" | "weekly") =>
		windows.find((window) => window.kind === kind);
	return {
		...usage,
		usedPercent: general("fiveHour")?.usedPercent ?? null,
		usedPercentWeekly: general("weekly")?.usedPercent ?? null,
		resetsAt: general("fiveHour")?.resetsAt ?? null,
		weeklyResetsAt: general("weekly")?.resetsAt ?? null,
		usedPercentCapturedAt: snapshot.capturedAt,
	};
}

/** The Claude check's windows beyond the two over every model: each model's
 * own weekly window, then windows Dure does not know, by the response's
 * name. Only the check reports them; a failed check keeps the last ones. */
export function claudeSeparateMeters(
	snapshot: ClaudeUsageSnapshot | undefined,
	nowSec: number,
): NamedLimitMeter[] {
	return currentWindows(snapshot, nowSec).flatMap(
		(window): NamedLimitMeter[] => {
			const resetLabel = fmtReset(window.resetsAt, nowSec);
			if (window.kind === "modelWeekly") {
				return [
					{
						limitId: window.id,
						limitName: window.model ?? window.id,
						pct: window.usedPercent,
						window: "weekly",
						resetLabel,
						weeklyPct: window.usedPercent,
						weeklyResetLabel: resetLabel,
					},
				];
			}
			if (window.kind === "other") {
				return [
					{
						limitId: window.id,
						limitName: window.id,
						pct: window.usedPercent,
						window: null,
						resetLabel,
						weeklyPct: null,
						weeklyResetLabel: null,
					},
				];
			}
			return [];
		},
	);
}

export type AccountSnapshotFreshness = "fresh" | "stale" | "unavailable";

export function accountSnapshotFreshness(
	snapshot: AccountUsageCheck | undefined,
	nowSec: number,
): AccountSnapshotFreshness {
	if (!snapshot?.capturedAt) return "unavailable";
	if (snapshot.error || nowSec - snapshot.capturedAt > FRESH_FOR_SECONDS)
		return "stale";
	return "fresh";
}
