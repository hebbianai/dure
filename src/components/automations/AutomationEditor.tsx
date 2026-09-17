import { Pause, Play, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { useEffect, useState } from "react";
import {
	AutomationFlow,
	type AutomationStep,
} from "@/components/automations/AutomationFlow";
import { AutomationRuns } from "@/components/automations/AutomationRuns";
import { useAutomationAction } from "@/components/automations/useAutomations";
import { FormField } from "@/components/common/FormField";
import { LoadingRow} from "@/components/common/StatusBlocks";
import { Button, ConfirmationButton } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import {
	type AutomationSchedule,
	isScheduleDraftValid,
	newScheduleDraft,
	scheduleDraft,
	scheduleErrorMessage,
} from "@/lib/automations/scheduleContract";
import { t } from "@/lib/i18n";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type {
	ScheduleClient,
	ScheduleProject,
	SchedulePutIntent,
} from "@/lib/ipc/dureSchedule";

export function AutomationEditor({
	client,
	authority,
	schedule,
	pro,
	onSaved,
	onClose,
}: {
	client: ScheduleClient;
	authority: DureBackendRouteAuthorityV1;
	schedule?: AutomationSchedule;
	pro: boolean;
	onSaved: () => void;
	onClose: () => void;
}) {
	const [saved, setSaved] = useState(schedule);
	const [scheduleId] = useState(
		() => schedule?.scheduleId ?? `automation-${crypto.randomUUID()}`,
	);
	const [initial] = useState(() =>
		schedule ? scheduleDraft(schedule) : newScheduleDraft(),
	);
	const [draft, setDraft] = useState(initial);
	const [step, setStep] = useState<AutomationStep>("trigger");
	const [tab, setTab] = useState<"flow" | "runs">(pro ? "flow" : "runs");
	const [projects, setProjects] = useState<ScheduleProject[]>([]);
	const [projectError, setProjectError] = useState<string>();
	const [projectsLimited, setProjectsLimited] = useState(false);
	const [projectsLoading, setProjectsLoading] = useState(true);
	const [testRunKey, setTestRunKey] = useState<string>();
	const [confirmClose, setConfirmClose] = useState(false);
	const action = useAutomationAction();
	const dirty =
		JSON.stringify(draft) !==
		JSON.stringify(saved ? scheduleDraft(saved) : initial);
	const locked = action.busy || action.retryable;
	const valid = isScheduleDraftValid(draft);
	useEffect(() => {
		let current = true;
		void client
			.projects(authority)
			.then((value) => {
				if (!current) return;
				setProjects(value.projects);
				setProjectsLimited(!value.complete);
			})
			.catch((reason: unknown) => {
				if (current) setProjectError(scheduleErrorMessage(reason));
			})
			.finally(() => {
				if (current) setProjectsLoading(false);
			});
		return () => {
			current = false;
		};
	}, [client, authority]);

	function persist(nextDraft = draft) {
		const intent: SchedulePutIntent = {
			...structuredClone(nextDraft),
			schemaVersion: 1,
			scheduleId,
			expectedRevision: saved?.revision ?? 0,
			idempotencyKey: `schedule-put-${crypto.randomUUID()}`,
		};
		void action.perform(async () => {
			const next = await client.put(intent, authority);
			setSaved(next);
			setDraft(scheduleDraft(next));
			onSaved();
		});
	}
	function run() {
		if (!saved || !pro || dirty) return;
		const key = `schedule-run-${crypto.randomUUID()}`;
		const target = saved;
		void action.perform(async () => {
			const occurrence = await client.runOnce(target, key, authority);
			setTestRunKey(occurrence.idempotencyKey);
			setTab("runs");
		});
	}
	function close() {
		if (action.busy) return;
		if (dirty || action.retryable) setConfirmClose(true);
		else onClose();
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent
				className="flex max-h-[calc(100dvh-3rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]"
				showCloseButton={false}
				dismiss="escape-only"
			>
				<header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
					<div className="min-w-0 space-y-1">
						<DialogTitle className="truncate text-base">
							{saved?.name ?? t("automations.new")}
						</DialogTitle>
						<DialogDescription className="text-xs">
							{t("automations.runtime", { name: authority.profileId })}
						</DialogDescription>
					</div>
					<IconButton
						title={t("common.close")}
						disabled={action.busy}
						onClick={close}
					>
						<X />
					</IconButton>
				</header>
				<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
					<Segmented
						value={tab}
						onChange={setTab}
						variant="pills"
						size="sm"
						options={[
							{ value: "flow", label: t("automations.flow") },
							{ value: "runs", label: t("automations.runs") },
						]}
					/>
					<span className="text-xs text-muted-foreground">
						{t(saved?.enabled ? "automations.active" : "automations.paused")}
					</span>
				</div>
				<div className="min-h-0 overflow-y-auto">
					{tab === "flow" && (
						<>
							<div className="border-b border-border px-5 py-4">
								<FormField label={t("automations.name")}>
									<Input
										value={draft.name}
										disabled={!pro || locked}
										onChange={(event) =>
											setDraft({ ...draft, name: event.target.value })
										}
									/>
								</FormField>
							</div>
							{projectsLoading && (
								<LoadingRow className="px-5 pt-3">
									{t("common.loading")}
								</LoadingRow>
							)}
							{projectError && (
								<Alert className="mx-5 mt-3">{projectError}</Alert>
							)}
							{projectsLimited && (
								<p className="px-5 pt-3 text-xs text-muted-foreground">
									{t("automations.limited")}
								</p>
							)}
							<AutomationFlow
								draft={draft}
								step={step}
								setStep={setStep}
								setDraft={setDraft}
								disabled={!pro || locked}
								projects={projects}
							/>
						</>
					)}
					{tab === "runs" &&
						(saved ? (
							<AutomationRuns
								key={testRunKey ?? saved.scheduleId}
								client={client}
								authority={authority}
								scheduleId={saved.scheduleId}
								initialSelection={testRunKey}
							/>
						) : (
							<p className="p-8 text-center text-xs text-muted-foreground">
								{t("automations.saveFirst")}
							</p>
						))}
				</div>
				<footer className="shrink-0 space-y-3 border-t border-border px-5 py-4">
					{action.error && (
						<Alert>
							<div className="space-y-2">
								<p>{action.error}</p>
								{action.retryable && (
									<>
										<p>{t("automations.retryHelp")}</p>
										<Button
											size="xs"
											variant="outline"
											disabled={action.busy}
											onClick={() => {
												void action.perform();
											}}
										>
											{t("common.retry")}
										</Button>
									</>
								)}
							</div>
						</Alert>
					)}
					{action.busy && <LoadingRow>{t("common.loading")}</LoadingRow>}
					{confirmClose ? (
						<InlineConfirmRow
							className="flex-wrap [&>span]:basis-full [&>span]:whitespace-normal"
							question={t(
								action.retryable
									? "automations.closeUncertain"
									: "automations.discardQuestion",
							)}
							confirmLabel={t("common.close")}
							onCancel={() => setConfirmClose(false)}
							onConfirm={onClose}
						/>
					) : (
						<div className="flex flex-wrap items-center gap-2">
							{saved?.enabled && (
								<Button
									size="sm"
									variant="outline"
									disabled={locked || dirty}
									onClick={() =>
										persist({ ...scheduleDraft(saved), enabled: false })
									}
								>
									<Pause />
									{t("automations.pause")}
								</Button>
							)}
							<div className="ml-auto flex items-center gap-2">
								{pro && (
									<Button
										size="sm"
										variant="outline"
										disabled={!saved || dirty || locked}
										title={t("automations.saveFirst")}
										onClick={run}
									>
										<Play />
										{t("automations.testRun")}
									</Button>
								)}
								{pro && (
									<ConfirmationButton
										disabled={!valid || locked || (!!saved && !dirty)}
										onClick={() => persist()}
									>
										{t("common.save")}
									</ConfirmationButton>
								)}
							</div>
						</div>
					)}
				</footer>
			</DialogContent>
		</Dialog>
	);
}
