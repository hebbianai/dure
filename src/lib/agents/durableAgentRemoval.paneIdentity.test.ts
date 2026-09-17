// @vitest-environment jsdom
import { createDockview, type SerializedDockview } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rollbackCreatedAgentRegistration } from "@/lib/agents/agentRegistrationRollback";
import { removeAgentProjectionDurably } from "@/lib/agents/durableAgentRemoval";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import { convergePersistedAppState } from "@/lib/persistence/persistedAppStateConvergence";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import { DurableWriteCoordinator } from "@/lib/persistence/durableWriteCoordinator";
import { subscribeDurableStoreLayoutProjection } from "@/lib/persistence/durableStoreRehydration";
import { hmuxLocalBinding } from "@/lib/terminal/terminalBinding";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { panePinKey } from "@/lib/workspace/pane/panePin";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
	rehydrateAppStoreFromDurableStorage,
	useStore,
} from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import type { Project } from "@/types";

vi.mock("@/lib/workspace/layout/layoutPushChannel", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/layout/layoutPushChannel")
	>()),
	publishLayoutPush: vi.fn(),
}));

const former = managedAgentFixture({
	id: "former",
	sessionId: "former-session",
});
const current = managedAgentFixture({
	id: "current",
	sessionId: "current-session",
});
const paneId = `agent:${former.id}`;
const cleanups: Array<() => void> = [];
const replacements = [
	{
		component: "terminal",
		params: {
			sessionId: "shell",
			binding: hmuxLocalBinding("shell", "workspace"),
		},
	},
	{ component: "launcher", params: { cwd: "/repo" } },
	{ component: "agent", params: { agentRef: { agentId: current.id } } },
	{ component: "agent", params: { agentRef: null } },
	{ component: "future-content", params: { agentRef: { agentId: former.id } } },
] as const;

function dockview() {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	cleanups.push(() => {
		api.dispose();
		element.remove();
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

function state(layouts: PersistedAppState["layouts"]): PersistedAppState {
	return normalizePersistedState({
		spaces: [
			{ id: "a", name: "Main" },
			{ id: "b", name: "Other" },
		],
		agents: [former, current],
		chatSubmissions: {},
		layouts,
		pinnedPanes: Object.fromEntries(
			Object.entries(layouts).flatMap(([spaceId, snapshot]) =>
				panelsFromLayout(snapshot).map((pane) => [
					panePinKey(spaceId, pane.id),
					true,
				]),
			),
		),
	});
}

async function writeState(value: PersistedAppState) {
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
		value: { state: value, version: PERSIST_VERSION },
		result: undefined,
	}));
}

async function install(value: PersistedAppState) {
	await durableAppStorage.flush();
	await writeState(value);
	await rehydrateAppStoreFromDurableStorage();
	useStore.setState({
		sessionCwd: {
			"former-session": "/former",
			"current-session": "/current",
			shell: "/shell",
		},
	});
	await durableAppStorage.flush();
}

function readState(): PersistedAppState {
	return JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null")
		.state;
}

function expectRestored(snapshot: unknown, ids: string[]) {
	const api = dockview();
	api.fromJSON(snapshot as SerializedDockview);
	expect(api.panels.map((panel) => panel.id).sort()).toEqual([...ids].sort());
	return api;
}

afterEach(async () => {
	await durableAppStorage.flush();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe.each(["registered", "already-absent"] as const)(
	"%s Project cleanup",
	(registration) => {
		const project = {
			id: "project-former",
			name: "Former",
			path: "/former",
			kind: "local" as const,
			isRepo: true,
		};
		const legacyId = `git:${project.id}`;
		const request = {
			agents: [],
			projects: [
				{
					projectId: project.id,
					panelIds: [legacyId],
					applies: (candidate: Project) => candidate.path === project.path,
				},
			],
		};

		it.each(["pane-git", legacyId, "agent:unrelated"])(
			"removes current Git %s without removing a repurposed historical view in another Space",
			async (id) => {
				const baseline = state({
					a: layout(id, "git", { projectId: project.id, sessionId: "shell" }),
					b: layout(legacyId, "terminal", replacements[0].params),
				});
				baseline.projects = registration === "registered" ? [project] : [];
				await install(baseline);
				await expect(removeAgentProjectionDurably(request)).resolves.toBe(true);
				const final = readState();
				expectRestored(final.layouts.a, ["sibling"]);
				expect(final.layouts.b).toEqual(baseline.layouts.b);
				expect(final.projects).toEqual([]);
				expect(final.agents).toEqual(baseline.agents);
				expect(final.pinnedPanes[panePinKey("a", id)]).toBeUndefined();
				expect(final.pinnedPanes[panePinKey("b", legacyId)]).toBe(true);
				expect(useStore.getState().sessionCwd.shell).toBe("/shell");
				await expect(removeAgentProjectionDurably(request)).resolves.toBe(true);
				expect(readState()).toEqual(final);
			},
		);

		it.each([
			{ component: "git", params: { projectId: "another" } },
			{ component: "git", params: { projectId: null } },
			{ component: "git", params: {} },
			{ component: "future-content", params: { projectId: project.id } },
		])(
			"preserves explicit $component content at a historical ID ($params)",
			async ({ component, params }) => {
				const baseline = state({ a: layout(legacyId, component, params) });
				baseline.projects = registration === "registered" ? [project] : [];
				await install(baseline);
				await expect(removeAgentProjectionDurably(request)).resolves.toBe(true);
				const final = readState();
				expect(final.layouts).toEqual(baseline.layouts);
				expect(final.pinnedPanes).toEqual(baseline.pinnedPanes);
				expect(final.projects).toEqual([]);
			},
		);
	},
);

describe.each(["registered", "already-absent"] as const)(
	"%s Agent cleanup",
	(registration) => {
		it.each(replacements)(
			"preserves current $component content and pin at the old ID ($params)",
			async ({ component, params }) => {
				const baseline = state({ a: layout(paneId, component, params) });
				if (registration === "already-absent") baseline.agents = [current];
				await install(baseline);

				await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(
					true,
				);

				const final = readState();
				expect(final.layouts).toEqual(baseline.layouts);
				expect(final.pinnedPanes).toEqual(baseline.pinnedPanes);
				expect(final.agents).toEqual([current]);
				const restored = expectRestored(final.layouts.a, [paneId, "sibling"]);
				expect(restored.getPanel(paneId)?.api.component).toBe(component);
				expect(restored.getPanel(paneId)?.params).toEqual(params);
				expect(restored.activePanel?.id).toBe(paneId);
				expect(useStore.getState().sessionCwd.shell).toBe("/shell");
			},
		);
	},
);

describe("durable current-reference removal", () => {
	it.each([
		"opaque-pane",
		"launcher:original",
		"term:original",
		"agent:unrelated",
	])(
		"removes the actual Agent view %s and restores its sibling",
		async (id) => {
			await install(state({ a: layout(id) }));
			await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(
				true,
			);
			const final = readState();
			expectRestored(final.layouts.a, ["sibling"]);
			expect(final.pinnedPanes).toEqual({ [panePinKey("a", "sibling")]: true });
			expect(final.agents).toEqual([current]);
			expect(useStore.getState().sessionCwd).toEqual({
				"current-session": "/current",
				shell: "/shell",
			});
		},
	);

	it.each([
		"opaque-pane",
		"launcher:original",
		"term:original",
		"agent:unrelated",
	])(
		"finishes an absent registration's leftover current reference %s",
		async (id) => {
			const baseline = state({ a: layout(id) });
			baseline.agents = [current];
			await install(baseline);
			await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(
				true,
			);
			const final = readState();
			expectRestored(final.layouts.a, ["sibling"]);
			expect(final.pinnedPanes).toEqual({ [panePinKey("a", "sibling")]: true });
		},
	);

	it("removes every matching reference, not the same ID's independent Space occurrence", async () => {
		const baseline = state({
			a: layout(),
			b: layout(paneId, "agent", { agentRef: { agentId: current.id } }),
			orphan: layout("opaque-agent"),
		});
		await install(baseline);
		await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(true);
		const final = readState();
		expectRestored(final.layouts.a, ["sibling"]);
		expectRestored(final.layouts.orphan, ["sibling"]);
		expect(final.layouts.b).toEqual(baseline.layouts.b);
		expect(final.pinnedPanes).toEqual({
			[panePinKey("a", "sibling")]: true,
			[panePinKey("orphan", "sibling")]: true,
			[panePinKey("b", paneId)]: true,
			[panePinKey("b", "sibling")]: true,
		});
	});

	it("keeps legacy Agent content compatibility without using copied runtime params", async () => {
		await install(
			state({ a: layout(paneId, "agent", { agentId: current.id }) }),
		);
		await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(true);
		expectRestored(readState().layouts.a, ["sibling"]);
	});

	it.each(["exact", "batch"] as const)(
		"preserves a same-ID registration successor in %s mode",
		async (mode) => {
			const baseline = state({ a: layout("opaque-agent") });
			baseline.agents = [
				{ ...former, sessionId: "successor-session" },
				current,
			];
			await install(baseline);
			const agents = [
				{ agentId: former.id, panelIds: [paneId], applies: () => false },
			];
			const applied = await removeAgentProjectionDurably(
				mode === "batch" ? { agents, mode, applies: () => true } : { agents },
			);
			expect(applied).toBe(mode === "batch");
			expect(readState()).toEqual(baseline);
		},
	);

	it("cleans orphaned legacy pins while protecting a reused current ID", async () => {
		const baseline = state({ a: layout(paneId, "launcher", {}) });
		baseline.pinnedPanes[panePinKey("b", paneId)] = true;
		baseline.pinnedPanes[panePinKey("detached", paneId)] = true;
		await install(baseline);
		await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(true);
		expect(readState().pinnedPanes).toEqual({
			[panePinKey("a", paneId)]: true,
			[panePinKey("a", "sibling")]: true,
		});
	});

	it.each(["replacement-first", "removal-first"] as const)(
		"preserves a concurrent replacement and repeat cleanup: %s",
		async (order) => {
			const baseline = state({ a: layout() });
			await install(baseline);
			const other = createReferenceAwareLocalStorage<PersistedAppState>({
				coordinator: new DurableWriteCoordinator(),
				convergeState: convergePersistedAppState,
			});
			expect(other.getItem(DURABLE_APP_STORE_NAME)).not.toBeNull();
			const original = baseline.layouts.a as SerializedDockview;
			const replacement = {
				...baseline,
				layouts: {
					a: {
						...original,
						panels: {
							...original.panels,
							[paneId]: {
								...original.panels[paneId],
								contentComponent: "agent",
								params: { agentRef: { agentId: current.id } },
							},
						},
					},
				},
			};
			const publish = async () => {
				other.setItem(DURABLE_APP_STORE_NAME, {
					state: replacement,
					version: PERSIST_VERSION,
				});
				await other.flush();
			};
			if (order === "replacement-first") await publish();
			await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(
				true,
			);
			if (order === "removal-first") await publish();
			await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(
				true,
			);
			await rehydrateAppStoreFromDurableStorage();
			const final = readState();
			expect(final.layouts).toEqual(replacement.layouts);
			expect(final.pinnedPanes).toEqual(baseline.pinnedPanes);
			expect(final.agents).toEqual([current]);
			expectRestored(final.layouts.a, [paneId, "sibling"]);
		},
	);

	it("reprojects the committed removal after a failed first mounted projection", async () => {
		await install(state({ a: layout("opaque-agent") }));
		const api = dockview();
		api.fromJSON(readState().layouts.a as SerializedDockview);
		const project = vi
			.fn(() => {
				api.fromJSON(useStore.getState().layouts.a as SerializedDockview);
				return true;
			})
			.mockReturnValueOnce(false);
		cleanups.push(
			subscribeDurableStoreLayoutProjection("a", project, () => true),
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(true);
		expect(project).toHaveBeenCalledTimes(2);
		expect(api.panels.map((panel) => panel.id)).toEqual(["sibling"]);
		await expect(rollbackCreatedAgentRegistration(former)).resolves.toBe(true);
		expectRestored(readState().layouts.a, ["sibling"]);
	});

	it.each(["terminal", "ssh", "future-content"])(
		"projects only actual %s session departures when the local layout was unobserved",
		async (component) => {
			await install(state({}));
			await writeState(
				state({
					a: layout("opaque-terminal", component, { sessionId: "shell" }),
				}),
			);
			await expect(
				removeAgentProjectionDurably({
					agents: [],
					panes: [
						{
							spaceId: "a",
							panelId: "opaque-terminal",
							applies: (params) => params.sessionId === "shell",
						},
					],
				}),
			).resolves.toBe(true);
			expectRestored(readState().layouts.a, ["sibling"]);
			expect(useStore.getState().sessionCwd.shell).toBe(
				component === "future-content" ? "/shell" : undefined,
			);
		},
	);
});
