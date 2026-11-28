import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appWindowId, captureAppWindow } from "./lib/app-window-capture.mjs";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_PROGRAM_STATUS_PROOF;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const home = process.env.HOME;
assert.ok(proof && evidence && stateRoot && home, "Run through program-status-spaces-smoke.sh");
assert.ok(home.startsWith(`${stateRoot}/`), "QA HOME must stay inside its state root");

function receipt(phase, timeoutMs = 240_000) {
  return waitForQaLogReceipt(`program-status-spaces-${phase}`, proof, {
    timeoutMs, failedName: "program-status-spaces-failed",
  });
}

/** Pixels are supporting evidence; the DOM receipts are the proof. */
function capture(name) {
  try {
    captureAppWindow(appWindowId(), join(evidence, name));
    return { name, captured: true };
  } catch (error) {
    return { name, captured: false, error: String(error.message ?? error) };
  }
}

// A cold worktree spends minutes in Vite dependency reloads before the probe runs.
const ready = await receipt("ready", 480_000);
assert.equal(ready.isRegisteredAgent, false, "The pane must not be a registered Agent");
assert.notEqual(ready.activeSpace, ready.paneSpace, "The pane's Space must be off-screen");
assert.equal(ready.rowHasBadge, false);
assert.deepEqual(ready.rollups, []);

writeFileSync(join(home, "program-status-block"), "");
const { repositoryGrouping, spaceGrouping } = await receipt("blocked");
const blockedImage = capture("blocked.png");

for (const facts of [repositoryGrouping, spaceGrouping]) {
  assert.notEqual(facts.activeSpace, facts.paneSpace, "The wait must begin off-screen");
  assert.equal(facts.rowHasBadge, true, "The row repeats the program's label");
  assert.equal(facts.programStatus?.state, "blocked");
  assert.equal(facts.programStatus?.blocked_kind, "permission");
  assert.equal(facts.programStatus?.app, "codex");
  assert.equal(facts.hostAttention, "none", "The report must not become Host attention");
  assert.deepEqual(facts.attentionDisplayStates, [], "No Agent attention state appears");
  assert.deepEqual(facts.attentionEpisodes, [], "No episode can reach a notification");
  assert.equal(facts.nextUpChip, false, "Next-up membership is unchanged");
  for (const label of facts.rollups) assert.equal(label, facts.expectedRollup);
}
assert.equal(repositoryGrouping.rollups.length, 2, "Repository and Space headings both roll up");
assert.equal(repositoryGrouping.spaceHeadingRollup, repositoryGrouping.expectedRollup);
assert.equal(spaceGrouping.rollups.length, 1, "The Space heading rolls up alone");
assert.equal(spaceGrouping.spaceHeadingRollup, spaceGrouping.expectedRollup);

writeFileSync(join(home, "program-status-clear"), "");
const cleared = await receipt("cleared");
const clearedImage = capture("cleared.png");
assert.equal(cleared.rowHasBadge, false, "The row clears with the program's report");
assert.deepEqual(cleared.rollups, [], "The rollup clears with the program's report");
assert.equal(cleared.spaceHeadingRollup, null);
assert.equal(cleared.hostAttention, "none");
assert.deepEqual(cleared.attentionEpisodes, []);

writeFileSync(join(evidence, "program-status-spaces.json"), JSON.stringify({
  result: "passed", ready, repositoryGrouping, spaceGrouping, cleared, images: [blockedImage, clearedImage],
}, null, 2));
console.log("PASS: OSC 7501 reached an off-screen non-Agent pane's Spaces row and rollups, cleared with the program, and left Host attention untouched", [blockedImage, clearedImage]);
