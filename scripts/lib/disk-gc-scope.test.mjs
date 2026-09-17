import { describe, expect, it, vi } from "vitest";
import {
  DiskGcScopeError,
  parseWorktreeScope,
  selectRegisteredWorktrees,
} from "./disk-gc-scope.mjs";

describe("disk GC worktree scope", () => {
  it("requires one absolute path before canonicalization", () => {
    const canonicalize = vi.fn();

    expect(() =>
      parseWorktreeScope(["--worktree", "relative/path"], { canonicalize }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid-worktree-scope",
      }),
    );
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("canonicalizes the requested path exactly once", () => {
    const canonicalize = vi.fn(() => "/repo/.worktrees/alice");

    expect(
      parseWorktreeScope(["--worktree=/repo/link/alice"], { canonicalize }),
    ).toBe("/repo/.worktrees/alice");
    expect(canonicalize).toHaveBeenCalledOnce();
    expect(canonicalize).toHaveBeenCalledWith("/repo/link/alice");
  });

  it("rejects an unregistered path instead of matching a prefix", () => {
    expect(() =>
      selectRegisteredWorktrees(
        ["/repo", "/repo/.worktrees/alice"],
        "/repo/.worktrees/alice/hmux",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "unregistered-worktree-scope",
      }),
    );
  });

  it("selects only the exact registered worktree", () => {
    expect(
      selectRegisteredWorktrees(
        ["/repo", "/repo/.worktrees/alice", "/repo/.worktrees/bob"],
        "/repo/.worktrees/alice",
      ),
    ).toEqual(["/repo/.worktrees/alice"]);
  });

  it("preserves repository-wide behavior when no scope was requested", () => {
    const worktrees = ["/repo", "/repo/.worktrees/alice"];
    expect(selectRegisteredWorktrees(worktrees, null)).toEqual(worktrees);
  });

  it("uses a typed scope error", () => {
    const error = new DiskGcScopeError("test", "message", "/repo");
    expect(error).toMatchObject({
      code: "test",
      message: "message",
      name: "DiskGcScopeError",
      path: "/repo",
    });
  });
});
