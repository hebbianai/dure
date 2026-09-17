import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";

const script = fileURLToPath(
  new URL("./hmux-session-conversion-home-setup.mjs", import.meta.url),
);
const temporaryRoots = [];

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), "dure-conversion-home-setup-test-"),
  ));
  temporaryRoots.push(root);
  const stateRoot = root;
  const home = path.join(stateRoot, "home");
  const source = path.join(root, "source");
  const project = path.join(stateRoot, "project");
  const discovery = path.join(stateRoot, "hmux-discovery");
  fs.mkdirSync(path.join(home, ".dure"), { mode: 0o700, recursive: true });
  fs.mkdirSync(source);
  fs.mkdirSync(discovery);
  fs.writeFileSync(path.join(source, "auth.json"), "fixture-auth", {
    mode: 0o600,
  });
  return { discovery, home, project, root, source, stateRoot };
}

function run(input, overrides = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DURE_QA_STATE_ROOT: input.stateRoot,
      HEBBIAN_QA_PROJECT: input.project,
      HEBBIAN_QA_REAL_CODEX_HOME: input.source,
      HOME: input.home,
      HMUX_DISCOVERY_ROOT: input.discovery,
      ...overrides,
    },
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("Hmux conversion isolated home setup", () => {
  test("owns the project and autorun without following caller Git pointers", () => {
    const input = fixture();
    const peer = path.join(input.root, "peer");
    fs.mkdirSync(peer);
    const git = (args, cwd) => execFileSync("git", args, {
      cwd, encoding: "utf8", env: withoutLocalGitOverrides(),
    }).trim();
    git(["init", "-q", "-b", "peer"], peer);
    const head = fs.readFileSync(path.join(peer, ".git", "HEAD"), "utf8");
    const result = run(input, {
      GIT_DIR: path.join(peer, ".git"), GIT_WORK_TREE: peer,
      GIT_INDEX_FILE: path.join(peer, ".git", "index"),
      HEBBIAN_QA_PROJECT: peer,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(input.project, ".git"))).toBe(true);
    expect(git(["log", "-1", "--format=%s"], input.project)).toBe("base");
    expect(git(["branch", "--show-current"], input.project)).toBe("main");
    expect(fs.readFileSync(path.join(peer, ".git", "HEAD"), "utf8")).toBe(head);
    expect(fs.existsSync(path.join(peer, ".git", "refs", "heads", "peer"))).toBe(false);
    const autorun = path.join(input.stateRoot, "qa.autorun");
    expect(fs.readFileSync(autorun, "utf8")).toBe(`hmuxconversion-project=${input.project}\nhmuxcredential-profile=selected\n`);
    expect(fs.statSync(autorun).mode & 0o777).toBe(0o600);
    const receipt = JSON.parse(fs.readFileSync(path.join(input.stateRoot, "conversion-home-setup.json"), "utf8"));
    expect(receipt.project).toBe(input.project);
    expect(fs.readFileSync(path.join(input.home, ".codex", "config.toml"), "utf8"))
      .toBe(`[projects.${JSON.stringify(input.project)}]\ntrust_level = "trusted"\n`);
    expect(fs.readFileSync(path.join(input.source, "auth.json"), "utf8")).toBe("fixture-auth");
  });

  test("refuses an unrelated discovery root before provisioning or copying credentials", () => {
    const input = fixture();
    const result = run(input, { HMUX_DISCOVERY_ROOT: input.source });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(input.project)).toBe(false);
    expect(fs.existsSync(path.join(input.home, ".codex"))).toBe(false);
    expect(fs.readFileSync(path.join(input.source, "auth.json"), "utf8")).toBe("fixture-auth");
  });

  test("preserves existing project data and declines to reinitialize the fixture", () => {
    const input = fixture();
    fs.mkdirSync(input.project);
    fs.writeFileSync(path.join(input.project, "work.txt"), "retained work");
    const result = run(input);
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(input.project, "work.txt"), "utf8")).toBe("retained work");
    expect(fs.existsSync(path.join(input.home, ".codex"))).toBe(false);
  });

  test("preserves an unexpected autorun and does not publish successful preparation", () => {
    const input = fixture();
    fs.writeFileSync(path.join(input.stateRoot, "qa.autorun"), "retained scenario");
    const result = run(input);
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(input.stateRoot, "qa.autorun"), "utf8")).toBe("retained scenario");
    expect(fs.existsSync(path.join(input.stateRoot, "conversion-home-setup.json"))).toBe(false);
  });

  test("publishes the complete private topology before the app starts", () => {
    const input = fixture();

    const result = run(input);

    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(input.stateRoot, "conversion-home-setup.json"),
        "utf8",
      ),
    );
    expect(receipt).toMatchObject({
      appendFiles: ["history.jsonl", "session_index.jsonl"],
      ok: true,
      profile: "codex-selected",
      schema: 1,
    });
    expect(receipt.sharedDirectories).toEqual([
      "attachments",
      "memories",
      "plugins",
      "rules",
      "sessions",
      "shell_snapshots",
      "skills",
      "vendor_imports",
    ]);
    const canonical = fs.realpathSync(path.join(input.home, ".codex"));
    const profile = path.join(
      input.home,
      ".dure",
      "accounts",
      "codex-selected",
    );
    for (const name of receipt.sharedDirectories) {
      const destination = path.join(profile, name);
      expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(destination)).toBe(path.join(canonical, name));
    }
    for (const name of receipt.appendFiles) {
      const source = fs.statSync(path.join(canonical, name));
      const destination = fs.statSync(path.join(profile, name));
      expect([destination.dev, destination.ino]).toEqual([
        source.dev,
        source.ino,
      ]);
    }
    for (const credential of [
      path.join(canonical, "auth.json"),
      path.join(profile, "auth.json"),
    ]) {
      const metadata = fs.statSync(credential);
      expect(metadata.nlink).toBe(1);
      expect(metadata.mode & 0o777).toBe(0o600);
    }
  });

  test("rejects a HOME outside the runner-owned state root", () => {
    const input = fixture();
    const outside = path.join(input.root, "outside-home");
    fs.mkdirSync(outside);

    const result = run({ ...input, home: outside });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "conversion setup HOME is outside the isolated QA root",
    );
    expect(fs.existsSync(path.join(outside, ".codex"))).toBe(false);
  });
});
