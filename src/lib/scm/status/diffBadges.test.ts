import { describe, expect, it } from "vitest";
import {
  badgeFromFiles,
  badgeFromStat,
  type DiffBadge,
  hasChanges,
  normalizeDiffBadge,
  sameBadge,
} from "@/lib/scm/status/diffBadges";

const fullBadge = (overrides: Partial<DiffBadge> = {}): DiffBadge => ({
  added: 1,
  deleted: 2,
  binary: 0,
  files: 3,
  committed: { added: 1, deleted: 1, binary: 0, files: 2 },
  worktree: { added: 0, deleted: 1, binary: 0, files: 1 },
  ahead: 1,
  behind: 4,
  ...overrides,
});

describe("badgeFromFiles", () => {
  it("sums counts and tracks binary/file counts", () => {
    expect(
      badgeFromFiles([
        { added: 3, deleted: 1 },
        { added: 2, deleted: 0 },
        { added: null, deleted: null },
      ]),
    ).toEqual({ added: 5, deleted: 1, binary: 1, files: 3 });
  });

  it("returns a zero badge for an empty diff", () => {
    expect(badgeFromFiles([])).toEqual({ added: 0, deleted: 0, binary: 0, files: 0 });
  });
});

describe("hasChanges", () => {
  it("hides zero and missing badges, shows any change", () => {
    expect(hasChanges(undefined)).toBe(false);
    expect(hasChanges(null)).toBe(false);
    expect(hasChanges({ added: 0, deleted: 0, binary: 0, files: 0 })).toBe(false);
    expect(hasChanges({ added: 0, deleted: 0, binary: 1, files: 1 })).toBe(true);
    expect(hasChanges({ added: 1, deleted: 0, binary: 0, files: 1 })).toBe(true);
  });
});

describe("badgeFromStat", () => {
  it("separates committed work, local WIP, and branch divergence", () => {
    expect(
      badgeFromStat({
        baseRef: "origin/main",
        mergeBase: "base",
        files: [
          { path: "task.ts", oldPath: null, added: 4, deleted: 1, status: "M" },
          { path: "wip.ts", oldPath: null, added: 2, deleted: 0, status: "A" },
        ],
        committedFiles: [
          { path: "task.ts", oldPath: null, added: 4, deleted: 1, status: "M" },
        ],
        worktreeFiles: [
          { path: "wip.ts", oldPath: null, added: 2, deleted: 0, status: "A" },
        ],
        ahead: 2,
        behind: 7,
      }),
    ).toEqual({
      added: 6,
      deleted: 1,
      binary: 0,
      files: 2,
      committed: { added: 4, deleted: 1, binary: 0, files: 1 },
      worktree: { added: 2, deleted: 0, binary: 0, files: 1 },
      ahead: 2,
      behind: 7,
    });
  });

  it("falls back safely while an older backend is still attached", () => {
    expect(
      badgeFromStat({
        baseRef: "main",
        mergeBase: "base",
        files: [
          { path: "legacy.ts", oldPath: null, added: 1, deleted: 0, status: "M" },
        ],
      }),
    ).toEqual({
      added: 1,
      deleted: 0,
      binary: 0,
      files: 1,
      committed: { added: 1, deleted: 0, binary: 0, files: 1 },
      worktree: { added: 0, deleted: 0, binary: 0, files: 0 },
      ahead: 0,
      behind: 0,
    });
  });
});

describe("normalizeDiffBadge", () => {
  it("keeps a flat pre-upgrade HMR badge readable until the next poll", () => {
    expect(
      normalizeDiffBadge({ added: 3, deleted: 1, binary: 0, files: 2 }),
    ).toEqual({
      added: 3,
      deleted: 1,
      binary: 0,
      files: 2,
      committed: { added: 3, deleted: 1, binary: 0, files: 2 },
      worktree: { added: 0, deleted: 0, binary: 0, files: 0 },
      ahead: 0,
      behind: 0,
    });
  });
});

describe("sameBadge", () => {
  const b = fullBadge();
  it("compares by value", () => {
    expect(
      sameBadge(
        {
          ...b,
          committed: { ...b.committed },
          worktree: { ...b.worktree },
        },
        b,
      ),
    ).toBe(true);
    expect(sameBadge(undefined, b)).toBe(false);
    expect(sameBadge({ ...b, added: 9 }, b)).toBe(false);
    expect(
      sameBadge(
        { ...b, worktree: { ...b.worktree, files: b.worktree.files + 1 } },
        b,
      ),
    ).toBe(false);
  });
});
