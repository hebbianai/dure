import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appWindowId, captureAppWindow } from "./lib/app-window-capture.mjs";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_WORK_VIEW_ENDED_PROOF;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const home = process.env.HOME;
assert.ok(proof && evidence && stateRoot && home, "Run through work-view-ended-smoke.sh");
assert.ok(home.startsWith(`${stateRoot}/`), "QA HOME must stay inside its state root");

function receipt(phase, timeoutMs = 240_000) {
  return waitForQaLogReceipt(`work-view-ended-${phase}`, proof, {
    timeoutMs, failedName: "work-view-ended-failed",
  });
}

let windowId;
function capture(name) {
  windowId ??= appWindowId();
  captureAppWindow(windowId, join(evidence, name));
  return name;
}

const folds = (facts) => facts.folds.map(({ label, open, section }) => [section, label, open]);
const folded = (facts) => facts.rows.filter((row) => row.folded).map((row) => row.key).sort();

// A cold worktree spends minutes in Vite dependency reloads before the probe runs.
await receipt("ready", 600_000);
const results = {};
const images = [];
for (const scene of ["empty", "few", "many"]) {
  for (const theme of ["light", "dark"]) {
    const phase = `${scene}-${theme}`;
    const facts = await receipt(phase, 300_000);
    assert.equal(facts.dark, theme === "dark", `${phase}: theme`);
    results[phase] = facts;
    images.push(capture(`${phase}.png`));
    writeFileSync(join(home, `captured-${phase}`), "");
  }
}

const { empty, few, many } = {
  empty: results["empty-light"],
  few: results["few-light"],
  many: results["many-light"],
};
assert.equal(empty.empty, true, "No agents: the list offers the empty state");
assert.deepEqual(folds(few), [
  ["dure", "Ended · 1", false],
  ["api", "Ended · 1", false],
]);
assert.deepEqual(folded(few), ["few-migrate", "few-notes"]);
assert.deepEqual(folds(many), [
  ["dure", "Ended · 3", true],
  ["api", "Ended · 2", false],
  ["docs", "Ended · 3", false],
]);
// The lead keeps its ended worker open; the starting agent is unknown, never ended.
assert.equal(many.displayStates["many-starting"], "unknown");
assert.equal(many.rows.find((row) => row.key === "many-starting")?.folded, false);
assert.equal(many.rows.find((row) => row.key === "many-lead")?.folded, false);
for (const key of ["many-gc", "many-zstd", "many-release"]) {
  assert.equal(many.rows.find((row) => row.key === key)?.visible, true, `${key} shows in the open fold`);
}
// The Host-exit fact the observer recorded for every agent whose session is gone.
for (const key of folded(many)) assert.equal(many.agentActivity[key], "exited");

await receipt("done");
writeFileSync(join(evidence, "work-view-ended.json"), JSON.stringify({ result: "passed", results, images }, null, 2));
console.log("PASS: agents whose Host session is gone read Exited and fold per project, unknown stays open", images);
