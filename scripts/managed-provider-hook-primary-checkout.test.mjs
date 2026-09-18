import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const hook = path.resolve("src-tauri/resources/managed-claude-hook.py");
const contract = path.resolve("crates/dure-app/src/primary_checkout_guidance.rs");
const HOOK_SUBPROCESS_TIMEOUT_MS = 10_000;
const temporaryRoots = [];

const FENCE = {
  HMUX_SESSION_ID: "session-1",
  HMUX_WORKSPACE_ID: "workspace-1",
  HMUX_RUNNER_PRINCIPAL: "local-user",
  HMUX_RUNNER_INSTANCE: "runner-1",
  HMUX_CHANNEL_EPOCH: "1",
  HMUX_HOST_INSTANCE_ID: "host-1",
  HMUX_TERMINAL_EPOCH: "terminal-1",
};

function git(directory, ...argumentsList) {
  execFileSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "init.defaultBranch=main",
      ...argumentsList,
    ],
    { stdio: "ignore", env: scriptTestEnvironment({ HOME: directory }) },
  );
}

/** A repository with one commit and a linked worktree beside it. */
async function repository() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dure-primary-checkout-")));
  temporaryRoots.push(root);
  const checkout = path.join(root, "checkout");
  await mkdir(path.join(checkout, "src"), { recursive: true });
  git(checkout, "init", "-q");
  await writeFile(path.join(checkout, "src", "file.txt"), "fixture");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "fixture");
  git(checkout, "worktree", "add", "-q", "-b", "feature", "../linked");
  return { root, checkout, linked: path.join(root, "linked") };
}

async function expectedContext(toplevel, branch) {
  const source = await readFile(contract, "utf8");
  const template = source.match(
    /PRIMARY_CHECKOUT_SESSION_CONTEXT_TEMPLATE_V1: &str = "([^"]+)";/u,
  )?.[1];
  expect(template).toBeTruthy();
  return template.replace("{toplevel}", toplevel).replace("{branch}", branch);
}

/** Run the hook as Claude's settings hook or as Codex's notify script. */
async function runHook({ provider, payload, cwd, root, fence = FENCE }) {
  let script = hook;
  let argumentsList = ["claude", "--managed-direct", "--terminal-events"];
  if (provider === "codex") {
    script = path.join(root, "managed-codex-notify.sh");
    await copyFile(hook, script);
    argumentsList = [];
  }
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const child = spawn("python3", [script, ...argumentsList], {
    cwd,
    env: scriptTestEnvironment({ HOME: home, ...fence }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(payload));
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const timeout = setTimeout(() => child.kill("SIGKILL"), HOOK_SUBPROCESS_TIMEOUT_MS);
  const [code] = await once(child, "close");
  clearTimeout(timeout);
  expect(code, Buffer.concat(stderr).toString("utf8")).toBe(0);
  return Buffer.concat(stdout).toString("utf8");
}

function additionalContext(stdout) {
  const output = JSON.parse(stdout);
  expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
  return output.hookSpecificOutput.additionalContext;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed provider hook primary checkout guidance", () => {
  for (const provider of ["claude", "codex"]) {
    it(`guides a ${provider} session that starts in the primary checkout`, async () => {
      const { root, checkout } = await repository();
      const stdout = await runHook({
        provider,
        root,
        cwd: root,
        payload: { hook_event_name: "SessionStart", session_id: "session-1", cwd: checkout },
      });
      expect(additionalContext(stdout)).toBe(await expectedContext(checkout, "main"));
    });
  }

  it("names the checkout root from a subdirectory", async () => {
    const { root, checkout } = await repository();
    const stdout = await runHook({
      provider: "claude",
      root,
      cwd: root,
      payload: {
        hook_event_name: "SessionStart",
        session_id: "session-1",
        cwd: path.join(checkout, "src"),
      },
    });
    expect(additionalContext(stdout)).toBe(await expectedContext(checkout, "main"));
  });

  it("uses the hook directory when the payload has no cwd", async () => {
    const { root, checkout } = await repository();
    const stdout = await runHook({
      provider: "codex",
      root,
      cwd: checkout,
      payload: { hook_event_name: "SessionStart", session_id: "session-1" },
    });
    expect(additionalContext(stdout)).toBe(await expectedContext(checkout, "main"));
  });

  it("does not guide a session in a linked worktree", async () => {
    const { root, linked } = await repository();
    const stdout = await runHook({
      provider: "claude",
      root,
      cwd: root,
      payload: { hook_event_name: "SessionStart", session_id: "session-1", cwd: linked },
    });
    expect(stdout).toBe("");
  });

  it("does not guide other hook events", async () => {
    const { root, checkout } = await repository();
    const stdout = await runHook({
      provider: "claude",
      root,
      cwd: root,
      payload: { hook_event_name: "PreToolUse", session_id: "session-1", cwd: checkout },
    });
    expect(stdout).toBe("");
  });

  it("does not guide a session outside Dure's managed fence", async () => {
    const { root, checkout } = await repository();
    const stdout = await runHook({
      provider: "claude",
      root,
      cwd: root,
      fence: {},
      payload: { hook_event_name: "SessionStart", session_id: "session-1", cwd: checkout },
    });
    expect(stdout).toBe("");
  });
});
