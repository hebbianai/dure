import { Titled } from "@/components/ui/tooltip";

export interface AccountMenuLimit {
	pct: number | null;
	reset: string | null;
	credits?: readonly string[];
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
