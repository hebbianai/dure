import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  parseGitWorktreePorcelain,
  readGitWorktreeInventory,
} from "./worktree-inventory.mjs";

const SHA = "a".repeat(40);

describe("Git worktree inventory", () => {
  it("normalizes lifecycle facts without reinterpreting checkout state", () => {
    const entries = parseGitWorktreePorcelain(
      Buffer.from(
        [
          `worktree /repo\nlinked\0HEAD ${SHA}\0detached\0locked maintenance\nwindow\0prunable missing gitdir\0\0`,
          "worktree /bare\0bare\0\0",
          `worktree /repo/trailing \0HEAD ${SHA}\0branch refs/heads/main\0locked\0prunable missing\nmetadata\0\0`,
        ].join(""),
      ),
    );

    expect(entries).toEqual([
      {
        path: "/repo\nlinked",
        locked: { reason: "maintenance\nwindow" },
        prunable: { reason: "missing gitdir" },
      },
      {
        path: "/bare",
        locked: null,
        prunable: null,
      },
      {
        path: "/repo/trailing ",
        locked: { reason: null },
        prunable: { reason: "missing\nmetadata" },
      },
    ]);
  });

  it("fails closed on empty, truncated, invalid, and duplicate identity output", () => {
    expect(() => parseGitWorktreePorcelain("")).toThrow("no records");
    expect(() => parseGitWorktreePorcelain("\0\0")).toThrow("no records");
    expect(() =>
      parseGitWorktreePorcelain(`worktree /repo\0HEAD ${SHA}\0detached\0`),
    ).toThrow("ended inside a record");
    expect(() =>
      parseGitWorktreePorcelain(Buffer.from([0xff, 0x00, 0x00])),
    ).toThrow();
    expect(() =>
      parseGitWorktreePorcelain(
        `worktree /repo\0HEAD ${SHA}\0detached\0\0worktree /repo\0HEAD ${SHA}\0detached\0\0`,
      ),
    ).toThrow("duplicate path");
  });

  it("ignores checkout and future attributes outside its lifecycle contract", () => {
    const [entry] = parseGitWorktreePorcelain(
      `worktree /repo\0HEAD not-a-fixed-width-hash\0branch refs/heads/main\0detached\0future value\0\0`,
    );
    expect(entry).toEqual({ path: "/repo", locked: null, prunable: null });
  });

  it("owns the bounded Git invocation and strips ambient repository selectors", () => {
    const calls = [];
    const entries = readGitWorktreeInventory("/repo", {
      environment: { GIT_DIR: "/wrong", PATH: "/bin" },
      execute: (command, arguments_, options) => {
        calls.push({ command, arguments_, options });
        return `worktree /repo\0HEAD ${SHA}\0branch refs/heads/main\0\0`;
      },
    });

    expect(entries).toEqual([
      { path: "/repo", locked: null, prunable: null },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "git",
      arguments_: [
        "-C",
        "/repo",
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ],
    });
    expect(calls[0].options.env).not.toHaveProperty("GIT_DIR");
  });

  it("propagates command-level census failures", () => {
    expect(() =>
      readGitWorktreeInventory("/repo", {
        execute: () => {
          throw new Error("stdout maxBuffer length exceeded");
        },
      }),
    ).toThrow("maxBuffer");
  });

  it("admits a complete census delayed by a loaded many-worktree host", () => {
    const payload = `worktree /repo\0HEAD ${SHA}\0branch refs/heads/main\0\0`;
    const entries = readGitWorktreeInventory("/repo", {
      execute: (_command, _arguments, options) =>
        execFileSync(
          process.execPath,
          [
            "--eval",
            `setTimeout(() => process.stdout.write(${JSON.stringify(payload)}), 6000)`,
          ],
          options,
        ),
    });
    expect(entries).toEqual([{ path: "/repo", locked: null, prunable: null }]);
  });
});
