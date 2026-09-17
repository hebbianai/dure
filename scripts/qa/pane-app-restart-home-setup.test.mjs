import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const setup = fileURLToPath(new URL("./pane-app-restart-home-setup.mjs", import.meta.url));
const proof = "00000000-0000-4000-8000-000000000077";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dure-pane-app-restart.")));
  const home = join(root, "home");
  const discoveryRoot = join(root, "hmux-discovery");
  mkdirSync(join(home, ".dure"), { recursive: true, mode: 0o700 });
  mkdirSync(discoveryRoot, { mode: 0o700 });
  const environment = {
    PATH: process.env.PATH,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    HOME: home, DURE_HOME: join(home, ".dure"),
    HMUX_DISCOVERY_ROOT: discoveryRoot, DURE_QA_STATE_ROOT: root,
    DURE_QA_PANE_RESTART_PROOF: proof,
  };
  const run = (overrides = {}) => spawnSync(process.execPath, [setup], {
    env: { ...environment, ...overrides }, cwd: root,
    encoding: "utf8", timeout: 10000, maxBuffer: 16000,
  });
  return { root, home, run, baseline: join(root, "pane-restart.json"), autorun: join(root, "qa.autorun") };
}

test("seeds one owned first-boot baseline and no inherited autorun scenario", () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.baseline, "utf8")), { schemaVersion: 1, proof, phase: "fresh" });
  assert.equal(readFileSync(f.autorun, "utf8"), "");
  for (const file of [f.baseline, f.autorun]) assert.equal(statSync(file).mode & 0o777, 0o600);
});

for (const change of ["home", "discovery", "proof"]) {
  test(`refuses a mismatched ${change} before creating the first-boot baseline`, () => {
    const f = fixture();
    const overrides = change === "home" ? { HOME: f.root }
      : change === "discovery" ? { HMUX_DISCOVERY_ROOT: f.home }
      : { DURE_QA_PANE_RESTART_PROOF: "not-the-run-proof" };
    const result = f.run(overrides);
    assert.equal(result.status, 1);
    assert.equal(existsSync(f.baseline), false);
    assert.equal(existsSync(f.autorun), false);
  });
}

test("a repeated setup cannot replace the prepared restart baseline", () => {
  const f = fixture();
  const prepared = JSON.stringify({ schemaVersion: 1, proof, phase: "prepared", retainedEvidence: true });
  writeFileSync(f.baseline, prepared, { mode: 0o600 });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.baseline, "utf8"), prepared);
  assert.equal(existsSync(f.autorun), false);
});

test("an unexpected existing autorun file is preserved and setup fails", () => {
  const f = fixture();
  writeFileSync(f.autorun, "unexpected-scenario", { mode: 0o600 });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.autorun, "utf8"), "unexpected-scenario");
  assert.deepEqual(JSON.parse(readFileSync(f.baseline, "utf8")), { schemaVersion: 1, proof, phase: "fresh" });
});
