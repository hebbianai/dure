import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "vitest";

const execute = promisify(execFile);
const entry = resolve("scripts/qa/browser-panel-smoke.mjs");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function launch(mode, optIn) {
  const root = mkdtempSync(join(tmpdir(), "dure-browser-ime-entry-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  const receipt = join(root, "captured.json");
  // The child is a local recorder: these admission tests never build or launch an app.
  writeFileSync(join(root, "scripts/run-with-build-storage.mjs"), `
    import {writeFileSync} from 'node:fs';
    writeFileSync('captured.json', JSON.stringify({args: process.argv.slice(2),
      layer: process.env.DURE_QA_LAYER, ime: process.env.DURE_BROWSER_PANEL_OS_IME,
      viteIme: process.env.VITE_DURE_BROWSER_QA_OS_IME,
      required: process.env.DURE_QA_REQUIRE_EXECUTION,
      plan: JSON.parse(process.env.DURE_QA_WINDOW_PLAN_JSON)}));
  `);
  const env = { ...process.env, DURE_QA_LAYER: "exclusive_focus_injected", DURE_BROWSER_PANEL_OS_IME: "1" };
  delete env.HEBBIAN_QA_ALLOW_FOCUS_STEAL;
  if (optIn) env.HEBBIAN_QA_ALLOW_FOCUS_STEAL = "1";
  await execute(process.execPath, [entry, "fixture", "engine", "chromium", ...mode], { cwd: root, env, timeout: 10_000 });
  return JSON.parse(readFileSync(receipt, "utf8"));
}

describe.skipIf(process.platform !== "darwin")("Browser panel native IME admission", () => {
  it("preserves background mode even with ambient native flags", async () => {
    const row = await launch([], true);
    assert.deepEqual(row.args, ["qa", "--", "sh", "scripts/qa/lib/tauri-app-runner.sh"]);
    assert.equal(row.layer, "background");
    assert.equal(row.ime, "0");
    assert.equal(row.viteIme, "0");
    assert.equal(row.plan[0].focus, false);
    assert.equal(row.plan[0].focusable, false);
    assert.equal(row.plan[0].x, -4000);
  });
  it("requires the canonical exclusive lock and normal QA storage for explicit OS IME mode", async () => {
    const row = await launch(["--os-ime"], true);
    assert.deepEqual(row.args, ["qa", "--", "sh", "scripts/qa/lib/hmux-exclusive-focus-runner.sh"]);
    assert.equal(row.layer, "exclusive_focus_browser_ime");
    assert.equal(row.ime, "1");
    assert.equal(row.viteIme, "1");
    assert.equal(row.required, "1");
    assert.equal(row.plan[0].focus, false);
    assert.equal(row.plan[0].focusable, true);
    assert.equal(row.plan[0].title, "Dure Browser Panel QA");
  });
  it("refuses OS IME mode without explicit foreground opt-in", async () => {
    await assert.rejects(launch(["--os-ime"], false), /explicit foreground maintenance window/u);
  });
  it("refuses unknown or extra native modes", async () => {
    await assert.rejects(launch(["--unknown"], true), /usage:/u);
    await assert.rejects(launch(["--os-ime", "extra"], true), /usage:/u);
  });
});
