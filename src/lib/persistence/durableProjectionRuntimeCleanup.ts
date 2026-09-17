import { sameAgentOperationalIdentity } from "@/lib/agents/resourceOperationalIdentity";
import { terminalSessionsFromLayout } from "@/lib/workspace/layout/terminalSessionRefs";
import { exactLayoutRevision } from "@/lib/workspace/layout/layoutCloseIdentity";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import type { Agent, Project, SshHostConfig } from "@/types";

interface DurableProjectionReferenceState {
	readonly agents: readonly Agent[];
	readonly projects: readonly Project[];
	readonly sshHosts: readonly SshHostConfig[];
	readonly layouts: Readonly<Record<string, unknown>>;
}

export interface DurableProjectionSnapshot {
	readonly agents: ReadonlyMap<string, Agent>;
	readonly projects: ReadonlyMap<string, Project>;
	readonly sshHosts: ReadonlyMap<string, SshHostConfig>;
	readonly sessionIds: ReadonlySet<string>;
	readonly paneOccurrences: ReadonlySet<string>;
	readonly layoutRevisions: ReadonlyMap<string, string>;
}

export interface DurableProjectionDepartures {
	/** Agent registrations whose runtime-owned projection was replaced or removed. */
	readonly agentIds: ReadonlySet<string>;
	/** Project IDs that disappeared; same-ID successors retain discovery state. */
	readonly projectIds: ReadonlySet<string>;
	readonly sessionIds: ReadonlySet<string>;
	readonly paneOccurrences: ReadonlySet<string>;
	readonly projectionSpaceIds: ReadonlySet<string>;
}

export type DurableProjectionCleanupCandidates = Partial<
	Pick<DurableProjectionDepartures, "agentIds" | "projectIds" | "sessionIds">
>;

function paneOccurrenceKey(spaceId: string, panelId: string): string {
	return JSON.stringify([spaceId, panelId]);
}

function byId<T extends { readonly id: string }>(
	values: readonly T[],
): ReadonlyMap<string, T> {
	return new Map(values.map((value) => [value.id, value]));
}

/** Capture only durable references. Runtime caches never create ownership. */
export function durableProjectionReferences(
	state: DurableProjectionReferenceState,
): DurableProjectionSnapshot {
	return {
		agents: byId(state.agents),
		projects: byId(state.projects),
		sshHosts: byId(state.sshHosts),
		sessionIds: new Set([
			...state.agents.map((agent) => agent.sessionId),
			...Object.values(state.layouts).flatMap((layout) =>
				terminalSessionsFromLayout(layout).map((session) => session.sessionId),
			),
		]),
		paneOccurrences: new Set(
			Object.entries(state.layouts).flatMap(([spaceId, layout]) =>
				panelsFromLayout(layout).map((panel) =>
					paneOccurrenceKey(spaceId, panel.id),
				),
			),
		),
		layoutRevisions: new Map(
			Object.entries(state.layouts).map(([spaceId, layout]) => [
				spaceId,
				exactLayoutRevision(layout),
			]),
		),
	};
}

function removed(before: ReadonlySet<string>, after: ReadonlySet<string>) {
	return new Set([...before].filter((id) => !after.has(id)));
}

function changedRevisionSpaceIds(
	previous: ReadonlyMap<string, string>,
	current: ReadonlyMap<string, string>,
): ReadonlySet<string> {
	return new Set(
		[...new Set([...previous.keys(), ...current.keys()])].filter(
			(spaceId) => previous.get(spaceId) !== current.get(spaceId),
		),
	);
}

/** Return durable registrations and references that departed during rehydrate. */
export function removedDurableProjectionReferences(
	previous: DurableProjectionSnapshot,
	current: DurableProjectionSnapshot,
): DurableProjectionDepartures {
	const agentIds = new Set(
		[...previous.agents].flatMap(([id, registration]) =>
			sameAgentOperationalIdentity(current.agents.get(id), registration)
				? []
				: [id],
		),
	);
	const projectIds = new Set(
		[...previous.projects.keys()].filter((id) => !current.projects.has(id)),
	);
	const paneOccurrences = removed(
		previous.paneOccurrences,
		current.paneOccurrences,
	);
	const changedSpaces = changedRevisionSpaceIds(
		previous.layoutRevisions,
		current.layoutRevisions,
	);
	return {
		agentIds,
		projectIds,
		sessionIds: removed(previous.sessionIds, current.sessionIds),
		paneOccurrences,
		projectionSpaceIds: changedSpaces,
	};
}

export async function rehydrateDurableProjectionRuntime(deps: {
	readonly current: () => DurableProjectionReferenceState;
	readonly rehydrate: () => Promise<void>;
	readonly additionalDepartures?: DurableProjectionCleanupCandidates;
	readonly remove: (references: DurableProjectionDepartures) => void;
}): Promise<DurableProjectionDepartures> {
	const before = durableProjectionReferences(deps.current());
	await deps.rehydrate();
	const current = durableProjectionReferences(deps.current());
	const observed = removedDurableProjectionReferences(
		before,
		current,
	);
	const departed = {
		...observed,
		agentIds: new Set([
			...observed.agentIds,
			...[...(deps.additionalDepartures?.agentIds ?? [])].filter(
				(id) => !current.agents.has(id),
			),
		]),
		projectIds: new Set([
			...observed.projectIds,
			...[...(deps.additionalDepartures?.projectIds ?? [])].filter(
				(id) => !current.projects.has(id),
			),
		]),
		sessionIds: new Set([
			...observed.sessionIds,
			...[...(deps.additionalDepartures?.sessionIds ?? [])].filter(
				(id) => !current.sessionIds.has(id),
			),
		]),
	};
	if (
		departed.agentIds.size > 0 ||
		departed.projectIds.size > 0 ||
		departed.sessionIds.size > 0
	) {
		deps.remove(departed);
	}
	return departed;
}
