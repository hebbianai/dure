import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { withoutLocalGitOverrides } from "../../../scripts/lib/git-environment.mjs";
import { providerFixtureRoot } from "../paths.mjs";

const execFileAsync = promisify(execFile);
const PROVIDER_SESSION_NAME =
  /^dure-media-[a-z0-9]{1,32}(?:-[a-zA-Z0-9_-]{1,96})?$/u;

async function runGit(args, cwd, env) {
  await execFileAsync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function providerWorktreePath(fixture, sessionName) {
  if (!PROVIDER_SESSION_NAME.test(sessionName)) {
    throw new Error("invalid provider media session name");
  }
  const worktree = resolve(fixture.root, "worktrees", sessionName);
  const pathFromFixture = relative(fixture.root, worktree);
  if (
    pathFromFixture === "" ||
    pathFromFixture.startsWith("..") ||
    resolve(fixture.root, pathFromFixture) !== worktree
  ) {
    throw new Error("provider worktree must stay below its fixture");
  }
  return worktree;
}

export async function createProviderDemoWorktree(
  fixture,
  sessionName,
  env = process.env,
) {
  const worktree = providerWorktreePath(fixture, sessionName);
  await mkdir(resolve(fixture.root, "worktrees"), {
    recursive: true,
    mode: 0o700,
  });
  await runGit(
    [
      "worktree",
      "add",
      "--quiet",
      "-b",
      `media/${sessionName}`,
      worktree,
      "HEAD",
    ],
    fixture.repo,
    env,
  );
  await chmod(worktree, 0o700);
  return worktree;
}

export async function createProviderDemoRepo(scenarioId, env = process.env) {
  await mkdir(providerFixtureRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve(providerFixtureRoot, `${scenarioId}-`));
  try {
    await chmod(root, 0o700);
    const repo = resolve(root, "repo");
    const discoveryRoot = resolve(root, "hmux-discovery");
    await mkdir(resolve(repo, "src"), { recursive: true, mode: 0o700 });
    await mkdir(resolve(repo, "test"), { recursive: true, mode: 0o700 });
    await mkdir(discoveryRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(
        resolve(repo, "README.md"),
        "# Session handoff demo\n\nA tiny read-only fixture for Dure product media capture.\n",
        { mode: 0o600 },
      ),
      writeFile(
        resolve(repo, "src/session-router.mjs"),
        [
          "export function commitHandoff(current, next) {",
          "  if (current.generation !== next.expectedGeneration) {",
          '    throw new Error("stale handoff");',
          "  }",
          "  return { ...next, generation: current.generation + 1 };",
          "}",
          "",
        ].join("\n"),
        { mode: 0o600 },
      ),
      writeFile(
        resolve(repo, "test/session-router.test.mjs"),
        [
          'import assert from "node:assert/strict";',
          'import test from "node:test";',
          'import { commitHandoff } from "../src/session-router.mjs";',
          "",
          'test("rejects a stale generation", () => {',
          "  assert.throws(",
          "    () => commitHandoff({ generation: 4 }, { expectedGeneration: 3 }),",
          '    /stale handoff/,',
          "  );",
          "});",
          "",
        ].join("\n"),
        { mode: 0o600 },
      ),
      writeFile(
        resolve(repo, "package.json"),
        `${JSON.stringify(
          {
            name: "dure-session-handoff-demo",
            private: true,
            type: "module",
            scripts: { test: "node --test" },
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      ),
    ]);
    const gitEnv = withoutLocalGitOverrides(env);
    await runGit(["init", "--quiet"], repo, gitEnv);
    await runGit(["add", "."], repo, gitEnv);
    await runGit(
      [
        "-c",
        "user.name=Dure Media",
        "-c",
        "user.email=media@invalid.example",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "fixture: add session handoff demo",
      ],
      repo,
      gitEnv,
    );
    return { root, repo, discoveryRoot };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
