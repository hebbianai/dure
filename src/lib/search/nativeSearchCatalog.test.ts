import { describe, expect, it } from "vitest";
import {
	buildNativeSearchCatalog,
	type NativeSearchCatalogInput,
	nativeSearchFileContexts,
} from "@/lib/search/nativeSearchCatalog";

function input(
	overrides: Partial<NativeSearchCatalogInput> = {},
): NativeSearchCatalogInput {
	return {
		activeSpaceId: "desk-1",
		spaces: [{ id: "desk-1", name: "Main" }],
		layouts: {},
		projects: [
			{
				id: "project-1",
				name: "Dure",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [
			{
				id: "agent-1",
				name: "Native Search",
				provider: "codex",
				projectId: "project-1",
				worktreePath: "/repo/.worktrees/search",
				branch: "feat/search",
				sessionId: "session-agent",
				sessionKind: "pty",
			},
		],
		detected: {
			"project-1": [
				{
					path: "/repo/.worktrees/external",
					branch: "external",
					isMain: false,
					claudeSessions: 1,
					codexSessions: 0,
				},
			],
		},
		sshHosts: [],
		agentActivity: { "agent-1": "working" },
		agentDisplayStates: {},
		sessionAgentRuntimeState: {
			"shell-1": {
				lifecycle: "running",
				activity: "waiting",
				attention: "none",
			},
		},
		sessionCwd: { "shell-1": "/repo" },
		sessionAgent: { "shell-1": "claude" },
		sessionAgentPin: {},
		sessionTitle: { "shell-1": "Tests" },
		sessionActivity: {},
		sshStates: {},
		...overrides,
	};
}

describe("buildNativeSearchCatalog", () => {
	it.each(["slot", "launcher:previous", "term:previous"])("focuses the current Agent reference at %s rather than its historical alias", (panelId) => {
		const catalog = buildNativeSearchCatalog(input({ livePanels: [
			{ desktopId: "desk-1", id: panelId, component: "agent", params: { agentRef: { agentId: "agent-1" } } },
			{ desktopId: "desk-1", id: "agent:agent-1", component: "terminal", params: { sessionId: "shell-1" } },
		] }));
		expect(catalog.find(({ id }) => id === "agent:agent-1")?.action).toEqual({ type: "focus-panel", desktopId: "desk-1", panelId });
		expect(catalog.find(({ id }) => id === "session:agent:agent-1")?.title).toBe("Tests");
	});

	it.each(["slot", "launcher:previous", "agent:previous"])("lists terminal content at %s without turning copied launcher fields into a session", (panelId) => {
		const catalog = buildNativeSearchCatalog(input({ layouts: { "desk-1": { panels: {
			[panelId]: { contentComponent: "terminal", params: { sessionId: "shell-1" } },
			"term:copied": { contentComponent: "launcher", params: { sessionId: "shell-1" } },
		} } } }));
		expect(catalog.filter(({ kind }) => kind === "session").map(({ id }) => id)).toEqual([`session:${panelId}`]);
	});

	it("joins live and persisted targets with liveness and safe navigation actions", () => {
		const catalog = buildNativeSearchCatalog(
			input({
				livePanels: [
					{
						desktopId: "desk-1",
						id: "agent:agent-1",
						component: "agent",
						params: { agentRef: { agentId: "agent-1" } },
					},
					{
						desktopId: "desk-1",
						id: "term:shell-1",
						component: "terminal",
						params: { sessionId: "shell-1", cwd: "/old" },
					},
				],
			}),
		);

		expect(catalog.find(({ id }) => id === "agent:agent-1")).toMatchObject({
			status: "working",
			action: {
				type: "focus-panel",
				desktopId: "desk-1",
				panelId: "agent:agent-1",
			},
		});
		expect(
			catalog.find(({ id }) => id === "session:term:shell-1"),
		).toMatchObject({
			title: "Tests",
			status: "waiting",
			detail: expect.stringContaining("/repo"),
		});
		expect(
			catalog.find(({ id }) => id === "repository:project-1")?.detail,
		).toBe("/repo");
	});

	it("uses the watcher-resolved attention state instead of a weaker heuristic", () => {
		const catalog = buildNativeSearchCatalog(
			input({
				agentActivity: { "agent-1": "waiting" },
				agentDisplayStates: { "agent-1": "blocked" },
			}),
		);
		expect(catalog.find(({ id }) => id === "agent:agent-1")?.status).toBe(
			"blocked",
		);
	});

	it("reports a terminal session the Host has seen exit as exited, not by its last activity", () => {
		const catalog = buildNativeSearchCatalog(
			input({
				livePanels: [
					{
						desktopId: "desk-1",
						id: "term:shell-1",
						component: "terminal",
						params: { sessionId: "shell-1", cwd: "/repo" },
					},
				],
				sessionAgentRuntimeState: {
					"shell-1": {
						lifecycle: "exited",
						activity: "waiting",
						attention: "none",
					},
				},
			}),
		);
		expect(
			catalog.find(({ id }) => id === "session:term:shell-1")?.status,
		).toBe("exited");
	});

	it("keeps external worktrees searchable without pretending they are live agents", () => {
		const external = buildNativeSearchCatalog(input()).find(
			({ id }) => id === "worktree:local::/repo/.worktrees/external",
		);
		expect(external).toMatchObject({
			title: "external",
			status: undefined,
			action: { type: "open-worktree", path: "/repo/.worktrees/external" },
		});
	});
});

describe("nativeSearchFileContexts", () => {
	it("deduplicates project roots already represented by a main worktree", () => {
		const contexts = nativeSearchFileContexts(
			input({
				detected: {
					"project-1": [
						{
							path: "/repo",
							branch: "main",
							isMain: true,
							claudeSessions: 0,
							codexSessions: 0,
						},
					],
				},
			}),
		);
		expect(contexts.map(({ root }) => root)).toEqual([
			"/repo/.worktrees/search",
			"/repo",
		]);
	});
});
