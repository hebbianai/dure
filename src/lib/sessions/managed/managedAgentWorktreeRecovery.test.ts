import { describe, expect, it, vi } from "vitest";
import { agentFixture } from "@/test/agentFixtures";
import type { Project } from "@/types";
import {
	inspectManagedAgentWorktree,
	type ManagedAgentWorktreeRecoveryDeps,
	managedAgentWorktreeRecovery,
	planManagedAgentWorktreeRecovery,
	recreateManagedAgentWorktree,
} from "./managedAgentWorktreeRecovery";

const project: Project = {
	id: "project-1",
	name: "repo",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

function deps(
	patch: Partial<ManagedAgentWorktreeRecoveryDeps> = {},
): ManagedAgentWorktreeRecoveryDeps {
	return {
		listDir: vi.fn().mockResolvedValue([]),
		locateGitCheckoutPaths: vi.fn().mockResolvedValue([undefined, undefined]),
		provisionWorktree: vi.fn(),
		...patch,
	} as ManagedAgentWorktreeRecoveryDeps;
}

const agent = agentFixture({
	name: "codex-pane",
	branch: "agent/codex-pane",
	worktreePath: "/repo/.worktrees/codex-pane",
});

describe("managed Agent worktree recovery", () => {
	it.each([
		{
			label: "default in-repository root",
			worktreePath: "/repo/.worktrees/codex-pane",
			worktreeRoot: ".worktrees",
			inspectionBase: "/repo",
			inspectionSegments: [".worktrees", "codex-pane"],
		},
		{
			label: "nested in-repository root",
			worktreePath: "/repo/.claude/worktrees/codex-pane",
			worktreeRoot: ".claude/worktrees",
			inspectionBase: "/repo",
			inspectionSegments: [".claude", "worktrees", "codex-pane"],
		},
		{
			label: "sibling root",
			worktreePath: "/codex-pane",
			worktreeRoot: "..",
			inspectionBase: "/",
			inspectionSegments: ["codex-pane"],
		},
	])("derives the canonical checkout request for a $label", (fixture) => {
		expect(
			planManagedAgentWorktreeRecovery(
				{ ...agent, worktreePath: fixture.worktreePath },
				project,
			),
		).toEqual({
			repo: "/repo",
			branch: "agent/codex-pane",
			worktreePath: fixture.worktreePath,
			worktreeRoot: fixture.worktreeRoot,
			inspectionBase: fixture.inspectionBase,
			inspectionSegments: fixture.inspectionSegments,
		});
	});

	it("derives the same bounded root from native Windows paths", () => {
		expect(
			planManagedAgentWorktreeRecovery(
				{ ...agent, worktreePath: "c:\\repo\\.worktrees\\codex-pane" },
				{ ...project, path: "C:\\repo" },
			),
		).toEqual(
			expect.objectContaining({
				worktreeRoot: ".worktrees",
				inspectionSegments: [".worktrees", "codex-pane"],
			}),
		);
	});

	it.each([
		{
			label: "the primary checkout",
			candidate: { ...agent, worktreePath: "/repo" },
			candidateProject: project,
		},
		{
			label: "an unrelated external path",
			candidate: { ...agent, worktreePath: "/elsewhere/codex-pane" },
			candidateProject: project,
		},
		{
			label: "a directory that does not match the branch",
			candidate: { ...agent, worktreePath: "/repo/.worktrees/other" },
			candidateProject: project,
		},
		{
			label: "an SSH checkout",
			candidate: agent,
			candidateProject: { ...project, kind: "ssh" as const },
		},
	])(
		"does not guess recovery authority for $label",
		({ candidate, candidateProject }) => {
			expect(
				planManagedAgentWorktreeRecovery(candidate, candidateProject),
			).toBeUndefined();
		},
	);

	it("classifies an absent path without treating inspection as launch admission", async () => {
		const plan = planManagedAgentWorktreeRecovery(agent, project);
		if (!plan) throw new Error("expected recovery plan");
		const d = deps({
			listDir: vi.fn().mockResolvedValueOnce([]),
		});

		await expect(inspectManagedAgentWorktree(plan, d)).resolves.toBe("missing");
		expect(d.locateGitCheckoutPaths).not.toHaveBeenCalled();
	});

	it("recognizes only the exact linked checkout of the same repository", async () => {
		const plan = planManagedAgentWorktreeRecovery(agent, project);
		if (!plan) throw new Error("expected recovery plan");
		const d = deps({
			listDir: vi
				.fn()
				.mockResolvedValueOnce([
					{
						name: ".worktrees",
						path: "/repo/.worktrees",
						isDir: true,
						isRepo: false,
						ignored: true,
					},
				])
				.mockResolvedValueOnce([
					{
						name: "codex-pane",
						path: agent.worktreePath,
						isDir: true,
						isRepo: true,
						ignored: true,
					},
				]),
			locateGitCheckoutPaths: vi.fn().mockResolvedValue([
				{
					schemaVersion: 1,
					canonicalPath: "/canonical/repo",
					gitCommonDir: "/canonical/repo/.git",
				},
				{
					schemaVersion: 1,
					canonicalPath: "/canonical/repo/.worktrees/codex-pane",
					gitCommonDir: "/canonical/repo/.git",
				},
			]),
		});

		await expect(inspectManagedAgentWorktree(plan, d)).resolves.toBe("present");
	});

	it("recreates the missing path from the preserved branch and exact root", async () => {
		const plan = planManagedAgentWorktreeRecovery(agent, project);
		if (!plan) throw new Error("expected recovery plan");
		const d = deps({
			listDir: vi.fn().mockResolvedValue([]),
			provisionWorktree: vi.fn().mockResolvedValue({
				path: agent.worktreePath,
				branch: agent.branch,
			}),
		});

		await expect(
			recreateManagedAgentWorktree(plan, d),
		).resolves.toBeUndefined();
		expect(d.provisionWorktree).toHaveBeenCalledWith({
			repo: project.path,
			branch: agent.branch,
			worktreePath: agent.worktreePath,
			action: "checkout-existing-branch",
			worktreeRoot: ".worktrees",
		});
	});

	it("never replaces an occupied recorded path", async () => {
		const plan = planManagedAgentWorktreeRecovery(agent, project);
		if (!plan) throw new Error("expected recovery plan");
		const d = deps({
			listDir: vi
				.fn()
				.mockResolvedValueOnce([
					{
						name: ".worktrees",
						path: "/repo/.worktrees",
						isDir: true,
						isRepo: false,
						ignored: true,
					},
				])
				.mockResolvedValueOnce([
					{
						name: "codex-pane",
						path: agent.worktreePath,
						isDir: false,
						isRepo: false,
						ignored: true,
					},
				]),
		});

		await expect(recreateManagedAgentWorktree(plan, d)).rejects.toThrow(
			"managed_agent_worktree_occupied",
		);
		expect(d.provisionWorktree).not.toHaveBeenCalled();
	});

	it("is idempotent when the exact checkout is already back", async () => {
		const present = vi.fn().mockResolvedValue([
			{
				schemaVersion: 1,
				canonicalPath: "/repo",
				gitCommonDir: "/repo/.git",
			},
			{
				schemaVersion: 1,
				canonicalPath: agent.worktreePath,
				gitCommonDir: "/repo/.git",
			},
		]);
		const d = deps({
			listDir: vi
				.fn()
				.mockResolvedValueOnce([
					{
						name: ".worktrees",
						path: "/repo/.worktrees",
						isDir: true,
						isRepo: false,
						ignored: true,
					},
				])
				.mockResolvedValueOnce([
					{
						name: "codex-pane",
						path: agent.worktreePath,
						isDir: true,
						isRepo: true,
						ignored: true,
					},
				]),
			locateGitCheckoutPaths: present,
		});
		const recovery = managedAgentWorktreeRecovery(agent, project, d);
		if (!recovery) throw new Error("expected recovery action");

		await expect(recovery.recreate()).resolves.toBeUndefined();
		expect(d.provisionWorktree).not.toHaveBeenCalled();
	});
});
