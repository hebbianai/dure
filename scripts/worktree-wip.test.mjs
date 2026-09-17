import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  checkpointWorktree,
  restoreWorktree,
  syncWorktree,
  WorktreeWipError,
} from "./lib/worktree-wip.mjs";

const syncCli = path.resolve("scripts/sync-worktree.mjs");
const wipCli = path.resolve("scripts/worktree-wip.mjs");
const temporaryDirectories = [];

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
    input: options.input,
  });
  if (options.allowFailure !== true) {
    expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
  }
  return result;
}

function runNode(cwd, script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
  });
}

function write(root, relative, content) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function commit(cwd, message) {
  runGit(cwd, ["add", "."]);
  runGit(cwd, [
    "-c",
    "user.name=abko-test",
    "-c",
    "user.email=abko-test@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
}

function createRepository() {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "worktree-wip-test-"),
  );
  temporaryDirectories.push(temporary);
  const repository = path.join(temporary, "repository");
  const first = path.join(temporary, "first");
  const second = path.join(temporary, "second");
  fs.mkdirSync(repository);
  runGit(repository, ["init", "--quiet", "-b", "main"]);
  runGit(repository, ["config", "user.name", "abko-test"]);
  runGit(repository, ["config", "user.email", "abko-test@example.test"]);
  runGit(repository, ["config", "commit.gpgSign", "false"]);
  for (const file of [
    "first-staged.txt",
    "first-unstaged.txt",
    "second-staged.txt",
    "second-unstaged.txt",
  ]) {
    write(repository, file, `base:${file}\n`);
  }
  write(repository, "upstream.txt", "base\n");
  commit(repository, "initial");
  runGit(repository, ["worktree", "add", "--quiet", "-b", "first", first]);
  runGit(repository, ["worktree", "add", "--quiet", "-b", "second", second]);
  return { first, repository, second, temporary };
}

function makeWip(root, owner) {
  write(root, `${owner}-staged.txt`, `${owner}:staged\n`);
  runGit(root, ["add", `${owner}-staged.txt`]);
  write(root, `${owner}-unstaged.txt`, `${owner}:unstaged\n`);
  write(root, `${owner}-untracked.txt`, `${owner}:untracked\n`);
}

function expectWip(root, owner) {
  expect(fs.readFileSync(path.join(root, `${owner}-staged.txt`), "utf8")).toBe(
    `${owner}:staged\n`,
  );
  expect(
    fs.readFileSync(path.join(root, `${owner}-unstaged.txt`), "utf8"),
  ).toBe(`${owner}:unstaged\n`);
  expect(
    fs.readFileSync(path.join(root, `${owner}-untracked.txt`), "utf8"),
  ).toBe(`${owner}:untracked\n`);
  expect(
    runGit(root, ["diff", "--cached", "--name-only"]).stdout.trim(),
  ).toBe(`${owner}-staged.txt`);
  expect(runGit(root, ["diff", "--name-only"]).stdout.trim()).toBe(
    `${owner}-unstaged.txt`,
  );
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("owner-scoped worktree WIP checkpoints", { timeout: 30_000 }, () => {
  test("reproduces the original shared stash-pop WIP exchange", () => {
    const fixture = createRepository();
    makeWip(fixture.first, "first");
    runGit(fixture.first, [
      "stash",
      "push",
      "--include-untracked",
      "--message",
      "first WIP",
    ]);
    makeWip(fixture.second, "second");
    runGit(fixture.second, [
      "stash",
      "push",
      "--include-untracked",
      "--message",
      "second WIP",
    ]);

    runGit(fixture.first, ["stash", "pop"]);

    expect(
      fs.readFileSync(
        path.join(fixture.first, "second-unstaged.txt"),
        "utf8",
      ),
    ).toBe("second:unstaged\n");
    expect(
      fs.readFileSync(
        path.join(fixture.first, "second-untracked.txt"),
        "utf8",
      ),
    ).toBe("second:untracked\n");
    expect(fs.existsSync(path.join(fixture.first, "first-untracked.txt"))).toBe(
      false,
    );
    expect(
      runGit(fixture.repository, ["stash", "list"]).stdout.trim(),
    ).toContain("first WIP");
  });

  test("interleaves linked-worktree syncs without exchanging WIP or touching refs/stash", async () => {
    const fixture = createRepository();
    write(fixture.repository, "shared-stash-seed.txt", "shared stash\n");
    runGit(fixture.repository, [
      "stash",
      "push",
      "--include-untracked",
      "--message",
      "shared stack sentinel",
    ]);
    const sharedStash = runGit(fixture.repository, [
      "rev-parse",
      "refs/stash",
    ]).stdout.trim();
    write(fixture.repository, "upstream.txt", "updated upstream\n");
    commit(fixture.repository, "upstream");

    makeWip(fixture.first, "first");
    makeWip(fixture.second, "second");
    const firstPaused = deferred();
    const secondPaused = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    let firstCheckpoint;
    let secondCheckpoint;

    const firstSync = syncWorktree({
      afterCheckpoint: async (checkpoint) => {
        firstCheckpoint = checkpoint;
        firstPaused.resolve();
        await releaseFirst.promise;
      },
      cwd: fixture.first,
      fetch: false,
      target: "main",
    });
    await firstPaused.promise;

    const secondSync = syncWorktree({
      afterCheckpoint: async (checkpoint) => {
        secondCheckpoint = checkpoint;
        secondPaused.resolve();
        await releaseSecond.promise;
      },
      cwd: fixture.second,
      fetch: false,
      target: "main",
    });
    await secondPaused.promise;

    expect(firstCheckpoint.ref).not.toBe(secondCheckpoint.ref);
    expect(runGit(fixture.first, ["status", "--porcelain"]).stdout).toBe("");
    expect(runGit(fixture.second, ["status", "--porcelain"]).stdout).toBe("");
    expect(
      runGit(fixture.repository, ["rev-parse", "refs/stash"]).stdout.trim(),
    ).toBe(sharedStash);

    releaseSecond.resolve();
    await secondSync;
    releaseFirst.resolve();
    await firstSync;

    expectWip(fixture.first, "first");
    expectWip(fixture.second, "second");
    expect(fs.existsSync(path.join(fixture.first, "second-untracked.txt"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(fixture.second, "first-untracked.txt"))).toBe(
      false,
    );
    expect(
      runGit(fixture.repository, ["rev-parse", "refs/stash"]).stdout.trim(),
    ).toBe(sharedStash);
    for (const checkpoint of [firstCheckpoint, secondCheckpoint]) {
      expect(
        runGit(fixture.repository, ["show-ref", "--verify", checkpoint.ref], {
          allowFailure: true,
        }).status,
      ).not.toBe(0);
    }
  });

  test("refuses cross-worktree restore and retains the exact checkpoint", () => {
    const fixture = createRepository();
    makeWip(fixture.first, "first");
    const checkpoint = checkpointWorktree(fixture.first);

    expect(() => restoreWorktree(fixture.second, checkpoint.ref)).toThrowError(
      expect.objectContaining({
        code: "worktree_wip_owner_mismatch",
      }),
    );
    expect(
      runGit(fixture.repository, ["show-ref", "--verify", checkpoint.ref])
        .status,
    ).toBe(0);

    restoreWorktree(fixture.first, checkpoint.ref);
    expectWip(fixture.first, "first");
  });

  test("round-trips a checkpoint containing only untracked files", () => {
    const fixture = createRepository();
    write(fixture.first, "only-untracked.txt", "only untracked\n");

    const checkpoint = checkpointWorktree(fixture.first);

    expect(runGit(fixture.first, ["status", "--porcelain"]).stdout).toBe("");
    expect(
      runGit(fixture.repository, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        checkpoint.ref,
      ]).stdout
        .trim()
        .split(" "),
    ).toHaveLength(4);
    restoreWorktree(fixture.first, checkpoint.ref);
    expect(
      fs.readFileSync(path.join(fixture.first, "only-untracked.txt"), "utf8"),
    ).toBe("only untracked\n");
  });

  test("accepts pnpm's standalone argument separator in both CLIs", () => {
    const fixture = createRepository();
    write(fixture.repository, "upstream.txt", "updated upstream\n");
    commit(fixture.repository, "upstream");
    makeWip(fixture.first, "first");

    const sync = runNode(fixture.first, syncCli, [
      "--",
      "--no-fetch",
      "--target",
      "main",
      "--json",
    ]);

    expect(sync.status, sync.stderr).toBe(0);
    expect(JSON.parse(sync.stdout).target).toBe("main");
    expectWip(fixture.first, "first");

    const checkpoint = runNode(fixture.second, wipCli, [
      "--",
      "checkpoint",
      "--json",
    ]);
    expect(checkpoint.status, checkpoint.stderr).toBe(0);
    expect(JSON.parse(checkpoint.stdout)).toBeNull();
  });

  test("rebases non-interactively when repository commit signing is enabled", async () => {
    const fixture = createRepository();
    write(fixture.first, "branch-only.txt", "branch\n");
    commit(fixture.first, "branch change");
    write(fixture.repository, "main-only.txt", "main\n");
    commit(fixture.repository, "main change");
    runGit(fixture.repository, ["config", "commit.gpgsign", "true"]);
    runGit(fixture.repository, ["config", "gpg.format", "ssh"]);
    runGit(fixture.repository, [
      "config",
      "gpg.ssh.program",
      "/usr/bin/false",
    ]);

    await expect(
      syncWorktree({
        cwd: fixture.first,
        fetch: false,
        target: "main",
      }),
    ).resolves.toMatchObject({ target: "main" });

    expect(
      runGit(fixture.first, ["rev-list", "--count", "main..HEAD"]).stdout.trim(),
    ).toBe("1");
    expect(
      runGit(fixture.first, ["merge-base", "--is-ancestor", "main", "HEAD"])
        .status,
    ).toBe(0);
  });

  test("keeps tracked and untracked recovery data pinned when restore conflicts", () => {
    const fixture = createRepository();
    write(fixture.first, "first-unstaged.txt", "first conflicting WIP\n");
    write(fixture.first, "first-untracked.txt", "durable untracked WIP\n");
    const checkpoint = checkpointWorktree(fixture.first);

    write(fixture.repository, "first-unstaged.txt", "upstream conflict\n");
    commit(fixture.repository, "conflicting upstream");
    runGit(fixture.first, ["rebase", "main"]);

    expect(() => restoreWorktree(fixture.first, checkpoint.ref)).toThrowError(
      expect.objectContaining({
        code: "worktree_wip_restore_failed",
      }),
    );
    expect(
      runGit(fixture.repository, ["show-ref", "--verify", checkpoint.ref])
        .status,
    ).toBe(0);
    expect(
      runGit(fixture.repository, [
        "show",
        `${checkpoint.ref}:first-unstaged.txt`,
      ]).stdout,
    ).toBe("first conflicting WIP\n");
    expect(
      runGit(fixture.repository, [
        "show",
        `${checkpoint.ref}^3:first-untracked.txt`,
      ]).stdout,
    ).toBe("durable untracked WIP\n");
  });

  test("retains the owner checkpoint when rebase fails", async () => {
    const fixture = createRepository();
    write(fixture.first, "upstream.txt", "branch conflict\n");
    commit(fixture.first, "branch change");
    write(fixture.repository, "upstream.txt", "main conflict\n");
    commit(fixture.repository, "main change");
    write(fixture.first, "first-untracked.txt", "WIP behind failed rebase\n");

    await expect(
      syncWorktree({
        cwd: fixture.first,
        fetch: false,
        target: "main",
      }),
    ).rejects.toMatchObject({ code: "worktree_sync_rebase_failed" });

    const retainedRef = runGit(fixture.repository, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/hebbian-wip",
    ]).stdout.trim();
    expect(retainedRef).toMatch(/^refs\/hebbian-wip\//);
    expect(
      runGit(fixture.repository, [
        "show",
        `${retainedRef}^3:first-untracked.txt`,
      ]).stdout,
    ).toBe("WIP behind failed rebase\n");
  });

  test("restores WIP when fetch fails before rebase", async () => {
    const fixture = createRepository();
    makeWip(fixture.first, "first");

    await expect(
      syncWorktree({
        branch: "main",
        cwd: fixture.first,
        remote: "definitely-missing-remote",
      }),
    ).rejects.toMatchObject({ code: "worktree_sync_fetch_failed" });

    expectWip(fixture.first, "first");
    expect(
      runGit(fixture.repository, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/hebbian-wip",
      ]).stdout.trim(),
    ).toBe("");
  });

  test("restores WIP if a pre-rebase hook fails", async () => {
    const fixture = createRepository();
    makeWip(fixture.first, "first");

    await expect(
      syncWorktree({
        afterCheckpoint: () => {
          throw new WorktreeWipError("injected_failure", "stop before rebase");
        },
        cwd: fixture.first,
        fetch: false,
        target: "main",
      }),
    ).rejects.toMatchObject({ code: "injected_failure" });

    expectWip(fixture.first, "first");
    expect(
      runGit(fixture.repository, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/hebbian-wip",
      ]).stdout.trim(),
    ).toBe("");
  });
});
