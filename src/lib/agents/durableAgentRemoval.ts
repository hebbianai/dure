import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import { sshHostCredentialClaim } from "@/lib/ssh/sshCredentialClaim";
import { withSshCredentialLifecycle } from "@/lib/ssh/sshCredentialLifecycleCoordinator";
import { retireSshCredentialClaims } from "@/lib/ssh/sshCredentialRegistry";
import {
	panelsFromLayout,
	removePanelIdsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import { panePinKey } from "@/lib/workspace/pane/panePin";
import { gitProjectIdFromPane } from "@/lib/scm/gitPaneTarget";
import { terminalSessionFromPanel } from "@/lib/workspace/layout/terminalSessionRefs";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
} from "@/store";
import type {
	Agent,
	Project,
	SshCredentialClaimV1,
	SshHostConfig,
} from "@/types";

export interface DurableProjectionScopeState {
	readonly agents: readonly Agent[];
	readonly projects: readonly Project[];
	readonly sshHosts: readonly SshHostConfig[];
	readonly panes: readonly {
		readonly spaceId: string;
		readonly panelId: string;
		readonly params: Readonly<Record<string, unknown>>;
	}[];
}

export interface DurableAgentProjectionTarget {
	readonly agentId: string;
	/** Legacy orphan-pin hints; current panes are selected by their Agent reference. */
	readonly panelIds: readonly string[];
	readonly sessionIds?: readonly string[];
	readonly applies: (
		agent: Agent,
		projects: readonly Project[],
		sshHosts: readonly SshHostConfig[],
	) => boolean;
}

interface DurableProjectProjectionTarget {
	readonly projectId: string;
	/** Legacy orphan-pin hints; current Git panes carry an explicit project reference. */
	readonly panelIds?: readonly string[];
	readonly applies: (project: Project) => boolean;
}

interface DurableSshHostProjectionTarget {
	readonly hostId: string;
	readonly applies: (host: SshHostConfig) => boolean;
}

interface DurablePaneProjectionTarget {
	readonly spaceId: string;
	readonly panelId: string;
	readonly ownerHostId?: string;
	readonly sessionIds?: readonly string[];
	readonly applies?: (params: Readonly<Record<string, unknown>>) => boolean;
}

interface DurableProjectionRemovalRequestBase {
	readonly agents: readonly DurableAgentProjectionTarget[];
	readonly projects?: readonly DurableProjectProjectionTarget[];
	readonly sshHosts?: readonly DurableSshHostProjectionTarget[];
	readonly panes?: readonly DurablePaneProjectionTarget[];
}

interface DurableExactProjectionRemovalRequest
	extends DurableProjectionRemovalRequestBase {
	readonly mode?: "exact";
	readonly applies?: never;
}

interface DurableBatchProjectionRemovalRequest
	extends DurableProjectionRemovalRequestBase {
	readonly mode: "batch";
	readonly applies: (state: DurableProjectionScopeState) => boolean;
}

export type DurableProjectionRemovalRequest =
	| DurableExactProjectionRemovalRequest
	| DurableBatchProjectionRemovalRequest;

interface RemovablePane {
	readonly spaceId: string;
	readonly panelId: string;
	readonly sessionIds: readonly string[];
	readonly applies?: DurablePaneProjectionTarget["applies"];
}

interface RemovedPaneOccurrence {
	readonly spaceId: string;
	readonly panelId: string;
	readonly sessionIds: readonly string[];
}

interface DurableProjectionRemovalResult {
	readonly applied: boolean;
	readonly affectedSpaceIds: readonly string[];
	readonly agentIds: readonly string[];
	readonly projectIds: readonly string[];
	readonly sessionIds: readonly string[];
	readonly retiredCredentialClaims: readonly SshCredentialClaimV1[];
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function removablePaneOccurrences(
	layouts: Readonly<Record<string, unknown>>,
	panes: readonly RemovablePane[],
	agentIds: ReadonlySet<string>,
	projectIds: ReadonlySet<string>,
): RemovedPaneOccurrence[] {
	const exact = new Map(
		panes.map((pane) => [`${pane.spaceId}\0${pane.panelId}`, pane] as const),
	);
	const occurrences: RemovedPaneOccurrence[] = [];
	for (const [spaceId, layout] of Object.entries(layouts)) {
		for (const panel of panelsFromLayout(layout)) {
			const target = exact.get(`${spaceId}\0${panel.id}`);
			const selectedExplicitly = Boolean(
				target && (!target.applies || target.applies(panel.params)),
			);
			const agentId =
				panel.component === "agent"
					? agentIdFromPaneParameters(panel.params)
					: undefined;
			const projectId = gitProjectIdFromPane(panel);
			if (
				selectedExplicitly ||
				(agentId !== undefined && agentIds.has(agentId)) ||
				(projectId !== undefined && projectIds.has(projectId))
			) {
				const session = terminalSessionFromPanel(panel);
				occurrences.push({
					spaceId,
					panelId: panel.id,
					sessionIds: unique([
						...(selectedExplicitly ? target?.sessionIds ?? [] : []),
						...(session ? [session.sessionId] : []),
					]),
				});
			}
		}
	}
	return occurrences;
}

function removePanePins(
	pinnedPanes: Readonly<Record<string, boolean>>,
	spaceIds: readonly string[],
	legacyPanelIds: ReadonlySet<string>,
	layouts: Readonly<Record<string, unknown>>,
	occurrences: readonly RemovedPaneOccurrence[],
): Record<string, boolean> {
	const retained = new Set(
		Object.entries(layouts).flatMap(([spaceId, layout]) =>
			panelsFromLayout(layout).map((panel) => panePinKey(spaceId, panel.id)),
		),
	);
	const removed = new Set<string>(
		[...spaceIds, "detached"].flatMap((spaceId) =>
			[...legacyPanelIds]
				.map((panelId) => panePinKey(spaceId, panelId))
				.filter((key) => !retained.has(key)),
		),
	);
	for (const occurrence of occurrences) {
		removed.add(panePinKey(occurrence.spaceId, occurrence.panelId));
	}
	if (removed.size === 0) {
		return { ...pinnedPanes };
	}
	return Object.fromEntries(
		Object.entries(pinnedPanes).filter(([key]) => !removed.has(key)),
	);
}

async function projectDurableRemovalResult(
	result: DurableProjectionRemovalResult,
): Promise<void> {
	const options =
		result.affectedSpaceIds.length > 0
			? { forceProjectionDesktopIds: result.affectedSpaceIds }
			: {};
	const additionalDepartures = {
		agentIds: new Set(result.agentIds),
		projectIds: new Set(result.projectIds),
		sessionIds: new Set(result.sessionIds),
	};
	await recoverCurrentDurableStoreProjection(options, additionalDepartures);
}

/**
 * Remove an exact set of Agent/resource projections under the origin-wide
 * durable writer. Structural records and their pane references commit once;
 * runtime records and mounted views are cleanup-only after that commit.
 */
async function removeAgentProjectionDurablyUnlocked(
	request: DurableProjectionRemovalRequest,
): Promise<boolean> {
	const agentTargets = new Map(
		request.agents.map((target) => [target.agentId, target] as const),
	);
	const projectTargets = new Map(
		(request.projects ?? []).map(
			(target) => [target.projectId, target] as const,
		),
	);
	const hostTargets = new Map(
		(request.sshHosts ?? []).map((target) => [target.hostId, target] as const),
	);
	const result = await durableAppStorage.transact(
		DURABLE_APP_STORE_NAME,
		(
			current,
		): {
			value: typeof current;
			result: DurableProjectionRemovalResult;
		} => {
			const rejected = (
				affectedSpaceIds: readonly string[] = [],
			): DurableProjectionRemovalResult => ({
				applied: false,
				affectedSpaceIds,
				agentIds: [],
				projectIds: [],
				sessionIds: [],
				retiredCredentialClaims: [],
			});
			if (!current) return { value: current, result: rejected() };
			const state = normalizePersistedState(current.state);
			const rejectedResult = rejected(
				unique([
					...state.spaces.map((space) => space.id),
					...Object.keys(state.layouts),
					...(request.panes ?? []).map((pane) => pane.spaceId),
				]),
			);
			const scopeState = {
				agents: state.agents,
				projects: state.projects,
				sshHosts: state.sshHosts,
				panes: Object.entries(state.layouts).flatMap(([spaceId, layout]) =>
					panelsFromLayout(layout).map((panel) => ({
						spaceId,
						panelId: panel.id,
						params: panel.params,
					})),
				),
			};
			const scopeApplies = request.mode === "batch"
				? request.applies(scopeState)
				: state.agents.every((agent) => {
						const target = agentTargets.get(agent.id);
						return (
							!target || target.applies(agent, state.projects, state.sshHosts)
						);
					}) &&
					state.projects.every((project) => {
						const target = projectTargets.get(project.id);
						return !target || target.applies(project);
					}) &&
					state.sshHosts.every((host) => {
						const target = hostTargets.get(host.id);
						return !target || target.applies(host);
					});
			if (!scopeApplies) {
				return { value: current, result: rejectedResult };
			}

			const removedAgents = state.agents.filter((agent) => {
				const target = agentTargets.get(agent.id);
				return Boolean(
					target?.applies(agent, state.projects, state.sshHosts),
				);
			});
			const removedAgentIds = new Set(removedAgents.map((agent) => agent.id));
			const preservedAgentIds = new Set(
				state.agents
					.filter(
						(agent) =>
							agentTargets.has(agent.id) && !removedAgentIds.has(agent.id),
					)
					.map((agent) => agent.id),
			);
			const removedProjects = state.projects.filter((project) => {
				const target = projectTargets.get(project.id);
				return Boolean(target?.applies(project));
			});
			const removedProjectIds = new Set(
				removedProjects.map((project) => project.id),
			);
			const preservedProjectIds = new Set(
				state.projects
					.filter(
						(project) =>
							projectTargets.has(project.id) &&
							!removedProjectIds.has(project.id),
					)
					.map((project) => project.id),
			);
			const removedHosts = state.sshHosts.filter((host) => {
				const target = hostTargets.get(host.id);
				return Boolean(target?.applies(host));
			});
			const removedHostIds = new Set(removedHosts.map((host) => host.id));
			const retiredCredentialClaims = removedHosts.flatMap((host) => {
				const claim = sshHostCredentialClaim(host);
				return claim ? [claim] : [];
			});
			const preservedHostIds = new Set(
				state.sshHosts
					.filter(
						(host) => hostTargets.has(host.id) && !removedHostIds.has(host.id),
					)
					.map((host) => host.id),
			);

			const removedOrAbsentAgentIds = request.agents
				.filter((target) => !preservedAgentIds.has(target.agentId))
				.map((target) => target.agentId);
			const removedOrAbsentProjectIds = (request.projects ?? [])
				.filter((target) => !preservedProjectIds.has(target.projectId))
				.map((target) => target.projectId);
			const panes: RemovablePane[] = (request.panes ?? []).flatMap((pane) =>
					pane.ownerHostId && preservedHostIds.has(pane.ownerHostId)
						? []
						: [
								{
									spaceId: pane.spaceId,
									panelId: pane.panelId,
									sessionIds: pane.sessionIds ?? [],
									...(pane.applies ? { applies: pane.applies } : {}),
								},
							],
				);
			const paneOccurrences = removablePaneOccurrences(
				state.layouts,
				panes,
				new Set(removedOrAbsentAgentIds),
				new Set(removedOrAbsentProjectIds),
			);
			const occurrenceIdsBySpace = new Map<string, Set<string>>();
			for (const occurrence of paneOccurrences) {
				const ids = occurrenceIdsBySpace.get(occurrence.spaceId) ?? new Set();
				ids.add(occurrence.panelId);
				occurrenceIdsBySpace.set(occurrence.spaceId, ids);
			}
			const affectedSpaceIds = [...occurrenceIdsBySpace.keys()];
			const layouts = Object.fromEntries(
				Object.entries(state.layouts).map(([spaceId, layout]) => {
					const panelIds = occurrenceIdsBySpace.get(spaceId) ?? new Set<string>();
					return [spaceId, removePanelIdsFromLayout(layout, panelIds)];
				}),
			);
			const sessionIds = unique([
				...removedAgents.map((agent) => agent.sessionId),
				...request.agents.flatMap((target) => target.sessionIds ?? []),
				...panes.flatMap((pane) => pane.sessionIds),
				...paneOccurrences.flatMap((pane) => pane.sessionIds),
			]);

			return {
				value: {
					version: PERSIST_VERSION,
					state: persistedSlice({
						...state,
						agents: state.agents.filter(
							(agent) => !removedAgentIds.has(agent.id),
						),
						projects: state.projects.filter(
							(project) => !removedProjectIds.has(project.id),
						),
						pinnedProjects: state.pinnedProjects.filter(
							(projectId) => !removedProjectIds.has(projectId),
						),
						sshHosts: state.sshHosts.filter(
							(host) => !removedHostIds.has(host.id),
						),
						layouts,
						pinnedPanes: removePanePins(
							state.pinnedPanes,
							unique([
								...state.spaces.map((space) => space.id),
								...Object.keys(state.layouts),
							]),
							new Set([
								...(request.projects ?? []).flatMap((target) =>
									preservedProjectIds.has(target.projectId)
										? []
										: target.panelIds ?? [],
								),
								...request.agents.flatMap((target) =>
									preservedAgentIds.has(target.agentId) ? [] : target.panelIds,
								),
							]),
							layouts,
							paneOccurrences,
						),
					}),
				},
				result: {
					applied: true,
					affectedSpaceIds,
					agentIds: removedOrAbsentAgentIds,
					projectIds: removedOrAbsentProjectIds,
					sessionIds,
					retiredCredentialClaims,
				},
			};
		},
	);
	if (result.applied && result.retiredCredentialClaims.length > 0) {
		await retireSshCredentialClaims(result.retiredCredentialClaims).catch(
			(error) => {
				console.error("[ssh credential retirement after Host removal]", error);
			},
		);
	}
	await projectDurableRemovalResult(result);
	return result.applied;
}

export function removeAgentProjectionDurably(
	request: DurableProjectionRemovalRequest,
): Promise<boolean> {
	const remove = () => removeAgentProjectionDurablyUnlocked(request);
	return request.sshHosts?.length
		? withSshCredentialLifecycle(remove)
		: remove();
}
