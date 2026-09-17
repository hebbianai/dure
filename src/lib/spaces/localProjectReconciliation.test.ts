import { describe, expect, it } from "vitest";
import { reconcileLocalProjectState } from "@/lib/spaces/localProjectReconciliation";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent, Project } from "@/types";

const worktreeProject: Project = {
	id: "project-worktree",
	name: "dure-frontend",
	path: "/repo/HebbianIDE/.worktrees/dure-frontend",
	kind: "local",
	isRepo: true,
};
const primaryProject: Project = {
	id: "project-primary",
	name: "HebbianIDE",
	path: "/repo/HebbianIDE",
	kind: "local",
	isRepo: true,
};

function agent(projectId: string): Agent {
	return agentFixture({
		id: "agent-patric",
		name: "patric",
		provider: "claude",
		projectId,
		worktreePath: "/repo/HebbianIDE/.worktrees/patric",
		branch: "patric",
		sessionId: "session-patric",
		started: true,
	});
}

describe("local Project repository reconciliation", () => {
	it("moves a linked-worktree Agent to the existing primary Project", () => {
		const source = agent(worktreeProject.id);
		const result = reconcileLocalProjectState(
			{
				projects: [worktreeProject, primaryProject],
				agents: [source],
				pinnedProjects: [worktreeProject.id, primaryProject.id],
				detected: {},
			},
			new Map([
				[
					worktreeProject.id,
					{ path: primaryProject.path, name: "dure-internal" },
				],
				[
					primaryProject.id,
					{ path: primaryProject.path, name: "dure-internal" },
				],
			]),
		);

		expect(result.projects).toEqual([
			{ ...primaryProject, name: "dure-internal" },
		]);
		expect(result.agents[0]).toMatchObject({
			projectId: primaryProject.id,
			worktreePath: "/repo/HebbianIDE/.worktrees/patric",
			sessionId: "session-patric",
		});
		expect(result.pinnedProjects).toEqual([primaryProject.id]);
		expect(result.changed).toBe(true);
	});

	it("keeps unrelated local and SSH repositories separate", () => {
		const otherLocal: Project = {
			id: "project-other",
			name: "other",
			path: "/repo/other",
			kind: "local",
			isRepo: true,
		};
		const remote: Project = {
			id: "project-remote",
			name: "HebbianIDE",
			path: "/repo/HebbianIDE/.worktrees/remote",
			kind: "ssh",
			sshHostId: "host-one",
			isRepo: true,
		};
		const result = reconcileLocalProjectState(
			{
				projects: [worktreeProject, otherLocal, remote],
				agents: [],
				pinnedProjects: [],
				detected: {},
			},
			new Map([
				[
					worktreeProject.id,
					{ path: primaryProject.path, name: "dure-internal" },
				],
				[otherLocal.id, { path: otherLocal.path, name: otherLocal.name }],
			]),
		);

		expect(result.projects).toEqual([
			{
				...worktreeProject,
				name: "dure-internal",
				path: primaryProject.path,
			},
			otherLocal,
			remote,
		]);
	});
});
