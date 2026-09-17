import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

const roots = [];
const script = path.resolve("scripts/verify-release-base.mjs");
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-base-"));
  roots.push(root);
  const environment = withoutLocalGitOverrides();
  const git = (...args) => execFileSync("git", args, { cwd: root, env: environment, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("-c", "user.name=Release", "-c", "user.email=release@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "source");
  const base = git("rev-parse", "HEAD");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "api") console.log("b".repeat(40));
else console.log(process.env.EXACT_CI_RUNS);
`, { mode: 0o700 });
  return { root, base, environment: { ...environment, PATH: `${bin}${path.delimiter}${environment.PATH}`, GITHUB_REPOSITORY: "hebbianai/dure-internal", GH_CALLS: path.join(root, "gh-calls") } };
}

function verify(target, runs, sha = target.base) {
  return spawnSync(process.execPath, [script, sha], {
    cwd: target.root,
    encoding: "utf8",
    env: { ...target.environment, EXACT_CI_RUNS: JSON.stringify(runs) },
  });
}

test("admits the dispatch source with exact green CI even after main advances", () => {
  const target = fixture();
  const result = verify(target, [{ headSha: target.base, status: "completed", conclusion: "success" }]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = fs.readFileSync(target.environment.GH_CALLS, "utf8");
  expect(calls).not.toContain("git/ref/heads/main");
});

test("rejects a different checkout and refuses another SHA's green CI", () => {
  const target = fixture();
  const runs = [{ headSha: "b".repeat(40), status: "completed", conclusion: "success" }];
  expect(verify(target, runs).status).toBe(1);
  expect(verify(target, runs, "b".repeat(40)).stderr).toContain("release_checkout_mismatch");
});
