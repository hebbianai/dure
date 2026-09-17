import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";

const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
assert.equal(home, path.join(root, "home"));
assert(path.basename(root).startsWith("dure-agent-removal."));
const runId = process.env.VITE_DURE_AGENT_REMOVAL_QA_RUN_ID;
assert.match(runId ?? "", /^[a-f0-9-]{36}$/);
const repo = path.join(home, "repo");
fs.mkdirSync(repo, { mode: 0o700 });
const git = (...args) => execFileSync("git", args, {
	cwd: repo,
	env: withoutLocalGitOverrides(),
	encoding: "utf8",
	timeout: 10_000,
});
git("init", "--initial-branch=main");
git("-c", "user.name=Removal QA", "-c", "user.email=qa@example.test",
	"commit", "--allow-empty", "-m", "Disposable removal fixture");
for (const name of ["already-absent", "refresh", "new-user"]) {
	git("worktree", "add", "-b", name, path.join(repo, ".worktrees", name));
}
fs.writeFileSync(
	path.join(root, "qa.autorun"),
	`agentremoval=${JSON.stringify({ runId, home, repo })}\n`,
	{ flag: "wx", mode: 0o600 },
);
