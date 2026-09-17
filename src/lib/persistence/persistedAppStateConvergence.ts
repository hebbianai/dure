import {
	convergeDurableCas,
	convergeDurableIdEntities,
	convergeDurableOrderedStrings,
	convergeDurableRecord,
	createFieldwiseDurableStateConvergence,
	DURABLE_FIELD_MISSING,
	type DurableFieldConvergence,
	type DurableFieldPolicies,
	type DurableFieldValue,
	type DurableStateConvergence,
} from "@/lib/persistence/durableWriteCoordinator";
import type { PersistedAppState } from "@/lib/persistence/persistedAppState";
import {
	type PaneLayoutConvergenceContext,
	type PersistedReferenceConvergence,
	convergePersistedAgents,
	convergePersistedReferences,
} from "@/lib/persistence/persistedResourceConvergence";
import { classifyTerminalPaneHost } from "@/lib/terminal/paneHostIdentity";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import {
	appendPanelToLayout,
	graftPanelIdsFromLayout,
	isSerializedDockviewLayout,
	panelDefinitionFromLayout,
	panelIsPlacedInLayout,
	panelsFromLayout,
	removePanelIdsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { panePinKey } from "@/lib/workspace/pane/panePin";
import { gitProjectIdFromPane } from "@/lib/scm/gitPaneTarget";
import type { Agent, Project, SshHostConfig } from "@/types";

function owns(value: object, key: PropertyKey): boolean {
	return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

function recordPolicy<T>(): DurableFieldConvergence<T> {
	return (base, local, remote) =>
		convergeDurableRecord(
			base as DurableFieldValue<Record<string, unknown>>,
			local as DurableFieldValue<Record<string, unknown>>,
			remote as DurableFieldValue<Record<string, unknown>>,
		) as DurableFieldValue<T>;
}

function idEntityPolicy<T extends { id: string }>(): DurableFieldConvergence<
	T[]
> {
	return convergeDurableIdEntities;
}

function panelIds(layout: unknown): Set<string> | undefined {
	if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
		return undefined;
	}
	const panels = (layout as Record<string, unknown>).panels;
	if (!panels || typeof panels !== "object" || Array.isArray(panels)) {
		return undefined;
	}
	return new Set(Object.keys(panels));
}

function removedPanelIds(
	base: ReadonlySet<string>,
	projection: ReadonlySet<string>,
): Set<string> {
	return new Set([...base].filter((id) => !projection.has(id)));
}

function cloneRecord(value: unknown): Record<string, unknown> | undefined {
	try {
		const cloned = JSON.parse(JSON.stringify(value)) as unknown;
		return cloned && typeof cloned === "object" && !Array.isArray(cloned)
			? (cloned as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function panelRecord(layout: unknown): Record<string, unknown> | undefined {
	if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
		return undefined;
	}
	const panels = (layout as Record<string, unknown>).panels;
	return panels && typeof panels === "object" && !Array.isArray(panels)
		? (panels as Record<string, unknown>)
		: undefined;
}

function sameSerializedLayout(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function panelPlacementEvidence(value: unknown, panelId: string): unknown {
	if (Array.isArray(value)) {
		const matches = value
			.map((entry) => panelPlacementEvidence(entry, panelId))
			.filter((entry) => entry !== undefined);
		return matches.length > 0 ? matches : undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		[record.views, record.panelIds].some(
			(ids) => Array.isArray(ids) && ids.includes(panelId),
		)
	) {
		return cloneRecord(record);
	}
	const descendants = Object.fromEntries(
		Object.entries(record)
			.map(([key, entry]) => [key, panelPlacementEvidence(entry, panelId)] as const)
			.filter(([, entry]) => entry !== undefined),
	);
	if (Object.keys(descendants).length === 0) return undefined;
	return {
		...Object.fromEntries(
			Object.entries(record).filter(
				([, entry]) => entry === null || typeof entry !== "object",
			),
		),
		...descendants,
	};
}

function panelPlacementRevision(
	layout: Record<string, unknown> | undefined,
	panelId: string,
): string | undefined {
	if (!layout) return undefined;
	const grid = cloneRecord(layout.grid);
	const evidence = {
		grid: grid
			? panelPlacementEvidence(
					{ orientation: grid.orientation, root: grid.root },
					panelId,
				)
			: undefined,
		floatingGroups: panelPlacementEvidence(layout.floatingGroups, panelId),
		popoutGroups: panelPlacementEvidence(layout.popoutGroups, panelId),
		edgeGroups: panelPlacementEvidence(layout.edgeGroups, panelId),
	};
	return Object.values(evidence).some((entry) => entry !== undefined)
		? JSON.stringify(evidence)
		: undefined;
}

function placedPanelIds(layout: Record<string, unknown>): Set<string> {
	return new Set(
		Object.keys(panelRecord(layout) ?? {}).filter((panelId) =>
			panelIsPlacedInLayout(layout, panelId),
		),
	);
}

function placementPanelIds(
	value: unknown,
	availableIds: ReadonlySet<string>,
): string[] {
	if (typeof value === "string") {
		return availableIds.has(value) ? [value] : [];
	}
	if (Array.isArray(value)) {
		return value.flatMap((entry) => placementPanelIds(entry, availableIds));
	}
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	for (const key of ["views", "panelIds"] as const) {
		if (Array.isArray(record[key])) {
			return record[key].filter(
				(id): id is string =>
					typeof id === "string" && availableIds.has(id),
			);
		}
	}
	return Object.values(record).flatMap((entry) =>
		placementPanelIds(entry, availableIds),
	);
}

function rootGridPanelOrder(layout: Record<string, unknown>): string[] {
	const grid = layout.grid;
	const root =
		grid && typeof grid === "object" && !Array.isArray(grid)
			? (grid as Record<string, unknown>).root
			: undefined;
	const children =
		root && typeof root === "object" && !Array.isArray(root)
			? (root as Record<string, unknown>).data
			: undefined;
	return Array.isArray(children)
		? children.flatMap((child) => placementPanelIds(child, placedPanelIds(layout)))
		: [];
}

function panelPlacementChanged(
	base: Record<string, unknown> | undefined,
	candidate: Record<string, unknown>,
	panelId: string,
): boolean {
	if (!base) return panelPlacementRevision(candidate, panelId) !== undefined;
	if (
		panelPlacementRevision(base, panelId) !==
		panelPlacementRevision(candidate, panelId)
	) {
		return true;
	}
	const baseOrder = rootGridPanelOrder(base);
	const candidateOrder = rootGridPanelOrder(candidate);
	const sharedIds = new Set(baseOrder.filter((id) => candidateOrder.includes(id)));
	if (!sharedIds.has(panelId)) return false;
	return (
		JSON.stringify(baseOrder.filter((id) => sharedIds.has(id))) !==
		JSON.stringify(candidateOrder.filter((id) => sharedIds.has(id)))
	);
}

function placementPeers(
	layout: Record<string, unknown>,
	seedIds: ReadonlySet<string>,
	availableIds: ReadonlySet<string>,
	blockedIds: ReadonlySet<string>,
): Set<string> {
	const expanded = new Set(seedIds);
	let changed = true;
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		for (const key of ["views", "panelIds"] as const) {
			const ids = record[key];
			if (!Array.isArray(ids) || !ids.some((id) => expanded.has(id))) continue;
			for (const id of ids) {
				if (
					typeof id === "string" &&
					availableIds.has(id) &&
					!blockedIds.has(id) &&
					!expanded.has(id)
				) {
					expanded.add(id);
					changed = true;
				}
			}
		}
		for (const entry of Object.values(record)) visit(entry);
	};
	while (changed) {
		changed = false;
		visit(layout.grid);
		visit(layout.floatingGroups);
		visit(layout.popoutGroups);
		visit(layout.edgeGroups);
	}
	return expanded;
}

function convergeSerializedSpaceLayout(
	base: DurableFieldValue<unknown>,
	local: unknown,
	remote: unknown,
	localSemanticPanes: ReadonlySet<string>,
	remoteSemanticPanes: ReadonlySet<string>,
): DurableFieldValue<unknown> | undefined {
	if (
		!isSerializedDockviewLayout(local) ||
		!isSerializedDockviewLayout(remote) ||
		(base !== DURABLE_FIELD_MISSING && !isSerializedDockviewLayout(base))
	) {
		return undefined;
	}
	const localLayout = local as Record<string, unknown>;
	const remoteLayout = remote as Record<string, unknown>;
	const baseLayout =
		base === DURABLE_FIELD_MISSING
			? undefined
			: (base as Record<string, unknown>);
	const localPanels = panelRecord(localLayout);
	const remotePanels = panelRecord(remoteLayout);
	const basePanels = baseLayout ? panelRecord(baseLayout) : {};
	if (
		!localPanels ||
		!remotePanels ||
		!basePanels
	) {
		return undefined;
	}

	const mergedPanelValue = convergeDurableRecord(
		basePanels,
		localPanels,
		remotePanels,
	);
	if (mergedPanelValue === DURABLE_FIELD_MISSING) {
		return undefined;
	}
	const mergedPanelDefinitions = cloneRecord(mergedPanelValue);
	if (!mergedPanelDefinitions) return undefined;

	// Pane cleanup only loses to a semantic registration that survived its
	// field convergence. Ordinary stale projections cannot revive a closed pane.
	for (const panelId of localSemanticPanes) {
		const definition = panelDefinitionFromLayout(localLayout, panelId);
		if (definition !== undefined) mergedPanelDefinitions[panelId] = definition;
	}
	for (const panelId of remoteSemanticPanes) {
		const definition = panelDefinitionFromLayout(remoteLayout, panelId);
		if (definition !== undefined) mergedPanelDefinitions[panelId] = definition;
	}

	const basePanelIds = new Set(Object.keys(basePanels));
	const localRemoved = removedPanelIds(
		basePanelIds,
		new Set(Object.keys(localPanels)),
	);
	const remoteRemoved = removedPanelIds(
		basePanelIds,
		new Set(Object.keys(remotePanels)),
	);
	const selectedSnapshot = convergeDurableCas(
		baseLayout ?? DURABLE_FIELD_MISSING,
		localLayout,
		remoteLayout,
	);
	if (selectedSnapshot === DURABLE_FIELD_MISSING) return undefined;
	const bothChanged =
		baseLayout !== undefined &&
		!sameSerializedLayout(localLayout, baseLayout) &&
		!sameSerializedLayout(remoteLayout, baseLayout);
	const localProtectsRemoteRemoval = [...remoteRemoved].some((panelId) =>
		localSemanticPanes.has(panelId),
	);
	const remoteProtectsLocalRemoval = [...localRemoved].some((panelId) =>
		remoteSemanticPanes.has(panelId),
	);
	// A serialized layout is one complete placement snapshot. Choose one side's
	// tree, then replay proven deletions and semantic additions over it; merging
	// grid and auxiliary groups independently can place one panel twice.
	const structuralSource =
		localProtectsRemoteRemoval && !remoteProtectsLocalRemoval
			? localLayout
			: remoteProtectsLocalRemoval && !localProtectsRemoteRemoval
				? remoteLayout
				: bothChanged && remoteRemoved.size > 0 && localRemoved.size === 0
			? localLayout
			: bothChanged && localRemoved.size > 0 && remoteRemoved.size === 0
				? remoteLayout
				: selectedSnapshot;
	const next = cloneRecord(structuralSource);
	if (!next) return undefined;
	const nextGrid = cloneRecord(next.grid);
	const localGrid = cloneRecord(localLayout.grid);
	const remoteGrid = cloneRecord(remoteLayout.grid);
	const baseGrid = baseLayout ? cloneRecord(baseLayout.grid) : undefined;
	if (nextGrid && localGrid && remoteGrid) {
		for (const dimension of ["width", "height"] as const) {
			const selected = convergeDurableCas(
				baseGrid && owns(baseGrid, dimension)
					? baseGrid[dimension]
					: DURABLE_FIELD_MISSING,
				owns(localGrid, dimension)
					? localGrid[dimension]
					: DURABLE_FIELD_MISSING,
				owns(remoteGrid, dimension)
					? remoteGrid[dimension]
					: DURABLE_FIELD_MISSING,
			);
			if (selected === DURABLE_FIELD_MISSING) delete nextGrid[dimension];
			else nextGrid[dimension] = selected;
		}
		next.grid = nextGrid;
	}
	const targetPanelIds = new Set(Object.keys(mergedPanelDefinitions));
	let converged: unknown = removePanelIdsFromLayout(
		next,
		new Set(
			Object.keys(panelRecord(next) ?? {}).filter(
				(panelId) => !targetPanelIds.has(panelId),
			),
		),
	);
	const localPlacementIds = new Set<string>();
	const remotePlacementIds = new Set<string>();
	// Removal redistributes space among survivors. Compare each writer against
	// that same reduced base so automatic resizing is not replayed as a move.
	const localPlacementBase =
		localRemoved.size > 0
			? cloneRecord(removePanelIdsFromLayout(baseLayout, localRemoved))
			: baseLayout;
	const remotePlacementBase =
		remoteRemoved.size > 0
			? cloneRecord(removePanelIdsFromLayout(baseLayout, remoteRemoved))
			: baseLayout;
	for (const panelId of targetPanelIds) {
		const localRevision = panelPlacementRevision(localLayout, panelId);
		const remoteRevision = panelPlacementRevision(remoteLayout, panelId);
		const localChanged = panelPlacementChanged(
			localPlacementBase,
			localLayout,
			panelId,
		);
		const remoteChanged = panelPlacementChanged(
			remotePlacementBase,
			remoteLayout,
			panelId,
		);
		if (
			localRevision !== undefined &&
			((localSemanticPanes.has(panelId) &&
				(localChanged || remoteRevision === undefined)) ||
				(localChanged && !remoteChanged))
		) {
			localPlacementIds.add(panelId);
		} else if (
			remoteRevision !== undefined &&
			((remoteSemanticPanes.has(panelId) &&
				(remoteChanged || localRevision === undefined)) ||
				(remoteChanged && !localChanged))
		) {
			remotePlacementIds.add(panelId);
		}
	}
	const localExpanded = placementPeers(
		localLayout,
		localPlacementIds,
		targetPanelIds,
		remotePlacementIds,
	);
	const remoteExpanded = placementPeers(
		remoteLayout,
		remotePlacementIds,
		targetPanelIds,
		localPlacementIds,
	);
	for (const panelId of targetPanelIds) {
		if (
			!localPlacementIds.has(panelId) &&
			!remotePlacementIds.has(panelId) &&
			localExpanded.has(panelId) &&
			remoteExpanded.has(panelId)
		) {
			localExpanded.delete(panelId);
			remoteExpanded.delete(panelId);
		}
	}
	for (const [source, panelIds] of [
		[localLayout, localExpanded],
		[remoteLayout, remoteExpanded],
	] as const) {
		if (
			panelIds.size === 0 ||
			sameSerializedLayout(source, structuralSource)
		) {
			continue;
		}
		const grafted = graftPanelIdsFromLayout(converged, source, panelIds);
		if (grafted) converged = grafted;
	}
	for (const panelId of targetPanelIds) {
		if (panelIsPlacedInLayout(converged, panelId)) continue;
		const appended = appendPanelToLayout(
			converged,
			panelId,
			mergedPanelDefinitions[panelId],
		);
		if (!appended) return undefined;
		converged = appended;
	}
	const convergedPanels = panelRecord(converged);
	if (!convergedPanels) return undefined;
	for (const [panelId, definition] of Object.entries(mergedPanelDefinitions)) {
		convergedPanels[panelId] = definition;
	}
	return converged;
}

function convergeSpaceLayout(
	base: DurableFieldValue<unknown>,
	local: DurableFieldValue<unknown>,
	remote: DurableFieldValue<unknown>,
	localSemanticPanes: ReadonlySet<string>,
	remoteSemanticPanes: ReadonlySet<string>,
): DurableFieldValue<unknown> {
	const selected = convergeDurableCas(base, local, remote);
	if (local === DURABLE_FIELD_MISSING || remote === DURABLE_FIELD_MISSING) {
		return selected;
	}
	const serialized = convergeSerializedSpaceLayout(
		base,
		local,
		remote,
		localSemanticPanes,
		remoteSemanticPanes,
	);
	if (serialized !== undefined) return serialized;
	if (base === DURABLE_FIELD_MISSING) return selected;
	const basePanels = panelIds(base);
	const localPanels = panelIds(local);
	const remotePanels = panelIds(remote);
	if (!basePanels || !localPanels || !remotePanels) return selected;
	const locallyRemoved = removedPanelIds(basePanels, localPanels);
	const remotelyRemoved = removedPanelIds(basePanels, remotePanels);
	const removed = new Set([...locallyRemoved, ...remotelyRemoved]);
	if (removed.size === 0) return selected;
	// Exact cleanup is a transform over the latest layout. When its stale
	// counterpart added/resized another pane, keep that counterpart as the
	// structural base and replay only the proven base-panel deletions.
	const structuralBase =
		remotelyRemoved.size > 0 && locallyRemoved.size === 0 ? local : remote;
	return removePanelIdsFromLayout(structuralBase, removed);
}

export const convergeDurableLayouts: DurableFieldConvergence<
	PersistedAppState["layouts"]
> = (baseValue, localValue, remoteValue) =>
	convergeDurableLayoutsForSemanticPanes(baseValue, localValue, remoteValue);

function convergeDurableLayoutsForSemanticPanes(
	baseValue: DurableFieldValue<Record<string, unknown>>,
	localValue: DurableFieldValue<Record<string, unknown>>,
	remoteValue: DurableFieldValue<Record<string, unknown>>,
	panes?: PaneLayoutConvergenceContext,
): DurableFieldValue<Record<string, unknown>> {
	if (
		localValue === DURABLE_FIELD_MISSING ||
		remoteValue === DURABLE_FIELD_MISSING
	) {
		return convergeDurableCas(baseValue, localValue, remoteValue);
	}
	const base = baseValue === DURABLE_FIELD_MISSING ? {} : baseValue;
	if (
		!base ||
		typeof base !== "object" ||
		Array.isArray(base) ||
		!localValue ||
		typeof localValue !== "object" ||
		Array.isArray(localValue) ||
		!remoteValue ||
		typeof remoteValue !== "object" ||
		Array.isArray(remoteValue)
	) {
		return remoteValue;
	}
	const merged: Record<string, unknown> = {};
	for (const spaceId of new Set([
		...Object.keys(base),
		...Object.keys(remoteValue),
		...Object.keys(localValue),
	])) {
		const localLayout = owns(localValue, spaceId)
			? localValue[spaceId]
			: undefined;
		const remoteLayout = owns(remoteValue, spaceId)
			? remoteValue[spaceId]
			: undefined;
		const localSemanticPanesForSpace = new Set(
			[...(panes?.localPaneIdsBySpace.get(spaceId) ?? [])].filter(
				(paneId) => panelIsPlacedInLayout(localLayout, paneId),
			),
		);
		const remoteSemanticPanesForSpace = new Set(
			[...(panes?.remotePaneIdsBySpace.get(spaceId) ?? [])].filter(
				(paneId) => panelIsPlacedInLayout(remoteLayout, paneId),
			),
		);
		const selected = convergeSpaceLayout(
			owns(base, spaceId) ? base[spaceId] : DURABLE_FIELD_MISSING,
			owns(localValue, spaceId) ? localValue[spaceId] : DURABLE_FIELD_MISSING,
			owns(remoteValue, spaceId) ? remoteValue[spaceId] : DURABLE_FIELD_MISSING,
			localSemanticPanesForSpace,
			remoteSemanticPanesForSpace,
		);
		if (selected !== DURABLE_FIELD_MISSING) merged[spaceId] = selected;
	}
	return merged;
}

function pruneUnownedResourcePanes(
	base: PersistedAppState | undefined,
	layouts: PersistedAppState["layouts"],
	agents: readonly Agent[],
	projects: readonly Project[],
	sshHosts: readonly SshHostConfig[],
): PersistedAppState["layouts"] {
	const agentIds = new Set(agents.map((agent) => agent.id));
	const projectIds = new Set(projects.map((project) => project.id));
	const hostIds = new Set(sshHosts.map((host) => host.id));
	const removedAgentIds = new Set(
		(base?.agents ?? [])
			.filter((agent) => !agentIds.has(agent.id))
			.map((agent) => agent.id),
	);
	const removedProjectIds = new Set(
		(base?.projects ?? [])
			.filter((project) => !projectIds.has(project.id))
			.map((project) => project.id),
	);
	const removedHostIds = new Set(
		(base?.sshHosts ?? [])
			.filter((host) => !hostIds.has(host.id))
			.map((host) => host.id),
	);
	return Object.fromEntries(
		Object.entries(layouts).map(([spaceId, layout]) => {
			const removed = new Set(
				panelsFromLayout(layout).flatMap((pane) => {
					if (pane.component === "agent") {
						const agentId = agentIdFromPaneParameters(pane.params);
						return agentId !== undefined && removedAgentIds.has(agentId)
							? [pane.id]
							: [];
					}
					const projectId = gitProjectIdFromPane(pane);
					if (projectId !== undefined) {
						return removedProjectIds.has(projectId)
							? [pane.id]
							: [];
					}
					return [...removedHostIds].some(
						(hostId) =>
							classifyTerminalPaneHost(pane.params, hostId) === "owned",
					)
						? [pane.id]
						: [];
				}),
			);
			return [
				spaceId,
				removed.size > 0 ? removePanelIdsFromLayout(layout, removed) : layout,
			];
		}),
	);
}

function convergeProtectedProjectPins(
	base: PersistedAppState | undefined,
	local: PersistedAppState,
	remote: PersistedAppState,
	references: PersistedReferenceConvergence,
): string[] {
	const converged = convergeDurableOrderedStrings(
		base?.pinnedProjects ?? DURABLE_FIELD_MISSING,
		local.pinnedProjects,
		remote.pinnedProjects,
	);
	const survivingProjects = new Set(
		references.projects.map((project) => project.id),
	);
	const removedProjectIds = new Set(
		(base?.projects ?? [])
			.filter((project) => !survivingProjects.has(project.id))
			.map((project) => project.id),
	);
	const pins = Array.isArray(converged)
		? converged.filter((projectId) => !removedProjectIds.has(projectId))
		: [];
	const pinned = new Set(pins);
	for (const [source, protectedIds] of [
		[local, references.localProtectedProjectIds],
		[remote, references.remoteProtectedProjectIds],
	] as const) {
		for (const projectId of source.pinnedProjects) {
			if (
				protectedIds.has(projectId) &&
				survivingProjects.has(projectId) &&
				!pinned.has(projectId)
			) {
				pinned.add(projectId);
				pins.push(projectId);
			}
		}
	}
	return pins;
}

function deletionProvenPanePinKeys(
	base: PersistedAppState | undefined,
	local: PersistedAppState,
	remote: PersistedAppState,
	agents: readonly Agent[],
	projects: readonly Project[],
	layouts: PersistedAppState["layouts"],
): Set<string> {
	const finalAgentIds = new Set(agents.map((agent) => agent.id));
	const finalProjectIds = new Set(projects.map((project) => project.id));
	const removedAgentIds = (base?.agents ?? [])
		.filter((agent) => !finalAgentIds.has(agent.id))
		.map((agent) => agent.id);
	const removedProjectIds = (base?.projects ?? [])
		.filter((project) => !finalProjectIds.has(project.id))
		.map((project) => project.id);
	const finalOccurrences = new Set(
		Object.entries(layouts).flatMap(([spaceId, layout]) =>
			panelsFromLayout(layout).map((pane) => panePinKey(spaceId, pane.id)),
		),
	);
	const spaceIds = new Set([
		"detached",
		...Object.keys(base?.layouts ?? {}),
		...Object.keys(local.layouts),
		...Object.keys(remote.layouts),
		...Object.keys(layouts),
		...(base?.spaces ?? []).map((space) => space.id),
		...local.spaces.map((space) => space.id),
		...remote.spaces.map((space) => space.id),
	]);
	const removed = new Set<string>();
	for (const spaceId of spaceIds) {
		for (const agentId of removedAgentIds) {
			const key = panePinKey(spaceId, `agent:${agentId}`);
			// Retire orphaned legacy pins, never a current pane with a reused ID.
			if (!finalOccurrences.has(key)) removed.add(key);
		}
		for (const projectId of removedProjectIds) {
			const key = panePinKey(spaceId, `git:${projectId}`);
			if (!finalOccurrences.has(key)) removed.add(key);
		}
	}
	for (const state of [base, local, remote]) {
		if (!state) continue;
		for (const [spaceId, layout] of Object.entries(state.layouts)) {
			for (const pane of panelsFromLayout(layout)) {
				const key = panePinKey(spaceId, pane.id);
				if (!finalOccurrences.has(key)) removed.add(key);
			}
		}
	}
	return removed;
}

function convergeProtectedPanePins(
	base: PersistedAppState | undefined,
	local: PersistedAppState,
	remote: PersistedAppState,
	references: PersistedReferenceConvergence,
	agents: readonly Agent[],
	layouts: PersistedAppState["layouts"],
): PersistedAppState["pinnedPanes"] {
	const converged = convergeDurableRecord(
		base?.pinnedPanes ?? DURABLE_FIELD_MISSING,
		local.pinnedPanes,
		remote.pinnedPanes,
	);
	const removedPins = deletionProvenPanePinKeys(
		base,
		local,
		remote,
		agents,
		references.projects,
		layouts,
	);
	const pins = Object.fromEntries(
		Object.entries(
			converged === DURABLE_FIELD_MISSING ? {} : converged,
		).filter(
			([key, pinned]) => pinned === true && !removedPins.has(key),
		),
	);
	for (const [source, protectedBySpace] of [
		[local, references.panes.localPaneIdsBySpace],
		[remote, references.panes.remotePaneIdsBySpace],
	] as const) {
		for (const [spaceId, sourceLayout] of Object.entries(source.layouts)) {
			for (const paneId of protectedBySpace.get(spaceId) ?? []) {
				const key = panePinKey(spaceId, paneId);
				if (
					source.pinnedPanes[key] === true &&
					panelDefinitionFromLayout(sourceLayout, paneId) !== undefined &&
					panelDefinitionFromLayout(layouts[spaceId], paneId) !== undefined
				) {
					pins[key] = true;
				}
			}
		}
	}
	return pins;
}

type IndependentPersistedAppState = Omit<
	PersistedAppState,
	| "agents"
	| "layouts"
	| "pinnedPanes"
	| "pinnedProjects"
	| "projects"
	| "sshHosts"
>;

const policies = {
	spaces: idEntityPolicy<PersistedAppState["spaces"][number]>(),
	spaceVisits: recordPolicy<PersistedAppState["spaceVisits"]>(),
	shortcutOverrides: recordPolicy<PersistedAppState["shortcutOverrides"]>(),
	fileTreeSelected: recordPolicy<PersistedAppState["fileTreeSelected"]>(),
	terminalFontSize: convergeDurableCas,
	terminalPrefs: recordPolicy<PersistedAppState["terminalPrefs"]>(),
	uiPrefs: recordPolicy<PersistedAppState["uiPrefs"]>(),
	notifyPrefs: recordPolicy<PersistedAppState["notifyPrefs"]>(),
	stats: recordPolicy<PersistedAppState["stats"]>(),
	accounts: idEntityPolicy<PersistedAppState["accounts"][number]>(),
	activeAccounts: recordPolicy<PersistedAppState["activeAccounts"]>(),
	customThemes: idEntityPolicy<PersistedAppState["customThemes"][number]>(),
	autoSwitchAccounts: convergeDurableCas,
	skipPermissions: recordPolicy<PersistedAppState["skipPermissions"]>(),
	language: convergeDurableCas,
} satisfies DurableFieldPolicies<IndependentPersistedAppState>;

const convergeIndependentPersistedAppFields =
	createFieldwiseDurableStateConvergence<IndependentPersistedAppState>(
		policies,
	);

/** Resource decisions project onto the panes that currently reference them. */
export const convergePersistedAppState: DurableStateConvergence<
	PersistedAppState
> = (base, local, remote) => {
	const agentConvergence = convergePersistedAgents(
		base?.agents ?? [],
		local.agents,
		remote.agents,
	);
	const referenceConvergence = convergePersistedReferences(
		base,
		local,
		remote,
		agentConvergence,
	);
	const mergedLayouts = convergeDurableLayoutsForSemanticPanes(
		base?.layouts ?? DURABLE_FIELD_MISSING,
		local.layouts,
		remote.layouts,
		referenceConvergence.panes,
	) as PersistedAppState["layouts"];
	const layouts = pruneUnownedResourcePanes(
		base,
		mergedLayouts,
		agentConvergence.agents,
		referenceConvergence.projects,
		referenceConvergence.sshHosts,
	);
	return {
		...convergeIndependentPersistedAppFields(base, local, remote),
		projects: referenceConvergence.projects,
		pinnedProjects: convergeProtectedProjectPins(
			base,
			local,
			remote,
			referenceConvergence,
		),
		sshHosts: referenceConvergence.sshHosts,
		agents: agentConvergence.agents,
		layouts,
		pinnedPanes: convergeProtectedPanePins(
			base,
			local,
			remote,
			referenceConvergence,
			agentConvergence.agents,
			layouts,
		),
	};
};
