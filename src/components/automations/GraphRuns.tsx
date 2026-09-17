import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { GraphCanvas } from "@/components/automations/GraphCanvas";
import { SafeMarkdown } from "@/components/common/SafeMarkdown";
import {
	EmptyHint, LoadingRow} from "@/components/common/StatusBlocks";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Segmented } from "@/components/ui/segmented";
import type { WorkflowRunSummary } from "@/lib/automations/graphContract";
import {
	graphErrorMessage,
	graphFieldLabel,
} from "@/lib/automations/graphMessages";
import { observeRunHistory } from "@/lib/automations/observeRunHistory";
import { t } from "@/lib/i18n";
import {
	type DureBackendRouteAuthorityV1,
	sameDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";
import type { GraphClient } from "@/lib/ipc/dureGraph";
import { cn } from "@/lib/utils";

export function GraphRuns({
	client,
	workflowId,
	authority,
	initialRunId,
}: {
	client: GraphClient;
	workflowId: string;
	authority: DureBackendRouteAuthorityV1;
	initialRunId?: string;
}) {
	const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
	const [selected, setSelected] = useState(initialRunId);
	const [observation, setObservation] = useState<{
		authority: DureBackendRouteAuthorityV1;
		inspection: Awaited<ReturnType<GraphClient["inspect"]>>;
	}>();
	// Navigation and refresh request reads. Publishing the default selection
	// updates presentation without requesting the same history again.
	const [query, setQuery] = useState<{ runId?: string; nodeId?: string }>({
		runId: initialRunId,
	});
	const [tab, setTab] = useState<"inputs" | "outputs">("outputs");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (initialRunId) {
			setSelected(initialRunId);
			setQuery((current) =>
				current.runId === initialRunId ? current : { runId: initialRunId },
			);
		}
	}, [initialRunId]);
	useEffect(() => {
		let selectedRun = query.runId;
		return observeRunHistory({
			list: () => client.runs(workflowId, authority),
			select: (runs) => selectedRun ?? runs[0]?.runId,
			inspect: (id) => client.inspect(id, authority, query.nodeId),
			onResult: (runs, inspected) => {
				selectedRun = inspected?.run.runId;
				setRuns(runs);
				setObservation(
					inspected ? { authority, inspection: inspected } : undefined,
				);
				setError(undefined);
				setSelected(selectedRun);
			},
			onError: (reason) => {
				setError(graphErrorMessage(reason));
				setObservation(undefined);
			},
			onLoading: setLoading,
		});
	}, [client, workflowId, authority, query]);
	// Keep the canvas during same-Run reads, but never lend an old result to
	// a newly selected Run or backend while its observation is pending.
	const inspection =
		observation &&
		sameDureBackendRouteAuthority(observation.authority, authority) &&
		observation.inspection.run.workflowId === workflowId &&
		observation.inspection.run.runId === selected
			? observation.inspection
			: undefined;
	const task = inspection?.task;
	const node = inspection?.version.definition.nodes.find(
		(node) => node.nodeId === task?.nodeId,
	);
	const state = task?.state;
	const values =
		state && state.kind !== "pending"
			? tab === "inputs"
				? state.inputs
				: state.kind === "completed" || state.kind === "failed"
					? state.outputs
					: undefined
			: undefined;
	return (
		<div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[190px_minmax(0,1fr)] md:grid-rows-1">
			<aside className="max-h-36 overflow-y-auto border-b border-border p-3 md:max-h-none md:border-r md:border-b-0">
				<div className="mb-3 flex items-center justify-between">
					<span className="text-xs font-medium">{t("automations.runs")}</span>
					<RefreshButton
						busy={loading}
						onClick={() => setQuery({ ...query, runId: selected })}
					/>
				</div>
				{runs.map((run) => (
					<button
						type="button"
						key={run.runId}
						onClick={() => {
							setSelected(run.runId);
							setQuery({ runId: run.runId });
						}}
						className={cn(
							"mb-1 block w-full rounded-lg p-2 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
							selected === run.runId && "bg-muted",
						)}
					>
						<span className="block">
							{new Date(run.createdAtMs).toLocaleString()}
						</span>
						<span className="mt-1 block text-[11px] text-muted-foreground">
							{t("automations.graph.version", { version: run.workflowVersion })}{" "}
							·{" "}
							{t(
								run.trigger.kind === "manual"
									? "automations.graph.manual"
									: "automations.graph.schedule",
							)}
						</span>
						<span className="mt-1 block text-[11px] text-muted-foreground">
							{t(`automations.graph.states.${run.status}`)}
						</span>
					</button>
				))}
				{!loading && runs.length === 0 && (
					<EmptyHint>{t("automations.graph.noRuns")}</EmptyHint>
				)}
				{runs.length === 128 && (
					<p className="text-[11px] text-muted-foreground">
						{t("automations.limited")}
					</p>
				)}
			</aside>
			<div className="flex min-h-0 min-w-0 flex-col">
				{error && <Alert className="m-3">{error}</Alert>}
				{loading && !inspection && (
					<LoadingRow className="p-4">{t("common.loading")}</LoadingRow>
				)}
				{inspection && (
					<>
						<div className="flex-1 min-h-[220px]">
							<GraphCanvas
								definition={inspection.version.definition}
								tasks={inspection.tasks}
								selected={task?.nodeId}
								onSelect={(nodeId) => setQuery({ runId: selected, nodeId })}
								editable={false}
								positions={{}}
								onPositions={() => {}}
							/>
						</div>
						<section
							className="max-h-[52%] min-h-36 overflow-y-auto border-t border-border bg-background p-4"
							aria-label={t("automations.graph.stepResult")}
						>
							<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
								<h3 className="text-xs font-medium">{node?.name}</h3>
								<Segmented
									value={tab}
									onChange={setTab}
									size="sm"
									options={[
										{ value: "inputs", label: t("automations.graph.inputs") },
										{ value: "outputs", label: t("automations.graph.outputs") },
									]}
								/>
							</div>
							{state?.kind === "failed" && (
								<Alert className="mb-3">
									{t(
										state.uncertain
											? "automations.graph.uncertainHelp"
											: "automations.graph.failedHelp",
										{ code: state.code },
									)}
								</Alert>
							)}
							{!values && (
								<EmptyHint>
									{t(
										state?.kind === "pending"
											? "automations.graph.notStarted"
											: "automations.graph.waitingOutput",
									)}
								</EmptyHint>
							)}
							{values && (
								<div className="space-y-4">
									{Object.entries(values).map(([field, value]) => {
										const binding =
											tab === "inputs" ? node?.inputs[field] : undefined;
										return (
											<div key={field} className="space-y-1.5">
												<h4 className="text-[11px] font-medium text-muted-foreground">
													{graphFieldLabel(field)}
												</h4>
												{binding?.kind === "output" && (
													<p className="text-[11px] text-muted-foreground">
														{t("automations.graph.fromStep", {
															name:
																inspection.version.definition.nodes.find(
																	(node) => node.nodeId === binding.nodeId,
																)?.name ?? binding.nodeId,
															field: graphFieldLabel(binding.field),
														})}
													</p>
												)}
												{field === "resultMarkdown" &&
												typeof value === "string" ? (
													<SafeMarkdown markdown={value} />
												) : (
													<pre className="max-h-64 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11px] whitespace-pre-wrap break-words">
														{typeof value === "string"
															? value
															: JSON.stringify(value, null, 2)}
													</pre>
												)}
											</div>
										);
									})}
								</div>
							)}
						</section>
					</>
				)}
			</div>
		</div>
	);
}
