import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { findQaLogReceipt, resolveQaLogPath } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_PROGRAM_STATUS_PROOF;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const home = process.env.HOME;
assert.ok(proof && evidence && stateRoot && home, "Run through program-status-spaces-smoke.sh");
assert.ok(home.startsWith(`${stateRoot}/`), "QA HOME must stay inside its state root");

async function receipt(phase, timeoutMs = 240_000) {
  const logPath = resolveQaLogPath();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let log = "";
    try {
      log = readFileSync(logPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const failed = findQaLogReceipt(log, "program-status-spaces-failed", proof);
    if (failed) throw new Error(`In-app probe failed: ${failed.error}`);
    const found = findQaLogReceipt(log, `program-status-spaces-${phase}`, proof);
    if (found) return found;
    await delay(100);
  }
  throw new Error(`No ${phase} receipt for ${proof}`);
}

/** Pixels are supporting evidence; the DOM receipts are the proof. Capturing by
 * window id never raises the app, so the background layer's focus guard holds. */
function capture(name) {
  try {
    const { processId } = JSON.parse(readFileSync(process.env.DURE_QA_SERVER_DESCRIPTOR, "utf8"));
    const source = join(stateRoot, "window-id.swift");
    writeFileSync(source, `import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]
let owned = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
let area = { (window: [String: Any]) -> Double in
  let bounds = window[kCGWindowBounds as String] as! [String: Double]
  return bounds["Width"]! * bounds["Height"]!
}
print(owned.max { area($0) < area($1) }![kCGWindowNumber as String]!)
`);
    const windowId = execFileSync("/usr/bin/swift", [source, String(processId)], {
      encoding: "utf8", timeout: 90_000,
    }).trim();
    execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", windowId, join(evidence, name)]);
    return { name, captured: true };
  } catch (error) {
    return { name, captured: false, error: String(error.message ?? error) };
  }
}

const ready = await receipt("ready");
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
