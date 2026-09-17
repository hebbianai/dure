import {
	type Report,
	useCodexUsage,
} from "@/components/usage/ProviderUsageDetail";
import {
	ProviderUsagePopoverContent,
	type UsagePopoverAccount,
	type UsagePopoverLimit,
	type UsageRefreshAction,
} from "@/components/usage/ProviderUsagePopoverContent";
import { UsageMeterPopover } from "@/components/usage/UsageMeterPopover";
import { t } from "@/lib/i18n";
import { codexAccountMeter } from "@/lib/usage/accountUsageMeter";
import { codexSnapshotForCredential } from "@/lib/usage/codexUsageSnapshots";
import {
	codexCreditsLabel,
	codexResetCreditsLabel,
	usageDurationLabel,
	usageResetLabel,
} from "@/lib/usage/usageLabels";
import { fmtAgo, fmtTokens } from "@/lib/usage/usageMeter";

export function CodexUsagePopover({
	u5,
	u24,
	nowSec,
	refresh,
}: {
	u5: Report;
	u24: Report | null;
	nowSec: number;
	refresh?: UsageRefreshAction;
}) {
	const {
		working,
		resolved,
		snapshot,
		codex,
		dailyTotal,
		unattributed,
		meter,
		modelMeters,
		weeklyReset,
	} = useCodexUsage(u5, u24, nowSec);
	const headlinePct = [meter, ...modelMeters].reduce<number | null>(
		(highest, candidate) =>
			candidate.pct == null
				? highest
				: Math.max(highest ?? candidate.pct, candidate.pct),
		null,
	);
	const modelTip = modelMeters
		.flatMap((candidate) => {
			const model = candidate.limitName ?? t("usage.codex.separateModel");
			const primary =
				candidate.window === "weekly"
					? t("usage.codex.tipModelWeeklyPct", {
							model,
							pct: Math.round(candidate.pct ?? 0),
						})
					: t("usage.codex.tipModelFiveHourPct", {
							model,
							pct: Math.round(candidate.pct ?? 0),
						});
			const withReset = candidate.resetLabel
				? `${primary} ${t("usage.reset.inlineDotted", { reset: candidate.resetLabel })}`
				: primary;
			if (candidate.window === "weekly" || candidate.weeklyPct == null) {
				return [withReset];
			}
			const weekly = t("usage.codex.tipModelWeeklyPct", {
				model,
				pct: Math.round(candidate.weeklyPct),
			});
			return [
				withReset,
				candidate.weeklyResetLabel
					? `${weekly} ${t("usage.reset.inlineDotted", { reset: candidate.weeklyResetLabel })}`
					: weekly,
			];
		})
		.join("\n");
	const tip =
		(meter.pct == null
			? modelMeters.length > 0
				? t("usage.codex.generalLimitNoData")
				: t("usage.codex.noRateLimitData")
			: meter.window === "weekly"
				? t("usage.codex.tipWeeklyPct", { pct: Math.round(meter.pct) })
				: t("usage.codex.tipFiveHourPct", { pct: Math.round(meter.pct) })) +
		(meter.resetLabel
			? ` ${t("usage.reset.inlineDotted", { reset: meter.resetLabel })}`
			: "") +
		(meter.window !== "weekly" && codex.usedPercentWeekly != null
			? `\n${t("usage.codex.tipWeeklyBare", { pct: Math.round(codex.usedPercentWeekly) })}${
					weeklyReset
						? ` ${t("usage.reset.inlineDotted", { reset: weeklyReset })}`
						: ""
				}`
			: "") +
		(modelTip ? `\n${modelTip}` : "") +
		`\n${t("usage.tokens.last24hWithAgents", {
			total: fmtTokens(dailyTotal),
			n: working,
		})}`;
	const limits: UsagePopoverLimit[] = [
		...(codex.usedPercentWeekly != null
			? [
					{
						id: "codex",
						label: t("usage.window.weeklyAllModels"),
						value: `${Math.round(codex.usedPercentWeekly)}%`,
						pct: codex.usedPercentWeekly,
						reset: usageResetLabel(usageDurationLabel(weeklyReset)),
					} satisfies UsagePopoverLimit,
				]
			: meter.pct != null
				? [
						{
							id: "codex",
							label:
								meter.window === "weekly"
									? t("usage.window.weeklyAllModels")
									: t("usage.window.fiveHourAllModels"),
							value: `${Math.round(meter.pct)}%`,
							pct: meter.pct,
							reset: usageResetLabel(usageDurationLabel(meter.resetLabel)),
						} satisfies UsagePopoverLimit,
					]
				: []),
		...modelMeters.map((candidate): UsagePopoverLimit => {
			const weekly = candidate.weeklyPct != null;
			return {
				id: candidate.limitId,
				dataSlot: "codex-model-limit",
				label: `${weekly || candidate.window === "weekly" ? t("usage.window.weekly") : t("usage.window.fiveHour")} · ${candidate.limitName ?? t("usage.codex.separateModel")}`,
				value: `${Math.round(candidate.weeklyPct ?? candidate.pct ?? 0)}%`,
				pct: candidate.weeklyPct ?? candidate.pct,
				reset: usageResetLabel(
					usageDurationLabel(
						weekly ? candidate.weeklyResetLabel : candidate.resetLabel,
					),
				),
			};
		}),
	];
	const aggregateNotice = t("usage.attribution.noneTotalLong");
	const observedNotice = t("usage.attribution.observedOnly");
	const notices = [
		snapshot?.capturedAt
			? snapshot.error
				? t("usage.source.appServerFailedKeepLast", {
						ago: fmtAgo(snapshot.capturedAt, nowSec) ?? "—",
					})
				: t("usage.source.appServerCaptured", {
						ago: fmtAgo(snapshot.capturedAt, nowSec) ?? "—",
					})
			: snapshot?.error
				? t("usage.status.checkFailed")
				: meter.pct == null && modelMeters.length === 0
					? t("usage.status.noneObserved")
					: t("usage.source.sessionRecord"),
		!resolved.scoped
			? aggregateNotice
			: resolved.observedOnly
				? observedNotice
				: null,
		resolved.scoped && unattributed != null && unattributed.usage.total > 0
			? t("usage.attribution.unattributedExcluded", {
					total: fmtTokens(unattributed.usage.total),
				})
			: null,
	].filter((notice): notice is string => notice != null);
	const accountLimit = (profile: UsagePopoverAccount) => {
		const accountSnapshot = codexSnapshotForCredential(
			u5.codexAccountSnapshots,
			profile.id,
		);
		const accountMeter = codexAccountMeter(
			u5.codexAccounts,
			u5.codexAccountSnapshots,
			profile.id,
			nowSec,
		);
		return {
			pct: accountMeter?.pct ?? null,
			reset: usageResetLabel(
				usageDurationLabel(accountMeter?.resetLabel ?? null),
			),
			credits: [
				codexResetCreditsLabel(accountSnapshot, nowSec),
				codexCreditsLabel(accountSnapshot, nowSec),
			],
		};
	};

	return (
		<UsageMeterPopover
			provider="codex"
			pct={headlinePct}
			tip={tip}
			dataSlot="codex-usage-popover"
		>
			<ProviderUsagePopoverContent
				provider="codex"
				title="Codex"
				refresh={refresh}
				accountLimit={accountLimit}
				limits={limits}
				metrics={[
					{
						label: t("usage.tokens.last24hTotal"),
						value: fmtTokens(dailyTotal),
					},
					{ label: t("usage.agents.working"), value: String(working) },
				]}
				notices={notices}
			/>
		</UsageMeterPopover>
	);
}
