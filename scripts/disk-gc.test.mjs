import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  DISK_GC_HELP,
  diskGcExitCode,
  main,
  publicDiskGcReport,
  runDiskGcCli,
} from "./disk-gc.mjs";

const report = (overrides = {}) => ({
  applied: true,
  refused: [],
  removed: [],
  satisfied: true,
  plan: { selected: [] },
  ...overrides,
});

describe("disk GC CLI contract", () => {
  it.skipIf(
    process.platform !== "darwin" && process.platform !== "linux",
  )("enters background priority before observation and descendants", () => {
    const moduleUrl = new URL("./disk-gc.mjs", import.meta.url).href;
    const descendantProbe =
      'import { getPriority } from "node:os"; process.stdout.write(String(getPriority()));';
    const probe = `
import { spawnSync } from "node:child_process";
import { getPriority } from "node:os";
import { runDiskGcCli } from ${JSON.stringify(moduleUrl)};
const observations = [];
let forwardedArguments;
const status = runDiskGcCli(["--status"], {
  execute: (arguments_) => {
    forwardedArguments = arguments_;
    observations.push({ stage: "observation", priority: getPriority() });
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", ${JSON.stringify(descendantProbe)}],
      { encoding: "utf8" },
    );
    if (child.status !== 0) throw child.error ?? new Error(child.stderr);
    observations.push({
      stage: "descendant",
      priority: Number(child.stdout.trim()),
    });
    return 0;
  },
});
process.stdout.write(JSON.stringify({
  parentPriority: getPriority(process.ppid),
  runnerPriority: getPriority(),
  forwardedArguments,
  observations,
  status,
}));
`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", probe],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);

    expect(receipt.status).toBe(0);
    expect(receipt.forwardedArguments).toEqual(["--status"]);
    expect(receipt.observations.map(({ stage }) => stage)).toEqual([
      "observation",
      "descendant",
    ]);
    const expectedPriority = Math.max(15, receipt.parentPriority);
    expect(receipt.runnerPriority).toBe(expectedPriority);
    expect(
      receipt.observations.every(
        ({ priority }) => priority === expectedPriority,
      ),
    ).toBe(true);
  });

  it("documents the exact non-worktree destructive boundary", () => {
    expect(DISK_GC_HELP).toContain("--worktree <absolute path>");
    expect(DISK_GC_HELP).toMatch(/one exact\s+registered Git worktree/);
    expect(DISK_GC_HELP).toMatch(/never removes Git worktrees/i);
    expect(DISK_GC_HELP).toMatch(/does not override live activity/i);
  });

  it("fails closed with a JSON receipt for an invalid scope", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(main(["--worktree", "relative/path", "--json"])).toBe(2);
      expect(JSON.parse(output.mock.calls[0][0])).toEqual({
        applied: false,
        error: {
          code: "invalid-worktree-scope",
          message: "--worktree requires one absolute path",
        },
        scope: { kind: "worktree", requestedPath: "relative/path" },
      });
    } finally {
      output.mockRestore();
    }
  });

  it("returns failure when an applied plan is incomplete", () => {
    expect(diskGcExitCode(report({ satisfied: false }))).toBe(1);
    expect(
      diskGcExitCode(report({ refused: [{ path: "/repo", reason: "busy" }] })),
    ).toBe(1);
    expect(diskGcExitCode(report({ applied: false, satisfied: false }))).toBe(0);
  });

  it("keeps automation fields while hiding transaction internals", () => {
    const entry = {
      bytes: 42,
      kind: "recovery",
      lifecycle: "removing",
      path: "/repo/hmux/target",
      storagePath: "/repo/.dure-reclaim/id/target",
      tier: "recovery",
      transaction: "/repo/.dure-reclaim/id",
      worktree: "/repo",
    };
    const value = publicDiskGcReport(
      report({
        plan: { selected: [entry] },
        removed: [entry],
        refused: [
          {
            detail: "failed at /repo/.dure-reclaim/id/target",
            path: "/repo/hmux/target",
            reason: "remove-failed",
          },
        ],
        skipped: [
          {
            detail: "bad /repo/.dure-reclaim/id",
            kind: "recovery",
            reason: "reclaim-residue-conflict",
            worktree: "/repo",
          },
        ],
      }),
    );

    expect(value.plan.selected).toEqual([
      {
        bytes: 42,
        kind: "recovery",
        lifecycle: "removing",
        path: "/repo/hmux/target",
        tier: "recovery",
      },
    ]);
    expect(value.removed[0]).toMatchObject({
      path: "/repo/hmux/target",
      worktree: "/repo",
    });
    expect(value.refused).toEqual([
      { path: "/repo/hmux/target", reason: "remove-failed" },
    ]);
    expect(value.skipped).toEqual([
      {
        kind: "recovery",
        reason: "reclaim-residue-conflict",
        worktree: "/repo",
      },
    ]);
    expect(JSON.stringify(value)).not.toContain(".dure-reclaim");
  });

  it("keeps the exact worktree scope in the public receipt", () => {
    const value = publicDiskGcReport(
      report({
        scope: { kind: "worktree", path: "/repo/.worktrees/alice" },
        skipped: [],
      }),
    );

    expect(value.scope).toEqual({
      kind: "worktree",
      path: "/repo/.worktrees/alice",
    });
  });
});
