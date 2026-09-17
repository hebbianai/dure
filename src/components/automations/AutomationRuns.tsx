import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { SafeMarkdown } from "@/components/common/SafeMarkdown";
import {
	EmptyHint, LoadingRow} from "@/components/common/StatusBlocks";
import { RefreshButton } from "@/components/ui/refresh-button";
import { observeRunHistory } from "@/lib/automations/observeRunHistory";
import {
	occurrenceStatus,
	type ScheduleOccurrence,
	scheduleErrorMessage,
} from "@/lib/automations/scheduleContract";
import { t } from "@/lib/i18n";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { ScheduleClient } from "@/lib/ipc/dureSchedule";
import { cn } from "@/lib/utils";

export function AutomationRuns({
	client,
	authority,
	scheduleId,
	initialSelection,
}: {
	client: ScheduleClient;
	authority: DureBackendRouteAuthorityV1;
	scheduleId: string;
	initialSelection?: string;
}) {
	const [runs, setRuns] = useState<ScheduleOccurrence[]>([]);
	const [selected, setSelected] = useState(initialSelection);
	const [report, setReport] =
		useState<Awaited<ReturnType<ScheduleClient["inspect"]>>>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [refresh, setRefresh] = useState(0);
	useEffect(() => {
		setReport(undefined);
		return observeRunHistory({
			list: () => client.occurrences(scheduleId, authority),
			select: (runs) => selected ?? runs[0]?.idempotencyKey,
			inspect: (key) => client.inspect(key, authority),
			onList: setRuns,
			onResult: (_runs, next) => {
				setReport(next);
				setError(undefined);
			},
			onError: (reason) => setError(scheduleErrorMessage(reason)),
			onLoading: setLoading,
		});
	}, [client, authority, scheduleId, selected, refresh]);
	return (
		<section
			className="grid min-h-[340px] min-w-0 gap-0 md:grid-cols-[230px_minmax(0,1fr)]"
			aria-label={t("automations.runs")}
		>
			<div className="min-w-0 border-b border-border p-3 md:border-r md:border-b-0">
				<div className="mb-2 flex items-center justify-between gap-2">
					<h3 className="text-xs font-medium">{t("automations.recentRuns")}</h3>
					<RefreshButton
						busy={loading}
						disabled={loading}
						onClick={() => setRefresh((value) => value + 1)}
					/>
				</div>
				{loading && runs.length === 0 && (
					<LoadingRow>{t("common.loading")}</LoadingRow>
				)}
				{!loading && !error && runs.length === 0 && (
					<EmptyHint>{t("automations.noRuns")}</EmptyHint>
				)}
				<div className="max-h-[360px] space-y-1 overflow-y-auto">
					{runs.map((run) => (
						<button
							type="button"
							key={run.idempotencyKey}
							aria-pressed={
								report?.occurrence.idempotencyKey === run.idempotencyKey
							}
							className={cn(
								"w-full rounded-lg p-2 text-left text-xs hover:bg-muted",
								report?.occurrence.idempotencyKey === run.idempotencyKey &&
									"bg-muted",
							)}
							onClick={() => setSelected(run.idempotencyKey)}
						>
							<span className="block">
								{new Date(run.createdAtMs).toLocaleString()}
							</span>
							<span className="mt-1 block text-[11px] text-muted-foreground">
								{t(
									run.trigger.kind === "manual"
										? "automations.manual"
										: "automations.scheduled",
								)}{" "}
								· {occurrenceStatus(run)}
							</span>
						</button>
					))}
				</div>
				{runs.length === 128 && (
					<p className="mt-2 text-xs text-muted-foreground">
						{t("automations.limited")}
					</p>
				)}
			</div>
			<div className="min-w-0 space-y-4 bg-background p-5">
				{error && <Alert>{error}</Alert>}
				{report && (
					<>
						<div className="space-y-1">
							<h3 className="text-sm font-medium">
								{occurrenceStatus(report.occurrence)}
							</h3>
							<p className="text-xs text-muted-foreground">
								{t("automations.runRevision", {
									revision: report.occurrence.scheduleRevision,
								})}
							</p>
						</div>
						{report.occurrence.errorCode && (
							<Alert>{report.occurrence.errorCode}</Alert>
						)}
						{report.resultMarkdown !== null ? (
							<SafeMarkdown markdown={report.resultMarkdown} />
						) : (
							<p className="text-xs leading-6 text-muted-foreground">
								{t("automations.noReport")}
							</p>
						)}
						{report.occurrence.run && (
							<dl className="grid min-w-0 gap-1 border-t border-border pt-3 text-[11px] text-muted-foreground">
								<dt>{t("automations.workspace")}</dt>
								<dd className="break-all font-mono" data-selectable>
									{report.occurrence.run.workspaceId}
								</dd>
							</dl>
						)}
					</>
				)}
			</div>
		</section>
	);
}
