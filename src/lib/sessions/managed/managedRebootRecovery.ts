import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { isHmuxLocalShellBinding } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import {
	type HmuxStandalonePaneBindingV1,
	isTerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import type { Agent, Project } from "@/types";

export interface ManagedSessionIdentity {
	sessionId: string;
	workspaceId: string;
}

function findRebootStaleSource(
	sessions: readonly HmuxSessionSummary[],
	identity: ManagedSessionIdentity,
	sessionClass: "managed" | "standalone",
): HmuxSessionSummary | undefined {
	return sessions.find(
		(session) =>
			session.sessionId === identity.sessionId &&
			session.workspaceId === identity.workspaceId &&
			session.sessionClass === sessionClass &&
			session.manifestLifecycle === "ready" &&
			session.lifecycle === "unavailable" &&
			session.health === "stale_transport" &&
			session.hostProcessAlive === false,
	);
}

/**
 * A missed handshake does not prove a reboot. Require the adapter's OS-backed
 * Host absence observation before admitting automatic replacement; the existing
 * backend transaction still owns exact-generation retirement and creation.
 */
export function findRebootStaleManagedSource(
	sessions: readonly HmuxSessionSummary[],
	identity: ManagedSessionIdentity,
): HmuxSessionSummary | undefined {
	return findRebootStaleSource(sessions, identity, "managed");
}

function findRebootStaleStandaloneSource(
	sessions: readonly HmuxSessionSummary[],
	identity: ManagedSessionIdentity,
): HmuxSessionSummary | undefined {
	return findRebootStaleSource(sessions, identity, "standalone");
}

export interface AutomaticManagedRebootRecoveryCandidate {
	identity: string;
	agentId: string;
	desktopId: string;
	panelId: string;
	conversationId: string;
	requireSocketOwnerAbsent?: true;
}

interface AutomaticManagedRebootRecoverySnapshot {
	agents: readonly Agent[];
	projects: readonly Project[];
	layouts: Readonly<Record<string, unknown>>;
	mounted?: Parameters<typeof agentPaneLocations>[1];
	sessions: readonly HmuxSessionSummary[];
	visibleDesktopIds: ReadonlySet<string>;
}

/** Select visible native panes whose exact Host is absent or socket-free.
 * The latter requires a broker recheck. Provider identity and a durable stop fence are
 * mandatory; ambiguous or background presentation never starts a provider. */
export function automaticManagedRebootRecoveryCandidates(
	snapshot: AutomaticManagedRebootRecoverySnapshot,
): AutomaticManagedRebootRecoveryCandidate[] {
	const visiblePanes = agentPaneLocations(
		snapshot.layouts,
		snapshot.mounted,
	).filter((pane) => snapshot.visibleDesktopIds.has(pane.desktopId));

	return snapshot.agents.flatMap((agent) => {
		const binding = agent.runtimeBinding;
		const panes = visiblePanes.filter((pane) => pane.agentId === agent.id);
		const project = snapshot.projects.find(
			(candidate) => candidate.id === agent.projectId,
		);
		const conversationId = managedConversationId(agent);
		if (
			agent.interactionProfile !== undefined ||
			agent.pendingCredentialSwitch !== undefined ||
			project?.kind !== "local" ||
			binding?.runtime !== "hmux_managed_v1" ||
			binding.source !== "local" ||
			binding.hostId !== "local" ||
			binding.sessionId !== agent.sessionId ||
			!binding.stopFence ||
			!conversationId ||
			panes.length !== 1
		) {
			return [];
		}
		const source =
			findRebootStaleManagedSource(snapshot.sessions, binding) ??
			snapshot.sessions.find(
				(session) =>
					session.sessionId === binding.sessionId &&
					session.workspaceId === binding.workspaceId &&
					session.sessionClass === "managed" &&
					session.manifestLifecycle === "ready" &&
					session.lifecycle === "unavailable" &&
					session.health === "stale_transport" &&
					session.hostSocketOwnerAbsent === true,
			);
		if (
			!source?.stopFence ||
			!sameHmuxManagedGeneration(source.stopFence, binding.stopFence)
		) {
			return [];
		}
		return [
			{
				identity: JSON.stringify([
					binding.workspaceId,
					binding.sessionId,
					source.terminalEpoch,
				]),
				agentId: agent.id,
				desktopId: panes[0].desktopId,
				panelId: panes[0].panelId,
				conversationId,
				...(source.hostProcessAlive !== false
					? { requireSocketOwnerAbsent: true as const }
					: {}),
			},
		];
	});
}

export interface AutomaticStandaloneRebootRecoveryCandidate {
	identity: string;
	desktopId: string;
	panelId: string;
	source: HmuxStandalonePaneBindingV1;
	sourceTerminalEpoch: string;
}

export interface AutomaticManagedShellRebootRecoveryCandidate {
	identity: string;
	desktopId: string;
	panelId: string;
}

/** Select exact visible managed local-shell panes that are not claimed by an
 * Agent. The managed-shell replacement path repeats the pane and Host fences. */
export function automaticManagedShellRebootRecoveryCandidates(
	snapshot: Pick<
		AutomaticManagedRebootRecoverySnapshot,
		"layouts" | "sessions" | "visibleDesktopIds"
	> & { claimedSessionIds: ReadonlySet<string> },
): AutomaticManagedShellRebootRecoveryCandidate[] {
	const candidates = new Map<
		string,
		AutomaticManagedShellRebootRecoveryCandidate
	>();
	for (const desktopId of snapshot.visibleDesktopIds) {
		const layout = snapshot.layouts[desktopId];
		if (!layout) continue;
		for (const panel of panelsFromLayout(layout)) {
			const binding = isTerminalPaneBindingV1(panel.params.binding)
				? panel.params.binding
				: undefined;
			if (
				binding?.runtime !== "hmux_managed_v1" ||
				!isHmuxLocalShellBinding(binding, panel.component) ||
				binding.sessionId !== panel.params.sessionId ||
				snapshot.claimedSessionIds.has(binding.sessionId)
			) {
				continue;
			}
			const source = findRebootStaleManagedSource(snapshot.sessions, binding);
			if (
				!source?.stopFence ||
				(binding.stopFence !== undefined &&
					!sameHmuxManagedGeneration(source.stopFence, binding.stopFence))
			) {
				continue;
			}
			const identity = JSON.stringify([
				binding.workspaceId,
				binding.sessionId,
				source.terminalEpoch,
			]);
			const candidate = { identity, desktopId, panelId: panel.id };
			const current = candidates.get(identity);
			if (
				!current ||
				`${desktopId}\0${panel.id}` < `${current.desktopId}\0${current.panelId}`
			) {
				candidates.set(identity, candidate);
			}
		}
	}
	return [...candidates.values()].sort((left, right) =>
		left.identity.localeCompare(right.identity),
	);
}

/** Select one visible pane per exact Dure-owned standalone generation. The
 * pane-set recovery transaction retargets any additional consumers together. */
export function automaticStandaloneRebootRecoveryCandidates(
	snapshot: Pick<
		AutomaticManagedRebootRecoverySnapshot,
		"layouts" | "sessions" | "visibleDesktopIds"
	>,
): AutomaticStandaloneRebootRecoveryCandidate[] {
	const candidates = new Map<
		string,
		AutomaticStandaloneRebootRecoveryCandidate
	>();
	for (const desktopId of snapshot.visibleDesktopIds) {
		const layout = snapshot.layouts[desktopId];
		if (!layout) continue;
		for (const panel of panelsFromLayout(layout)) {
			const binding = isTerminalPaneBindingV1(panel.params.binding)
				? panel.params.binding
				: undefined;
			if (
				panel.component !== "terminal" ||
				binding?.runtime !== "hmux_standalone_v1" ||
				binding.source !== "local" ||
				binding.hostId !== "local" ||
				panel.params.managedShellMigration !== undefined
			) {
				continue;
			}
			const source = findRebootStaleStandaloneSource(
				snapshot.sessions,
				binding,
			);
			if (
				!source?.terminalEpoch ||
				source.retirementPolicy?.kind !==
					"after_graceful_last_client_departure_v1" ||
				source.retirementPolicy.gracePeriodMs !== 2_000
			) {
				continue;
			}
			const identity = JSON.stringify([
				binding.workspaceId,
				binding.sessionId,
				source.terminalEpoch,
			]);
			const candidate = {
				identity,
				desktopId,
				panelId: panel.id,
				source: binding,
				sourceTerminalEpoch: source.terminalEpoch,
			};
			const current = candidates.get(identity);
			if (
				!current ||
				`${desktopId}\0${panel.id}` < `${current.desktopId}\0${current.panelId}`
			) {
				candidates.set(identity, candidate);
			}
		}
	}
	return [...candidates.values()].sort((left, right) =>
		left.identity.localeCompare(right.identity),
	);
}
