import { t } from "@/lib/i18n";
import type { CodexUsageSnapshot } from "@/lib/ipc";
import { accountSnapshotFreshness } from "@/lib/usage/accountUsageSnapshots";
import type { NamedLimitMeter } from "@/lib/usage/usageMeter";

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
	return accountSnapshotFreshness(snapshot, nowSec) === "stale"
		? t("usage.credits.lastKnown", { credits: label })
		: label;
}

/** The account's workspace credit balance. `limitReached` says its plan
 * limit is used up: with a balance left, Codex keeps running on the credits,
 * so the label says so instead of leaving a bare 100% that reads as blocked. */
export function codexCreditsLabel(
	snapshot: CodexUsageSnapshot | undefined,
	nowSec: number,
	limitReached = false,
): string {
	const credits = snapshot?.capturedAt
		? snapshot.rateLimits.find((limit) => limit.limitId === "codex")?.credits
		: null;
	const raw = credits?.balance?.trim();
	const balance = raw ? Number(raw) : Number.NaN;
	const shown = Number.isFinite(balance)
		? balance.toLocaleString(undefined, { maximumFractionDigits: 20 })
		: "";
	const label = credits?.unlimited
		? t(
				limitReached
					? "usage.credits.inUseUnlimited"
					: "usage.credits.unlimited",
			)
		: Number.isFinite(balance) && balance >= 0
			? t(
					limitReached && balance > 0
						? "usage.credits.inUse"
						: "usage.credits.remaining",
					{ balance: shown },
				)
			: null;
	if (!label) return t("usage.credits.unavailable");
	return accountSnapshotFreshness(snapshot, nowSec) === "stale"
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

/** How a list shows a separate limit (a model's own budget): its weekly
 * window when the provider reports one, else the window that binds, under
 * the period and the provider's name for it. `resetLabel` is the raw
 * duration (`1d 2h`) for the caller's own sentence. */
export interface SeparateLimitView {
	id: string;
	label: string;
	pct: number;
	resetLabel: string | null;
}

export function separateLimitView(
	meter: NamedLimitMeter,
	fallbackName: string,
): SeparateLimitView {
	const weekly = meter.weeklyPct != null;
	const period =
		weekly || meter.window === "weekly"
			? t("usage.window.weekly")
			: meter.window === "5h"
				? t("usage.window.fiveHour")
				: null;
	const name = meter.limitName ?? fallbackName;
	return {
		id: meter.limitId,
		label: period ? `${period} · ${name}` : name,
		pct: meter.weeklyPct ?? meter.pct ?? 0,
		resetLabel: weekly ? meter.weeklyResetLabel : meter.resetLabel,
	};
}

/** Separate limits as one-line phrases for an account row: what each limit
 * is and when it resets (`Weekly · Fable 5.1 · resets in 1d 2h`), beside its
 * use. */
export function separateLimitPhrases(
	meters: readonly NamedLimitMeter[],
	fallbackName: string,
): { id: string; label: string; pct: number }[] {
	return meters.map((meter) => {
		const view = separateLimitView(meter, fallbackName);
		const reset = usageDurationLabel(view.resetLabel);
		return {
			id: view.id,
			label: reset
				? `${view.label} · ${t("usage.reset.inlineShort", { reset })}`
				: view.label,
			pct: view.pct,
		};
	});
}

/** Tooltip lines for separate limits: each window the provider reports,
 * with its reset. */
export function separateLimitTipLines(
	meters: readonly NamedLimitMeter[],
	fallbackName: string,
): string[] {
	const withReset = (line: string, reset: string | null) =>
		reset ? `${line} ${t("usage.reset.inlineDotted", { reset })}` : line;
	return meters.flatMap((meter) => {
		const model = meter.limitName ?? fallbackName;
		const pct = Math.round(meter.pct ?? 0);
		const primary =
			meter.window === "weekly"
				? t("usage.limit.tipModelWeeklyPct", { model, pct })
				: meter.window === "5h"
					? t("usage.limit.tipModelFiveHourPct", { model, pct })
					: t("usage.limit.tipNamedPct", { model, pct });
		const lines = [withReset(primary, meter.resetLabel)];
		if (meter.window === "5h" && meter.weeklyPct != null) {
			lines.push(
				withReset(
					t("usage.limit.tipModelWeeklyPct", {
						model,
						pct: Math.round(meter.weeklyPct),
					}),
					meter.weeklyResetLabel,
				),
			);
		}
		return lines;
	});
}
