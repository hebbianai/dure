// @vitest-environment jsdom
import { createDockview, type SerializedDockview } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import { convergePersistedAppState } from "@/lib/persistence/persistedAppStateConvergence";
import { hmuxLocalBinding } from "@/lib/terminal/terminalBinding";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { panePinKey } from "@/lib/workspace/pane/panePin";
import {
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";

const cleanups: Array<() => void> = [];
const former = managedAgentFixture({ id: "former" });
const current = managedAgentFixture({ id: "current" });
const paneId = "agent:former";
const terminalParams = {
	sessionId: "retained-shell",
	binding: hmuxLocalBinding("retained-shell", "terminal-workspace"),
};
const replacements = [
	{ component: "terminal", params: terminalParams },
	{ component: "launcher", params: { cwd: "/repo" } },
	{ component: "agent", params: { agentRef: { agentId: current.id } } },
	{ component: "agent", params: { agentRef: null } },
	{ component: "future-content", params: { agentId: former.id } },
] as const;

function dockview() {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	cleanups.push(() => {
		api.dispose();
		container.remove();
	});
	return api;
}

function layout(
	id = paneId,
	component = "agent",
	params: Record<string, unknown> = { agentRef: { agentId: former.id } },
): SerializedDockview {
	const api = dockview();
	api.addPanel({
		id: "sibling",
		component: "file",
		params: { path: "/repo/a" },
	});
	api.addPanel({
		id,
		component,
		params,
		position: { referencePanel: "sibling", direction: "right" },
	});
	return api.toJSON();
}

function state(snapshot = layout()): PersistedAppState {
	return normalizePersistedState({
		spaces: [
			{ id: "a", name: "Main" },
			{ id: "b", name: "Other" },
		],
		agents: [former, current],
		layouts: { a: snapshot },
		pinnedPanes: Object.fromEntries(
			Object.keys(snapshot.panels).map((id) => [panePinKey("a", id), true]),
		),
	});
}

function replace(
	base: PersistedAppState,
	id: string,
	component: string,
	params: Record<string, unknown>,
): PersistedAppState {
	const snapshot = base.layouts.a as SerializedDockview;
	return {
		...base,
		layouts: {
			...base.layouts,
			a: {
				...snapshot,
				panels: {
					...snapshot.panels,
					[id]: { ...snapshot.panels[id], contentComponent: component, params },
				},
			},
		},
	};
}

function remove(
	base: PersistedAppState,
	closePanes = false,
): PersistedAppState {
	return {
		...base,
		agents: base.agents.filter((agent) => agent.id !== former.id),
		...(closePanes
			? {
					layouts: Object.fromEntries(
						Object.entries(base.layouts).map(([spaceId, snapshot]) => {
							const api = dockview();
							api.fromJSON(snapshot as SerializedDockview);
							for (const panel of api.panels) {
								if (panel.id !== "sibling") api.removePanel(panel);
							}
							return [spaceId, api.toJSON()];
						}),
					),
					pinnedPanes: { [panePinKey("a", "sibling")]: true },
				}
			: {}),
	};
}

function expectRestored(
	result: PersistedAppState,
	expected: PersistedAppState,
	id: string,
) {
	expect(result.layouts.a).toEqual(expected.layouts.a);
	expect(result.pinnedPanes[panePinKey("a", id)]).toBe(true);
	expect([...result.agents].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
		[...expected.agents].sort((a, b) => a.id.localeCompare(b.id)),
	);
	const reloaded = normalizePersistedState(JSON.parse(JSON.stringify(result)));
	const api = dockview();
	api.fromJSON(reloaded.layouts.a as SerializedDockview);
	expect(api.panels.map((panel) => panel.id).sort()).toEqual(
		[id, "sibling"].sort(),
	);
	const definition = panelsFromLayout(expected.layouts.a).find(
		(pane) => pane.id === id,
	);
	expect(api.getPanel(id)?.api.component).toBe(definition?.component);
	expect(api.getPanel(id)?.params).toEqual(definition?.params);
	expect(api.activePanel?.id).toBe(id);
}

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe.each(["removal-first", "change-first"] as const)("Git %s", (order) => {
	const project = {
		id: "project-former",
		name: "Former",
		path: "/former",
		kind: "local" as const,
		isRepo: true,
	};
	const other = { ...project, id: "project-current", path: "/current" };
	const legacyId = `git:${project.id}`;
	function projectState(id = legacyId) {
		return {
			...state(layout(id, "git", { projectId: project.id })),
			projects: [project, other],
		};
	}
	function retire(base: PersistedAppState, closePanes = false): PersistedAppState {
		return {
			...remove(base, closePanes),
			agents: base.agents,
			projects: [other],
		};
	}
	function converge(
		base: PersistedAppState,
		change: PersistedAppState,
		removal = retire(base),
	) {
		return order === "removal-first"
			? convergePersistedAppState(base, change, removal)
			: convergePersistedAppState(base, removal, change);
	}

	it.each(["pane-git", legacyId, "agent:unrelated"])(
		"prunes only current Git references at %s",
		(id) => {
			const base = projectState(id);
			const result = converge(base, base);
			expect(panelsFromLayout(result.layouts.a).map((pane) => pane.id)).toEqual(
				["sibling"],
			);
			expect(result.pinnedPanes[panePinKey("a", id)]).toBeUndefined();
			expect(result.projects).toEqual([other]);
		},
	);

	it.each([
		{ component: "terminal", params: terminalParams },
		{ component: "git", params: { projectId: other.id } },
		{ component: "git", params: { projectId: null } },
		{ component: "future-content", params: { projectId: project.id } },
	])(
		"retains same-slot $component replacement after project cleanup ($params)",
		({ component, params }) => {
			const base = projectState();
			const change = replace(base, legacyId, component, params);
			const result = converge(base, change, retire(base, true));
			const expected = { ...change, projects: [other] };
			expectRestored(result, expected, legacyId);
			expect(result.projects).toEqual([other]);
			expectRestored(converge(base, base, result), expected, legacyId);
			expect(converge(base, change, result)).toEqual(result);
		},
	);

	it.each(["pane-git", legacyId])(
		"protects successor Git %s only in its actual Space",
		(id) => {
			const base = projectState(id);
			base.layouts.b = layout(id, "terminal", terminalParams);
			base.pinnedPanes[panePinKey("b", id)] = true;
			const successor = { ...project, path: "/successor" };
			const change = { ...base, projects: [successor, other] };
			const result = converge(base, change, retire(base, true));
			expectRestored(result, change, id);
			expect(
				[...result.projects].sort((a, b) => a.id.localeCompare(b.id)),
			).toEqual([other, successor]);
			expect(panelsFromLayout(result.layouts.b).map((pane) => pane.id)).toEqual(
				["sibling"],
			);
			expect(result.pinnedPanes[panePinKey("b", id)]).toBeUndefined();
		},
	);
});

describe.each(["removal-first", "change-first"] as const)("%s", (order) => {
	function converge(
		base: PersistedAppState,
		change: PersistedAppState,
		removal = remove(base),
	) {
		return order === "removal-first"
			? convergePersistedAppState(base, change, removal)
			: convergePersistedAppState(base, removal, change);
	}

	it.each(replacements)(
		"does not delete current $component content or its pin by historical ID ($params)",
		({ component, params }) => {
			const base = state(layout(paneId, component, params));
			const removal = remove(base);
			expectRestored(converge(base, base, removal), removal, paneId);
		},
	);

	it.each(replacements)(
		"preserves replacement $component content against predecessor cleanup ($params)",
		({ component, params }) => {
			const base = state();
			const change = replace(base, paneId, component, params);
			const result = converge(base, change, remove(base, true));
			const expected = { ...change, agents: [current] };
			expectRestored(result, expected, paneId);
			// Replayed predecessor snapshots cannot undo the converged content.
			expectRestored(converge(base, base, result), expected, paneId);
			expect(converge(base, change, result)).toEqual(result);
		},
	);

	it.each(["opaque-slot", "launcher:slot", "agent:current"])(
		"prunes an actual removed Agent reference at %s, not the ID's old owner",
		(id) => {
			const base = state(layout(id));
			const result = converge(base, base);
			expect(panelsFromLayout(result.layouts.a).map((pane) => pane.id)).toEqual(
				["sibling"],
			);
			expect(result.pinnedPanes).toEqual({
				[panePinKey("a", "sibling")]: true,
			});
			expect(result.agents).toEqual([current]);
		},
	);

	it.each([
		["opaque-slot", "terminal"],
		[paneId, "terminal"],
		["opaque-slot", "agent"],
		[paneId, "agent"],
	] as const)(
		"preserves the Agent successor at %s without reviving another Space's %s",
		(id, component) => {
			const base = state(layout(id));
			base.layouts.b = layout(
				id,
				component,
				component === "agent"
					? { agentRef: { agentId: current.id } }
					: terminalParams,
			);
			base.pinnedPanes[panePinKey("b", id)] = true;
			const successor = {
				...former,
				sessionId: "successor-session",
				runtimeBinding: managedBindingFixture({
					sessionId: "successor-session",
				}),
			};
			const change = { ...base, agents: [successor, current] };
			const result = converge(base, change, remove(base, true));
			expectRestored(result, change, id);
			expect(panelsFromLayout(result.layouts.b).map((pane) => pane.id)).toEqual(
				["sibling"],
			);
			expect(result.pinnedPanes[panePinKey("b", id)]).toBeUndefined();
		},
	);

	it("does not revive an unchanged Agent pane for a title-only change", () => {
		const base = state();
		const change = structuredClone(base);
		(change.layouts.a as SerializedDockview).panels[paneId].title = "renamed";
		const result = converge(base, change, remove(base, true));
		expect(panelsFromLayout(result.layouts.a).map((pane) => pane.id)).toEqual([
			"sibling",
		]);
		expect(result.agents).toEqual([current]);
	});

	it("keeps legacy Agent ownership at the normalization boundary", () => {
		const base = state(layout(paneId, "agent", {}));
		expect(
			panelsFromLayout(base.layouts.a).find((pane) => pane.id === paneId)
				?.params,
		).toEqual({ agentRef: { agentId: former.id } });
		expect(
			panelsFromLayout(converge(base, base).layouts.a).map((pane) => pane.id),
		).toEqual(["sibling"]);
	});

	it("prunes stale newly added panes by their explicit removed Agent reference", () => {
		const change = state(layout("opaque-slot"));
		const base = remove(change, true);
		base.agents = [former, current];
		const result = converge(base, change);
		expect(panelsFromLayout(result.layouts.a).map((pane) => pane.id)).toEqual([
			"sibling",
		]);
		expect(result.pinnedPanes[panePinKey("a", "opaque-slot")]).toBeUndefined();
	});

	it("does not let an old Agent-shaped ID bypass terminal Host cleanup", () => {
		const base = state(
			layout(paneId, "ssh", { hostId: "remote", sessionId: "shell" }),
		);
		base.sshHosts = [
			{
				id: "remote",
				name: "remote",
				host: "example.test",
				user: "dure",
				port: 22,
				auth: "auto",
			},
		];
		const removal = { ...base, sshHosts: [] };
		const result = converge(base, base, removal);
		expect(panelsFromLayout(result.layouts.a).map((pane) => pane.id)).toEqual([
			"sibling",
		]);
		expect(result.pinnedPanes[panePinKey("a", paneId)]).toBeUndefined();
		expect(result.agents).toEqual(base.agents);
	});

	it("does not interpret a missing content observation as Agent ownership", () => {
		const base = state();
		delete (base.layouts.a as SerializedDockview).panels[paneId]
			.contentComponent;
		const result = converge(base, base);
		expect(result.layouts).toEqual(base.layouts);
		expect(result.pinnedPanes).toEqual(base.pinnedPanes);
		expect(result.agents).toEqual([current]);
	});
});

it("takes the durable winner when both writers replace the same retired Agent view", () => {
	const base = state();
	const older = {
		...replace(base, paneId, "terminal", terminalParams),
		agents: [current],
	};
	const newer = {
		...replace(base, paneId, "launcher", { cwd: "/new" }),
		agents: [current],
	};
	expectRestored(convergePersistedAppState(base, older, newer), newer, paneId);
	expectRestored(convergePersistedAppState(base, newer, older), older, paneId);
});
