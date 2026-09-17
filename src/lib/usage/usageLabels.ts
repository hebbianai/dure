import { t } from "@/lib/i18n";
import type { CodexUsageSnapshot } from "@/lib/ipc";
import { codexSnapshotFreshness } from "@/lib/usage/codexUsageSnapshots";

export function codexResetCreditsLabel(
	snapshot: CodexUsageSnapshot | undefined,
	nowSec: number,
): string {
	const count = snapshot?.capturedAt ? snapshot.rateLimitResetsAvailable : null;
	if (count == null || !Number.isSafeInteger(count) || count < 0) {
		return t("usage.resetCredits.unavailable");
	}
	const label = t("usage.resetCredits.available", {
		count: count.toLocaleString(),
	});
	return codexSnapshotFreshness(snapshot, nowSec) === "stale"
		? t("usage.credits.lastKnown", { credits: label })
		: label;
}

export function codexCreditsLabel(
	snapshot: CodexUsageSnapshot | undefined,
	nowSec: number,
): string {
	const credits = snapshot?.capturedAt
		? snapshot.rateLimits.find((limit) => limit.limitId === "codex")?.credits
		: null;
	const raw = credits?.balance?.trim();
	const balance = raw ? Number(raw) : Number.NaN;
	const label = credits?.unlimited
		? t("usage.credits.unlimited")
		: Number.isFinite(balance) && balance >= 0
			? t("usage.credits.remaining", {
					balance: balance.toLocaleString(undefined, {
						maximumFractionDigits: 20,
					}),
				})
			: null;
	if (!label) return t("usage.credits.unavailable");
	return codexSnapshotFreshness(snapshot, nowSec) === "stale"
		? t("usage.credits.lastKnown", { credits: label })
		: label;
}

export function usageDurationLabel(value: string | null): string | null {
	return (
		value
			?.replace(/(\d+)d/g, (_, n: string) => t("usage.duration.days", { n }))
			.replace(/(\d+)h/g, (_, n: string) => t("usage.duration.hours", { n }))
			.replace(/(\d+)m/g, (_, n: string) =>
				t("usage.duration.minutes", { n }),
			) ?? null
	);
}

export function usageResetLabel(value: string | null): string | null {
	return value ? t("usage.reset.standalone", { reset: value }) : null;
}
