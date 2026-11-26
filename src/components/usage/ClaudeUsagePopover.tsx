import type { Ref } from "react";
import { accountMenuLimit } from "@/components/usage/AccountMenuLabel";
import {
	claudeCheckSourceNotice,
	type Report,
	useClaudeUsage,
} from "@/components/usage/ProviderUsageDetail";
import {
	ProviderUsagePopoverContent,
	separateLimitRows,
	type UsagePopoverAccount,
	type UsagePopoverLimit,
	type UsageRefreshAction,
} from "@/components/usage/ProviderUsagePopoverContent";
import { UsageMeterPopover } from "@/components/usage/UsageMeterPopover";
import { resolveLang, t } from "@/lib/i18n";
import type { ClaudeCollectorState } from "@/lib/ipc";
import { claudeAccountMeter } from "@/lib/usage/accountUsageMeter";
import {
	separateLimitTipLines,
	usageDurationLabel,
	usageResetLabel,
} from "@/lib/usage/usageLabels";
import { fmtReset, fmtTokens, highestPct } from "@/lib/usage/usageMeter";
import { useStore } from "@/store";

function weeklyResetLabel(
	resetAt: number | null,
	nowSec: number,
	language: ReturnType<typeof resolveLang>,
) {
	if (!resetAt || resetAt <= nowSec) return null;
	const date = new Date(resetAt * 1000);
	const weekday = new Intl.DateTimeFormat(language, {
		weekday: "short",
	}).format(date);
	const time = new Intl.DateTimeFormat(language, {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
	return t("usage.reset.atWeekdayTime", { weekday, time });
}

export function ClaudeUsagePopover({
	u5,
	u24,
	nowSec,
	collector,
	installing,
	onInstall,
	refresh,
	onAddAccount,
	triggerRef,
	restoreFocusOnClose = true,
}: {
	u5: Report;
	u24: Report | null;
	nowSec: number;
	collector: ClaudeCollectorState | null;
	installing: boolean;
	onInstall: () => void;
	refresh?: UsageRefreshAction;
	onAddAccount: () => void;
	triggerRef?: Ref<HTMLButtonElement>;
	restoreFocusOnClose?: boolean;
}) {
	const language = resolveLang(useStore((state) => state.language));
	const usage = useClaudeUsage(u5, nowSec);
	const {
		working,
		resolved,
		snapshot,
		fromCheck,
		claude,
		used,
		meter,
		separateMeters,
		capturedAgo,
	} = usage;
	const separateName = t("usage.limit.separateModel");
	const rawReset =
		meter.resetLabel ??
		fmtReset(claude.resetsAt ?? claude.weeklyResetsAt, nowSec);
	const resetDuration = usageDurationLabel(rawReset);
	const reset = usageResetLabel(resetDuration);
	const weeklyReset = weeklyResetLabel(claude.weeklyResetsAt, nowSec, language);
	const captured = usageDurationLabel(capturedAgo);
	const tokenDetail = t(
		"usage.tokens.breakdown",
		{
			input: fmtTokens(claude.input),
			output: fmtTokens(claude.output),
			cacheWrite: fmtTokens(claude.cacheWrite),
		},
	);
	const pct = meter.pct == null ? null : Math.round(meter.pct);
	const generalPctTip =
		pct == null
			? null
			: meter.window === "weekly"
				? fromCheck
					? t("usage.claude.tipWeeklyPctChecked", { pct })
					: t("usage.claude.tipWeeklyPct", { pct })
				: fromCheck
					? t("usage.claude.tipFiveHourPctChecked", { pct })
					: t("usage.claude.tipFiveHourPct", { pct });
	const generalTip =
		generalPctTip &&
		`${generalPctTip}${rawReset ? ` ${t("usage.reset.inlineDotted", { reset: rawReset })}` : ""}`;
	const tip = [
		generalTip ??
			t("usage.claude.tipFiveHourTokens", { used: fmtTokens(used) }),
		...separateLimitTipLines(separateMeters, separateName),
		tokenDetail,
	].join("\n");
	const foreignNotice = t(
		"usage.collector.foreignStatusLine",
	);
	const scopedNotice = t(
		"usage.account.noHistoryYet",
	);
	const missingNotice = t(
		"usage.collector.missingPctLong",
	);
	const aggregateNotice = t(
		"usage.attribution.sharedTokensLong",
	).replace(" %", "\u00a0%");
	const notice =
		claudeCheckSourceNotice(usage, nowSec) ??
		(meter.pct != null
			? captured
				? t("usage.source.statusLineCapturedDetail", { ago: captured })
				: t("usage.source.statusLine")
			: collector === "foreign"
				? foreignNotice
				: resolved.scoped
					? scopedNotice
					: collector === "installed"
						? t("usage.collector.installedNotice")
						: missingNotice);
	// The check failed and the limits shown are not its own.
	const checkFailedNotice =
		snapshot?.error && !fromCheck ? t("usage.status.checkFailed") : null;
	const limits: UsagePopoverLimit[] = [];
	if (claude.usedPercent != null) {
		limits.push({
			id: "claude-5h",
			label: t("usage.limit.fiveHourLong"),
			value: `${Math.round(claude.usedPercent)}%`,
			pct: claude.usedPercent,
			reset,
		});
	}
	if (claude.usedPercentWeekly != null) {
		limits.push({
			id: "claude-weekly",
			label: t("usage.window.weeklyAllModels"),
			value: `${Math.round(claude.usedPercentWeekly)}%`,
			pct: claude.usedPercentWeekly,
			reset: weeklyReset,
		});
	}
	limits.push(
		...separateLimitRows(separateMeters, separateName, "claude-model-limit"),
	);
	const metrics =
		limits.length === 0
			? [
					{ label: t("usage.tokens.fiveHourLong"), value: fmtTokens(used) },
					{
						label: t("usage.tokens.last24hWithWorking", {
							total: fmtTokens(u24?.claude.total ?? 0),
							n: working,
						}),
						value: resetDuration
							? t("usage.reset.rowValue", { reset: resetDuration })
							: null,
						mutedValue: true,
					},
				]
			: [
					{ label: t("usage.tokens.fiveHourLong"), value: fmtTokens(used) },
					{
						label: t("usage.tokens.breakdownLabelLong"),
						value: `${fmtTokens(claude.input)} · ${fmtTokens(claude.output)} · ${fmtTokens(claude.cacheWrite)}`,
					},
					{
						label: t("usage.tokens.last24hTotal"),
						value: fmtTokens(u24?.claude.total ?? 0),
					},
					{ label: t("usage.agents.working"), value: String(working) },
				];
	const accountLimit = (profile: UsagePopoverAccount) =>
		accountMenuLimit(
			claudeAccountMeter(
				u5.claudeAccounts,
				u5.claudeAccountSnapshots,
				profile.id,
				profile.dir,
				nowSec,
			),
			separateName,
		);

	return (
		<UsageMeterPopover
			provider="claude"
			triggerRef={triggerRef}
			restoreFocusOnClose={restoreFocusOnClose}
			pct={highestPct([meter, ...separateMeters])}
			tip={tip}
			dataSlot="claude-usage-popover"
		>
			<ProviderUsagePopoverContent
				provider="claude"
				onAddAccount={onAddAccount}
				title="Claude"
				refresh={refresh}
				accountLimit={accountLimit}
				limits={limits}
				metrics={metrics}
				notices={[
					notice,
					checkFailedNotice,
					limits.length > 0 ? aggregateNotice : null,
				].filter((entry): entry is string => entry != null)}
				secondaryAction={
					meter.pct == null && collector === "not_installed"
						? {
								label: installing ? t("common.installing") : t("usage.collector.install"),
								detail: (
									<span
										aria-hidden="true"
										className="font-normal text-muted-foreground"
									>
										statusLine
									</span>
								),
								disabled: installing,
								onClick: onInstall,
							}
						: undefined
				}
			/>
		</UsageMeterPopover>
	);
}
