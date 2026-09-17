import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = fileURLToPath(new URL("./slack-connections-home-setup.mjs", import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(scenario) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dure-slack-${scenario}.`)));
  roots.push(root);
  const home = path.join(root, "home");
  const source = path.join(root, "source");
  const discovery = path.join(root, "hmux-discovery");
  for (const directory of [home, source, discovery]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(source, "auth.json"), "private-fixture-auth", { mode: 0o600 });
  return { root, home, source, discovery, run(overrides = {}) {
    return spawnSync(process.execPath, [script], { encoding: "utf8", env: {
      ...process.env, DURE_QA_STATE_ROOT: root, HOME: home, HMUX_DISCOVERY_ROOT: discovery,
      DURE_QA_ARTIFACT_NAME: `slack-${scenario}`, DURE_QA_NODE_BIN: process.execPath,
      DURE_QA_CODEX_BIN: process.execPath, DURE_QA_CODEX_HOME: source,
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
  expect(fs.readFileSync(destination, "utf8")).toBe("private-fixture-auth");
  expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  expect(fs.statSync(destination).ino).not.toBe(fs.statSync(path.join(f.source, "auth.json")).ino);
  fs.writeFileSync(destination, "updated-only-in-isolation");
  expect(fs.readFileSync(path.join(f.source, "auth.json"), "utf8")).toBe("private-fixture-auth");
  expect(fs.existsSync(path.join(f.home, "project", ".git", "HEAD"))).toBe(true);
  expect(fs.existsSync(path.join(f.root, "caller.git"))).toBe(false);
  expect(result.stdout + result.stderr).not.toContain("private-fixture-auth");
});
test("unrelated discovery fails before provisioning any provider state", () => {
  const f = fixture("share");
  const result = f.run({ HMUX_DISCOVERY_ROOT: f.source });
  expect(result.status).not.toBe(0);
  expect(fs.existsSync(path.join(f.home, ".zprofile"))).toBe(false);
  expect(fs.existsSync(path.join(f.home, ".codex"))).toBe(false);
  expect(fs.readFileSync(path.join(f.source, "auth.json"), "utf8")).toBe("private-fixture-auth");
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
