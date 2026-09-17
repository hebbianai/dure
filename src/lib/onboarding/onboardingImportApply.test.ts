// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOnboardingImportDraft } from "@/lib/onboarding/onboardingImportApply";
import { buildOnboardingImportDraft } from "@/lib/onboarding/onboardingImportDraft";
import {
	beginOnboardingImportJournal,
	readOnboardingImportJournal,
	type OnboardingImportJournalStorage,
} from "@/lib/onboarding/onboardingImportJournal";
import { useStore } from "@/store";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";

function storage(): OnboardingImportJournalStorage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key),
	};
}

const original = {
	spaces: useStore.getState().spaces,
	activeSpaceId: useStore.getState().activeSpaceId,
	layouts: useStore.getState().layouts,
	projects: useStore.getState().projects,
	agents: useStore.getState().agents,
	agentActivity: useStore.getState().agentActivity,
	stats: useStore.getState().stats,
	uiPrefs: useStore.getState().uiPrefs,
};

const fixtures: Array<{ api: DockviewApi; element: HTMLElement }> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const { api, element } of fixtures.splice(0)) {
		unregisterDockview("desk-first", api);
		api.dispose();
		element.remove();
	}
	useStore.setState(original);
});

function mountedDesktop(paneId = "onboarding:main", component = "onboarding") {
	useStore.setState({
		spaces: [{ id: "desk-first", name: "Desktop 1" }],
		activeSpaceId: "desk-first",
		layouts: {},
		projects: [
			{
				id: "project-one",
				name: "repo",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [],
		agentActivity: {},
	});
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
			dispose() {},
		}),
	});
	api.layout(1200, 800);
	api.addPanel({ id: paneId, component });
	useStore.getState().saveLayout("desk-first", api.toJSON());
	registerDockview("desk-first", api);
	fixtures.push({ api, element });
	return api;
}

function draft() {
	return buildOnboardingImportDraft({
		total: 1,
		groups: [
			{
				id: "repo:dure",
				name: "HebbianIDE",
				cwd: "/repo",
				items: [
					{
						key: "codex:one",
						conversationId: "conversation-one",
						title: "One",
						mtime: 1,
						provider: "codex",
						cwd: "/repo",
						workspaceRoot: "/repo",
						groupIdentity: "repo:dure",
						defaultSelected: true,
						executionLocation: "local",
					},
				],
			},
		],
	});
}

describe("applyOnboardingImportDraft", () => {
	it.each(["pane-guide", "onboarding:main"])(
		"reuses the current Space based on its guide content, not ID %s",
		async (id) => {
			const api = mountedDesktop(id);
			const receipt = await applyOnboardingImportDraft(draft(), {
				storage: storage(),
			});
			expect(receipt.desktopIds).toEqual(["desk-first"]);
			expect(useStore.getState().spaces).toHaveLength(1);
			expect(api.panels[0].api.component).toBe("agent");
		},
	);

	it.each([true, false])(
		"preserves retargeted guide content before import commit (mounted: %s)",
		async (mounted) => {
			const api = mountedDesktop();
			const memory = storage();
			beginOnboardingImportJournal(
				draft(),
				{ reusableDesktopId: "desk-first" },
				memory,
			);
			api.replacePanel(api.panels[0].api, {
				component: "terminal",
				params: { draft: "keep user work" },
			});
			const saved = api.toJSON();
			useStore.getState().saveLayout("desk-first", saved);
			if (!mounted) unregisterDockview("desk-first", api);
			await expect(
				applyOnboardingImportDraft(draft(), { storage: memory }),
			).rejects.toThrow("onboarding desktop changed before import commit");
			expect(useStore.getState().agents).toHaveLength(0);
			expect(useStore.getState().layouts["desk-first"]).toEqual(saved);
			expect(api.toJSON()).toEqual(saved);
		},
	);

	it("does not infer disposable guide content from an untyped saved record", async () => {
		const api = mountedDesktop();
		unregisterDockview("desk-first", api);
		const saved = { panels: { "onboarding:main": {} } };
		useStore.getState().saveLayout("desk-first", saved);
		await expect(
			applyOnboardingImportDraft(draft(), {
				storage: storage(),
				reusableDesktopId: "desk-first",
			}),
		).rejects.toThrow("onboarding desktop changed before import commit");
		expect(useStore.getState().layouts["desk-first"]).toEqual(saved);
		expect(useStore.getState().agents).toHaveLength(0);
	});

	it("replays the journal's view IDs and explicit targets through mounted Dockview", async () => {
		const api = mountedDesktop();
		const memory = storage();
		await expect(
			applyOnboardingImportDraft(draft(), {
				storage: memory,
				afterCommit: () => {
					throw new Error("response lost");
				},
			}),
		).rejects.toThrow("response lost");
		const journal = readOnboardingImportJournal(memory)!;
		const pane = api.getPanel(journal.paneIds[0])!;
		expect(api.panels.map((panel) => panel.id)).toEqual(journal.paneIds);
		expect(
			agentIdFromPane({
				id: pane.id,
				component: pane.api.component,
				params: pane.params,
			}),
		).toBe(journal.agentIds[0]);
		const saved = api.toJSON();
		const receipt = await applyOnboardingImportDraft(draft(), {
			storage: memory,
		});
		expect(receipt.agentIds).toEqual(journal.agentIds);
		expect(api.toJSON()).toEqual(saved);
		expect(api.getPanel(pane.id)).toBe(pane);
		expect(useStore.getState().agents).toHaveLength(1);
	});

	it("resumes an old journal with the original Agent-shaped view ID", async () => {
		const api = mountedDesktop();
		const memory = storage();
		const { paneIds: _paneIds, ...legacy } = beginOnboardingImportJournal(
			draft(),
			{ reusableDesktopId: "desk-first" },
			memory,
		);
		memory.setItem("dure:first-run-session-import:v1", JSON.stringify(legacy));
		await applyOnboardingImportDraft(draft(), { storage: memory });
		expect(api.panels.map((pane) => pane.id)).toEqual(
			legacy.agentIds.map((id) => `agent:${id}`),
		);
		expect(api.panels[0].params).toEqual({
			agentRef: { agentId: legacy.agentIds[0] },
		});
	});

	it("refuses a malformed journal before project registration or layout mutation", async () => {
		const api = mountedDesktop();
		const memory = storage();
		const initial = api.toJSON();
		const journal = beginOnboardingImportJournal(draft(), {}, memory);
		const raw = JSON.stringify({ ...journal, paneIds: null });
		memory.setItem("dure:first-run-session-import:v1", raw);
		const ensureProject = vi.spyOn(useStore.getState(), "ensureProjectForPath");
		await expect(
			applyOnboardingImportDraft(draft(), { storage: memory }),
		).rejects.toThrow("onboarding import journal is invalid");
		expect(ensureProject).not.toHaveBeenCalled();
		expect(api.toJSON()).toEqual(initial);
		expect(useStore.getState().agents).toHaveLength(0);
		expect(memory.getItem("dure:first-run-session-import:v1")).toBe(raw);
	});

	it.each(["retargeted", "closed"])(
		"preserves %s user views when recovering a lost import response",
		async (change) => {
			const api = mountedDesktop();
			const memory = storage();
			await expect(
				applyOnboardingImportDraft(draft(), {
					storage: memory,
					afterCommit: () => {
						throw new Error("response lost");
					},
				}),
			).rejects.toThrow("response lost");
			const pane = api.panels[0];
			if (change === "closed") api.removePanel(pane);
			else {
				api.replacePanel(pane.api, {
					component: "terminal",
					title: "User shell",
					params: { draft: "unsent input" },
				});
				api.addPanel({
					id: "pane-user-work",
					component: "file-viewer",
					params: { path: "/repo/notes.md", source: "local" },
				});
			}
			const userLayout = api.toJSON();
			useStore.getState().saveLayout("desk-first", userLayout);
			const currentPane = api.getPanel(pane.id);
			await applyOnboardingImportDraft(draft(), { storage: memory });
			expect(api.toJSON()).toEqual(userLayout);
			expect(api.getPanel(pane.id)).toBe(currentPane);
			expect(useStore.getState().layouts["desk-first"]).toEqual(userLayout);
			expect(useStore.getState().agents).toHaveLength(1);
		},
	);

	it("projects the committed layout after the first presentation attempt fails", async () => {
		const api = mountedDesktop();
		const memory = storage();
		const fromJSON = vi.spyOn(api, "fromJSON").mockImplementationOnce(() => {
			throw new Error("presentation unavailable");
		});
		await expect(
			applyOnboardingImportDraft(draft(), { storage: memory }),
		).rejects.toThrow("presentation unavailable");
		const journal = readOnboardingImportJournal(memory)!;
		await applyOnboardingImportDraft(draft(), { storage: memory });
		expect(fromJSON).toHaveBeenCalledTimes(2);
		expect(api.panels.map((pane) => pane.id)).toEqual(journal.paneIds);
		expect(readOnboardingImportJournal(memory)?.status).toBe("complete");
		expect(useStore.getState().agents).toHaveLength(1);
	});

	it("returns the exact completed receipt after a later managed runtime rehost", async () => {
		const memory = storage();
		useStore.setState({
			spaces: [{ id: "desk-first", name: "Desktop 1" }],
			activeSpaceId: "desk-first",
			layouts: {
				"desk-first": {
					panels: { "onboarding:main": { contentComponent: "onboarding" } },
				},
			},
			projects: [
				{
					id: "project-one",
					name: "repo",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [],
			agentActivity: {},
		});
		const receipt = await applyOnboardingImportDraft(draft(), {
			storage: memory,
			reusableDesktopId: "desk-first",
		});
		const imported = useStore.getState().agents[0];
		if (imported.runtimeBinding?.runtime !== "hmux_managed_v1") {
			throw new Error("test agent is not managed");
		}
		useStore.setState({
			agents: [
				{
					...imported,
					sessionId: "rehosted-session",
					runtimeBinding: {
						...imported.runtimeBinding,
						sessionId: "rehosted-session",
					},
				},
			],
		});

		await expect(
			applyOnboardingImportDraft(draft(), {
				storage: memory,
				reusableDesktopId: "desk-first",
			}),
		).resolves.toEqual(receipt);
		expect(useStore.getState().agents[0].sessionId).toBe("rehosted-session");
	});

	it("recovers an exact response loss without duplicating desktop or agent records", async () => {
		const memory = storage();
		useStore.setState({
			spaces: [{ id: "desk-first", name: "Desktop 1" }],
			activeSpaceId: "desk-first",
			layouts: {
				"desk-first": {
					panels: { "onboarding:main": { contentComponent: "onboarding" } },
				},
			},
			projects: [
				{
					id: "project-one",
					name: "repo",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [],
			agentActivity: {},
		});

		await expect(
			applyOnboardingImportDraft(draft(), {
				storage: memory,
				reusableDesktopId: "desk-first",
				afterCommit: () => {
					throw new Error("fault-injected response loss");
				},
			}),
		).rejects.toThrow("fault-injected response loss");
		expect(useStore.getState().agents).toHaveLength(1);

		const receipt = await applyOnboardingImportDraft(draft(), {
			storage: memory,
			reusableDesktopId: "desk-first",
		});
		expect(useStore.getState().agents).toHaveLength(1);
		expect(useStore.getState().spaces).toEqual([
			{ id: "desk-first", name: "HebbianIDE" },
		]);
		expect(receipt.agentIds).toEqual([useStore.getState().agents[0].id]);
		expect(useStore.getState().agents[0]).toMatchObject({
			conversationId: "conversation-one",
			started: true,
			runtimeBinding: { runtime: "hmux_managed_v1" },
		});
	});

	it("keeps a historical ten-pane journal authoritative over a smaller retry hint", async () => {
		const memory = storage();
		const retryHint = draft();
		const seedPane = retryHint.desktops[0].panes[0];
		const historical = {
			...retryHint,
			desktops: [
				{
					...retryHint.desktops[0],
					panes: Array.from({ length: 10 }, (_, index) => ({
						...seedPane,
						key: `codex:legacy-${index}`,
						conversationId: `conversation-legacy-${index}`,
					})),
				},
			],
			discoveredCount: 10,
		};
		beginOnboardingImportJournal(
			historical,
			{ reusableDesktopId: "desk-first" },
			memory,
		);
		useStore.setState({
			spaces: [{ id: "desk-first", name: "Desktop 1" }],
			activeSpaceId: "desk-first",
			layouts: {
				"desk-first": {
					panels: { "onboarding:main": { contentComponent: "onboarding" } },
				},
			},
			projects: [
				{
					id: "project-one",
					name: "repo",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [],
			agentActivity: {},
		});

		const receipt = await applyOnboardingImportDraft(retryHint, {
			storage: memory,
			reusableDesktopId: "desk-first",
		});

		expect(receipt.agentIds).toHaveLength(10);
		expect(useStore.getState().agents).toHaveLength(10);
	});
});
