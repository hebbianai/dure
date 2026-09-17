import { describe, expect, it } from "vitest";
import {
	agentRunPresentationWorktree,
	projectAgentRunWorkspace,
	snapshotAgentRunPresentationWorktree,
} from "@/lib/agents/agentRunWorkspacePresentation";
import type { Agent, Project } from "@/types";

const project: Project = {
	id: "project-1",
	name: "Project",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const source: Agent = {
	id: "agent-source",
	name: "source",
	provider: "claude",
	projectId: project.id,
	worktreePath: "/repo/.worktrees/source",
	branch: "agent/source",
	sessionId: "session-source",
	sessionKind: "pty",
};

describe("Agent Run workspace presentation", () => {
	it("uses the backend's explicit checkout destination for a dedicated workspace", () => {
		const worktree = {
			kind: "dedicated" as const,
			branch: "agent/source",
			directoryName: "source",
			rootPath: "/custom/workspaces/source",
		};
		expect(projectAgentRunWorkspace(worktree, project.path)).toEqual({
			path: worktree.rootPath,
			branch: worktree.branch,
		});
	});

	it("combines the backend root with the pre-spawn branch snapshot", () => {
		const worktree = agentRunPresentationWorktree(
			{
				kind: "existing_workspace",
				sourceAgentId: source.id,
				rootPath: source.worktreePath,
			},
			{ sourceAgentId: source.id, branch: source.branch },
		);

		expect(projectAgentRunWorkspace(worktree, project.path)).toEqual({
			path: source.worktreePath,
			branch: source.branch,
		});
	});

	it("normalizes an external receipt from one exact source snapshot", () => {
		expect(
			snapshotAgentRunPresentationWorktree(
				{
					kind: "existing_workspace",
					sourceAgentId: source.id,
					rootPath: source.worktreePath,
				},
				[source],
				project,
				"claude",
			),
		).toEqual({
			kind: "existing_workspace",
			sourceAgentId: source.id,
			rootPath: source.worktreePath,
			branch: source.branch,
		});
	});

	it("does not borrow presentation metadata from another source", () => {
		expect(() =>
			snapshotAgentRunPresentationWorktree(
				{
					kind: "existing_workspace",
					sourceAgentId: source.id,
					rootPath: source.worktreePath,
				},
				[{ ...source, provider: "codex" }],
				project,
				"claude",
			),
		).toThrow("existing workspace source changed before presentation");
	});
});
