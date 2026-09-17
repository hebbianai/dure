import { isLegacyAgentWriterTarget } from "@/lib/agents/agentWriterPartition";
import {
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxCatalogSessionV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { remoteHmuxCatalog, remoteHmuxKnownHostTrust } from "@/lib/ipc";
import type { ExitedManagedAgentCleanupCandidate } from "@/lib/sessions/cleanup/exitedManagedAgentCleanup";
import {
	type CleanupCompensationStorage,
	type ExitedManagedAgentCleanupCompensation,
	exitedManagedAgentCleanupCompensations,
	markExitedManagedAgentCleanupReplacement,
	replacementAgentFromCleanupCompensation,
	replacementAgentFromRemoteCleanupCompensation,
	retireExitedManagedAgentCleanupCompensation,
	sameExitedManagedAgentCleanupBinding,
	stageExitedManagedAgentCleanupCompensation,
	updateExitedManagedAgentCleanupPendingDesktops,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanupCompensation";
import {
	type RemoteNeverCreatedManagedAgentCleanupCandidate,
	sameRemoteNeverCreatedManagedAgentCleanupCandidate,
} from "@/lib/sessions/cleanup/remoteNeverCreatedManagedAgentCleanup";
import {
	bindingForAgent,
	normalizeTerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import { openAgentPanel } from "@/lib/workspace/dock";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview, mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

export interface ExitedManagedAgentCleanupCompensationRuntime {
	storage: CleanupCompensationStorage;
	currentAgents: () => readonly Agent[];
	currentProjects: () => readonly Project[];
	desktopIdsForAgent: (agentId: string) => readonly string[];
	replaceAgent: (
		record: ExitedManagedAgentCleanupCompensation,
		replacement: Agent,
	) => boolean;
	restorePane: (
		desktopId: string,
		record: ExitedManagedAgentCleanupCompensation,
		replacement: Agent,
	) => "restored" | "pending" | "conflict";
}

export interface ExitedManagedAgentCleanupCompensationReceipt {
	agentId: string;
	cleanupId: string;
	outcome: "restored" | "pending" | "refused";
}

export function browserCleanupCompensationStorage():
	| CleanupCompensationStorage
	| undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

function currentAgentPaneDesktopIds(agentId: string): string[] {
	const state = useStore.getState();
	return [...new Set(agentPaneLocations(state.layouts, mountedDockviewEntries())
		.filter((pane) => pane.agentId === agentId)
		.map((pane) => pane.desktopId))];
}

function managedBinding(agent: Agent) {
	const binding = normalizeTerminalPaneBindingV1(agent.runtimeBinding);
	return binding?.runtime === "hmux_managed_v1" ? binding : undefined;
}

function sameAgentRegistration(left: Agent, right: Agent): boolean {
	const leftBinding = managedBinding(left);
	const rightBinding = managedBinding(right);
	return (
		left.id === right.id &&
		left.name === right.name &&
		left.projectId === right.projectId &&
		left.provider === right.provider &&
		left.worktreePath === right.worktreePath &&
		left.branch === right.branch &&
		left.sessionId === right.sessionId &&
		left.sessionKind === right.sessionKind &&
		leftBinding !== undefined &&
		rightBinding !== undefined &&
		sameExitedManagedAgentCleanupBinding(leftBinding, rightBinding)
	);
}

function sessionBindingConflict(
	agents: readonly Agent[],
	record: ExitedManagedAgentCleanupCompensation,
): boolean {
	return agents.some((agent) => {
		if (agent.id === record.agent.id) return false;
		const binding = managedBinding(agent);
		return (
			binding?.source === record.sourceBinding.source &&
			binding.hostId === record.sourceBinding.hostId &&
			binding?.sessionId === record.sourceBinding.sessionId &&
			binding.workspaceId === record.sourceBinding.workspaceId
		);
	});
}

function replaceAgentRegistration(
	record: ExitedManagedAgentCleanupCompensation,
	replacement: Agent,
): boolean {
	const state = useStore.getState();
	const current = state.agents.find((agent) => agent.id === record.agent.id);
	if (current && !isLegacyAgentWriterTarget(current)) return false;
	if (current && sameAgentRegistration(current, replacement)) return true;
	if (
		current &&
		(!sameAgentRegistration(current, record.agent) ||
			current.sessionId !== record.sourceBinding.sessionId)
	) {
		return false;
	}
	if (!current && sessionBindingConflict(state.agents, record)) return false;
	useStore.setState((latest) => {
		const latestAgent = latest.agents.find(
			(agent) => agent.id === record.agent.id,
		);
		if (latestAgent && !isLegacyAgentWriterTarget(latestAgent)) return latest;
		if (
			latestAgent &&
			!sameAgentRegistration(latestAgent, record.agent) &&
			!sameAgentRegistration(latestAgent, replacement)
		) {
			return latest;
		}
		if (!latestAgent && sessionBindingConflict(latest.agents, record)) {
			return latest;
		}
		return {
			agents: latestAgent
				? latest.agents.map((agent) =>
						agent.id === record.agent.id ? replacement : agent,
					)
				: [...latest.agents, replacement],
		};
	});
	return useStore
		.getState()
		.agents.some(
			(agent) =>
				isLegacyAgentWriterTarget(agent) &&
				sameAgentRegistration(agent, replacement),
		);
}

function restoreAgentPane(
	desktopId: string,
	record: ExitedManagedAgentCleanupCompensation,
	replacement: Agent,
): "restored" | "pending" | "conflict" {
	const state = useStore.getState();
	const replacementBinding = managedBinding(replacement);
	if (!replacementBinding) return "conflict";
	if (!state.spaces.some((desktop) => desktop.id === desktopId)) {
		return "restored";
	}
	const api = getDockview(desktopId);
	if (!api) return "pending";
	if (!findAgentPanel(api, record.agent.id)) {
		if (!openAgentPanel(desktopId, replacement)) return "pending";
	}
	state.saveLayout(desktopId, api.toJSON());
	return "restored";
}

function productionRuntime(
	storage: CleanupCompensationStorage,
): ExitedManagedAgentCleanupCompensationRuntime {
	return {
		storage,
		currentAgents: () => useStore.getState().agents,
		currentProjects: () => useStore.getState().projects,
		desktopIdsForAgent: currentAgentPaneDesktopIds,
		replaceAgent: replaceAgentRegistration,
		restorePane: restoreAgentPane,
	};
}

export function stageCurrentExitedManagedAgentCleanupCompensation(
	candidate: ExitedManagedAgentCleanupCandidate,
	options?: { storage?: CleanupCompensationStorage },
): boolean {
	const storage = options?.storage ?? browserCleanupCompensationStorage();
	if (!storage) return false;
	const state = useStore.getState();
	const agent = state.agents.find((entry) => entry.id === candidate.agentId);
	if (!isLegacyAgentWriterTarget(agent)) return false;
	const binding = bindingForAgent(agent, state.projects);
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local" ||
		!sameExitedManagedAgentCleanupBinding(binding, candidate.binding)
	) {
		return false;
	}
	return stageExitedManagedAgentCleanupCompensation({
		agent,
		sourceBinding: binding,
		sourceTerminalEpoch: candidate.terminalEpoch,
		desktopIds: currentAgentPaneDesktopIds(agent.id),
		storage,
	});
}

export function stageCurrentRemoteNeverCreatedManagedAgentCleanupCompensation(
	candidate: RemoteNeverCreatedManagedAgentCleanupCandidate,
	options?: { storage?: CleanupCompensationStorage },
): boolean {
	const storage = options?.storage ?? browserCleanupCompensationStorage();
	if (!storage) return false;
	const state = useStore.getState();
	const agent = state.agents.find((entry) => entry.id === candidate.agent.id);
	if (!isLegacyAgentWriterTarget(agent)) return false;
	if (
		!sameRemoteNeverCreatedManagedAgentCleanupCandidate(
			{ agent, projects: state.projects, sshHosts: state.sshHosts },
			candidate,
		)
	) {
		return false;
	}
	return stageExitedManagedAgentCleanupCompensation({
		agent: candidate.agent,
		sourceBinding: candidate.binding,
		desktopIds: currentAgentPaneDesktopIds(candidate.agent.id),
		storage,
	});
}

function restoreCompensationRecord(
	record: ExitedManagedAgentCleanupCompensation,
	replacement: Agent,
	current: ExitedManagedAgentCleanupCompensationRuntime,
): ExitedManagedAgentCleanupCompensationReceipt {
	if (!current.replaceAgent(record, replacement)) {
		return {
			agentId: record.agent.id,
			cleanupId: record.cleanupId,
			outcome: "refused",
		};
	}
	const pendingDesktopIds: string[] = [];
	for (const desktopId of record.desktopIds) {
		const outcome = current.restorePane(desktopId, record, replacement);
		if (outcome === "conflict") {
			return {
				agentId: record.agent.id,
				cleanupId: record.cleanupId,
				outcome: "refused",
			};
		}
		if (outcome === "pending") pendingDesktopIds.push(desktopId);
	}
	if (pendingDesktopIds.length > 0) {
		if (
			!updateExitedManagedAgentCleanupPendingDesktops(
				current.storage,
				record.cleanupId,
				pendingDesktopIds,
			)
		) {
			return {
				agentId: record.agent.id,
				cleanupId: record.cleanupId,
				outcome: "refused",
			};
		}
		return {
			agentId: record.agent.id,
			cleanupId: record.cleanupId,
			outcome: "pending",
		};
	}
	const retired = retireExitedManagedAgentCleanupCompensation(
		current.storage,
		record.cleanupId,
	);
	return {
		agentId: record.agent.id,
		cleanupId: record.cleanupId,
		outcome: retired ? "restored" : "pending",
	};
}

function canonicalSuccessorRefusal(
	record: ExitedManagedAgentCleanupCompensation,
	current: ExitedManagedAgentCleanupCompensationRuntime,
): ExitedManagedAgentCleanupCompensationReceipt | undefined {
	const successor = current
		.currentAgents()
		.find((agent) => agent.id === record.agent.id);
	return successor && !isLegacyAgentWriterTarget(successor)
		? {
				agentId: record.agent.id,
				cleanupId: record.cleanupId,
				outcome: "refused",
			}
		: undefined;
}

export function reconcileExitedManagedAgentCleanupCompensations(
	sessions: readonly HmuxSessionSummary[],
	deps?: ExitedManagedAgentCleanupCompensationRuntime,
): ExitedManagedAgentCleanupCompensationReceipt[] {
	const storage = deps?.storage ?? browserCleanupCompensationStorage();
	if (!storage) return [];
	const current = deps ?? productionRuntime(storage);
	const receipts: ExitedManagedAgentCleanupCompensationReceipt[] = [];
	for (const record of exitedManagedAgentCleanupCompensations(storage)) {
		const canonicalRefusal = canonicalSuccessorRefusal(record, current);
		if (canonicalRefusal) {
			receipts.push(canonicalRefusal);
			continue;
		}
		const summary = sessions.find(
			(session) =>
				session.sessionId === record.sourceBinding.sessionId &&
				session.workspaceId === record.sourceBinding.workspaceId,
		);
		const replacement = summary
			? replacementAgentFromCleanupCompensation(record, summary)
			: undefined;
		if (!replacement) continue;
		if (
			!markExitedManagedAgentCleanupReplacement(
				storage,
				record.cleanupId,
				replacement,
			) ||
			!current.replaceAgent(record, replacement)
		) {
			receipts.push({
				agentId: record.agent.id,
				cleanupId: record.cleanupId,
				outcome: "refused",
			});
			continue;
		}
		const pendingDesktopIds: string[] = [];
		let conflict = false;
		for (const desktopId of record.desktopIds) {
			const outcome = current.restorePane(desktopId, record, replacement);
			if (outcome === "pending") pendingDesktopIds.push(desktopId);
			if (outcome === "conflict") conflict = true;
		}
		if (conflict) {
			receipts.push({
				agentId: record.agent.id,
				cleanupId: record.cleanupId,
				outcome: "refused",
			});
			continue;
		}
		if (pendingDesktopIds.length > 0) {
			if (
				!updateExitedManagedAgentCleanupPendingDesktops(
					storage,
					record.cleanupId,
					pendingDesktopIds,
				)
			) {
				receipts.push({
					agentId: record.agent.id,
					cleanupId: record.cleanupId,
					outcome: "refused",
				});
				continue;
			}
			receipts.push({
				agentId: record.agent.id,
				cleanupId: record.cleanupId,
				outcome: "pending",
			});
			continue;
		}
		const retired = retireExitedManagedAgentCleanupCompensation(
			storage,
			record.cleanupId,
		);
		receipts.push({
			agentId: record.agent.id,
			cleanupId: record.cleanupId,
			outcome: retired ? "restored" : "pending",
		});
	}
	return receipts;
}

function reconcileRemoteManagedAgentCleanupCompensations(
	hostId: string,
	sessions: readonly RemoteHmuxCatalogSessionV1[],
	deps?: ExitedManagedAgentCleanupCompensationRuntime,
): ExitedManagedAgentCleanupCompensationReceipt[] {
	const storage = deps?.storage ?? browserCleanupCompensationStorage();
	if (!storage) return [];
	const current = deps ?? productionRuntime(storage);
	const receipts: ExitedManagedAgentCleanupCompensationReceipt[] = [];
	for (const record of exitedManagedAgentCleanupCompensations(storage)) {
		if (
			record.sourceBinding.source !== "ssh" ||
			record.sourceBinding.hostId !== hostId
		) {
			continue;
		}
		const canonicalRefusal = canonicalSuccessorRefusal(record, current);
		if (canonicalRefusal) {
			receipts.push(canonicalRefusal);
			continue;
		}
		const summary = sessions.find(
			(session) =>
				session.sessionId === record.sourceBinding.sessionId &&
				session.workspaceId === record.sourceBinding.workspaceId,
		);
		const replacement = summary
			? replacementAgentFromRemoteCleanupCompensation(record, summary)
			: undefined;
		if (!replacement) continue;
		if (
			!markExitedManagedAgentCleanupReplacement(
				storage,
				record.cleanupId,
				replacement,
			)
		) {
			receipts.push({
				agentId: record.agent.id,
				cleanupId: record.cleanupId,
				outcome: "refused",
			});
			continue;
		}
		receipts.push(restoreCompensationRecord(record, replacement, current));
	}
	return receipts;
}

let remoteRecoveryInFlight:
	| Promise<ExitedManagedAgentCleanupCompensationReceipt[]>
	| undefined;

/** Replays durable remote cleanup compensation after a renderer restart. An
 * unavailable or changed Host leaves the record intact for a later retry. */
export function recoverRemoteManagedAgentCleanupCompensations(): Promise<
	ExitedManagedAgentCleanupCompensationReceipt[]
> {
	if (remoteRecoveryInFlight) return remoteRecoveryInFlight;
	const operation = (async () => {
		const storage = browserCleanupCompensationStorage();
		if (!storage) return [];
		const hostIds = [
			...new Set(
				exitedManagedAgentCleanupCompensations(storage).flatMap((record) =>
					record.sourceBinding.source === "ssh"
						? [record.sourceBinding.hostId]
						: [],
				),
			),
		];
		const receipts: ExitedManagedAgentCleanupCompensationReceipt[] = [];
		for (const hostId of hostIds) {
			const state = useStore.getState();
			const host = state.sshHosts.find((entry) => entry.id === hostId);
			if (!host) continue;
			const hostSnapshot = JSON.stringify(host);
			try {
				const trust = await remoteHmuxKnownHostTrust(
					host.id,
					host.host,
					host.port,
				);
				const latestHost = useStore
					.getState()
					.sshHosts.find((entry) => entry.id === hostId);
				if (JSON.stringify(latestHost) !== hostSnapshot) continue;
				const target = planRemoteHmuxCatalogTarget([host], hostId, trust);
				const catalog = await remoteHmuxCatalog(target);
				const finalHost = useStore
					.getState()
					.sshHosts.find((entry) => entry.id === hostId);
				if (JSON.stringify(finalHost) !== hostSnapshot) continue;
				receipts.push(
					...reconcileRemoteManagedAgentCleanupCompensations(
						hostId,
						catalog.sessions,
					),
				);
			} catch {
				// Durable compensation remains authoritative until a later retry.
			}
		}
		return receipts;
	})();
	remoteRecoveryInFlight = operation;
	void operation.finally(() => {
		if (remoteRecoveryInFlight === operation)
			remoteRecoveryInFlight = undefined;
	});
	return operation;
}
