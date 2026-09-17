import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";
import { assertIsolatedCleanupBoundary } from "./lib/isolated-hmux-session-cleanup.mjs";

const root = realpathSync(process.env.DURE_QA_STATE_ROOT);
assertIsolatedCleanupBoundary(root, process.env.HMUX_DISCOVERY_ROOT);
const home = realpathSync(process.env.HOME);
assert.equal(home, join(root, "home"));
const sharing = process.env.DURE_QA_ARTIFACT_NAME === "slack-share";
const live = process.env.DURE_QA_SLACK_LIVE === "1";
assert.ok(basename(root).startsWith(sharing ? "dure-slack-share." : "dure-slack-connections."));
// Backend startup imports its login-shell PATH. The disposable home needs the
// same Node toolchain as this runner, without reading the real user's profile.
const nodeDirectory = dirname(realpathSync(process.env.DURE_QA_NODE_BIN));
const codexDirectory = sharing ? dirname(realpathSync(process.env.DURE_QA_CODEX_BIN)) : undefined;
const searchPath = [nodeDirectory, ...(codexDirectory ? [codexDirectory] : [])]
  .map((directory) => `'${directory.replaceAll("'", "'\\''")}'`).join(":");
writeFileSync(join(home, ".zprofile"), `export PATH=${searchPath}:"$PATH"\n`, {
  flag: "wx", mode: 0o600,
});
if (sharing) {
  const account = realpathSync(process.env.DURE_QA_CODEX_HOME);
  const isolated = join(home, ".codex");
  mkdirSync(isolated, { mode: 0o700 });
  copyFileSync(join(account, "auth.json"), join(isolated, "auth.json"));
  chmodSync(join(isolated, "auth.json"), 0o600);
  writeFileSync(join(isolated, "config.toml"), "mcp_servers = {}\n", { flag: "wx", mode: 0o600 });
  const project = join(home, "project");
  mkdirSync(project, { mode: 0o700 });
  writeFileSync(join(project, "AGENTS.md"), live
    ? "This is a disposable Slack integration test repository. Work only on the requested files in this directory. Do not inspect credentials, change configuration, contact external services, or delegate work. Preserve counts.txt.\n"
    : "This is an isolated native Slack sharing test. Only answer the requested marker. Do not inspect credentials, use tools or contact external services.\n", { flag: "wx", mode: 0o600 });
  if (live) {
    const credentials = JSON.parse(readFileSync(process.env.DURE_QA_SLACK_LIVE_CREDENTIALS, "utf8"));
    writeFileSync(join(home, "slack-live.json"), JSON.stringify({
      appToken: credentials.appToken, botToken: credentials.botToken,
      teamId: process.env.DURE_QA_SLACK_TEAM, channelId: process.env.DURE_QA_SLACK_CHANNEL,
    }), { flag: "wx", mode: 0o600 });
    writeFileSync(join(project, "counts.txt"), "17\n26\n", { flag: "wx", mode: 0o600 });
  }
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "QA source"]]) {
    execFileSync("git", args, { cwd: project, env: withoutLocalGitOverrides(), stdio: "pipe" });
  }
  writeFileSync(join(home, "slack-share-posts.jsonl"), "", { flag: "wx", mode: 0o600 });
}
