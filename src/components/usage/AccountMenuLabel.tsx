import { Titled } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import type { AccountUsageMeter } from "@/lib/usage/accountUsageMeter";
import {
	separateLimitPhrases,
	usageDurationLabel,
	usageResetLabel,
} from "@/lib/usage/usageLabels";

/** A separate limit in use on the account, such as a model's own weekly
 * window: what it is and when it resets in one phrase, and its use. */
interface AccountMenuSeparateLimit {
	id: string;
	label: string;
	pct: number;
}

export interface AccountMenuLimit {
	pct: number | null;
	reset: string | null;
	credits?: readonly string[];
	separate?: readonly AccountMenuSeparateLimit[];
}

/** An account's meter as its menu row shows it. `fallbackName` names a
 * separate limit the provider gave no name. */
export function accountMenuLimit(
	meter: AccountUsageMeter | null,
	fallbackName = t("usage.limit.separateModel"),
): AccountMenuLimit | null {
	if (!meter) return null;
	return {
		pct: meter.pct,
		reset: usageResetLabel(usageDurationLabel(meter.resetLabel)),
		separate: separateLimitPhrases(meter.separate, fallbackName),
	};
}

/** The limit's phrases for an accessible description of the row. */
export function accountMenuLimitDescription(
	limit: AccountMenuLimit | null,
): string {
	return [
		limit?.reset,
		limit?.pct != null ? `${Math.round(limit.pct)}%` : null,
		...(limit?.separate ?? []).map(
			(separate) => `${separate.label} ${Math.round(separate.pct)}%`,
		),
		...(limit?.credits ?? []),
	]
		.filter((value): value is string => value != null)
		.join(" · ");
}

/** Keep account identity separate from secondary usage or login information. */
export function AccountMenuLabel({
	label,
	limit,
	detail,
}: {
	label: string;
	limit?: AccountMenuLimit | null;
	detail?: string;
}) {
	return (
		<span className="flex min-w-0 flex-1 flex-col gap-0.5">
			<Titled title={label}>
				<span data-slot="account-menu-label" className="truncate text-xs">
					{label}
				</span>
			</Titled>
			{(detail || limit?.reset || limit?.pct != null) && (
				<span
					data-slot="account-menu-detail"
					className="flex min-w-0 items-baseline justify-between gap-3 text-meta leading-snug text-muted-foreground"
				>
					<span className="min-w-0 whitespace-normal break-words">
						{detail ?? limit?.reset}
					</span>
					{!detail && limit?.pct != null && (
						<span className="shrink-0 font-mono tabular-nums">
							{Math.round(limit.pct)}%
						</span>
					)}
				</span>
			)}
			{!detail &&
				limit?.separate?.map((separate) => (
					<span
						key={separate.id}
						data-slot="account-menu-separate-limit"
						className="flex min-w-0 items-baseline justify-between gap-3 text-meta leading-snug text-muted-foreground"
					>
						<span className="min-w-0 whitespace-normal break-words">
							{separate.label}
						</span>
						<span className="shrink-0 font-mono tabular-nums">
							{Math.round(separate.pct)}%
						</span>
					</span>
				))}
			{!detail && limit?.credits && (
				<span className="flex flex-wrap gap-x-3 gap-y-0.5 whitespace-normal break-words text-meta leading-snug text-muted-foreground tabular-nums">
					{limit.credits.map((credit) => (
						<span key={credit}>{credit}</span>
					))}
				</span>
			)}
		</span>
	);
}
