import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ foreignProject = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-conversion-client-"));
  roots.push(root);
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const qa = path.join(repo, "scripts", "qa");
  fs.mkdirSync(path.join(qa, "lib"), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, "conversion-home-setup.json"), JSON.stringify({
    schema: 1, ok: true, profile: "codex-selected", sharedDirectories: [], appendFiles: [],
    project: path.join(root, foreignProject ? "foreign" : "project"),
  }));
  for (const file of ["hmux-session-conversion-client.mjs", "lib/qa-log-receipt.mjs"])
    fs.copyFileSync(fileURLToPath(new URL(file, import.meta.url)), path.join(qa, file));
  const probe = path.join(root, "hook-probe.json");
  fs.writeFileSync(path.join(qa, "managed-claude-hook-channel-handoff-smoke.mjs"), `
    import fs from 'node:fs';
    fs.writeFileSync(process.env.FIXTURE_PROBE, JSON.stringify({
      parent: process.ppid, home: process.env.HOME, stateRoot: process.env.DURE_QA_STATE_ROOT,
      temporaryRoot: process.env.TMPDIR, discovery: process.env.HMUX_DISCOVERY_ROOT,
    }));
    console.error('controlled-hook-refusal');
    process.exit(17);
  `);
  const result = spawnSync(process.execPath, [path.join(qa, "hmux-session-conversion-client.mjs")], {
    cwd: repo, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: home, DURE_HOME: path.join(home, ".dure"),
      DURE_QA_STATE_ROOT: root, HMUX_DISCOVERY_ROOT: path.join(root, "hmux-discovery"),
      DURE_QA_HMUX_CLI: "fixture-hmux-never-executed", DURE_HMUX_RUNTIME_BIN: "fixture-runtime-never-executed",
      HEBBIAN_QA_CODEX_BIN: "fixture-codex-never-executed", HEBBIAN_QA_CLAUDE_BIN: "fixture-claude-never-executed",
      DURE_QA_SERVER_DESCRIPTOR: path.join(root, "no-server.json"), FIXTURE_PROBE: probe },
  });
  return { root, home, probe, result };
}

test("retains the hook prerequisite in the isolated client's process and data scope", () => {
  const f = fixture();
  expect(f.result.status).toBe(1);
  expect(f.result.stderr).toContain("channel handoff hook probe failed: controlled-hook-refusal");
  expect(JSON.parse(fs.readFileSync(f.probe, "utf8"))).toEqual({
    parent: f.result.pid, home: f.home, stateRoot: f.root, temporaryRoot: f.root,
    discovery: path.join(f.root, "hmux-discovery"),
  });
});

test("refuses a foreign project receipt before any hook or provider starts", () => {
  const f = fixture({ foreignProject: true });
  expect(f.result.status).toBe(1);
  expect(f.result.stderr).toContain("conversion home setup receipt is invalid");
  expect(fs.existsSync(f.probe)).toBe(false);
});
