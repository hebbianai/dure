import type { HmuxSessionSummary } from "@/lib/ipc";
import type { HmuxStandalonePaneBindingV1 } from "@/lib/terminal/terminalBinding";

export interface AutomaticManagedShellCandidate {
	eligible: true;
	identity: string;
	desktopId: string;
	panelId: string;
	source: HmuxStandalonePaneBindingV1;
	sourceTerminalEpoch: string;
}

export type AutomaticManagedShellAssessment =
	| AutomaticManagedShellCandidate
	| { eligible: false; reason: string };

export interface AutomaticManagedShellSnapshot {
	desktopId: string;
	panelId: string;
	source: HmuxStandalonePaneBindingV1;
	session?: HmuxSessionSummary;
	sourceConsumerCount: number;
	agentDetected: boolean;
	desktopVisible: boolean;
	migrationPending: boolean;
}

/** Product policy only. The backend repeats the provider, generation, agent,
 * attachment, child-process, and retirement checks at the mutation boundary. */
export function assessAutomaticManagedShell(
	value: AutomaticManagedShellSnapshot,
): AutomaticManagedShellAssessment {
	const session = value.session;
	if (value.sourceConsumerCount !== 1) {
		return { eligible: false, reason: "shared_source" };
	}
	if (value.desktopVisible) {
		return { eligible: false, reason: "visible_desktop" };
	}
	if (value.agentDetected) {
		return { eligible: false, reason: "agent_detected" };
	}
	if (value.migrationPending) {
		return { eligible: false, reason: "migration_pending" };
	}
	if (
		!session ||
		session.sessionId !== value.source.sessionId ||
		session.workspaceId !== value.source.workspaceId
	) {
		return { eligible: false, reason: "session_missing" };
	}
	if (
		session.sessionClass !== "standalone" ||
		session.lifecycle !== "ready" ||
		session.manifestLifecycle === "exited" ||
		!session.terminalEpoch ||
		session.inputAllowed !== true ||
		session.detachOnly === true ||
		(session.health !== "current_healthy" &&
			session.health !== "compatible_old_healthy")
	) {
		return { eligible: false, reason: "source_unhealthy" };
	}
	if (
		session.retirementPolicy?.kind !==
			"after_graceful_last_client_departure_v1" ||
		session.retirementPolicy.gracePeriodMs !== 2_000
	) {
		return { eligible: false, reason: "source_not_dure_owned" };
	}
	return {
		eligible: true,
		identity: JSON.stringify([
			"automatic-managed-shell-v1",
			value.desktopId,
			value.panelId,
			value.source.workspaceId,
			value.source.sessionId,
			session.terminalEpoch,
		]),
		desktopId: value.desktopId,
		panelId: value.panelId,
		source: value.source,
		sourceTerminalEpoch: session.terminalEpoch,
	};
}
