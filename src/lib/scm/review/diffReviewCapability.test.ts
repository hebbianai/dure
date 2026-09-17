import { describe, expect, it, vi } from "vitest";
import {
  DiffReviewCapabilityCache,
  diffReviewCapabilityFromGitProbe,
  localStandaloneDiffCwd,
} from "@/lib/scm/review/diffReviewCapability";

describe("localStandaloneDiffCwd", () => {
  it("accepts only exact local terminal cwd values", () => {
    expect(
      localStandaloneDiffCwd({
        kind: "term",
        cwd: "/repo/worktree ",
      }),
    ).toBe("/repo/worktree ");
    expect(
      localStandaloneDiffCwd({
        kind: "term",
        cwd: "/repo/worktree",
        hostId: "ssh-host",
      }),
    ).toBeUndefined();
    expect(
      localStandaloneDiffCwd({
        kind: "agent",
        cwd: "/repo/worktree",
      }),
    ).toBeUndefined();
    expect(localStandaloneDiffCwd({ kind: "term", cwd: "  " })).toBeUndefined();
  });
});

describe("diffReviewCapabilityFromGitProbe", () => {
  it("accepts a Git root while preserving legitimate trailing path spaces", () => {
    expect(
      diffReviewCapabilityFromGitProbe({
        code: 0,
        stdout: "/repo/worktree \r\n",
      }),
    ).toEqual({
      status: "available",
      worktreePath: "/repo/worktree ",
    });
  });

  it("fails closed for Git failures and empty output", () => {
    expect(diffReviewCapabilityFromGitProbe({ code: 128, stdout: "" })).toEqual({
      status: "unavailable",
    });
    expect(diffReviewCapabilityFromGitProbe({ code: 0, stdout: "\n" })).toEqual({
      status: "unavailable",
    });
  });
});

describe("DiffReviewCapabilityCache", () => {
  it("deduplicates concurrent probes for the same cwd", async () => {
    let resolveProbe:
      | ((value: { status: "available"; worktreePath: string }) => void)
      | undefined;
    const run = vi.fn(
      () =>
        new Promise<{ status: "available"; worktreePath: string }>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const cache = new DiffReviewCapabilityCache();

    const first = cache.probe("/repo/subdir", run);
    const second = cache.probe("/repo/subdir", run);
    expect(run).toHaveBeenCalledOnce();

    resolveProbe?.({ status: "available", worktreePath: "/repo" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "available", worktreePath: "/repo" },
      { status: "available", worktreePath: "/repo" },
    ]);
  });

  it("keeps late results attached only to their exact cwd", async () => {
    let resolveOld:
      | ((value: { status: "available"; worktreePath: string }) => void)
      | undefined;
    const cache = new DiffReviewCapabilityCache();
    const old = cache.probe(
      "/old/repo",
      () =>
        new Promise<{ status: "available"; worktreePath: string }>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await cache.probe("/new/not-a-repo", async () => ({ status: "unavailable" }));

    expect(cache.read("/new/not-a-repo")).toEqual({ status: "unavailable" });
    expect(cache.read("/old/repo")).toBeUndefined();

    resolveOld?.({ status: "available", worktreePath: "/old/repo" });
    await old;

    expect(cache.read("/old/repo")).toEqual({
      status: "available",
      worktreePath: "/old/repo",
    });
    expect(cache.read("/new/not-a-repo")).toEqual({ status: "unavailable" });
  });

  it("expires stale results and bounds cwd history with LRU eviction", async () => {
    let now = 100;
    const cache = new DiffReviewCapabilityCache({
      maxEntries: 2,
      ttlMs: 10,
      now: () => now,
    });
    const run = vi.fn(async (cwd: string) => ({
      status: "available" as const,
      worktreePath: cwd,
    }));

    await cache.probe("/one", run);
    await cache.probe("/two", run);
    expect(cache.read("/one")).toEqual({ status: "available", worktreePath: "/one" });
    await cache.probe("/three", run);
    expect(cache.read("/two")).toBeUndefined();

    now = 111;
    expect(cache.read("/one")).toBeUndefined();
    await cache.probe("/one", run);
    expect(run).toHaveBeenCalledTimes(4);
  });
});
