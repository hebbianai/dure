import { providerSupportsExplicitResume } from "@/lib/agents/providers";
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

/** Why an Agent whose Host is gone cannot be restored without its pane. */
export type ManagedRebootRecoverySkipReason =
	| "runtime_generation_changed"
	| "transition_in_progress"
	| "no_conversation_id"
	| "provider_without_exact_resume"
	| "pane_missing"
	| "pane_ambiguous";

export type ManagedRebootRecoveryAssessment =
	| {
			outcome: "restorable";
			candidate: AutomaticManagedRebootRecoveryCandidate;
	  }
	| {
			outcome: "skipped";
			identity: string;
			agentId: string;
			reason: ManagedRebootRecoverySkipReason;
	  };

interface ManagedRebootRecoverySnapshot {
	agents: readonly Agent[];
	projects: readonly Project[];
	layouts: Readonly<Record<string, unknown>>;
	mounted?: Parameters<typeof agentPaneLocations>[1];
	sessions: readonly HmuxSessionSummary[];
}

interface AutomaticManagedRebootRecoverySnapshot
	extends ManagedRebootRecoverySnapshot {
	visibleDesktopIds: ReadonlySet<string>;
}

/** The exact Host is absent, or socket-free; the latter needs a broker recheck. */
function findHostGoneManagedSource(
	sessions: readonly HmuxSessionSummary[],
	identity: ManagedSessionIdentity,
): HmuxSessionSummary | undefined {
	return (
		findRebootStaleManagedSource(sessions, identity) ??
		sessions.find(
			(session) =>
				session.sessionId === identity.sessionId &&
				session.workspaceId === identity.workspaceId &&
				session.sessionClass === "managed" &&
				session.manifestLifecycle === "ready" &&
				session.lifecycle === "unavailable" &&
				session.health === "stale_transport" &&
				session.hostSocketOwnerAbsent === true,
		)
	);
}

/** Assess every local native Agent whose exact Host is gone, in the panes of
 * `desktopIds` (every Space when omitted). Agents whose Host still runs, Chat
 * agents and remote agents are not part of the result. Provider identity, an
 * exact-resume provider, a matching durable stop fence and exactly one pane
 * are mandatory: ambiguous presentation never starts a provider. */
export function assessManagedRebootRecovery(
	snapshot: ManagedRebootRecoverySnapshot,
	desktopIds?: ReadonlySet<string>,
): ManagedRebootRecoveryAssessment[] {
	const panes = agentPaneLocations(snapshot.layouts, snapshot.mounted).filter(
		(pane) => !desktopIds || desktopIds.has(pane.desktopId),
	);
	return snapshot.agents.flatMap((agent): ManagedRebootRecoveryAssessment[] => {
		const binding = agent.runtimeBinding;
		const project = snapshot.projects.find(
			(candidate) => candidate.id === agent.projectId,
		);
		if (
			agent.interactionProfile !== undefined ||
			project?.kind !== "local" ||
			binding?.runtime !== "hmux_managed_v1" ||
			binding.source !== "local" ||
			binding.hostId !== "local" ||
			binding.sessionId !== agent.sessionId
		) {
			return [];
		}
		const source = findHostGoneManagedSource(snapshot.sessions, binding);
		if (!source) return [];
		const identity = JSON.stringify([
			binding.workspaceId,
			binding.sessionId,
			source.terminalEpoch,
		]);
		const skipped = (reason: ManagedRebootRecoverySkipReason) => [
			{ outcome: "skipped" as const, identity, agentId: agent.id, reason },
		];
		if (
			!binding.stopFence ||
			!source.stopFence ||
			!sameHmuxManagedGeneration(source.stopFence, binding.stopFence)
		) {
			return skipped("runtime_generation_changed");
		}
		if (agent.pendingCredentialSwitch !== undefined) {
			return skipped("transition_in_progress");
		}
		const conversationId = managedConversationId(agent);
		if (!conversationId) return skipped("no_conversation_id");
		if (!providerSupportsExplicitResume(agent.provider)) {
			return skipped("provider_without_exact_resume");
		}
		const agentPanes = panes.filter((pane) => pane.agentId === agent.id);
		if (agentPanes.length === 0) return skipped("pane_missing");
		if (agentPanes.length > 1) return skipped("pane_ambiguous");
		return [
			{
				outcome: "restorable",
				candidate: {
					identity,
					agentId: agent.id,
					desktopId: agentPanes[0].desktopId,
					panelId: agentPanes[0].panelId,
					conversationId,
					...(source.hostProcessAlive !== false
						? { requireSocketOwnerAbsent: true as const }
						: {}),
				},
			},
		];
	});
}

/** Select visible native panes whose exact Host is absent or socket-free.
 * Background presentation waits for an explicit Restore all. */
export function automaticManagedRebootRecoveryCandidates(
	snapshot: AutomaticManagedRebootRecoverySnapshot,
): AutomaticManagedRebootRecoveryCandidate[] {
	return assessManagedRebootRecovery(
		snapshot,
		snapshot.visibleDesktopIds,
	).flatMap((assessment) =>
		assessment.outcome === "restorable" ? [assessment.candidate] : [],
	);
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
