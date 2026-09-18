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
  if (!live) {
    const replacementAccount = realpathSync(process.env.DURE_QA_CODEX_REPLACEMENT_HOME || account);
    const profileDirectoryName = "codex-qa-replacement";
    const replacement = join(home, ".dure", "accounts", profileDirectoryName);
    mkdirSync(replacement, { recursive: true, mode: 0o700 });
    copyFileSync(join(replacementAccount, "auth.json"), join(replacement, "auth.json"));
    chmodSync(join(replacement, "auth.json"), 0o600);
    writeFileSync(join(replacement, "config.toml"), "mcp_servers = {}\n", { flag: "wx", mode: 0o600 });
    const accountIdentity = (directory) => {
      const auth = JSON.parse(readFileSync(join(directory, "auth.json"), "utf8"));
      return typeof auth.tokens?.account_id === "string" ? auth.tokens.account_id : null;
    };
    const sourceIdentity = accountIdentity(isolated);
    const targetIdentity = accountIdentity(replacement);
    const limitedAccount = process.env.DURE_QA_CODEX_LIMITED_HOME;
    const limitedProfileDirectoryName = limitedAccount ? "codex-qa-limited" : undefined;
    if (limitedAccount) {
      const limited = join(home, ".dure", "accounts", limitedProfileDirectoryName);
      mkdirSync(limited, { recursive: true, mode: 0o700 });
      copyFileSync(join(realpathSync(limitedAccount), "auth.json"), join(limited, "auth.json"));
      chmodSync(join(limited, "auth.json"), 0o600);
      writeFileSync(join(limited, "config.toml"), "mcp_servers = {}\n", { flag: "wx", mode: 0o600 });
    }
    writeFileSync(join(home, "slack-queue-account.json"), JSON.stringify({
      profileDirectoryName, referenceId: "qa-replacement", limitedProfileDirectoryName,
      distinctProviderAccounts: sourceIdentity !== null && targetIdentity !== null && sourceIdentity !== targetIdentity,
    }), { flag: "wx", mode: 0o600 });
  }
  const project = join(home, "project");
  mkdirSync(project, { mode: 0o700 });
  writeFileSync(join(project, "AGENTS.md"), live
    ? "This is a disposable Slack integration test repository. Work only on the requested files in this directory. Do not inspect credentials, change configuration, contact external services, or delegate work. Preserve counts.txt.\n"
    : "This is an isolated native Slack sharing test. Only perform the requested task. You may run python3 queue-barrier.py or python3 queue-account-barrier.py when explicitly requested, and wait for it to finish. Do not run other tools, inspect credentials, or contact external services.\n", { flag: "wx", mode: 0o600 });
  if (!live) {
    for (const name of ["queue", "queue-account"]) {
      writeFileSync(join(project, `${name}-barrier.py`), `from pathlib import Path
import time

project = Path(__file__).resolve().parent
assert project.name == "project" and project.parent.name == "home"
assert project.parent.parent.name.startswith("dure-slack-share.")
(project / "${name}-active").write_text("waiting")
deadline = time.monotonic() + 180
while not (project / "${name}-release").exists():
    if time.monotonic() > deadline:
        raise RuntimeError("The isolated queue test did not release its tool")
    time.sleep(0.1)
print("QA_ACTIVE_DONE")
`, { flag: "wx", mode: 0o600 });
    }
  }
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
