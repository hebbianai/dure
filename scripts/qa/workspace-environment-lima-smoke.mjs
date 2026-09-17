#!/usr/bin/env node
// Opt-in real Lima proof. No application or provider credentials are used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBoundedOwnedProcessGroup } from "./lib/bounded-owned-process-group.mjs";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../..");
if (process.argv[2] !== "--fixture") {
  const root = fs.mkdtempSync("/tmp/dvm-");
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, "owner.json"), JSON.stringify({ task: "workspace-environment-lima", repository }), { mode: 0o600 });
  console.log("Retained QA root:", root);
  process.exitCode = await runBoundedOwnedProcessGroup(root, "900", process.execPath, [script, "--fixture", root]);
} else {
  const root = process.argv[3];
  assert.match(root, /^\/tmp\/dvm-[a-zA-Z0-9]+$/u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "owner.json"), "utf8")).repository, repository);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DURE_|HMUX_|GIT_|CODEX_|CLAUDE_)/u.test(key)));
  const project = path.join(root, "project");
  for (const directory of ["project", "home", "lima", "dure", "discovery"]) fs.mkdirSync(path.join(root, directory), { mode: 0o700 });
  Object.assign(environment, {
    HOME: path.join(root, "home"),
    LIMA_HOME: path.join(root, "lima"),
    DURE_HOME: path.join(root, "dure"),
    HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    DURE_ENVIRONMENT_ID: "env-" + createHash("sha256").update(root).digest("hex"),
    DURE_ENVIRONMENT_NAME: "Disposable VM proof",
    DURE_PROJECT_PATH: project,
  });
  const run = (command, args, extra = {}) => {
    const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...extra });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, command + " failed: " + result.stderr);
    return result.stdout;
  };
  const recipe = path.join(repository, "docs/public/examples/lima/lima.sh");
  const lifecycle = (action) => run("/bin/bash", [recipe], { env: { ...environment, DURE_ENVIRONMENT_ACTION: action } });
  run("git", ["init", project]);
  fs.writeFileSync(path.join(project, "tracked.txt"), "committed fixture\n");
  run("git", ["-C", project, "add", "tracked.txt"]);
  run("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture"]);
  try {
    const created = JSON.parse(lifecycle("create"));
    assert.equal(created.schemaVersion, 1);
    const ssh = (...args) => run("limactl", ["shell", created.resourceId, "--", ...args]);
    assert.equal(ssh("cat", "/home/dure/project/tracked.txt").trim(), "committed fixture");
    ssh("git", "-C", "/home/dure/project", "worktree", "add", "--detach", "/home/dure/task", "HEAD");
    ssh("bash", "-c", "printf isolated > /home/dure/task/only-in-vm");
    assert.equal(fs.existsSync(path.join(project, "only-in-vm")), false);
    lifecycle("suspend");
    const resumed = JSON.parse(lifecycle("resume"));
    assert.deepEqual(resumed.connection, created.connection);
    assert.equal(ssh("cat", "/home/dure/task/only-in-vm").trim(), "isolated");
    console.log("PASS: real VM create, committed checkout, separate worktree, suspend/resume, stable SSH.");
  } finally {
    lifecycle("destroy");
    assert.equal(run("limactl", ["list", "--quiet"]).trim(), "");
    console.log("PASS: owned VM destroyed; diagnostics retained at", root);
  }
}
