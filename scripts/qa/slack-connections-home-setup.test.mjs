import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = fileURLToPath(new URL("./slack-connections-home-setup.mjs", import.meta.url));
const roots = [];
const sourceAuth = JSON.stringify({ tokens: { account_id: "source-account", access_token: "private-fixture-auth" } });
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(scenario) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dure-slack-${scenario}.`)));
  roots.push(root);
  const home = path.join(root, "home");
  const source = path.join(root, "source");
  const discovery = path.join(root, "hmux-discovery");
  for (const directory of [home, source, discovery]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(source, "auth.json"), sourceAuth, { mode: 0o600 });
  return { root, home, source, discovery, run(overrides = {}) {
    return spawnSync(process.execPath, [script], { encoding: "utf8", env: {
      ...process.env, DURE_QA_STATE_ROOT: root, HOME: home, HMUX_DISCOVERY_ROOT: discovery,
      DURE_QA_ARTIFACT_NAME: `slack-${scenario}`, DURE_QA_NODE_BIN: process.execPath,
      DURE_QA_CODEX_BIN: process.execPath, DURE_QA_CODEX_HOME: source,
      DURE_QA_CODEX_REPLACEMENT_HOME: "",
      GIT_DIR: path.join(root, "caller.git"), GIT_WORK_TREE: source,
      ...overrides,
    } });
  } };
}
test("connection-only setup preserves the runner's Node without copying provider credentials", () => {
  const f = fixture("connections");
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(fs.existsSync(path.join(f.home, ".codex"))).toBe(false);
  const profile = fs.readFileSync(path.join(f.home, ".zprofile"), "utf8");
  expect(profile).not.toContain("::");
  expect(profile).toContain(path.dirname(fs.realpathSync(process.execPath)));
});
test("sharing owns its provider state and repository without mutating the source or caller Git directory", () => {
  const f = fixture("share");
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  const destination = path.join(f.home, ".codex", "auth.json");
  expect(fs.readFileSync(destination, "utf8")).toBe(sourceAuth);
  expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  expect(fs.statSync(destination).ino).not.toBe(fs.statSync(path.join(f.source, "auth.json")).ino);
  fs.writeFileSync(destination, "updated-only-in-isolation");
  expect(fs.readFileSync(path.join(f.source, "auth.json"), "utf8")).toBe(sourceAuth);
  expect(fs.existsSync(path.join(f.home, "project", ".git", "HEAD"))).toBe(true);
  expect(fs.existsSync(path.join(f.root, "caller.git"))).toBe(false);
  expect(result.stdout + result.stderr).not.toContain("private-fixture-auth");
  expect(JSON.parse(fs.readFileSync(path.join(f.home, "slack-queue-account.json"), "utf8")).distinctProviderAccounts).toBe(false);
  expect(fs.readFileSync(path.join(f.home, ".dure/accounts/codex-qa-replacement/auth.json"), "utf8")).toBe(sourceAuth);
});
test("account replacement copies only the selected credentials without exposing or mutating either source", () => {
  const f = fixture("share");
  const second = path.join(f.root, "second-account");
  fs.mkdirSync(second);
  const auth = JSON.stringify({ tokens: { account_id: "second-account", access_token: "second-private-token" } });
  fs.writeFileSync(path.join(second, "auth.json"), auth, { mode: 0o600 });
  fs.writeFileSync(path.join(second, "unrelated"), "do not copy");
  const result = f.run({ DURE_QA_CODEX_REPLACEMENT_HOME: second });
  expect(result.status, result.stderr).toBe(0);
  const target = path.join(f.home, ".dure/accounts/codex-qa-replacement/auth.json");
  expect(fs.readFileSync(target, "utf8")).toBe(auth);
  expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  expect(fs.statSync(target).ino).not.toBe(fs.statSync(path.join(second, "auth.json")).ino);
  expect(fs.existsSync(path.join(path.dirname(target), "unrelated"))).toBe(false);
  const metadata = fs.readFileSync(path.join(f.home, "slack-queue-account.json"), "utf8");
  expect(JSON.parse(metadata)).toEqual({ profileDirectoryName: "codex-qa-replacement", referenceId: "qa-replacement", distinctProviderAccounts: true });
  expect(result.stdout + result.stderr + metadata).not.toContain("second-private-token");
  expect(metadata).not.toContain("second-account");
  fs.writeFileSync(target, "updated only in the disposable account");
  expect(fs.readFileSync(path.join(second, "auth.json"), "utf8")).toBe(auth);
  expect(fs.readFileSync(path.join(f.source, "auth.json"), "utf8")).toBe(sourceAuth);
});
test("unrelated discovery fails before provisioning any provider state", () => {
  const f = fixture("share");
  const result = f.run({ HMUX_DISCOVERY_ROOT: f.source });
  expect(result.status).not.toBe(0);
  expect(fs.existsSync(path.join(f.home, ".zprofile"))).toBe(false);
  expect(fs.existsSync(path.join(f.home, ".codex"))).toBe(false);
  expect(fs.readFileSync(path.join(f.source, "auth.json"), "utf8")).toBe(sourceAuth);
});
test("explicit live sharing copies only the selected app credentials privately and owns its source data", () => {
  const f = fixture("share");
  const credentials = path.join(f.source, "slack.json");
  fs.writeFileSync(credentials, JSON.stringify({ appToken: "private-app", botToken: "private-bot", unrelated: "do-not-copy" }), { mode: 0o600 });
  const result = f.run({ DURE_QA_SLACK_LIVE: "1", DURE_QA_SLACK_LIVE_CREDENTIALS: credentials,
    DURE_QA_SLACK_TEAM: "TREAL", DURE_QA_SLACK_CHANNEL: "CREAL" });
  expect(result.status, result.stderr).toBe(0);
  const destination = path.join(f.home, "slack-live.json");
  expect(JSON.parse(fs.readFileSync(destination, "utf8"))).toEqual({
    appToken: "private-app", botToken: "private-bot", teamId: "TREAL", channelId: "CREAL",
  });
  expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(path.join(f.home, "project", "counts.txt"), "utf8")).toBe("17\n26\n");
  expect(result.stdout + result.stderr).not.toContain("private-app");
  expect(result.stdout + result.stderr).not.toContain("private-bot");
});
