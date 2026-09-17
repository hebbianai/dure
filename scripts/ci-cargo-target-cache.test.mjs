import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const managerScript = path.join(
  repositoryRoot,
  "scripts",
  "manage-ci-cargo-target.sh",
);
const temporaryDirectories = [];
// These scenarios intentionally create and prune several filesystem trees.
// The self-hosted verify job runs at background priority, so the generic 5s
// Vitest limit is too tight under normal machine contention. This remains a
// bounded functional test rather than a wall-clock performance assertion.

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ci-cargo-target-cache-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function setRustVersion(fixture, version) {
  fs.writeFileSync(
    fixture.rustc,
    `#!/bin/sh
if [ "\${1:-}" != "-vV" ]; then
  exit 2
fi
printf '%s\\n' '${version}'
printf '%s\\n' 'host: aarch64-apple-darwin'
`,
  );
  fs.chmodSync(fixture.rustc, 0o755);
}

function createFixture() {
  const root = temporaryDirectory();
  const runnerWork = path.join(root, "_work");
  const runnerTemp = path.join(runnerWork, "_temp");
  const workspace = path.join(runnerWork, "HebbianIDE", "HebbianIDE");
  const commandDirectory = path.join(root, "bin");
  const rustc = path.join(commandDirectory, "rustc");
  const githubEnvironmentDirectory = path.join(
    runnerTemp,
    "_runner_file_commands",
  );
  const githubEnvironment = path.join(
    githubEnvironmentDirectory,
    "set_env_test",
  );
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(commandDirectory);
  fs.mkdirSync(githubEnvironmentDirectory, { recursive: true });
  fs.writeFileSync(githubEnvironment, "");

  const fixture = {
    githubEnvironment,
    root,
    runnerTemp,
    runnerWork,
    rustc,
    workspace,
  };
  setRustVersion(fixture, "rustc 1.97.1 (test)");
  return fixture;
}

function runManager(
  fixture,
  mode,
  {
    maxKib,
    profile = "verify",
    runAttempt = "1",
    runId = "12345",
    staleSeconds,
  } = {},
) {
  return spawnSync("sh", [managerScript, mode], {
    cwd: fixture.workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_ENV: fixture.githubEnvironment,
      GITHUB_JOB: profile,
      GITHUB_RUN_ATTEMPT: runAttempt,
      GITHUB_RUN_ID: runId,
      GITHUB_WORKSPACE: fixture.workspace,
      HEBBIAN_CI_RUNNER_TEMP: fixture.runnerTemp,
      HEBBIAN_CI_TARGET_MAX_KIB:
        maxKib === undefined ? "" : String(maxKib),
      HEBBIAN_CI_TARGET_PROFILE: profile,
      HEBBIAN_CI_TARGET_STALE_LEASE_SECONDS:
        staleSeconds === undefined ? "" : String(staleSeconds),
      PATH: `${path.dirname(fixture.rustc)}:${process.env.PATH}`,
    },
  });
}

function publishedTarget(fixture) {
  const lines = fs
    .readFileSync(fixture.githubEnvironment, "utf8")
    .trim()
    .split("\n");
  return lines
    .find((line) => line.startsWith("CARGO_TARGET_DIR="))
    ?.slice("CARGO_TARGET_DIR=".length);
}

function runFixtureGit(cwd, args, sourceEnvironment = process.env) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: withoutLocalGitOverrides(sourceEnvironment),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("runner-local Cargo target manager", () => {
  test.each([
    "verify",
    "windows-cross-target",
    "linux-musl-artifacts",
    "hmux-release-trust",
    "hmux-release-promotion",
  ])("admits the declared %s profile", (profile) => {
    const fixture = createFixture();

    const prepared = runManager(fixture, "prepare", { profile });
    expect(prepared.status, prepared.stderr).toBe(0);
    const released = runManager(fixture, "release", { profile });
    expect(released.status, released.stderr).toBe(0);
  });

  test("publishes a target outside both checkout and runner temp", () => {
    const fixture = createFixture();

    const result = runManager(fixture, "prepare");
    const target = publishedTarget(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(target).toBeTruthy();
    expect(
      target.startsWith(
        `${fs.realpathSync(fixture.runnerWork)}/_hebbian-ci-targets-v1/`,
      ),
    ).toBe(true);
    expect(target.startsWith(fixture.workspace)).toBe(false);
    expect(target.startsWith(fixture.runnerTemp)).toBe(false);
    expect(path.basename(target)).toBe("target");
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(
      fs.readFileSync(path.join(path.dirname(target), ".hebbian-ci-target-owner"), "utf8"),
    ).toContain("profile=verify\n");
    expect(
      fs.readFileSync(
        path.join(path.dirname(path.dirname(target)), ".lease", ".hebbian-ci-lease"),
        "utf8",
      ),
    ).toBe("12345:1:verify\n");
  });

  test("refuses a concurrent lease and releases only its exact owner", () => {
    const fixture = createFixture();
    expect(runManager(fixture, "prepare").status).toBe(0);

    const concurrent = runManager(fixture, "prepare", { runId: "67890" });
    const wrongRelease = runManager(fixture, "release", { runId: "67890" });
    const exactRelease = runManager(fixture, "release");

    expect(concurrent.status).not.toBe(0);
    expect(concurrent.stderr).toContain("active target lease");
    expect(wrongRelease.status).not.toBe(0);
    expect(wrongRelease.stderr).toContain("belongs to another run");
    expect(exactRelease.status, exactRelease.stderr).toBe(0);
    expect(
      fs.existsSync(path.join(path.dirname(path.dirname(publishedTarget(fixture))), ".lease")),
    ).toBe(false);
    expect(fs.existsSync(publishedTarget(fixture))).toBe(true);
  });

  test("reclaims a stale lease after the bounded job timeout", () => {
    const fixture = createFixture();
    expect(runManager(fixture, "prepare").status).toBe(0);
    const lease = path.join(path.dirname(path.dirname(publishedTarget(fixture))), ".lease");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lease, old, old);

    const reclaimed = runManager(fixture, "prepare", {
      runId: "67890",
      staleSeconds: 60,
    });

    expect(reclaimed.status, reclaimed.stderr).toBe(0);
    expect(reclaimed.stdout).toContain("Reclaimed stale Cargo target lease");
    expect(
      fs.readFileSync(path.join(lease, ".hebbian-ci-lease"), "utf8"),
    ).toBe("67890:1:verify\n");
  });

  test("refuses a symlinked cache root without touching its destination", () => {
    const fixture = createFixture();
    const destination = path.join(fixture.root, "developer-owned");
    const targetRoot = path.join(
      fixture.runnerWork,
      "_hebbian-ci-targets-v1",
    );
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "sentinel"), "developer-owned");
    fs.symlinkSync(destination, targetRoot);

    const result = runManager(fixture, "prepare");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("target root must not be a symlink");
    expect(fs.readFileSync(path.join(destination, "sentinel"), "utf8")).toBe(
      "developer-owned",
    );
  });

  test("survives a checkout git clean because the target is outside it", () => {
    const fixture = createFixture();
    expect(runManager(fixture, "prepare").status).toBe(0);
    const target = publishedTarget(fixture);
    fs.writeFileSync(path.join(target, "cached-artifact"), "keep");
    fs.writeFileSync(path.join(fixture.workspace, "untracked"), "remove");
    expect(
      runFixtureGit(fixture.workspace, ["init", "--quiet"]).status,
    ).toBe(0);

    const cleaned = runFixtureGit(fixture.workspace, ["clean", "-fdx"]);

    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(fs.existsSync(path.join(fixture.workspace, "untracked"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "cached-artifact"), "utf8")).toBe(
      "keep",
    );
  });

  test("does not redirect fixture Git into an inherited linked worktree", () => {
    const fixture = createFixture();
    const repository = path.join(temporaryDirectory(), "repository");
    const linked = path.join(temporaryDirectory(), "linked");
    fs.mkdirSync(repository);
    expect(runFixtureGit(repository, ["init", "--quiet"]).status).toBe(0);
    // 개발자 전역 서명 설정(1Password 등)에 의존하지 않게 — 에이전트가 죽어
    // 있으면 commit이 128로 죽는다.
    expect(
      runFixtureGit(repository, ["config", "commit.gpgSign", "false"]).status,
    ).toBe(0);
    expect(
      runFixtureGit(repository, [
        "-c",
        "user.name=axq-test",
        "-c",
        "user.email=axq-test@example.test",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "initial",
      ]).status,
    ).toBe(0);
    expect(
      runFixtureGit(repository, [
        "worktree",
        "add",
        "--quiet",
        "-b",
        "linked",
        linked,
      ]).status,
    ).toBe(0);
    const linkedGitDirectory = runFixtureGit(linked, [
      "rev-parse",
      "--absolute-git-dir",
    ]).stdout.trim();
    const inheritedHookEnvironment = {
      ...process.env,
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='.githooks'",
      GIT_DIR: linkedGitDirectory,
    };

    expect(
      runFixtureGit(
        fixture.workspace,
        ["init", "--quiet"],
        inheritedHookEnvironment,
      ).status,
    ).toBe(0);
    fs.writeFileSync(path.join(fixture.workspace, "untracked"), "remove");
    expect(
      runFixtureGit(
        fixture.workspace,
        ["clean", "-fdx"],
        inheritedHookEnvironment,
      ).status,
    ).toBe(0);

    expect(
      runFixtureGit(repository, ["config", "--bool", "core.bare"]).stdout.trim(),
    ).toBe("false");
    for (const worktree of [repository, linked]) {
      expect(
        runFixtureGit(worktree, [
          "rev-parse",
          "--is-inside-work-tree",
        ]).stdout.trim(),
      ).toBe("true");
      expect(runFixtureGit(worktree, ["status", "--short"]).status).toBe(0);
    }
  });

  test("refuses to prune an unowned profile entry", () => {
    const fixture = createFixture();
    expect(runManager(fixture, "prepare").status).toBe(0);
    expect(runManager(fixture, "release").status).toBe(0);
    const target = publishedTarget(fixture);
    const unowned = path.join(path.dirname(path.dirname(target)), "developer-owned");
    fs.mkdirSync(unowned);
    fs.writeFileSync(path.join(unowned, "sentinel"), "keep");
    fs.writeFileSync(fixture.githubEnvironment, "");

    const result = runManager(fixture, "prepare");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unrecognized entry");
    expect(fs.readFileSync(path.join(unowned, "sentinel"), "utf8")).toBe(
      "keep",
    );
  });

  test("keeps at most two Rust toolchain generations per profile", () => {
      const fixture = createFixture();
      const targets = [];
      for (const version of ["rustc 1.95.0", "rustc 1.96.0", "rustc 1.97.0"]) {
        setRustVersion(fixture, version);
        fs.writeFileSync(fixture.githubEnvironment, "");
        const prepared = runManager(fixture, "prepare");
        expect(prepared.status, prepared.stderr).toBe(0);
        targets.push(publishedTarget(fixture));
        expect(runManager(fixture, "release").status).toBe(0);
      }

      expect(new Set(targets).size).toBe(3);
      expect(targets.filter((target) => fs.existsSync(target))).toHaveLength(2);
      expect(fs.existsSync(targets[2])).toBe(true);
  });

  test("resets an owned current generation that exceeds its disk cap", () => {
      const fixture = createFixture();
      expect(runManager(fixture, "prepare", { maxKib: 64 }).status).toBe(0);
      const target = publishedTarget(fixture);
      const oversized = path.join(target, "oversized-artifact");
      fs.writeFileSync(oversized, Buffer.alloc(128 * 1024));
      expect(runManager(fixture, "release", { maxKib: 64 }).status).toBe(0);
      fs.writeFileSync(fixture.githubEnvironment, "");

      const prepared = runManager(fixture, "prepare", { maxKib: 64 });

      expect(prepared.status, prepared.stderr).toBe(0);
      expect(prepared.stdout).toContain("Reset oversized Cargo target generation");
      expect(fs.existsSync(oversized)).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(target), ".hebbian-ci-target-owner"))).toBe(
        true,
      );
  });

  test("keeps legacy generation output while preparing the native target child", () => {
    const fixture = createFixture();
    expect(runManager(fixture, "prepare").status).toBe(0);
    const target = publishedTarget(fixture);
    expect(runManager(fixture, "release").status).toBe(0);
    fs.rmdirSync(target);
    const legacyOutput = path.join(path.dirname(target), "debug");
    fs.mkdirSync(legacyOutput);
    fs.writeFileSync(path.join(legacyOutput, "cached-artifact"), "keep");
    fs.writeFileSync(fixture.githubEnvironment, "");

    const prepared = runManager(fixture, "prepare");

    expect(prepared.status, prepared.stderr).toBe(0);
    expect(publishedTarget(fixture)).toBe(target);
    expect(fs.readFileSync(path.join(legacyOutput, "cached-artifact"), "utf8")).toBe("keep");
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });

  test("refuses an escaped output child without touching its destination", () => {
    const fixture = createFixture();
    expect(runManager(fixture, "prepare").status).toBe(0);
    const target = publishedTarget(fixture);
    expect(runManager(fixture, "release").status).toBe(0);
    fs.rmdirSync(target);
    const destination = path.join(fixture.root, "developer-owned");
    fs.mkdirSync(destination, { mode: 0o755 });
    const previousMode = fs.statSync(destination).mode;
    fs.writeFileSync(path.join(destination, "sentinel"), "keep");
    fs.symlinkSync(destination, target);
    fs.writeFileSync(fixture.githubEnvironment, "");

    const result = runManager(fixture, "prepare");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cargo output directory must not be a symlink");
    expect(fs.readFileSync(fixture.githubEnvironment, "utf8")).toBe("");
    expect(fs.readFileSync(path.join(destination, "sentinel"), "utf8")).toBe("keep");
    expect(fs.statSync(destination).mode).toBe(previousMode);
  });
});
