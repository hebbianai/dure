import { describe, expect, it } from "vitest";
import {
  defaultBaseRef,
  defaultBranchName,
  planFromDialog,
  planWorktree,
  resolveMode,
  sanitizeSegment,
  worktreeDirName,
  type BranchInfo,
  type WorktreeDialogInput,
  type WorktreePlanInput,
  type WorktreeSummary,
} from "@/lib/scm/worktrees/worktreePlan";

function input(over: Partial<WorktreePlanInput>): WorktreePlanInput {
  return {
    repoPath: "/repo",
    agentName: "my-agent",
    branch: "agent/my-agent",
    mode: "new-branch",
    baseRef: "main",
    branches: [],
    worktrees: [],
    ...over,
  };
}

describe("sanitizeSegment / defaultBranchName / worktreeDirName", () => {
  it("keeps alnum/-/_ and replaces the rest with '-'", () => {
    expect(sanitizeSegment("feat/A B.c")).toBe("feat-A-B-c");
    expect(sanitizeSegment("한글_ok-1")).toBe("한글_ok-1");
  });

  it("derives agent/<sanitized-name> as the default branch", () => {
    expect(defaultBranchName("Refactor Auth")).toBe("agent/Refactor-Auth");
    expect(defaultBranchName("  spaced  ")).toBe("agent/spaced");
  });

  it("derives the worktree dir from the last branch segment", () => {
    expect(worktreeDirName("agent/refactor-auth")).toBe("refactor-auth");
    expect(worktreeDirName("main")).toBe("main");
    expect(worktreeDirName("feature/x/y")).toBe("y");
    // trailing slash / empty last segment falls back to the whole name
    expect(worktreeDirName("agent/")).toBe("agent");
  });
});

describe("planWorktree — new-branch", () => {
  it("plans a fresh branch from base at repo/.worktrees/<dir>", () => {
    const plan = planWorktree(input({ branch: "agent/foo", mode: "new-branch", baseRef: "main" }));
    expect(plan.action).toBe("create-new-branch");
    expect(plan.worktreePath).toBe("/repo/.worktrees/foo");
    expect(plan.baseRef).toBe("main");
    expect(plan.branchExists).toBe(false);
    expect(plan.blocker).toBeUndefined();
  });

  /** 시안 2256:29177의 '워크트리 위치'. 기본값을 바꾸지 않는 것이 계약의
   *  절반이다 — 기본이 움직이면 기존 레포의 워크트리가 두 곳으로 갈린다. */
  it("워크트리 루트를 바꿔 담을 수 있고, 생략하면 기존 .worktrees/ 그대로다", () => {
    const custom = planWorktree(
      input({
        branch: "agent/foo",
        mode: "new-branch",
        baseRef: "main",
        worktreeRoot: ".claude/worktrees/",
      }),
    );
    expect(custom.worktreePath).toBe("/repo/.claude/worktrees/foo");

    const omitted = planWorktree(
      input({ branch: "agent/foo", mode: "new-branch", baseRef: "main" }),
    );
    expect(omitted.worktreePath).toBe("/repo/.worktrees/foo");
  });

  it("루트의 앞뒤 슬래시를 정규화해 경로가 겹치지 않는다", () => {
    for (const root of ["/wt/", "wt", "/wt"]) {
      const plan = planWorktree(
        input({ branch: "agent/foo", mode: "new-branch", baseRef: "main", worktreeRoot: root }),
      );
      expect(plan.worktreePath, `root=${root}`).toBe("/repo/wt/foo");
    }
  });

  it("blocks empty branch names", () => {
    const plan = planWorktree(input({ branch: "   " }));
    expect(plan.blocker).toEqual({ kind: "empty-branch" });
  });

  it("blocks when the new branch name already exists", () => {
    const plan = planWorktree(
      input({ branch: "agent/foo", mode: "new-branch", branches: [{ name: "agent/foo" }] }),
    );
    expect(plan.branchExists).toBe(true);
    expect(plan.blocker).toEqual({ kind: "branch-exists", branch: "agent/foo" });
  });

  it("routes a linked checkout at the derived path to explicit selection", () => {
    const plan = planWorktree(
      input({
        branch: "agent/foo",
        mode: "new-branch",
        worktrees: [{ path: "/repo/.worktrees/foo", branch: "other/branch", isMain: false }],
      }),
    );
    expect(plan.pathCollision?.branch).toBe("other/branch");
    expect(plan.blocker).toEqual({
      kind: "existing-worktree-requires-explicit-selection",
      path: "/repo/.worktrees/foo",
    });
  });

  it("does not offer the primary checkout as an existing-worktree collision", () => {
    const plan = planWorktree(
      input({
        branch: "agent/foo",
        mode: "new-branch",
        worktrees: [{ path: "/repo/.worktrees/foo", branch: "main", isMain: true }],
      }),
    );
    expect(plan.blocker).toEqual({
      kind: "worktree-path-taken",
      path: "/repo/.worktrees/foo",
      occupiedBy: "main",
    });
  });

  it("does not baseRef when in existing mode", () => {
    const plan = planWorktree(
      input({ branch: "agent/x", mode: "existing-branch", branches: [{ name: "agent/x" }] }),
    );
    expect(plan.baseRef).toBeUndefined();
  });
});

describe("planWorktree — existing-branch", () => {
  it("checks out an existing branch into a new worktree when it is not checked out anywhere", () => {
    const plan = planWorktree(
      input({ branch: "agent/foo", mode: "existing-branch", branches: [{ name: "agent/foo" }] }),
    );
    expect(plan.action).toBe("checkout-existing-branch");
    expect(plan.worktreePath).toBe("/repo/.worktrees/foo");
    expect(plan.blocker).toBeUndefined();
  });

  it("blocks when the chosen existing branch does not exist", () => {
    const plan = planWorktree(input({ branch: "agent/ghost", mode: "existing-branch" }));
    expect(plan.blocker).toEqual({ kind: "no-such-branch", branch: "agent/ghost" });
  });

  it("requires explicit selection when the branch is already checked out in a linked worktree", () => {
    const wt = { path: "/repo/.worktrees/refactor-auth", branch: "agent/refactor-auth", isMain: false };
    const plan = planWorktree(
      input({
        branch: "agent/refactor-auth",
        mode: "existing-branch",
        branches: [{ name: "agent/refactor-auth", checkedOutAt: wt.path }],
        worktrees: [wt],
      }),
    );
    expect(plan.action).toBe("checkout-existing-branch");
    expect(plan.adoptable).toEqual(wt);
    expect(plan.worktreePath).toBe(wt.path);
    expect(plan.blocker).toEqual({
      kind: "existing-worktree-requires-explicit-selection",
      path: wt.path,
    });
  });

  it("also requires explicit selection when only the worktree list proves checkout", () => {
    const wt = { path: "/repo/.worktrees/foo", branch: "agent/foo", isMain: false };
    const plan = planWorktree(
      input({
        branch: "agent/foo",
        mode: "existing-branch",
        branches: [{ name: "agent/foo" }],
        worktrees: [wt],
      }),
    );
    expect(plan.action).toBe("checkout-existing-branch");
    expect(plan.adoptable).toEqual(wt);
    expect(plan.blocker?.kind).toBe("existing-worktree-requires-explicit-selection");
  });

  it("routes checkout path collisions to explicit linked-worktree selection", () => {
    const plan = planWorktree(
      input({
        branch: "agent/foo",
        mode: "existing-branch",
        branches: [{ name: "agent/foo" }],
        // agent/foo is not checked out, but the path we'd use is occupied by another
        worktrees: [{ path: "/repo/.worktrees/foo", branch: "agent/bar", isMain: false }],
      }),
    );
    expect(plan.blocker).toEqual({
      kind: "existing-worktree-requires-explicit-selection",
      path: "/repo/.worktrees/foo",
    });
  });

  it("never adopts the primary (main) checkout — blocks isolation instead", () => {
    // Regression: picking the main branch would have adopted the repo root,
    // running the agent in the user's primary working tree (no isolation).
    const plan = planWorktree(
      input({
        branch: "main",
        mode: "existing-branch",
        branches: [{ name: "main", checkedOutAt: "/repo" }],
        worktrees: [{ path: "/repo", branch: "main", isMain: true }],
      }),
    );
    expect(plan.action).not.toBe("adopt-worktree");
    expect(plan.adoptable).toBeUndefined();
    expect(plan.blocker).toEqual({ kind: "branch-in-main-worktree", branch: "main" });
  });
});

function dialogInput(over: Partial<WorktreeDialogInput>): WorktreeDialogInput {
  return {
    repoPath: "/repo",
    agentName: "my-agent",
    branchInput: "",
    modeChoice: "auto",
    baseRef: "main",
    branches: [],
    worktrees: [],
    loaded: true,
    ...over,
  };
}

describe("resolveMode / defaultBaseRef", () => {
  it("auto resolves by branch existence; explicit passes through", () => {
    const branches: BranchInfo[] = [{ name: "agent/x" }];
    expect(resolveMode("auto", "agent/x", branches)).toBe("existing-branch");
    expect(resolveMode("auto", "agent/new", branches)).toBe("new-branch");
    expect(resolveMode("new-branch", "agent/x", branches)).toBe("new-branch");
    expect(resolveMode("existing-branch", "agent/new", branches)).toBe("existing-branch");
  });

  it("defaultBaseRef prefers main worktree branch, then main/master, then HEAD", () => {
    const branches: BranchInfo[] = [{ name: "trunk" }, { name: "main" }, { name: "master" }];
    const wts: WorktreeSummary[] = [{ path: "/repo", branch: "trunk", isMain: true }];
    expect(defaultBaseRef(wts, branches)).toBe("trunk");
    expect(defaultBaseRef([], branches)).toBe("main");
    expect(defaultBaseRef([], [{ name: "master" }])).toBe("master");
    expect(defaultBaseRef([], [{ name: "feature" }])).toBe("HEAD");
    // detached main worktree is skipped
    expect(
      defaultBaseRef([{ path: "/r", branch: "(detached)", isMain: true }], [{ name: "main" }]),
    ).toBe("main");
  });
});

describe("planFromDialog", () => {
  it("auto flips to existing-branch when the typed branch exists", () => {
    const view = planFromDialog(
      dialogInput({ branchInput: "agent/x", branches: [{ name: "agent/x" }] }),
    );
    expect(view.resolvedMode).toBe("existing-branch");
    expect(view.autoResolved).toBe(true);
  });

  it("auto stays new-branch for an unknown name and shows the base selector", () => {
    const view = planFromDialog(dialogInput({ branchInput: "agent/brand-new" }));
    expect(view.resolvedMode).toBe("new-branch");
    expect(view.showBaseRef).toBe(true);
    expect(view.action).toBe("create-new-branch");
    expect(view.canStart).toBe(true);
  });

  it("an existing linked worktree is blocked until chosen by the exact selector", () => {
    const wt = { path: "/repo/.worktrees/refactor", branch: "agent/refactor", isMain: false };
    const view = planFromDialog(
      dialogInput({
        branchInput: "agent/refactor",
        modeChoice: "existing-branch",
        branches: [{ name: "agent/refactor", checkedOutAt: wt.path }],
        worktrees: [wt],
      }),
    );
    expect(view.action).toBe("checkout-existing-branch");
    expect(view.banner?.kind).toBe("explicit-existing");
    expect(view.banner?.adoptPath).toBe(wt.path);
    expect(view.plan.worktreePath).toBe(wt.path);
    expect(view.canStart).toBe(false);
    expect(view.startLabel).toBe("에이전트 시작");
  });

  it("new-branch on an existing branch name is blocked with a rename-able banner", () => {
    const view = planFromDialog(
      dialogInput({
        branchInput: "agent/x",
        modeChoice: "new-branch",
        branches: [{ name: "agent/x" }],
      }),
    );
    expect(view.banner?.kind).toBe("branch-exists");
    expect(view.banner?.canRename).toBe(true);
    expect(view.canStart).toBe(false);
  });

  it("existing-branch on a missing branch is blocked and not rename-able", () => {
    const view = planFromDialog(
      dialogInput({ branchInput: "agent/ghost", modeChoice: "existing-branch" }),
    );
    expect(view.banner?.kind).toBe("no-such-branch");
    expect(view.banner?.canRename).toBe(false);
    expect(view.canStart).toBe(false);
  });

  it("path collision from a different linked branch offers the exact existing selector", () => {
    const view = planFromDialog(
      dialogInput({
        branchInput: "agent/foo",
        modeChoice: "new-branch",
        worktrees: [{ path: "/repo/.worktrees/foo", branch: "agent/bar", isMain: false }],
      }),
    );
    expect(view.banner?.kind).toBe("explicit-existing");
    expect(view.banner?.adoptPath).toBe("/repo/.worktrees/foo");
    expect(view.canStart).toBe(false);
  });

  it("orders adoptable branches first and prefix-filters branchOptions", () => {
    const view = planFromDialog(
      dialogInput({
        branchInput: "agent/",
        branches: [{ name: "agent/a" }, { name: "agent/b" }, { name: "other" }],
        worktrees: [{ path: "/repo/.worktrees/b", branch: "agent/b", isMain: false }],
      }),
    );
    // "other" filtered out by the "agent/" prefix; adoptable "agent/b" hoisted first
    expect(view.branchOptions).toEqual(["agent/b", "agent/a"]);
  });

  it("blocks start until the lists are loaded even for a clean plan", () => {
    const view = planFromDialog(dialogInput({ branchInput: "agent/brand-new", loaded: false }));
    expect(view.plan.blocker).toBeUndefined();
    expect(view.canStart).toBe(false);
  });

  it("falls back to the default branch name when the input is empty", () => {
    const view = planFromDialog(dialogInput({ agentName: "cool agent", branchInput: "" }));
    expect(view.effectiveBranch).toBe("agent/cool-agent");
  });

  it("blocks selecting the primary checkout's branch (no isolation, not adoptable)", () => {
    const view = planFromDialog(
      dialogInput({
        branchInput: "main",
        branches: [{ name: "main", checkedOutAt: "/repo" }],
        worktrees: [{ path: "/repo", branch: "main", isMain: true }],
      }),
    );
    expect(view.action).not.toBe("adopt-worktree");
    expect(view.banner?.kind).toBe("path-taken");
    expect(view.banner?.severity).toBe("error");
    expect(view.canStart).toBe(false);
  });
});
