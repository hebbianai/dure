import { describe, expect, it } from "vitest";
import {
  planAgentWorktreeRemoval,
  type WorktreeAgent,
  type WorktreeProject,
} from "@/lib/scm/worktrees/worktreeRemoval";

const localProject: WorktreeProject = {
	id: "p1",
	path: "/w/app",
	kind: "local",
};
const sshProject: WorktreeProject = {
	id: "p2",
	path: "/srv/app",
	kind: "ssh",
	sshHostId: "h1",
};

const agent = (over: Partial<WorktreeAgent> = {}): WorktreeAgent => ({
  id: "agent-1",
  worktreePath: "/w/app/.worktrees/feature",
  branch: "agent/feature",
  projectId: "p1",
  sessionKind: "pty",
  ...over,
});

describe("planAgentWorktreeRemoval", () => {
  it("plans a local worktree removal", () => {
    expect(planAgentWorktreeRemoval(agent(), localProject)).toEqual({
      kind: "local",
      repo: "/w/app",
      wtPath: "/w/app/.worktrees/feature",
    });
  });

  it("plans an ssh worktree removal carrying the host", () => {
    expect(
      planAgentWorktreeRemoval(
				agent({
					sessionKind: "ssh",
					worktreePath: "/srv/app/.worktrees/x",
					projectId: "p2",
				}),
        sshProject,
      ),
		).toEqual({
			kind: "ssh",
			hostId: "h1",
			repo: "/srv/app",
			wtPath: "/srv/app/.worktrees/x",
		});
  });

  it("returns null for a no-worktree agent (branch empty, path is repo root)", () => {
    expect(
			planAgentWorktreeRemoval(
				agent({ branch: "", worktreePath: "/w/app" }),
				localProject,
			),
    ).toBeNull();
  });

  it("returns null when the worktree path equals the repo root even with a branch", () => {
		expect(
			planAgentWorktreeRemoval(
				agent({ worktreePath: "/w/app/" }),
				localProject,
			),
		).toBeNull();
  });

	it("returns null for equivalent Windows project-root spellings", () => {
		expect(
			planAgentWorktreeRemoval(agent({ worktreePath: "c:/repo/" }), {
				...localProject,
				path: "C:\\Repo",
			}),
		).toBeNull();
  });

	it.each([
        {
			project: { ...localProject, path: "/" },
			worktreePath: "/linked",
			expectedRepo: "/",
        },
		{
			project: { ...localProject, path: "C:/" },
			worktreePath: "C:/linked",
			expectedRepo: "C:/",
		},
		{
			project: { ...localProject, path: "\\\\server\\share\\" },
			worktreePath: "\\\\server\\share\\linked",
			expectedRepo: "\\\\server\\share\\",
		},
	])(
		"preserves repository roots in removal plans",
		({ project, worktreePath, expectedRepo }) => {
			expect(
				planAgentWorktreeRemoval(agent({ worktreePath }), project),
			).toMatchObject({
				repo: expectedRepo,
				wtPath: worktreePath,
  });
		},
    );

	it("returns null with no project", () => {
		expect(planAgentWorktreeRemoval(agent(), undefined)).toBeNull();
  });

	it("returns null when an SSH project has no registered host", () => {
		expect(
			planAgentWorktreeRemoval(agent({ sessionKind: "ssh", projectId: "p2" }), {
				...sshProject,
				sshHostId: undefined,
			}),
		).toBeNull();
  });
});
