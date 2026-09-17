import { describe, expect, it, vi } from "vitest";
import type { Agent, Project } from "@/types";
import {
	ExternalWorkspaceActionError,
	type ExternalWorkspaceDependencies,
	openExternalWorkspaceForPane,
} from "./externalWorkspace";

const localProject: Project = {
	id: "project-1",
	name: "repo",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const localAgent: Agent = {
	id: "agent-1",
	name: "agent-1",
	provider: "codex",
	projectId: localProject.id,
	worktreePath: "/repo/.worktrees/agent-1",
	branch: "agent/agent-1",
	sessionId: "session-1",
	sessionKind: "pty",
};

function fixture(overrides: Partial<ExternalWorkspaceDependencies> = {}) {
	const panel = paneSnapshot("agent:agent-1", "agent", { agentRef: { agentId: localAgent.id } });
	const preferences: { defaultExternalOpenTargetId?: string } = {};
	const open = vi.fn(async (path: string, targetId: string) => ({
		schemaVersion: 1 as const,
		targetId,
		canonicalPath: path,
		attemptedCandidates: 1,
	}));
	const setUiPrefs = vi.fn((next: { defaultExternalOpenTargetId: string }) => {
		Object.assign(preferences, next);
	});
	const dockview = { getPanel: () => panel };
	const dependencies: ExternalWorkspaceDependencies = {
		dockview: () => dockview,
		state: () => ({
			agents: [localAgent],
			projects: [localProject],
			detected: {},
			spaces: [{ id: "space-1" }],
			sessionCwd: {},
			uiPrefs: preferences,
			setUiPrefs,
		}),
		executionLocation: () => ({ kind: "local" }),
		open,
		...overrides,
	};
	return { dependencies, open, panel, preferences, setUiPrefs };
}

function paneSnapshot(id: string, component: string, params: Record<string, unknown> = {}) {
	return { id, params, api: { component, getParameters: () => params } };
}

describe("external workspace action", () => {
	it.each(["slot", "launcher:previous", "term:previous", "agent:previous"])("opens the current Agent reference at %s", async (panelId) => {
		const base = fixture();
		const panel = paneSnapshot(panelId, "agent", { agentRef: { agentId: localAgent.id } });
		const dockview = { getPanel: () => panel };
		await openExternalWorkspaceForPane({ spaceId: "space-1", panelId, targetId: "finder" }, { ...base.dependencies, dockview: () => dockview });
		expect(base.open).toHaveBeenCalledWith(localAgent.worktreePath, "finder");
	});

	it.each([null, {}, { agentId: "missing" }])("never falls back from an invalid explicit Agent reference: %j", async (agentRef) => {
		const base = fixture();
		const panel = paneSnapshot("agent:agent-1", "agent", { agentRef, cwd: "/repo", projectId: localProject.id });
		const dockview = { getPanel: () => panel };
		await expect(openExternalWorkspaceForPane({ spaceId: "space-1", panelId: panel.id, targetId: "finder" }, { ...base.dependencies, dockview: () => dockview })).rejects.toMatchObject({ code: "workspace_stale" });
		expect(base.open).not.toHaveBeenCalled();
	});

	it("ignores old Agent spelling and copied fields when the pane is now a terminal", async () => {
		const base = fixture();
		const panel = paneSnapshot("agent:agent-1", "terminal", { cwd: "/current-shell", agentId: localAgent.id, agentRef: { agentId: localAgent.id }, projectId: localProject.id });
		const dockview = { getPanel: () => panel };
		await openExternalWorkspaceForPane({ spaceId: "space-1", panelId: panel.id, targetId: "finder" }, { ...base.dependencies, dockview: () => dockview });
		expect(base.open).toHaveBeenCalledWith("/current-shell", "finder");
	});

	it("does not open copied workspace fields on launcher content", async () => {
		const base = fixture();
		const panel = paneSnapshot("agent:agent-1", "launcher", { cwd: "/repo", agentId: localAgent.id, projectId: localProject.id });
		const dockview = { getPanel: () => panel };
		await expect(openExternalWorkspaceForPane({ spaceId: "space-1", panelId: panel.id, targetId: "finder" }, { ...base.dependencies, dockview: () => dockview })).rejects.toMatchObject({ code: "workspace_unavailable" });
		expect(base.open).not.toHaveBeenCalled();
	});

	it("preserves the local session-diff workspace action", async () => {
		const base = fixture();
		const panel = paneSnapshot("slot", "diff", { sessionId: "shell", cwd: "/review" });
		const dockview = { getPanel: () => panel };
		await openExternalWorkspaceForPane({ spaceId: "space-1", panelId: panel.id, targetId: "finder" }, { ...base.dependencies, dockview: () => dockview });
		expect(base.open).toHaveBeenCalledWith("/review", "finder");
	});

	it.each(["unknown", "ssh"] as const)("keeps %s execution location from opening a local terminal workspace", async (kind) => {
		const base = fixture();
		const panel = paneSnapshot("slot", "terminal", { sessionId: "shell", cwd: "/repo" });
		const dockview = { getPanel: () => panel };
		await expect(openExternalWorkspaceForPane({ spaceId: "space-1", panelId: panel.id, targetId: "finder" }, { ...base.dependencies, dockview: () => dockview, executionLocation: () => kind === "ssh" ? { kind, target: "remote" } : { kind } })).rejects.toMatchObject({ code: kind === "ssh" ? "workspace_remote" : "workspace_unavailable" });
		expect(base.open).not.toHaveBeenCalled();
	});

	it("does not use copied cwd when an explicit terminal binding is invalid", async () => {
		const base = fixture();
		const panel = paneSnapshot("term:shell", "terminal", { sessionId: "shell", cwd: "/repo", binding: {} });
		const dockview = { getPanel: () => panel };
		await expect(openExternalWorkspaceForPane({ spaceId: "space-1", panelId: panel.id, targetId: "finder" }, { ...base.dependencies, dockview: () => dockview })).rejects.toMatchObject({ code: "workspace_stale" });
		expect(base.open).not.toHaveBeenCalled();
	});

	it("opens an Agent's exact worktree instead of its base repository", async () => {
		const { dependencies, open, setUiPrefs } = fixture();

		const receipt = await openExternalWorkspaceForPane(
			{ spaceId: "space-1", panelId: "agent:agent-1", targetId: "cursor" },
			dependencies,
		);

		expect(open).toHaveBeenCalledWith("/repo/.worktrees/agent-1", "cursor");
		expect(receipt).toMatchObject({
			spaceId: "space-1",
			panelId: "agent:agent-1",
			kind: "agent",
			canonicalPath: "/repo/.worktrees/agent-1",
		});
		expect(setUiPrefs).toHaveBeenCalledWith({
			defaultExternalOpenTargetId: "cursor",
		});
	});

	it("opens a project pane's exact local project path", async () => {
		const base = fixture();
		const panel = paneSnapshot("git:project-1", "git", { projectId: "project-1" });
		const dockview = { getPanel: () => panel };
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			dockview: () => dockview,
		};

		const receipt = await openExternalWorkspaceForPane(
			{ spaceId: "space-1", panelId: panel.id, targetId: "finder" },
			dependencies,
		);

		expect(base.open).toHaveBeenCalledWith("/repo", "finder");
		expect(receipt).toMatchObject({
			panelId: "git:project-1",
			kind: "project",
			canonicalPath: "/repo",
		});
	});

	it("opens the exact Agent worktree containing a local file pane", async () => {
		const base = fixture();
		const path = "/repo/.worktrees/agent-1/src/main.ts";
		const panel = {
			id: `file:local::${path}`,
			api: { component: "fileviewer", getParameters: () => ({}) },
			params: { path, source: "local" },
		};
		const dockview = { getPanel: () => panel };
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			dockview: () => dockview,
		};

		const receipt = await openExternalWorkspaceForPane(
			{ spaceId: "space-1", panelId: panel.id, targetId: "cursor" },
			dependencies,
		);

		expect(base.open).toHaveBeenCalledWith(
			"/repo/.worktrees/agent-1",
			"cursor",
		);
		expect(receipt).toMatchObject({
			panelId: panel.id,
			kind: "agent",
			canonicalPath: "/repo/.worktrees/agent-1",
		});
	});

	it("opens the registered local project containing a file outside Agent worktrees", async () => {
		const base = fixture();
		const path = "/repo/docs/guide.md";
		const panel = {
			id: `file:local::${path}`,
			api: { component: "fileviewer", getParameters: () => ({}) },
			params: { path, source: "local" },
		};
		const dockview = { getPanel: () => panel };
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			dockview: () => dockview,
		};

		const receipt = await openExternalWorkspaceForPane(
			{ spaceId: "space-1", panelId: panel.id, targetId: "finder" },
			dependencies,
		);

		expect(base.open).toHaveBeenCalledWith("/repo", "finder");
		expect(receipt.kind).toBe("project");
	});

	it("opens the exact detected Git worktree containing a local file pane", async () => {
		const base = fixture();
		const path = "/repo/.worktrees/review/src/main.ts";
		const panel = {
			id: `file:local::${path}`,
			api: { component: "fileviewer", getParameters: () => ({}) },
			params: { path, source: "local" },
		};
		const dockview = { getPanel: () => panel };
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			dockview: () => dockview,
			state: () => ({
				...base.dependencies.state(),
				detected: {
					[localProject.id]: [
						{
							path: "/repo/.worktrees/review",
							branch: "agent/review",
							isMain: false,
							claudeSessions: 0,
							codexSessions: 0,
						},
					],
				},
			}),
		};

		await openExternalWorkspaceForPane(
			{ spaceId: "space-1", panelId: panel.id, targetId: "cursor" },
			dependencies,
		);

		expect(base.open).toHaveBeenCalledWith(
			"/repo/.worktrees/review",
			"cursor",
		);
	});

	it("does not guess a workspace for an unrelated local file pane", async () => {
		const base = fixture();
		const path = "/repo-other/notes.md";
		const panel = {
			id: `file:local::${path}`,
			api: { component: "fileviewer", getParameters: () => ({}) },
			params: { path, source: "local" },
		};
		const dockview = { getPanel: () => panel };
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			dockview: () => dockview,
		};

		await expect(
			openExternalWorkspaceForPane(
				{ spaceId: "space-1", panelId: panel.id, targetId: "finder" },
				dependencies,
			),
		).rejects.toMatchObject({ code: "workspace_unavailable" });
		expect(base.open).not.toHaveBeenCalled();
	});

	it("rejects a remote file pane before native I/O", async () => {
		const base = fixture();
		const panel = {
			id: "file:ssh:host-1:/repo/docs/guide.md",
			api: { component: "fileviewer", getParameters: () => ({}) },
			params: {
				path: "/repo/docs/guide.md",
				source: "ssh",
				hostId: "host-1",
			},
		};
		const dockview = { getPanel: () => panel };
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			dockview: () => dockview,
		};

		await expect(
			openExternalWorkspaceForPane(
				{ spaceId: "space-1", panelId: panel.id, targetId: "finder" },
				dependencies,
			),
		).rejects.toMatchObject({ code: "workspace_remote" });
		expect(base.open).not.toHaveBeenCalled();
	});

	it.each(["slot", "file:local::/previous/guide.md"])("opens the explicit local file target at %s", async (panelId) => {
		const base = fixture();
		const panel = paneSnapshot(panelId, "fileviewer", { path: "/repo/docs/guide.md", source: "local" });
		const dockview = { getPanel: () => panel };
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			dockview: () => dockview,
		};

		await openExternalWorkspaceForPane(
				{ spaceId: "space-1", panelId: panel.id, targetId: "finder" },
				dependencies,
			);
		expect(base.open).toHaveBeenCalledWith("/repo", "finder");
	});

	it("persists no default when the native launch fails", async () => {
		const { dependencies, setUiPrefs } = fixture({
			open: vi.fn(async () => {
				throw { code: "target_unavailable", message: "Cursor is missing" };
			}),
		});

		await expect(
			openExternalWorkspaceForPane(
				{ spaceId: "space-1", panelId: "agent:agent-1", targetId: "cursor" },
				dependencies,
			),
		).rejects.toMatchObject({ code: "target_unavailable" });
		expect(setUiPrefs).not.toHaveBeenCalled();
	});

	it("rejects a remote Agent before native I/O", async () => {
		const remote = { ...localAgent, sessionKind: "ssh" as const };
		const base = fixture();
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			state: () => ({
				...base.dependencies.state(),
				agents: [remote],
			}),
		};

		await expect(
			openExternalWorkspaceForPane(
				{ spaceId: "space-1", panelId: "agent:agent-1", targetId: "finder" },
				dependencies,
			),
		).rejects.toMatchObject({ code: "workspace_remote" });
		expect(base.open).not.toHaveBeenCalled();
	});

	it("classifies an Agent with a retired project as stale, not remote", async () => {
		const base = fixture();
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			state: () => ({
				...base.dependencies.state(),
				projects: [],
			}),
		};

		await expect(
			openExternalWorkspaceForPane(
				{ spaceId: "space-1", panelId: "agent:agent-1", targetId: "finder" },
				dependencies,
			),
		).rejects.toMatchObject({ code: "workspace_stale" });
		expect(base.open).not.toHaveBeenCalled();
	});

	it("rejects a pane generation that changes before native I/O", async () => {
		const base = fixture();
		const replacement = paneSnapshot("agent:agent-1", "agent", { agentRef: { agentId: localAgent.id } });
		let lookup = 0;
		const dockview = {
			getPanel: () => (++lookup === 1 ? base.panel : replacement),
		};
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			dockview: () => dockview,
		};

		await expect(
			openExternalWorkspaceForPane(
				{ spaceId: "space-1", panelId: "agent:agent-1", targetId: "finder" },
				dependencies,
			),
		).rejects.toBeInstanceOf(ExternalWorkspaceActionError);
		expect(base.open).not.toHaveBeenCalled();
	});

	it("ignores a mismatched copied param in favor of the explicit Agent reference", async () => {
		const base = fixture();
		const legacyPanel = {
			id: "agent:agent-1",
			api: { component: "agent", getParameters: () => ({}) },
			params: { agentRef: { agentId: localAgent.id }, agentId: "replacement-agent" },
		};
		const dockview = {
			getPanel: () => legacyPanel,
		};
		const dependencies: ExternalWorkspaceDependencies = {
			...base.dependencies,
			dockview: () => dockview,
		};

		await openExternalWorkspaceForPane(
			{ spaceId: "space-1", panelId: "agent:agent-1", targetId: "finder" },
			dependencies,
		);

		expect(base.open).toHaveBeenCalledWith(
			"/repo/.worktrees/agent-1",
			"finder",
		);
	});

	it("uses the last successful target when the common command omits one", async () => {
		const base = fixture();
		base.preferences.defaultExternalOpenTargetId = "terminal";

		await openExternalWorkspaceForPane(
			{ spaceId: "space-1", panelId: "agent:agent-1" },
			base.dependencies,
		);

		expect(base.open).toHaveBeenCalledWith(
			"/repo/.worktrees/agent-1",
			"terminal",
		);
	});
});
