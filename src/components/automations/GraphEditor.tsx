import {
	Bot,
	Clock3,
	Play,
	Plus,
	Save,
	Terminal,
	Workflow,
	X,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { useEffect, useState } from "react";
import { GraphCanvas } from "@/components/automations/GraphCanvas";
import { GraphInspector } from "@/components/automations/GraphInspector";
import { GraphRuns } from "@/components/automations/GraphRuns";
import { useAutomationAction } from "@/components/automations/useAutomations";
import { useGraphLayout } from "@/components/automations/useGraphLayout";
import { FormField } from "@/components/common/FormField";
import {
	EmptyHint, LoadingRow} from "@/components/common/StatusBlocks";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Segmented } from "@/components/ui/segmented";
import type {
	ActionContract,
	GraphIssue,
	WorkflowRecord,
} from "@/lib/automations/graphContract";
import {
	appendNode,
	dailyReviewWorkflow,
	emptyWorkflow,
	workflowDraft,
} from "@/lib/automations/graphEditing";
import {
	graphErrorMessage,
	graphIssueMessage,
} from "@/lib/automations/graphMessages";
import { t } from "@/lib/i18n";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { GraphChangeIntent, GraphClient } from "@/lib/ipc/dureGraph";
import type { ScheduleClient, ScheduleProject } from "@/lib/ipc/dureSchedule";

interface GraphEditorProps {
	client: GraphClient;
	scheduleClient: ScheduleClient;
	authority: DureBackendRouteAuthorityV1;
	workflowId?: string;
	pro: boolean;
	onSaved: () => void;
	onClose: () => void;
}

export function GraphEditor(props: GraphEditorProps) {
	const [workflow, setWorkflow] = useState<WorkflowRecord>();
	const [loaded, setLoaded] = useState(!props.workflowId);
	const [error, setError] = useState<string>();
	useEffect(() => {
		let current = true;
		if (!props.workflowId) return;
		void props.client
			.show(props.workflowId, props.authority)
			.then((workflow) => {
				if (current) setWorkflow(workflow);
			})
			.catch((reason) => {
				if (current) setError(graphErrorMessage(reason));
			})
			.finally(() => {
				if (current) setLoaded(true);
			});
		return () => {
			current = false;
		};
	}, [props.client, props.authority, props.workflowId]);
	if (!loaded || error)
		return (
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open) props.onClose();
				}}
			>
				<DialogContent>
					<DialogTitle>{t("automations.title")}</DialogTitle>
					<DialogDescription>
						{t("automations.runtime", { name: props.authority.profileId })}
					</DialogDescription>
					{error ? (
						<Alert>{error}</Alert>
					) : (
						<LoadingRow>{t("common.loading")}</LoadingRow>
					)}
				</DialogContent>
			</Dialog>
		);
	return <GraphEditorReady {...props} workflow={workflow} />;
}

function GraphEditorReady({
	client,
	scheduleClient,
	authority,
	workflow,
	pro,
	onSaved,
	onClose,
}: {
	client: GraphClient;
	scheduleClient: ScheduleClient;
	authority: DureBackendRouteAuthorityV1;
	workflow?: WorkflowRecord;
	pro: boolean;
	onSaved: () => void;
	onClose: () => void;
}) {
	const [workflowId] = useState(
		() => workflow?.workflowId ?? `workflow-${crypto.randomUUID()}`,
	);
	const [saved, setSaved] = useState(workflow);
	const [initial] = useState(() =>
		workflow ? workflowDraft(workflow) : emptyWorkflow(),
	);
	const [draft, setDraft] = useState(initial);
	const [tab, setTab] = useState<"editor" | "runs">(pro ? "editor" : "runs");
	const [selected, setSelected] = useState<string | undefined>(
		initial.definition.nodes[0]?.nodeId,
	);
	const [catalog, setCatalog] = useState<ActionContract[]>([]);
	const [projects, setProjects] = useState<ScheduleProject[]>([]);
	const [issues, setIssues] = useState<GraphIssue[]>([]);
	const [loading, setLoading] = useState(true);
	const [validating, setValidating] = useState(true);
	const [projectError, setProjectError] = useState(false);
	const [catalogError, setCatalogError] = useState<string>();
	const [validationError, setValidationError] = useState<string>();
	const error = catalogError ?? validationError;
	const [confirmClose, setConfirmClose] = useState(false);
	const [testRunId, setTestRunId] = useState<string>();
	const action = useAutomationAction(graphErrorMessage);
	const layout = useGraphLayout(
		JSON.stringify([authority.profileId, authority.backend.id, workflowId]),
	);
	const dirty =
		JSON.stringify(draft) !==
		JSON.stringify(saved ? workflowDraft(saved) : initial);
	const locked = action.busy || action.retryable;
	const editable = pro && !locked && !loading;
	const valid =
		!validating &&
		issues.length === 0 &&
		!error &&
		draft.definition.nodes.length > 0;
	const node = draft.definition.nodes.find((node) => node.nodeId === selected);
	useEffect(() => {
		let current = true;
		void Promise.allSettled([
			client.catalog(authority),
			scheduleClient.projects(authority),
		]).then(([catalog, projects]) => {
			if (!current) return;
			if (catalog.status === "fulfilled") setCatalog(catalog.value);
			else setCatalogError(graphErrorMessage(catalog.reason));
			if (projects.status === "fulfilled") setProjects(projects.value.projects);
			else setProjectError(true);
			setLoading(false);
		});
		return () => {
			current = false;
		};
	}, [client, scheduleClient, authority]);
	useEffect(() => {
		let current = true;
		setValidating(true);
		const timer = window.setTimeout(() => {
			void client
				.validate(draft, authority)
				.then((result) => {
					if (current) {
						setIssues(result.issues);
						setValidationError(undefined);
					}
				})
				.catch((reason) => {
					if (current) setValidationError(graphErrorMessage(reason));
				})
				.finally(() => {
					if (current) setValidating(false);
				});
		}, 300);
		return () => {
			current = false;
			window.clearTimeout(timer);
		};
	}, [client, draft, authority]);
	function changeIntent(): GraphChangeIntent {
		return {
			schemaVersion: 1,
			workflowId,
			expectedRevision: saved?.revision ?? 0,
			idempotencyKey: `workflow-${crypto.randomUUID()}`,
		};
	}
	function save() {
		const intent = { ...draft, ...changeIntent() };
		void action.perform(async () => {
			const result = await client.put(intent, authority);
			setSaved(result);
			setDraft(workflowDraft(result));
			onSaved();
		});
	}
	function change(operation: "activate" | "pause") {
		const intent = changeIntent();
		void action.perform(async () => {
			const result = await client[operation](intent, authority);
			setSaved(result);
			onSaved();
		});
	}
	function testRun() {
		const intent = changeIntent();
		void action.perform(async () => {
			const run = await client.runOnce(intent, authority);
			setTestRunId(run.runId);
			setTab("runs");
		});
	}
	function close() {
		if (action.busy) return;
		if (dirty || action.retryable) setConfirmClose(true);
		else onClose();
	}
	function add(contract: ActionContract) {
		const result = appendNode(
			draft.definition,
			contract.action,
			t(`automations.graph.actions.${contract.action.actionId}`),
			node?.nodeId,
		);
		setDraft({ ...draft, definition: result.definition });
		setSelected(result.nodeId);
	}
	function useDailyReview() {
		setDraft(
			dailyReviewWorkflow(
				{
					name: draft.name || t("automations.graph.dailyReview"),
					collect: t("automations.graph.collectChanges"),
					review: t("automations.graph.reviewChanges"),
					prompt: t("automations.graph.reviewPrompt"),
				},
				Intl.DateTimeFormat().resolvedOptions().timeZone,
				projects.length === 1 ? projects[0].id : undefined,
			),
		);
		setSelected("collect");
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent
				className="flex h-[calc(100dvh-2rem)] max-h-[900px] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1440px]"
				showCloseButton={false}
				dismiss="escape-only"
			>
				<header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-4">
					<div className="min-w-0">
						<DialogTitle className="truncate text-sm">
							{saved?.name ?? t("automations.new")}
						</DialogTitle>
						<DialogDescription className="mt-1 text-[11px]">
							{t("automations.runtime", { name: authority.profileId })}
						</DialogDescription>
					</div>
					<div className="flex items-center gap-2">
						<span className="text-[11px] text-muted-foreground">
							{saved?.enabled && saved.activeVersion
								? t("automations.graph.draftVersion", {
										version: saved.activeVersion,
									})
								: t("automations.graph.draft")}
						</span>
						<IconButton
							title={t("common.close")}
							showTooltip={false}
							disabled={action.busy}
							onClick={close}
						>
							<X />
						</IconButton>
					</div>
				</header>
				<div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-2.5">
					<Segmented
						value={tab}
						onChange={setTab}
						size="sm"
						options={[
							{ value: "editor", label: t("automations.graph.editor") },
							{ value: "runs", label: t("automations.runs") },
						]}
					/>
					<div className="flex flex-wrap items-center gap-2">
						{saved?.enabled && (
							<Button
								size="sm"
								variant="ghost"
								disabled={locked}
								onClick={() => change("pause")}
							>
								{t("automations.graph.pause")}
							</Button>
						)}
						{pro && (
							<>
								<Button
									size="sm"
									variant="outline"
									disabled={
										!editable || !draft.name.trim() || (!dirty && !!saved)
									}
									onClick={save}
								>
									<Save />
									{t("automations.graph.saveDraft")}
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={!editable || !saved || dirty || !valid}
									onClick={testRun}
								>
									<Play />
									{t("automations.testRun")}
								</Button>
								<Button
									size="sm"
									disabled={!editable || !saved || dirty || !valid}
									onClick={() => change("activate")}
								>
									{t("automations.graph.activate")}
								</Button>
							</>
						)}
					</div>
				</div>
				{(error || action.error) && (
					<Alert className="mx-4 mt-3">
						{error ?? action.error}
						{action.retryable && (
							<Button
								size="xs"
								variant="outline"
								onClick={() => void action.perform()}
							>
								{t("common.retry")}
							</Button>
						)}
					</Alert>
				)}
				{projectError && tab === "editor" && (
					<p className="mx-5 mt-3 text-[11px] text-muted-foreground">
						{t("automations.graph.projectLookupFailed")}
					</p>
				)}
				{loading && (
					<LoadingRow className="p-4">{t("common.loading")}</LoadingRow>
				)}
				{tab === "runs" ? (
					<GraphRuns
						client={client}
						authority={authority}
						workflowId={workflowId}
						initialRunId={testRunId}
					/>
				) : (
					<>
						<div className="grid shrink-0 gap-3 border-b border-border px-5 py-3 sm:grid-cols-[minmax(150px,1fr)_minmax(150px,1fr)]">
							<FormField label={t("automations.name")}>
								<Input
									value={draft.name}
									disabled={!editable}
									onChange={(event) =>
										setDraft({ ...draft, name: event.target.value })
									}
								/>
							</FormField>
							<FormField label={t("automations.trigger")}>
								<SelectField
									value={draft.trigger.kind}
									disabled={!editable}
									onValueChange={(nextValue) =>
										setDraft({
											...draft,
											trigger:
												nextValue === "manual"
													? { kind: "manual" }
													: {
															kind: "schedule",
															expression: "0 9 * * 1-5",
															timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
														},
										})
									}
								>
									<SelectOption value="manual">{t("automations.graph.manual")}</SelectOption>
									<SelectOption value="schedule">
										{t("automations.graph.schedule")}
									</SelectOption>
								</SelectField>
							</FormField>
							{draft.trigger.kind === "schedule" && (
								<>
									<FormField
										label={t("automations.expression")}
										description={t("automations.cronHelp")}
									>
										<Input
											value={draft.trigger.expression}
											disabled={!editable}
											onChange={(event) => {
												if (draft.trigger.kind === "schedule")
													setDraft({
														...draft,
														trigger: {
															...draft.trigger,
															expression: event.target.value,
														},
													});
											}}
										/>
									</FormField>
									<FormField label={t("automations.timezone")}>
										<Input
											value={draft.trigger.timezone}
											disabled={!editable}
											onChange={(event) => {
												if (draft.trigger.kind === "schedule")
													setDraft({
														...draft,
														trigger: {
															...draft.trigger,
															timezone: event.target.value,
														},
													});
											}}
										/>
									</FormField>
								</>
							)}
						</div>
						<div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(260px,1fr)_minmax(0,1fr)] overflow-y-auto lg:grid-cols-[148px_minmax(0,1fr)_320px] lg:grid-rows-1 lg:overflow-hidden">
							<aside
								className="flex flex-wrap gap-2 border-b border-border p-3 lg:block lg:space-y-2 lg:border-r lg:border-b-0"
								aria-label={t("automations.graph.addStep")}
							>
								<h3 className="w-full pb-1 text-[11px] font-medium text-muted-foreground">
									{t("automations.graph.addStep")}
								</h3>
								{catalog.map((contract) => (
									<Button
										key={`${contract.action.actionId}:${contract.action.version}`}
										size="sm"
										variant="outline"
										className="justify-start lg:w-full"
										disabled={!editable || draft.definition.nodes.length >= 64}
										onClick={() => add(contract)}
									>
										{contract.action.actionId === "agent" ? (
											<Bot />
										) : (
											<Terminal />
										)}
										{t(`automations.graph.actions.${contract.action.actionId}`)}
										<Plus className="ml-auto size-3" />
									</Button>
								))}
								{draft.definition.nodes.length === 0 && (
									<Button
										size="sm"
										variant="ghost"
										className="h-auto whitespace-normal text-left lg:mt-4 lg:w-full"
										disabled={!editable}
										onClick={useDailyReview}
									>
										<Clock3 />
										{t("automations.graph.dailyReview")}
									</Button>
								)}
								<p className="hidden pt-4 text-[11px] leading-4 text-muted-foreground lg:block">
									{t("automations.graph.addStepHelp")}
								</p>
							</aside>
							<div className="relative min-h-0">
								<GraphCanvas
									definition={draft.definition}
									selected={selected}
									onSelect={setSelected}
									positions={layout.positions}
									onPositions={layout.update}
									issues={issues}
									editable={editable}
									onConnect={(source, target) => {
										if (
											!draft.definition.edges.some(
												(edge) =>
													edge.source === source && edge.target === target,
											)
										)
											setDraft({
												...draft,
												definition: {
													...draft.definition,
													edges: [
														...draft.definition.edges,
														{ source, target },
													],
												},
											});
									}}
								/>
								{draft.definition.nodes.length === 0 && (
									<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
										<Workflow className="size-8 text-muted-foreground" />
										<p className="max-w-64 text-xs text-muted-foreground">
											{t("automations.graph.emptyCanvas")}
										</p>
									</div>
								)}
							</div>
							{node ? (
								<GraphInspector
									key={node.nodeId}
									node={node}
									definition={draft.definition}
									catalog={catalog}
									projects={projects}
									issues={issues}
									disabled={!editable}
									onSelect={setSelected}
									onChange={(definition) => setDraft({ ...draft, definition })}
								/>
							) : (
								<div className="border-t border-border p-5 lg:border-t-0 lg:border-l">
									<EmptyHint>{t("automations.graph.selectStep")}</EmptyHint>
								</div>
							)}
						</div>
						<footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground">
							<Clock3 className="size-3.5" />
							<span>
								{t(
									saved?.enabled
										? "automations.graph.activeHelp"
										: "automations.graph.draftHelp",
								)}
							</span>
							{!validating && issues.length > 0 && (
								<span className="ml-auto text-destructive">
									{graphIssueMessage(
										issues.find((issue) => !issue.nodeId) ?? issues[0],
									)}
								</span>
							)}
						</footer>
					</>
				)}
				{confirmClose && (
					<InlineConfirmRow
						className="m-3 shrink-0"
						question={t(
							action.retryable
								? "automations.closeUncertain"
								: "automations.discardQuestion",
						)}
						confirmLabel={t("automations.graph.closeEditor")}
						onConfirm={onClose}
						onCancel={() => setConfirmClose(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
