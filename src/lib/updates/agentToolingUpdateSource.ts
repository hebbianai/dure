import type { AgentToolingEnvironmentSnapshot } from "@/lib/agents/agentToolingEnvironment";
import {
	probeAgentToolingEnvironment,
	resolveAgentToolingCommand,
} from "@/lib/agents/agentToolingEnvironment";
import { runShell } from "@/lib/ipc/process";
import {
	deriveAgentToolingGuidance,
	type AgentToolingGuidance,
	type AgentToolingGuidanceAction,
} from "@/lib/agents/agentToolingGuidance";
import { t } from "@/lib/i18n";
import { installDureCli } from "@/lib/ipc/system";
import {
	clearMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import { openSettingsPage } from "@/lib/settings/settingsBus";
import {
	clearUpdateNotice,
	upsertUpdateNotice,
} from "@/lib/updates/updateNotice";

const AGENT_TOOLING_UPDATE_SOURCE_REF = "dure.agent-tooling";

export interface AgentToolingUpdateNoticeDependencies {
	installCli?: typeof installDureCli;
	openSettings?: typeof openSettingsPage;
	probeEnvironment?: typeof probeAgentToolingEnvironment;
	runCommand?: typeof runShell;
}

function actionReference(action: AgentToolingGuidanceAction): string {
	if (action.target === "cli") return "Dure CLI";
	if (action.target === "integration") {
		return `${action.detail.provider} orchestration integration`;
	}
	if (action.target === "skills") return "Dure skills";
	return action.dependency.label;
}

function actionRevision(
	action: AgentToolingGuidanceAction,
	snapshot: AgentToolingEnvironmentSnapshot,
): string {
	if (action.target === "cli") {
		return JSON.stringify([
			action.operation,
			snapshot.cliInstallStatus?.installed?.version ?? "missing",
			snapshot.cliInstallStatus?.installed?.digest ?? "missing",
			snapshot.cliInstallStatus?.installed?.installRoot ?? "missing",
			snapshot.cliInstallStatus?.installed?.executablePath ?? "missing",
			snapshot.cliInstallStatus?.available.version ?? "unknown",
			snapshot.cliInstallStatus?.available.digest ?? "unknown",
			snapshot.cliInstallStatus?.available.installRoot ?? "unknown",
			snapshot.cliInstallStatus?.available.executablePath ?? "unknown",
		]);
	}
	if (action.target === "integration") {
		return JSON.stringify([
			action.operation,
			action.detail.provider,
			action.detail.status,
			action.detail.installRootRef ?? "unknown",
			action.detail.version ?? "unknown",
			action.detail.digest ?? "unknown",
			action.detail.channel ?? "unknown",
			action.detail.transportRef ?? "unknown",
			[...(action.detail.capabilities ?? [])].sort(),
			action.detail.refreshCommand ?? "manual",
		]);
	}
	if (action.target === "skills") {
		return JSON.stringify([action.operation, action.command]);
	}
	return JSON.stringify([
		action.operation,
		action.dependency.id,
		action.dependency.fixCommand,
	]);
}

function actionDetails(
	action: AgentToolingGuidanceAction,
	snapshot: AgentToolingEnvironmentSnapshot,
): string {
	if (action.target === "cli") {
		const installed = snapshot.cliInstallStatus?.installed;
		const available = snapshot.cliInstallStatus?.available;
		return [
			installed
				? `${installed.version} · ${installed.digest} · ${installed.installRoot}`
				: t("common.notInstalled"),
			available
				? `${available.version} · ${available.digest} · ${available.installRoot}`
				: t("common.unverified"),
		].join(" → ");
	}
	if (action.target === "integration") {
		return [
			actionReference(action),
			action.detail.installRoot,
			action.detail.installRootRef ?? "-",
			action.detail.version ?? "-",
			action.detail.digest ?? "-",
			action.detail.channel ?? "-",
			action.detail.transportRef ?? "-",
			action.detail.capabilities.join(", ") || "-",
		].join(" · ");
	}
	if (action.target === "skills") {
		return `${actionReference(action)} · ${action.command}`;
	}
	return `${action.dependency.label} · ${action.dependency.id}`;
}

function guidanceTitle(guidance: AgentToolingGuidance): string {
	return guidance.nextAction.operation === "update"
		? t("common.agentToolingUpdateRequired")
		: t("common.agentToolingInstallRequired");
}

function guidanceImpact(action: AgentToolingGuidanceAction): string {
	return action.target === "cli"
		? t("updates.agentTooling.installDescription")
		: t("updates.agentTooling.reviewInSettings");
}

/** Project doctor-owned lifecycle guidance without executing its command. */
export function projectAgentToolingUpdateNotice(
	snapshot: AgentToolingEnvironmentSnapshot,
	dependencies: AgentToolingUpdateNoticeDependencies = {},
): void | Promise<void> {
	return reconcileAgentToolingUpdateNotice(snapshot, dependencies, new Set());
}

function reconcileAgentToolingUpdateNotice(
	snapshot: AgentToolingEnvironmentSnapshot,
	dependencies: AgentToolingUpdateNoticeDependencies,
	attemptedRefreshCommands: ReadonlySet<string>,
): void | Promise<void> {
	if (!snapshot.observed) return;
	const guidance = deriveAgentToolingGuidance(snapshot.report);
	if (!guidance) {
		clearUpdateNotice(AGENT_TOOLING_UPDATE_SOURCE_REF);
		return;
	}
	const action = guidance.nextAction;
	if (
		action.target === "integration" &&
		action.operation === "update" &&
		action.detail.refreshCommand &&
		dependencies.runCommand &&
		!attemptedRefreshCommands.has(action.detail.refreshCommand)
	) {
		const command = action.detail.refreshCommand;
		const attempted = new Set(attemptedRefreshCommands).add(command);
		return dependencies
			.runCommand(
				resolveAgentToolingCommand(snapshot.cliInstallStatus, command),
			)
			.then(async (result) => {
				if (result.code !== 0) {
					reconcileAgentToolingUpdateNotice(snapshot, {
						...dependencies,
						runCommand: undefined,
					}, attempted);
					return;
				}
				const probeEnvironment =
					dependencies.probeEnvironment ?? probeAgentToolingEnvironment;
				await reconcileAgentToolingUpdateNotice(
					await probeEnvironment(),
					dependencies,
					attempted,
				);
			})
			.catch(() => {
				reconcileAgentToolingUpdateNotice(snapshot, {
					...dependencies,
					runCommand: undefined,
				}, attempted);
			});
	}
	const openSettings = dependencies.openSettings ?? openSettingsPage;
	const installCli = dependencies.installCli ?? installDureCli;
	const probeEnvironment =
		dependencies.probeEnvironment ?? probeAgentToolingEnvironment;
	const primaryAction =
		action.target === "cli"
			? {
					label: action.operation === "update" ? t("common.update") : t("common.install"),
					progressLabel:
						action.operation === "update" ? t("common.updating") : t("common.installing"),
					completion: "retain" as const,
					run: async () => {
						await installCli();
						projectAgentToolingUpdateNotice(
							await probeEnvironment(),
							dependencies,
						);
					},
				}
			: {
					label: t("common.openSettings"),
					progressLabel: t("updates.agentTooling.openingSettings"),
					completion: "retain" as const,
					run: () => openSettings("agentTooling"),
				};
	upsertUpdateNotice({
		sourceRef: AGENT_TOOLING_UPDATE_SOURCE_REF,
		revision: actionRevision(action, snapshot),
		title: guidanceTitle(guidance),
		description: guidance.actions.map(actionReference).join(" · "),
		impact: guidanceImpact(action),
		details: actionDetails(action, snapshot),
		primaryAction,
	});
}

export function startAgentToolingUpdateChecks(): () => void {
	let disposed = false;
	let checking = false;
	const checkOnce = async () => {
		if (disposed || checking) return;
		checking = true;
		try {
			const snapshot = await probeAgentToolingEnvironment();
			if (!disposed) {
				await projectAgentToolingUpdateNotice(snapshot, {
					runCommand: runShell,
				});
			}
		} catch {
			// A transient probe failure leaves the last known notice intact.
		} finally {
			checking = false;
		}
	};
	const initial = window.setTimeout(() => void checkOnce(), 10_000);
	const interval = setMaintenanceLaneInterval(
		() => void checkOnce(),
		60 * 60 * 1000,
		"tooling-update-check",
	);
	return () => {
		disposed = true;
		window.clearTimeout(initial);
		clearMaintenanceLaneInterval(interval);
	};
}
