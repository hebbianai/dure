import { useState } from "react";
import { WorktreeAgentDialog } from "@/components/agents/WorktreeAgentDialog";
import { PageTitle } from "@/components/settings/PageTitle";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { connectWorkspaceEnvironment } from "@/lib/environments/connectWorkspaceEnvironment";
import { useWorkspaceEnvironments } from "@/lib/environments/useWorkspaceEnvironments";
import {
	type EnvironmentOperation,
	environmentActions,
	type WorkspaceEnvironment,
} from "@/lib/environments/workspaceEnvironmentContract";
import { t } from "@/lib/i18n";
import { transitionEnvironment } from "@/lib/ipc/dureWorkspaceEnvironment";
import type { Project } from "@/types";
import { useEnvironmentsPageState } from "./useEnvironmentsPageState";

export function EnvironmentsPage() {
	const { desktopId } = useEnvironmentsPageState();
	const { snapshot, error: loadError, refresh } = useWorkspaceEnvironments();
	const pro = useInterfaceMode() === "pro" && Boolean(snapshot?.proAvailable);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [confirm, setConfirm] = useState<{
		environment: WorkspaceEnvironment;
		operation: EnvironmentOperation;
	} | null>(null);
	const [project, setProject] = useState<Project | null>(null);
	const perform = async (
		environment: WorkspaceEnvironment,
		operation: EnvironmentOperation,
	) => {
		if (!snapshot) return;
		setBusy(true);
		setError(false);
		try {
			await transitionEnvironment(environment, operation, snapshot.authority);
			setConfirm(null);
		} catch {
			setError(true);
		} finally {
			await refresh().catch(() => {});
			setBusy(false);
		}
	};
	const connect = async (environment: WorkspaceEnvironment) => {
		setBusy(true);
		setError(false);
		try {
			setProject(await connectWorkspaceEnvironment(environment));
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<PageTitle
				title={t("environments.title")}
				desc={t("environments.description")}
			/>
			{!pro && (
				<p className="text-xs text-muted-foreground">
					{t("environments.proRequired")}
				</p>
			)}
			<div>
				<Button
					type="button"
					variant="glass"
					size="sm"
					disabled={busy}
					onClick={() => void refresh().catch(() => {})}
				>
					{t("common.refresh")}
				</Button>
			</div>
			{(error || Boolean(loadError)) && (
				<ErrorText>{t("environments.failed")}</ErrorText>
			)}
			{snapshot?.environments.length === 0 && (
				<p className="text-sm text-muted-foreground">
					{t("environments.empty")}
				</p>
			)}
			<div className="flex flex-col divide-y divide-border">
				{snapshot?.environments.map((environment) => (
					<section key={environment.id} className="flex flex-col gap-2 py-4">
						<div className="flex items-center justify-between gap-3">
							<span className="text-sm font-medium">{environment.name}</span>
							<span className="text-xs text-muted-foreground" role="status">
								{t(`environments.status.${environment.status}`)}
							</span>
						</div>
						<p
							className="truncate text-xs text-muted-foreground"
							title={environment.projectPath}
						>
							{environment.recipeName} · {environment.projectPath}
						</p>
						{environment.error && (
							<ErrorText>
								{t("environments.providerFailed")}{" "}
								<code>{environment.error}</code>
							</ErrorText>
						)}
						{confirm?.environment.id === environment.id ? (
							<InlineConfirmRow
								question={t(
									confirm.operation === "destroy"
										? "environments.destroyConfirm"
										: "environments.suspendConfirm",
								)}
								confirmLabel={t(`environments.${confirm.operation}`)}
								busy={busy}
								onCancel={() => setConfirm(null)}
								onConfirm={() =>
									void perform(confirm.environment, confirm.operation)
								}
							/>
						) : (
							<div className="flex flex-wrap gap-2">
								{environment.status === "running" && (
									<Button
										type="button"
										size="sm"
										variant="glass"
										disabled={busy}
										onClick={() => void connect(environment)}
									>
										{t("environments.open")}
									</Button>
								)}
								{environmentActions(environment, pro).map((operation) => (
									<Button
										key={operation}
										type="button"
										size="sm"
										variant={operation === "destroy" ? "destructive" : "ghost"}
										disabled={busy}
										onClick={() =>
											operation === "resume"
												? void perform(environment, operation)
												: setConfirm({ environment, operation })
										}
									>
										{t(`environments.${operation}`)}
									</Button>
								))}
							</div>
						)}
					</section>
				))}
			</div>
			{project?.sshHostId && desktopId && (
				<WorktreeAgentDialog
					desktopId={desktopId}
					host={{ id: project.sshHostId, name: project.name }}
					initialPath={project.path}
					onClose={() => setProject(null)}
				/>
			)}
		</>
	);
}
