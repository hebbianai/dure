import type { Ref } from "react";
import {
	type Report,
	useCodexUsage,
} from "@/components/usage/ProviderUsageDetail";
import {
	ProviderUsagePopoverContent,
	separateLimitRows,
	type UsagePopoverAccount,
	type UsagePopoverLimit,
	type UsageRefreshAction,
} from "@/components/usage/ProviderUsagePopoverContent";
import { accountMenuLimit } from "@/components/usage/AccountMenuLabel";
import { UsageMeterPopover } from "@/components/usage/UsageMeterPopover";
import { t } from "@/lib/i18n";
import { codexAccountMeter } from "@/lib/usage/accountUsageMeter";
import { accountSnapshotForCredential } from "@/lib/usage/accountUsageSnapshots";
import {
	codexCreditsLabel,
	codexResetCreditsLabel,
	separateLimitTipLines,
	usageDurationLabel,
	usageResetLabel,
} from "@/lib/usage/usageLabels";
import { fmtAgo, fmtTokens, highestPct } from "@/lib/usage/usageMeter";

export function CodexUsagePopover({
	u5,
	u24,
	nowSec,
	refresh,
	onAddAccount,
	triggerRef,
	restoreFocusOnClose = true,
}: {
	u5: Report;
	u24: Report | null;
	nowSec: number;
	refresh?: UsageRefreshAction;
	onAddAccount: () => void;
	triggerRef?: Ref<HTMLButtonElement>;
	restoreFocusOnClose?: boolean;
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
	const headlinePct = highestPct([meter, ...modelMeters]);
	const modelTip = separateLimitTipLines(
		modelMeters,
		t("usage.codex.separateModel"),
	).join("\n");
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
		...separateLimitRows(
			modelMeters,
			t("usage.codex.separateModel"),
			"codex-model-limit",
		),
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
		const accountSnapshot = accountSnapshotForCredential(
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
			pct: null,
			reset: null,
			...accountMenuLimit(accountMeter, t("usage.codex.separateModel")),
			credits: [
				codexResetCreditsLabel(accountSnapshot, nowSec),
				codexCreditsLabel(
					accountSnapshot,
					nowSec,
					(accountMeter?.pct ?? 0) >= 100,
				),
			],
		};
	};

	return (
		<UsageMeterPopover
			provider="codex"
			triggerRef={triggerRef}
			restoreFocusOnClose={restoreFocusOnClose}
			pct={headlinePct}
			tip={tip}
			dataSlot="codex-usage-popover"
		>
			<ProviderUsagePopoverContent
				provider="codex"
				onAddAccount={onAddAccount}
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
