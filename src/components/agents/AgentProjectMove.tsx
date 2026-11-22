import { FolderInput } from "lucide-react";
import { useState } from "react";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ErrorText } from "@/components/ui/error-text";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import type {
	AgentProjectMovePort,
	PreparedAgentProjectMove,
} from "@/lib/agents/agentProjectMoveTypes";
import { t } from "@/lib/i18n";
import type { AgentProjectMovePlan } from "@/lib/ipc/dureAgentProjectMove";

/** The move dialog. Its surface decides where the move runs through `port`. */
export function AgentProjectMove({
	port,
	disabled,
	disabledTitle,
	onBusyChange,
}: {
	port: AgentProjectMovePort;
	disabled?: boolean;
	/** Shown instead of the title while `disabled`, when the caller says why. */
	disabledTitle?: string;
	onBusyChange?(busy: boolean): void;
}) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [prepared, setPrepared] = useState<PreparedAgentProjectMove>();
	const [projectId, setProjectId] = useState("");
	const [plan, setPlan] = useState<AgentProjectMovePlan>();
	const [error, setError] = useState<string>();
	const [attempted, setAttempted] = useState(false);
	const [repairAvailable, setRepairAvailable] = useState(false);
	const finish = () => {
		setOpen(false);
		setPrepared(undefined);
		setPlan(undefined);
		setProjectId("");
		setAttempted(false);
		setRepairAvailable(false);
		setError(undefined);
	};
	const prepare = async () => {
		const next = await port.prepare();
		setPrepared(next);
		if (next.recoveredPlan) {
			setPlan(next.recoveredPlan);
			setProjectId(next.recoveredPlan.workspaceMove.targetProject.projectId);
			setAttempted(true);
			setRepairAvailable(next.recoveredStatus === "repair_required");
		}
	};
	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		onBusyChange?.(true);
		setError(undefined);
		try {
			await action();
		} catch (cause) {
			setError("failed");
			const code =
				cause && typeof cause === "object" && "code" in cause
					? cause.code
					: undefined;
			if (String(code).startsWith("agent_project_move_provider_version_"))
				setError("versionRequired");
			if (code === "agent_runtime_source_busy") setError("sourceBusy");
			if (
				[
					"agent_project_move_preview_stale",
					"agent_runtime_source_busy",
					"agent_runtime_source_retained",
				].includes(String(code)) ||
				(cause &&
					typeof cause === "object" &&
					"submitted" in cause &&
					cause.submitted === false)
			) {
				setPlan(undefined);
				setAttempted(false);
				setPrepared(undefined);
				setRepairAvailable(false);
			}
		} finally {
			setBusy(false);
			onBusyChange?.(false);
		}
	};
	return (
		<>
			<Button
				variant="ghost"
				size="icon-xs"
				title={
					disabled && disabledTitle
						? disabledTitle
						: t("agents.projectMove.title")
				}
				aria-label={t("agents.projectMove.title")}
				disabled={disabled || busy}
				onClick={() => {
					setOpen(true);
					if (!attempted) {
						setPlan(undefined);
						setPrepared(undefined);
						setProjectId("");
						void run(prepare);
					}
				}}
			>
				<FolderInput className="size-3.5" />
			</Button>
			<Dialog
				open={open}
				onOpenChange={(value) => {
					if (!busy) setOpen(value);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("agents.projectMove.title")}</DialogTitle>
						<DialogDescription>
							{t("agents.projectMove.description")}
						</DialogDescription>
					</DialogHeader>
					<SelectField
						aria-label={t("agents.projectMove.destination")}
						value={projectId}
						disabled={busy || attempted || !prepared}
						display={
							prepared?.projects.find((p) => p.id === projectId)?.displayName ??
							t("agents.projectMove.destination")
						}
						onValueChange={(value) => {
							setProjectId(value);
							setPlan(undefined);
							setError(undefined);
						}}
					>
						{prepared?.projects.map((project) => (
							<SelectOption key={project.id} value={project.id}>
								{project.displayName}
							</SelectOption>
						))}
					</SelectField>
					{prepared && !prepared.complete && (
						<p className="text-xs text-muted-foreground">
							{t("agents.projectMove.partial")}
						</p>
					)}
					{plan && (
						<dl className="space-y-2 break-all text-sm">
							<dt className="text-muted-foreground">
								{t("agents.projectMove.source")}
							</dt>
							<dd>{plan.workspaceMove.sourceWorkspace.rootPath}</dd>
							<dt className="text-muted-foreground">
								{t("agents.projectMove.destination")}
							</dt>
							<dd>{plan.workspaceMove.targetWorkspace.rootPath}</dd>
						</dl>
					)}
					{attempted && plan && (
						<div className="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() =>
									void run(async () => {
										const status = await prepared?.status(plan);
										setRepairAvailable(status === "repair_required");
										if (status === "not_submitted") {
											setPlan(undefined);
											setAttempted(false);
											setPrepared(undefined);
										} else if (status === "completed") finish();
										else setError("unconfirmed");
									})
								}
							>
								{t("agents.projectMove.status")}
							</Button>
							{repairAvailable && (
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() =>
										void run(async () => {
											await prepared?.repair(plan);
											finish();
										})
									}
								>
									{t("agents.projectMove.repair")}
								</Button>
							)}
						</div>
					)}
					{error && (
						<ErrorText>
							{t(
								attempted
									? "agents.projectMove.unconfirmed"
									: error === "versionRequired"
										? "agents.projectMove.versionRequired"
										: error === "sourceBusy"
											? "agents.projectMove.sourceBusy"
											: "agents.projectMove.failed",
							)}
						</ErrorText>
					)}
					<DialogActionFooter
						busy={busy}
						disabled={repairAvailable || (!!prepared && !projectId)}
						onCancel={() => setOpen(false)}
						confirmLabel={t(
							!prepared
								? "common.retry"
								: plan
									? "agents.projectMove.confirm"
									: "agents.projectMove.preview",
						)}
						onConfirm={() =>
							void run(async () => {
								if (!prepared) {
									await prepare();
									return;
								}
								if (!plan) {
									setPlan(await prepared.preview(projectId));
									return;
								}
								setAttempted(true);
								await prepared.apply(plan);
								finish();
							})
						}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
}
