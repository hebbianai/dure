import { describe, expect, it } from "vitest";
import {
	convergeDurableIdEntities,
	convergeDurableRecord,
} from "@/lib/persistence/durableWriteCoordinator";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import { convergePersistedAppState } from "@/lib/persistence/persistedAppStateConvergence";
import { hmuxLocalBinding } from "@/lib/terminal/terminalBinding";
import {
	panelIsPlacedInLayout,
	panelsFromLayout,
	removePanelIdsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent, Project, SshHostConfig } from "@/types";

type CommitOrder = "removal-first" | "change-first";

function project(
	id: string,
	path: string,
	sshHostId?: string,
): Project {
	return {
		id,
		name: id,
		path,
		kind: sshHostId ? "ssh" : "local",
		...(sshHostId ? { sshHostId } : {}),
		isRepo: true,
	};
}

function host(id: string, hostname: string): SshHostConfig {
	return {
		id,
		name: id,
		host: hostname,
		port: 22,
		user: "dure",
		auth: "auto",
	};
}

function agent(id: string, projectId: string, sessionId: string): Agent {
	return agentFixture({
		id,
		name: id,
		projectId,
		worktreePath: `/repo/.worktrees/${id}`,
		branch: id,
		sessionId,
	});
}

function withSshRuntime(agent: Agent, hostId: string): Agent {
	return {
		...agent,
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId,
			sessionId: agent.sessionId,
			workspaceId: `workspace-${agent.id}`,
			createIdempotencyKey: `create-${agent.id}`,
			commandBridgeNonce: `nonce-${agent.id}`,
		},
	};
}

function appState(patch: Partial<PersistedAppState>): PersistedAppState {
	return {
		...normalizePersistedState({}),
		spaces: [{ id: "space-a", name: "Main" }],
		...patch,
	};
}

function dockviewLayout(panelIds: readonly string[]): Record<string, unknown> {
	return {
		grid: {
			root: {
				type: "branch",
				data: panelIds.map((panelId) => ({
					type: "leaf",
					data: {
						id: `group:${panelId}`,
						views: [panelId],
						activeView: panelId,
					},
					size: 300,
				})),
				size: 400,
			},
			width: 600,
			height: 400,
			orientation: "HORIZONTAL",
		},
		panels: Object.fromEntries(
			panelIds.map((panelId) => [
				panelId,
				{
					id: panelId,
					// Legacy Agent fixtures still carry explicit content, without agentRef.
					...(panelId.startsWith("agent:") ? { contentComponent: "agent" } : {}),
					...(panelId.startsWith("git:")
						? { contentComponent: "git", params: { projectId: panelId.slice(4) } }
						: {}),
				},
			]),
		),
		activeGroup: panelIds.length > 0 ? `group:${panelIds[0]}` : undefined,
	};
}

function panelIds(state: PersistedAppState): string[] {
	return Object.keys(
		(state.layouts["space-a"] as { panels: Record<string, unknown> }).panels,
	).sort();
}

function rootPanelOrder(layout: unknown): string[] {
	const children = (
		layout as { grid?: { root?: { data?: { data?: { views?: string[] } }[] } } }
	).grid?.root?.data;
	return (children ?? []).flatMap((child) => child.data?.views ?? []);
}

function panelPlacementCountIn(value: unknown, panelId: string): number {
		if (Array.isArray(value)) {
			return value.reduce(
				(count, entry) => count + panelPlacementCountIn(entry, panelId),
				0,
			);
		}
		if (!value || typeof value !== "object") return 0;
		return Object.entries(value as Record<string, unknown>).reduce(
			(count, [key, entry]) =>
				count +
				((key === "views" || key === "panelIds") &&
				Array.isArray(entry) &&
				entry.includes(panelId)
					? 1
					: panelPlacementCountIn(entry, panelId)),
			0,
		);
}

function panelPlacementCount(layout: unknown, panelId: string): number {
	const record =
		layout && typeof layout === "object" && !Array.isArray(layout)
			? (layout as Record<string, unknown>)
			: undefined;
	if (!record) return 0;
	return ["grid", "floatingGroups", "popoutGroups", "edgeGroups"].reduce(
		(count, key) => count + panelPlacementCountIn(record[key], panelId),
		0,
	);
}

function floatingLayout(
	panelId: string,
	panelDefinitions: Record<string, unknown>,
): Record<string, unknown> {
	const value = dockviewLayout([]);
	value.panels = panelDefinitions;
	value.floatingGroups = [
		{
			data: {
				id: `floating:${panelId}`,
				views: [panelId],
				activeView: panelId,
			},
		},
	];
	return value;
}

function floatingTabbedLayout(
	panelIds: readonly string[],
	panelDefinitions: Record<string, unknown>,
): Record<string, unknown> {
	const value = dockviewLayout([]);
	value.panels = panelDefinitions;
	value.floatingGroups = [
		{
			data: {
				id: "floating:shared",
				views: [...panelIds],
				activeView: panelIds[panelIds.length - 1],
			},
		},
	];
	return value;
}

function paneParams(
	state: PersistedAppState,
	spaceId: string,
	panelId: string,
): Record<string, unknown> | undefined {
	return panelsFromLayout(state.layouts[spaceId]).find(
		(pane) => pane.id === panelId,
	)?.params;
}

function convergeOrder(
	base: PersistedAppState,
	change: PersistedAppState,
	removal: PersistedAppState,
	order: CommitOrder,
): PersistedAppState {
	return order === "removal-first"
		? convergePersistedAppState(base, change, removal)
		: convergePersistedAppState(base, removal, change);
}

function successorPlacementFixture(kind: "project" | "host" | "agent"): {
	base: PersistedAppState;
	change: PersistedAppState;
	removal: PersistedAppState;
	paneId: string;
} {
	if (kind === "project") {
		const source = project("project-a", "/repo/source");
		const paneId = `git:${source.id}`;
		const layout = floatingLayout(paneId, {
			[paneId]: { id: paneId, contentComponent: "git", params: { projectId: source.id } },
		});
		const base = appState({ projects: [source], layouts: { "space-a": layout } });
		return {
			base,
			change: { ...base, projects: [{ ...source, path: "/repo/successor" }] },
			removal: {
				...base,
				projects: [],
				layouts: { "space-a": dockviewLayout([]) },
			},
			paneId,
		};
	}
	if (kind === "host") {
		const source = host("host-a", "source.example.test");
		const paneId = "ssh:loose";
		const layout = floatingLayout(paneId, {
			[paneId]: { id: paneId, params: { hostId: source.id } },
		});
		const base = appState({ sshHosts: [source], layouts: { "space-a": layout } });
		return {
			base,
			change: {
				...base,
				sshHosts: [{ ...source, host: "successor.example.test" }],
			},
			removal: {
				...base,
				sshHosts: [],
				layouts: { "space-a": dockviewLayout([]) },
			},
			paneId,
		};
	}
	const sourceProject = project("project-a", "/repo");
	const source = agent("agent-a", sourceProject.id, "session-source");
	const paneId = `agent:${source.id}`;
	const layout = floatingLayout(paneId, {
		[paneId]: { id: paneId, contentComponent: "agent" },
	});
	const base = appState({
		projects: [sourceProject],
		agents: [source],
		layouts: { "space-a": layout },
	});
	return {
		base,
		change: {
			...base,
			agents: [
				{
					...source,
					sessionId: "session-successor",
					worktreePath: "/repo/.worktrees/successor",
				},
			],
		},
		removal: {
			...base,
			agents: [],
			layouts: { "space-a": dockviewLayout([]) },
		},
		paneId,
	};
}

describe("persisted app field convergence policies", () => {
	it("preserves independent record-key edits", () => {
		expect(
			convergeDurableRecord(
				{ local: 1, remote: 1 },
				{ local: 2, remote: 1 },
				{ local: 1, remote: 2 },
			),
		).toEqual({ local: 2, remote: 2 });
	});

	it("preserves independent fields on the same id entity", () => {
		expect(
			convergeDurableIdEntities(
				[{ id: "agent-a", name: "old", branch: "old" }],
				[{ id: "agent-a", name: "local", branch: "old" }],
				[{ id: "agent-a", name: "old", branch: "remote" }],
			),
		).toEqual([{ id: "agent-a", name: "local", branch: "remote" }]);
	});

	it("keeps a local reorder while appending a remote entity add", () => {
		const base = [
			{ id: "agent-a", name: "A" },
			{ id: "agent-b", name: "B" },
		];
		const local = [base[1], base[0]];
		const remote = [...base, { id: "agent-c", name: "C" }];

		const merged = convergeDurableIdEntities(base, local, remote);

		expect(
			Array.isArray(merged) ? merged.map((agent) => agent.id) : [],
		).toEqual(["agent-b", "agent-a", "agent-c"]);
	});

	it("selects one complete registration for concurrent same-id Agent adds", () => {
		const local = agent("agent-a", "project-a", "session-local");
		local.displayName = "Local display";
		const remote = {
			...agent("agent-a", "project-a", "session-remote"),
			worktreePath: "/repo/.worktrees/remote",
		};
		const base = appState({ agents: [] });

		const merged = convergePersistedAppState(
			base,
			{ ...base, agents: [local] },
			{ ...base, agents: [remote] },
		);

		expect(merged.agents).toEqual([remote]);
	});
});

describe("serialized layout convergence", () => {
	it.each(["placement-first", "semantic-first"] as const)(
		"preserves a one-sided root-axis change while merging a semantic Agent successor (%s)",
		(order) => {
			const sourceProject = project("project-a", "/repo");
			const sourceAgent = agent("agent-a", sourceProject.id, "session-source");
			const agentPaneId = `agent:${sourceAgent.id}`;
			const filePaneId = "file:keep";
			const baseLayout = dockviewLayout([agentPaneId, filePaneId]);
			const base = appState({
				projects: [sourceProject],
				agents: [sourceAgent],
				layouts: { "space-a": baseLayout },
			});
			const placementLayout = structuredClone(baseLayout);
			(placementLayout.grid as Record<string, unknown>).orientation = "VERTICAL";
			const placement = {
				...base,
				layouts: { "space-a": placementLayout },
			};
			const successor = {
				...sourceAgent,
				sessionId: "session-successor",
				worktreePath: "/repo/.worktrees/successor",
			};
			const semanticLayout = structuredClone(baseLayout);
			(semanticLayout.panels as Record<string, unknown>)[agentPaneId] = {
				id: agentPaneId,
				contentComponent: "agent",
				params: { sessionId: successor.sessionId },
			};
			const semantic = {
				...base,
				agents: [successor],
				layouts: { "space-a": semanticLayout },
			};

			const merged =
				order === "placement-first"
					? convergePersistedAppState(base, placement, semantic)
					: convergePersistedAppState(base, semantic, placement);
			const layout = merged.layouts["space-a"] as {
				grid: { orientation: string };
			};

			expect(layout.grid.orientation).toBe("VERTICAL");
			expect(panelPlacementCount(layout, agentPaneId)).toBe(1);
			expect(panelPlacementCount(layout, filePaneId)).toBe(1);
			expect(paneParams(merged, "space-a", agentPaneId)).toEqual({
				agentRef: { agentId: successor.id },
			});
			expect(merged.agents).toEqual([successor]);
		},
	);
});

describe("Project and SSH-host removal convergence", () => {
	it.each(["change-first", "change-second"] as const)(
		"preserves a one-sided pane move as one complete placement snapshot (%s)",
		(order) => {
			const paneId = "file:moved";
			const baseLayout = dockviewLayout([paneId]);
			const movedLayout = floatingLayout(
				paneId,
				baseLayout.panels as Record<string, unknown>,
			);
			const base = appState({ layouts: { "space-a": baseLayout } });
			const change = { ...base, layouts: { "space-a": movedLayout } };
			const unrelated = {
				...base,
				stats: { ...base.stats, activeMs: base.stats.activeMs + 1 },
			};

			const merged =
				order === "change-first"
					? convergePersistedAppState(base, change, unrelated)
					: convergePersistedAppState(base, unrelated, change);
			const layout = merged.layouts["space-a"] as Record<string, unknown>;

			expect(panelPlacementCountIn(layout.grid, paneId)).toBe(0);
			expect(panelPlacementCountIn(layout.floatingGroups, paneId)).toBe(1);
			expect(panelPlacementCount(layout, paneId)).toBe(1);
		},
	);

	it.each(["removal-first", "removal-second"] as const)(
		"keeps a pane move committed by the same writer as a Project removal (%s)",
		(order) => {
			const removedProject = project("project-remove", "/repo/remove");
			const movedPaneId = "file:moved";
			const projectPaneId = `git:${removedProject.id}`;
			const baseLayout = dockviewLayout([movedPaneId, projectPaneId]);
			const base = appState({
				projects: [removedProject],
				layouts: { "space-a": baseLayout },
			});
			const removalAndMove = {
				...base,
				projects: [],
				layouts: {
					"space-a": floatingLayout(movedPaneId, {
						[movedPaneId]: (baseLayout.panels as Record<string, unknown>)[
							movedPaneId
						],
					}),
				},
			};

			const merged =
				order === "removal-first"
					? convergePersistedAppState(base, removalAndMove, base)
					: convergePersistedAppState(base, base, removalAndMove);
			const layout = merged.layouts["space-a"] as Record<string, unknown>;

			expect(panelIds(merged)).toEqual([movedPaneId]);
			expect(panelPlacementCountIn(layout.grid, movedPaneId)).toBe(0);
			expect(panelPlacementCountIn(layout.floatingGroups, movedPaneId)).toBe(1);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps one placement when an unrelated pane moves while a Project is removed (%s)",
		(order) => {
			const removedProject = project("project-remove", "/repo/remove");
			const movedPaneId = "file:moved";
			const projectPaneId = `git:${removedProject.id}`;
			const baseLayout = dockviewLayout([movedPaneId, projectPaneId]);
			const base = appState({
				projects: [removedProject],
				layouts: { "space-a": baseLayout },
			});
			const removal = {
				...base,
				projects: [],
				layouts: { "space-a": dockviewLayout([movedPaneId]) },
			};
			const movedLayout = floatingLayout(
				movedPaneId,
				baseLayout.panels as Record<string, unknown>,
			);
			movedLayout.grid = dockviewLayout([projectPaneId]).grid;
			const change = { ...base, layouts: { "space-a": movedLayout } };

			const merged = convergeOrder(base, change, removal, order);

			expect(panelIds(merged)).toEqual([movedPaneId]);
			expect(panelPlacementCount(merged.layouts["space-a"], movedPaneId)).toBe(
				1,
			);
		});

	it.each(["removal-first", "change-first"] as const)(
		"keeps an operational Project successor without reviving its descendants (%s)",
		(order) => {
			const sourceProject = project("project-a", "/repo/source");
			const successor = { ...sourceProject, path: "/repo/successor" };
			const sourceAgent = agent("agent-a", sourceProject.id, "session-source");
			const sourceLayout = dockviewLayout([
				`git:${sourceProject.id}`,
				`agent:${sourceAgent.id}`,
				"file:base",
			]);
			const base = appState({
				projects: [sourceProject],
				pinnedProjects: [sourceProject.id],
				agents: [sourceAgent],
				layouts: { "space-a": sourceLayout },
				pinnedPanes: {
					[`space-a:git:${sourceProject.id}`]: true,
					[`space-a:agent:${sourceAgent.id}`]: true,
					"space-a:file:base": true,
				},
			});
			const removal = {
				...base,
				projects: [],
				pinnedProjects: [],
				agents: [],
				layouts: {
					"space-a": removePanelIdsFromLayout(
						sourceLayout,
						new Set([
							`git:${sourceProject.id}`,
							`agent:${sourceAgent.id}`,
						]),
					),
				},
				pinnedPanes: { "space-a:file:base": true },
			};
			const change = { ...base, projects: [successor] };

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.projects).toEqual([successor]);
			expect(merged.pinnedProjects).toEqual([sourceProject.id]);
			expect(merged.agents).toEqual([]);
			expect(panelIds(merged)).toEqual([
				"file:base",
				`git:${sourceProject.id}`,
			]);
			expect(merged.pinnedPanes).toEqual({
				[`space-a:git:${sourceProject.id}`]: true,
				"space-a:file:base": true,
			});
		},
	);

	it.each([
		["project", "removal-first"],
		["project", "change-first"],
		["host", "removal-first"],
		["host", "change-first"],
		["agent", "removal-first"],
		["agent", "change-first"],
	] as const)(
		"keeps a same-id %s successor in its exact floating placement (%s)",
		(kind, order) => {
			const { base, change, removal, paneId } = successorPlacementFixture(kind);

			const merged = convergeOrder(base, change, removal, order);
			const layout = merged.layouts["space-a"] as Record<string, unknown>;

			expect(panelPlacementCountIn(layout.grid, paneId)).toBe(0);
			expect(panelPlacementCountIn(layout.floatingGroups, paneId)).toBe(1);
			expect(panelPlacementCount(layout, paneId)).toBe(1);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps successor placement and an unrelated move from the removal snapshot (%s)",
		(order) => {
			const source = project("project-a", "/repo/source");
			const successor = { ...source, path: "/repo/successor" };
			const successorPaneId = `git:${source.id}`;
			const movedPaneId = "file:moved";
			const baseLayout = dockviewLayout([successorPaneId, movedPaneId]);
			const base = appState({
				projects: [source],
				layouts: { "space-a": baseLayout },
			});
			const successorLayout = floatingLayout(
				successorPaneId,
				baseLayout.panels as Record<string, unknown>,
			);
			successorLayout.grid = dockviewLayout([movedPaneId]).grid;
			const change = {
				...base,
				projects: [successor],
				layouts: { "space-a": successorLayout },
			};
			const removal = {
				...base,
				projects: [],
				layouts: {
					"space-a": floatingLayout(movedPaneId, {
						[movedPaneId]: (
							baseLayout.panels as Record<string, unknown>
						)[movedPaneId],
					}),
				},
			};

			const merged = convergeOrder(base, change, removal, order);
			const layout = merged.layouts["space-a"] as Record<string, unknown>;

			expect(panelPlacementCountIn(layout.floatingGroups, successorPaneId)).toBe(1);
			expect(panelPlacementCountIn(layout.floatingGroups, movedPaneId)).toBe(1);
			expect(panelPlacementCount(layout, successorPaneId)).toBe(1);
			expect(panelPlacementCount(layout, movedPaneId)).toBe(1);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps panes moved together in one tab group while restoring a successor (%s)",
		(order) => {
			const source = project("project-a", "/repo/source");
			const successor = { ...source, path: "/repo/successor" };
			const successorPaneId = `git:${source.id}`;
			const movedPaneIds = ["file:first", "file:second"] as const;
			const baseLayout = dockviewLayout([successorPaneId, ...movedPaneIds]);
			const definitions = baseLayout.panels as Record<string, unknown>;
			const base = appState({
				projects: [source],
				layouts: { "space-a": baseLayout },
			});
			const successorLayout = floatingLayout(successorPaneId, definitions);
			successorLayout.grid = dockviewLayout(movedPaneIds).grid;
			const change = {
				...base,
				projects: [successor],
				layouts: { "space-a": successorLayout },
			};
			const removal = {
				...base,
				projects: [],
				layouts: {
					"space-a": floatingTabbedLayout(movedPaneIds, {
						[movedPaneIds[0]]: definitions[movedPaneIds[0]],
						[movedPaneIds[1]]: definitions[movedPaneIds[1]],
					}),
				},
			};

			const merged = convergeOrder(base, change, removal, order);
			const layout = merged.layouts["space-a"] as {
				floatingGroups?: { data?: { views?: string[] } }[];
			};
			const sharedGroups = (layout.floatingGroups ?? []).filter(
				(group) =>
					movedPaneIds.every((panelId) => group.data?.views?.includes(panelId)),
			);

			expect(sharedGroups).toHaveLength(1);
			expect(sharedGroups[0]?.data?.views).toEqual([...movedPaneIds]);
			expect(panelPlacementCount(merged.layouts["space-a"], successorPaneId)).toBe(1);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps a one-sided grid resize while restoring a successor (%s)",
		(order) => {
			const source = project("project-a", "/repo/source");
			const successor = { ...source, path: "/repo/successor" };
			const successorPaneId = `git:${source.id}`;
			const resizedPaneIds = ["file:first", "file:second"] as const;
			const baseLayout = dockviewLayout([successorPaneId, ...resizedPaneIds]);
			const baseChildren = (
				(baseLayout.grid as { root: { data: { size: number }[] } }).root.data
			);
			baseChildren.forEach((child) => {
				child.size = 200;
			});
			const base = appState({
				projects: [source],
				layouts: { "space-a": baseLayout },
			});
			const change = { ...base, projects: [successor] };
			const resizedLayout = dockviewLayout(resizedPaneIds);
			const resizedChildren = (
				(resizedLayout.grid as { root: { data: { size: number }[] } }).root.data
			);
			resizedChildren[0].size = 350;
			resizedChildren[1].size = 250;
			const removal = {
				...base,
				projects: [],
				layouts: { "space-a": resizedLayout },
			};

			const merged = convergeOrder(base, change, removal, order);
			const children = (
				(merged.layouts["space-a"] as { grid: { root: { data: { size: number }[] } } })
					.grid.root.data
			);
			const sizes = Object.fromEntries(
				children.map((child) => {
					const data = child as unknown as { data: { views: string[] }; size: number };
					return [data.data.views[0], data.size];
				}),
			);

			expect(sizes[resizedPaneIds[0]]).toBe(350);
			expect(sizes[resizedPaneIds[1]]).toBe(250);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps a one-sided pane move when the semantic successor did not move it (%s)",
		(order) => {
			const sourceProject = project("project-a", "/repo");
			const source = agent("agent-a", sourceProject.id, "session-source");
			const successor = {
				...source,
				sessionId: "session-successor",
				worktreePath: "/repo/.worktrees/successor",
			};
			const paneId = `agent:${source.id}`;
			const baseLayout = dockviewLayout([paneId]);
			const base = appState({
				projects: [sourceProject],
				agents: [source],
				layouts: { "space-a": baseLayout },
			});
			const change = { ...base, agents: [successor] };
			const move = {
				...base,
				layouts: {
					"space-a": floatingLayout(
						paneId,
						baseLayout.panels as Record<string, unknown>,
					),
				},
			};

			const merged = convergeOrder(base, change, move, order);

			expect(merged.agents).toEqual([successor]);
			expect(
				panelPlacementCountIn(merged.layouts["space-a"], paneId),
			).toBe(1);
			expect(
				panelPlacementCountIn(
					(merged.layouts["space-a"] as Record<string, unknown>).floatingGroups,
					paneId,
				),
			).toBe(1);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps an unrelated sibling reorder while restoring a successor (%s)",
		(order) => {
			const source = project("project-a", "/repo/source");
			const successor = { ...source, path: "/repo/successor" };
			const successorPaneId = `git:${source.id}`;
			const baseLayout = dockviewLayout([
				successorPaneId,
				"file:first",
				"file:second",
			]);
			const base = appState({
				projects: [source],
				layouts: { "space-a": baseLayout },
			});
			const change = { ...base, projects: [successor] };
			const removal = {
				...base,
				projects: [],
				layouts: {
					"space-a": dockviewLayout(["file:second", "file:first"]),
				},
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(rootPanelOrder(merged.layouts["space-a"])).toEqual([
				successorPaneId,
				"file:second",
				"file:first",
			]);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps an operational host successor without reviving stale Projects or Agents (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const successor = { ...sourceHost, host: "successor.example.test" };
			const sourceProject = project("project-a", "/repo", sourceHost.id);
			const sourceAgent = agent("agent-a", sourceProject.id, "session-source");
			const base = appState({
				sshHosts: [sourceHost],
				projects: [sourceProject],
				agents: [sourceAgent],
			});
			const removal = {
				...base,
				sshHosts: [],
				projects: [],
				agents: [],
			};
			const change = { ...base, sshHosts: [successor] };

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.sshHosts).toEqual([successor]);
			expect(merged.projects).toEqual([]);
			expect(merged.agents).toEqual([]);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"preserves a same-id SSH config route successor during exact Host removal (%s)",
		(order) => {
			const sourceHost = {
				...host("host-a", "gateway.example.test"),
				sshConfigAlias: "gateway-a",
			};
			const successor = { ...sourceHost, sshConfigAlias: "gateway-b" };
			const base = appState({ sshHosts: [sourceHost] });
			const removal = { ...base, sshHosts: [] };
			const change = { ...base, sshHosts: [successor] };

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.sshHosts).toEqual([successor]);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"lets exact removal beat stale Project and host presentation edits (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const sourceProject = project("project-a", "/repo", sourceHost.id);
			const base = appState({
				sshHosts: [sourceHost],
				projects: [sourceProject],
			});
			const removal = { ...base, sshHosts: [], projects: [] };
			const change = {
				...base,
				sshHosts: [{ ...sourceHost, name: "Renamed host" }],
				projects: [
					{ ...sourceProject, name: "Renamed project", isRepo: false },
				],
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.sshHosts).toEqual([]);
			expect(merged.projects).toEqual([]);
		},
	);

	it("selects one complete operational successor instead of synthesizing one", () => {
		const sourceHost = {
			...host("host-a", "source.example.test"),
			secretId: "secret-source",
		};
		const sourceProject = project("project-a", "/repo/source", sourceHost.id);
		const localHost = {
			...sourceHost,
			host: "local.example.test",
			user: "local-user",
			secretId: "secret-local",
		};
		const remoteHost = {
			...sourceHost,
			host: "remote.example.test",
			user: "remote-user",
			secretId: "secret-remote",
		};
		const localProject = { ...sourceProject, path: "/repo/local" };
		const remoteProject = { ...sourceProject, path: "/repo/remote" };
		const base = appState({
			sshHosts: [sourceHost],
			projects: [sourceProject],
		});

		const merged = convergePersistedAppState(
			base,
			{ ...base, sshHosts: [localHost], projects: [localProject] },
			{ ...base, sshHosts: [remoteHost], projects: [remoteProject] },
		);

		expect(merged.sshHosts).toEqual([remoteHost]);
		expect(merged.projects).toEqual([remoteProject]);
	});

	it.each(["removal-first", "change-first"] as const)(
		"drops pins whose resource or exact pane occurrence was removed (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const sourceProject = project("project-a", "/repo", sourceHost.id);
			const sourceAgent = agent("agent-a", sourceProject.id, "session-a");
			const targetPanes = [
				`git:${sourceProject.id}`,
				`agent:${sourceAgent.id}`,
				"ssh:loose",
			];
			const baseLayout = dockviewLayout([...targetPanes, "file:keep"]);
			const basePanels = baseLayout.panels as Record<
				string,
				{ params?: Record<string, unknown> }
			>;
			basePanels["ssh:loose"] = {
				...basePanels["ssh:loose"],
				params: { hostId: sourceHost.id, sessionId: "ssh-session" },
			};
			const base = appState({
				sshHosts: [sourceHost],
				projects: [sourceProject],
				agents: [sourceAgent],
				layouts: { "space-a": baseLayout },
				pinnedPanes: { "space-a:file:keep": true },
			});
			const removal = {
				...base,
				sshHosts: [],
				projects: [],
				agents: [],
				layouts: { "space-a": dockviewLayout(["file:keep"]) },
			};
			const change = {
				...base,
				pinnedProjects: [sourceProject.id],
				pinnedPanes: {
					"space-a:file:keep": true,
					"detached:file:unrelated": true,
					...Object.fromEntries(
						targetPanes.map((paneId) => [`space-a:${paneId}`, true]),
					),
					[`detached:git:${sourceProject.id}`]: true,
					[`detached:agent:${sourceAgent.id}`]: true,
				},
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.pinnedProjects).toEqual([]);
			expect(merged.pinnedPanes).toEqual({
				"space-a:file:keep": true,
				"detached:file:unrelated": true,
			});
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"rejects stale resource panes added after their owners were removed (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const sourceProject = project("project-a", "/repo", sourceHost.id);
			const sourceAgent = agent("agent-a", sourceProject.id, "session-a");
			const base = appState({
				sshHosts: [sourceHost],
				projects: [sourceProject],
				agents: [sourceAgent],
				layouts: { "space-a": dockviewLayout(["file:keep"]) },
			});
			const removal = {
				...base,
				sshHosts: [],
				projects: [],
				agents: [],
			};
			const staleLayout = dockviewLayout([
				"file:keep",
				`git:${sourceProject.id}`,
				`agent:${sourceAgent.id}`,
				"ssh:late",
			]);
			const stalePanels = staleLayout.panels as Record<
				string,
				{ params?: Record<string, unknown> }
			>;
			stalePanels["ssh:late"] = {
				...stalePanels["ssh:late"],
				params: { hostId: sourceHost.id, sessionId: "session-late" },
			};
			const change = { ...base, layouts: { "space-a": staleLayout } };

			const merged = convergeOrder(base, change, removal, order);

			expect(panelIds(merged)).toEqual(["file:keep"]);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps an in-place SSH pane successor without touching a same-id pane in another Space (%s)",
		(order) => {
			const removedHost = host("host-remove", "remove.example.test");
			const survivorHost = host("host-keep", "keep.example.test");
			const paneId = "ssh:shared";
			const layoutA = dockviewLayout([paneId]);
			const layoutB = dockviewLayout([paneId]);
			(layoutA.panels as Record<string, { params: Record<string, unknown> }>)[
				paneId
			].params = { hostId: removedHost.id, sessionId: "session-old" };
			(layoutB.panels as Record<string, { params: Record<string, unknown> }>)[
				paneId
			].params = { hostId: survivorHost.id, sessionId: "session-b" };
			const base = appState({
				spaces: [
					{ id: "space-a", name: "A" },
					{ id: "space-b", name: "B" },
				],
				sshHosts: [removedHost, survivorHost],
				layouts: { "space-a": layoutA, "space-b": layoutB },
			});
			const removal = {
				...base,
				sshHosts: [survivorHost],
				layouts: {
					"space-a": dockviewLayout([]),
					"space-b": layoutB,
				},
			};
			const replacementA = dockviewLayout([paneId]);
			(
				replacementA.panels as Record<string, { params: Record<string, unknown> }>
			)[paneId].params = {
				hostId: survivorHost.id,
				sessionId: "session-new",
			};
			const change = {
				...base,
				layouts: { "space-a": replacementA, "space-b": layoutB },
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(paneParams(merged, "space-a", paneId)).toEqual({
				hostId: survivorHost.id,
				sessionId: "session-new",
			});
			expect(panelIsPlacedInLayout(merged.layouts["space-a"], paneId)).toBe(
				true,
			);
			expect(paneParams(merged, "space-b", paneId)).toEqual({
				hostId: survivorHost.id,
				sessionId: "session-b",
			});
		},
	);

	it.each([
		["removed", "removal-first"],
		["removed", "change-first"],
		["replaced", "removal-first"],
		["replaced", "change-first"],
	] as const)(
		"keeps a pane retargeted from a %s SSH Host to local runtime (%s)",
		(hostOutcome, order) => {
			const removedHost = host("host-remove", "remove.example.test");
			const hostSuccessor = {
				...removedHost,
				host: "successor.example.test",
			};
			const paneId = "ssh:shared";
			const sourceLayout = dockviewLayout([paneId]);
			(
				sourceLayout.panels as Record<
					string,
					{ params: Record<string, unknown> }
				>
			)[paneId].params = {
				hostId: removedHost.id,
				sessionId: "session-old",
			};
			const base = appState({
				sshHosts: [removedHost],
				layouts: { "space-a": sourceLayout },
			});
			const removal = {
				...base,
				sshHosts: [],
				layouts: { "space-a": dockviewLayout([]) },
			};
			const successorLayout = dockviewLayout([paneId]);
			(
				successorLayout.panels as Record<
					string,
					{ params: Record<string, unknown> }
				>
			)[paneId].params = {
				binding: hmuxLocalBinding("session-new", "workspace-new"),
			};
			const change = {
				...base,
				sshHosts: hostOutcome === "replaced" ? [hostSuccessor] : base.sshHosts,
				layouts: { "space-a": successorLayout },
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(paneParams(merged, "space-a", paneId)).toEqual({
				binding: hmuxLocalBinding("session-new", "workspace-new"),
			});
			expect(panelIsPlacedInLayout(merged.layouts["space-a"], paneId)).toBe(
				true,
			);
			expect(merged.sshHosts).toEqual(
				hostOutcome === "replaced" ? [hostSuccessor] : [],
			);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps loose panes owned by a same-id SSH Host successor (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const successor = { ...sourceHost, host: "successor.example.test" };
			const paneId = "ssh:loose";
			const layout = dockviewLayout([paneId]);
			(layout.panels as Record<string, { params: Record<string, unknown> }>)[
				paneId
			].params = { hostId: sourceHost.id, sessionId: "session-a" };
			const base = appState({
				sshHosts: [sourceHost],
				layouts: { "space-a": layout },
			});
			const removal = {
				...base,
				sshHosts: [],
				layouts: { "space-a": dockviewLayout([]) },
			};
			const change = { ...base, sshHosts: [successor] };

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.sshHosts).toEqual([successor]);
			expect(paneParams(merged, "space-a", paneId)).toEqual({
				hostId: sourceHost.id,
				sessionId: "session-a",
			});
			expect(panelIsPlacedInLayout(merged.layouts["space-a"], paneId)).toBe(
				true,
			);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"preserves a changed unresolved pane and its hinted Host (%s)",
		(order) => {
			const sourceHost = host("host-remove", "remove.example.test");
			const paneId = "ssh:future";
			const sourceLayout = dockviewLayout([paneId]);
			(
				sourceLayout.panels as Record<
					string,
					{ params: Record<string, unknown> }
				>
			)[paneId].params = {
				hostId: sourceHost.id,
				sessionId: "session-old",
			};
			const base = appState({
				sshHosts: [sourceHost],
				layouts: { "space-a": sourceLayout },
			});
			const removal = {
				...base,
				sshHosts: [],
				layouts: { "space-a": dockviewLayout([]) },
			};
			const unresolvedLayout = structuredClone(sourceLayout);
			(
				unresolvedLayout.panels as Record<
					string,
					{ params: Record<string, unknown> }
				>
			)[paneId].params = {
				hostId: sourceHost.id,
				binding: {
					schemaVersion: 2,
					runtime: "hmux_standalone_v1",
					source: "ssh",
					hostId: sourceHost.id,
					sessionId: "session-future",
					workspaceId: "workspace-future",
				},
			};
			const change = { ...base, layouts: { "space-a": unresolvedLayout } };

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.sshHosts).toEqual([sourceHost]);
			expect(paneParams(merged, "space-a", paneId)).toEqual(
				(
					unresolvedLayout.panels as Record<
						string,
						{ params: Record<string, unknown> }
					>
				)[paneId].params,
			);
			expect(panelIsPlacedInLayout(merged.layouts["space-a"], paneId)).toBe(
				true,
			);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"restores the Host directly required by a semantic Agent (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const sourceProject = project("project-local", "/repo");
			const direct = withSshRuntime(
				agent("agent-a", sourceProject.id, "session-a"),
				sourceHost.id,
			);
			const base = appState({
				sshHosts: [sourceHost],
				projects: [sourceProject],
				agents: [],
			});
			const removal = { ...base, sshHosts: [] };
			const change = { ...base, agents: [direct] };

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.agents).toEqual([direct]);
			expect(merged.sshHosts).toEqual([sourceHost]);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps an ID-routed Agent with a same-id Host successor (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const hostSuccessor = { ...sourceHost, host: "successor.example.test" };
			const sourceProject = project("project-local", "/repo");
			const source = withSshRuntime(
				agent("agent-a", sourceProject.id, "session-source"),
				sourceHost.id,
			);
			const successor = withSshRuntime(
				{
					...source,
					sessionId: "session-successor",
					worktreePath: "/repo/.worktrees/successor",
				},
				sourceHost.id,
			);
			const base = appState({
				sshHosts: [sourceHost],
				projects: [sourceProject],
				agents: [source],
			});
			const change = { ...base, agents: [successor] };
			const hostChange = { ...base, sshHosts: [hostSuccessor] };

			const merged = convergeOrder(base, change, hostChange, order);

			expect(merged.agents).toEqual([successor]);
			expect(merged.sshHosts).toEqual([hostSuccessor]);
		},
	);

	it.each([
		["new", "removal-first"],
		["new", "change-first"],
		["successor", "removal-first"],
		["successor", "change-first"],
	] as const)(
		"keeps a %s Agent and the Project it authoritatively requires (%s)",
		(agentChange, order) => {
			const sourceProject = project("project-a", "/repo");
			const sourceAgent = agent("agent-a", sourceProject.id, "session-source");
			const successor = {
				...sourceAgent,
				sessionId: "session-successor",
				worktreePath: "/repo/.worktrees/successor",
			};
			const baseAgent = agentChange === "successor" ? [sourceAgent] : [];
			const changedAgent = agentChange === "successor" ? successor : sourceAgent;
			const basePanelIds = [
				`git:${sourceProject.id}`,
				...(baseAgent.length > 0 ? [`agent:${sourceAgent.id}`] : []),
				"file:base",
			];
			const base = appState({
				projects: [sourceProject],
				pinnedProjects: [sourceProject.id],
				agents: baseAgent,
				layouts: { "space-a": dockviewLayout(basePanelIds) },
				pinnedPanes: {
					[`space-a:git:${sourceProject.id}`]: true,
					...(baseAgent.length > 0
						? { [`space-a:agent:${sourceAgent.id}`]: true }
						: {}),
					"space-a:file:base": true,
				},
			});
			const removal = {
				...base,
				projects: [],
				pinnedProjects: [],
				agents: [],
				layouts: { "space-a": dockviewLayout(["file:base"]) },
				pinnedPanes: { "space-a:file:base": true },
			};
			const change = {
				...base,
				agents: [changedAgent],
				layouts: {
					"space-a": dockviewLayout([
						`git:${sourceProject.id}`,
						`agent:${changedAgent.id}`,
						"file:base",
					]),
				},
				pinnedPanes: {
					...base.pinnedPanes,
					[`space-a:agent:${changedAgent.id}`]: true,
				},
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.projects).toEqual([sourceProject]);
			expect(merged.pinnedProjects).toEqual([sourceProject.id]);
			expect(merged.agents).toEqual([changedAgent]);
			expect(panelIds(merged)).toEqual(
				[
					`agent:${changedAgent.id}`,
					"file:base",
					`git:${sourceProject.id}`,
				].sort(),
			);
			expect(merged.pinnedPanes).toEqual({
				[`space-a:agent:${changedAgent.id}`]: true,
				"space-a:file:base": true,
				[`space-a:git:${sourceProject.id}`]: true,
			});
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps a new Project subtree and the SSH host it requires (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const addedProject = project("project-new", "/repo/new", sourceHost.id);
			const addedAgent = agent("agent-new", addedProject.id, "session-new");
			const base = appState({
				sshHosts: [sourceHost],
				layouts: { "space-a": dockviewLayout(["file:base"]) },
				pinnedPanes: { "space-a:file:base": true },
			});
			const removal = { ...base, sshHosts: [] };
			const change = {
				...base,
				projects: [addedProject],
				pinnedProjects: [addedProject.id],
				agents: [addedAgent],
				layouts: {
					"space-a": dockviewLayout([
						`git:${addedProject.id}`,
						`agent:${addedAgent.id}`,
						"file:base",
					]),
				},
				pinnedPanes: {
					[`space-a:git:${addedProject.id}`]: true,
					[`space-a:agent:${addedAgent.id}`]: true,
					"space-a:file:base": true,
				},
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.sshHosts).toEqual([sourceHost]);
			expect(merged.projects).toEqual([addedProject]);
			expect(merged.pinnedProjects).toEqual([addedProject.id]);
			expect(merged.agents).toEqual([addedAgent]);
			expect(merged.pinnedPanes).toEqual(change.pinnedPanes);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"does not revive loose Host panes when an Agent successor only requires the Host record (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const sourceProject = project("project-a", "/repo", sourceHost.id);
			const sourceAgent = agent("agent-a", sourceProject.id, "session-source");
			const successor = {
				...sourceAgent,
				sessionId: "session-successor",
				worktreePath: "/repo/.worktrees/successor",
			};
			const loosePaneId = "ssh:loose";
			const sourceLayout = dockviewLayout([
				`git:${sourceProject.id}`,
				`agent:${sourceAgent.id}`,
				loosePaneId,
			]);
			(
				sourceLayout.panels as Record<
					string,
					{ params: Record<string, unknown> }
				>
			)[loosePaneId].params = {
				hostId: sourceHost.id,
				sessionId: "loose-session",
			};
			const base = appState({
				sshHosts: [sourceHost],
				projects: [sourceProject],
				agents: [sourceAgent],
				layouts: { "space-a": sourceLayout },
				pinnedPanes: { [`space-a:${loosePaneId}`]: true },
			});
			const removal = {
				...base,
				sshHosts: [],
				projects: [],
				agents: [],
				layouts: { "space-a": dockviewLayout([]) },
				pinnedPanes: {},
			};
			const change = { ...base, agents: [successor] };

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.sshHosts).toEqual([sourceHost]);
			expect(merged.projects).toEqual([sourceProject]);
			expect(merged.agents).toEqual([successor]);
			expect(panelIds(merged)).not.toContain(loosePaneId);
			expect(merged.pinnedPanes).not.toHaveProperty(
				`space-a:${loosePaneId}`,
			);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"keeps a Host pane retargeted to local while an Agent successor restores only Host ancestry (%s)",
		(order) => {
			const sourceHost = host("host-a", "source.example.test");
			const sourceProject = project("project-a", "/repo", sourceHost.id);
			const sourceAgent = agent("agent-a", sourceProject.id, "session-source");
			const successor = {
				...sourceAgent,
				sessionId: "session-successor",
				worktreePath: "/repo/.worktrees/successor",
			};
			const paneId = "ssh:retargeted";
			const sourceLayout = dockviewLayout([
				`git:${sourceProject.id}`,
				`agent:${sourceAgent.id}`,
				paneId,
			]);
			(
				sourceLayout.panels as Record<
					string,
					{ params: Record<string, unknown> }
				>
			)[paneId].params = {
				hostId: sourceHost.id,
				sessionId: "remote-session",
			};
			const base = appState({
				sshHosts: [sourceHost],
				projects: [sourceProject],
				agents: [sourceAgent],
				layouts: { "space-a": sourceLayout },
			});
			const removal = {
				...base,
				sshHosts: [],
				projects: [],
				agents: [],
				layouts: { "space-a": dockviewLayout([]) },
			};
			const changedLayout = structuredClone(sourceLayout);
			(
				changedLayout.panels as Record<
					string,
					{ params: Record<string, unknown> }
				>
			)[paneId].params = {
				binding: hmuxLocalBinding("local-session", "local-workspace"),
			};
			const change = {
				...base,
				agents: [successor],
				layouts: { "space-a": changedLayout },
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.sshHosts).toEqual([sourceHost]);
			expect(paneParams(merged, "space-a", paneId)).toEqual({
				binding: hmuxLocalBinding("local-session", "local-workspace"),
			});
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"does not restore a removed parent for successors moved elsewhere (%s)",
		(order) => {
			const removedHost = host("host-remove", "remove.example.test");
			const survivorHost = host("host-survive", "survive.example.test");
			const removedProject = project(
				"project-remove",
				"/repo/remove",
				removedHost.id,
			);
			const survivorProject = project(
				"project-survive",
				"/repo/survive",
				survivorHost.id,
			);
			const sourceAgent = agent(
				"agent-a",
				removedProject.id,
				"session-source",
			);
			const movedProject = {
				...removedProject,
				path: "/repo/moved",
				sshHostId: survivorHost.id,
			};
			const movedAgent = {
				...sourceAgent,
				projectId: survivorProject.id,
				sessionId: "session-successor",
			};
			const base = appState({
				sshHosts: [removedHost, survivorHost],
				projects: [removedProject, survivorProject],
				agents: [sourceAgent],
			});
			const removal = {
				...base,
				sshHosts: [survivorHost],
				projects: [survivorProject],
				agents: [],
			};
			const change = {
				...base,
				projects: [movedProject, survivorProject],
				agents: [movedAgent],
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.sshHosts).toEqual([survivorHost]);
			expect(
				[...merged.projects].sort((left, right) =>
					left.id.localeCompare(right.id),
				),
			).toEqual(
				[movedProject, survivorProject].sort((left, right) =>
					left.id.localeCompare(right.id),
				),
			);
			expect(merged.agents).toEqual([movedAgent]);
		},
	);

	it.each(["removal-first", "change-first"] as const)(
		"leaves unrelated orphan records intact while removing an exact Project (%s)",
		(order) => {
			const removedProject = project("project-remove", "/repo/remove");
			const orphanProject = project(
				"project-orphan",
				"/repo/orphan",
				"host-missing",
			);
			const orphanAgent = agent(
				"agent-orphan",
				"project-missing",
				"session-orphan",
			);
			const base = appState({
				projects: [removedProject, orphanProject],
				agents: [orphanAgent],
			});
			const removal = { ...base, projects: [orphanProject] };
			const change = {
				...base,
				pinnedProjects: [orphanProject.id],
				pinnedPanes: { "space-a:file:unrelated": true },
				stats: { ...base.stats, agentsStarted: base.stats.agentsStarted + 1 },
			};

			const merged = convergeOrder(base, change, removal, order);

			expect(merged.projects).toEqual([orphanProject]);
			expect(merged.pinnedProjects).toEqual([orphanProject.id]);
			expect(merged.agents).toEqual([orphanAgent]);
			expect(merged.pinnedPanes).toEqual({
				"space-a:file:unrelated": true,
			});
			expect(merged.stats.agentsStarted).toBe(base.stats.agentsStarted + 1);
		},
	);
});
