import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";

const root = realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = realpathSync(process.env.HOME);
assert.equal(home, path.join(root, "home"));
assert(path.basename(root).startsWith("dure-repository-quick-start."));
await import("./workspace-performance-home-setup.mjs");
const repo = path.join(home, "quick-start-repo");
mkdirSync(repo, { mode: 0o700 });
const git = (...args) => execFileSync("git", args, {
  cwd: repo, env: withoutLocalGitOverrides(), stdio: "pipe", timeout: 5000,
});
git("init", "-b", "main");
writeFileSync(path.join(repo, "fixture.txt"), "Quick-start isolated fixture\n", { flag: "wx", mode: 0o600 });
git("add", "fixture.txt");
git("-c", "user.name=Dure QA", "-c", "user.email=qa@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "QA fixture");
