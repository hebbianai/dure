import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLiveDevWorktree } from "./dev-live-worktree.mjs";

describe("resolveLiveDevWorktree", () => {
  let root;
  let live;
  let other;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dure-live-worktree-"));
    live = join(root, "live");
    other = join(root, "other");
    mkdirSync(live);
    mkdirSync(other);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("canonicalizes the explicit path and gives it precedence", () => {
    expect(
      resolveLiveDevWorktree({
        explicitPath: join(other, "..", "live"),
        environment: {
          DURE_DEV_LIVE_WORKTREE: other,
          HEBBIAN_DEV_WORKTREE: other,
        },
      }),
    ).toBe(realpathSync(live));
  });

  it("prefers the canonical environment over the legacy variable", () => {
    expect(
      resolveLiveDevWorktree({
        environment: {
          DURE_DEV_LIVE_WORKTREE: live,
          HEBBIAN_DEV_WORKTREE: other,
        },
      }),
    ).toBe(realpathSync(live));
  });

  it("rejects the legacy variable as the only selector", () => {
    expect(() =>
      resolveLiveDevWorktree({
        environment: { HEBBIAN_DEV_WORKTREE: live },
      }),
    ).toThrow(/HEBBIAN_DEV_WORKTREE is ambiguous/);
  });

  it("requires one canonical selector", () => {
    expect(() => resolveLiveDevWorktree({ environment: {} })).toThrow(
      /live dev worktree is required/,
    );
  });
});
