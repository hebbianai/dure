import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { findQaLogReceipt, resolveQaLogPath } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_WORK_DETAIL_PROOF;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const home = process.env.HOME;
assert.ok(proof && evidence && stateRoot && home, "Run through work-detail-layout-smoke.sh");
assert.ok(home.startsWith(`${stateRoot}/`), "QA HOME must stay inside its state root");

const PHASES = [
  "five-light", "five-dark", "few-light", "few-dark", "many-light", "many-dark",
  "empty-light", "empty-dark", "many-folded-dark", "pinned-light",
];

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
    const failed = findQaLogReceipt(log, "work-detail-layout-failed", proof);
    if (failed) throw new Error(`In-app probe failed: ${JSON.stringify(failed)}`);
    const found = findQaLogReceipt(log, `work-detail-layout-${phase}`, proof);
    if (found) return found;
    await delay(100);
  }
  throw new Error(`No ${phase} receipt for ${proof}`);
}

/** The app's largest normal-layer window, by id. Capturing by window id never
 * raises the app, so the background layer's focus guard holds. */
function appWindowId() {
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
  return execFileSync("/usr/bin/swift", [source, String(processId)], {
    encoding: "utf8", timeout: 120_000,
  }).trim();
}

const near = (value, target, slack = 1) => Math.abs(value - target) <= slack;

/** The managed agents, a hairline, then the labelled conversation, with each
 * row's request on one line and the list never taller than a third of the
 * window. */
function verifyLayout(phase, facts) {
  const shown = facts.shown;
  assert.ok(shown.heading, `${phase}: the conversation has no label`);
  assert.equal(shown.heading.borderTop, "1px", `${phase}: no hairline above the conversation`);
  assert.ok(shown.conversation && shown.conversation.top >= shown.heading.rect.bottom - 0.5,
    `${phase}: the conversation starts above its label`);
  assert.ok(shown.conversation.bottom <= facts.viewport.height + 0.5 && shown.conversation.height > 200,
    `${phase}: the conversation is pushed off screen`);
  if (phase.startsWith("empty")) {
    assert.equal(shown.managed, null, `${phase}: an agent that manages nobody shows a managed part`);
    return;
  }
  const managed = shown.managed;
  assert.ok(managed, `${phase}: no managed part`);
  assert.equal(managed.borderTop, "1px", `${phase}: no hairline above the managed agents`);
  assert.equal(managed.borderColor, shown.heading.borderColor, `${phase}: the two hairlines differ`);
  assert.ok(managed.rect.bottom <= shown.heading.rect.top + 0.5, `${phase}: the label overlaps the list`);
  if (!facts.managedOpen) {
    assert.equal(managed.open, false);
    assert.deepEqual(managed.rows, [], `${phase}: a folded list still shows rows`);
    return;
  }
  assert.equal(managed.open, true);
  assert.ok(managed.rows.every((variant) => variant === "compact"), `${phase}: a row is not compact`);
  for (const activity of managed.activities) {
    assert.ok(activity, `${phase}: a row lost what it was asked`);
    assert.equal(activity.clamp, "1", `${phase}: a request is not clamped to one line`);
    assert.ok(near(activity.height, activity.lineHeight), `${phase}: a request takes more than one line`);
  }
  assert.ok(managed.body.height <= facts.viewport.height * 0.35 + 1,
    `${phase}: the managed list is taller than its cap`);
}

const windowId = await (async () => {
  await receipt("started", 480_000);
  // A cold worktree spends minutes in Vite dependency reloads; the window
  // exists once the probe has started.
  return appWindowId();
})();
const images = [];
const reports = {};
const artifacts = process.env.DURE_QA_ARTIFACT_ROOT ?? "artifacts/qa";
const imageDir = join(artifacts, `work-detail-layout-${proof}`);
mkdirSync(imageDir, { recursive: true });
for (const phase of PHASES) {
  const facts = await receipt(phase);
  reports[phase] = facts;
  const name = `${phase}.png`;
  // An off-screen WKWebView window composites after the DOM settles; a
  // theme switch can still be on its way to the window's backing store.
  await delay(1_000);
  execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", windowId, join(evidence, name)]);
  copyFileSync(join(evidence, name), join(imageDir, name));
  images.push(name);
  writeFileSync(join(home, `work-detail-captured-${phase}`), "");
}
await receipt("done");

const failures = [];
for (const phase of PHASES) {
  try {
    const facts = reports[phase];
    assert.equal(facts.dark, phase.includes("dark"), `${phase}: wrong theme`);
    verifyLayout(phase, facts);
  } catch (error) {
    failures.push(error.message);
  }
}
const five = reports["five-light"].shown.managed;
const many = reports["many-light"].shown.managed;
const folded = reports["many-folded-dark"];
const pinned = reports["pinned-light"];
try {
  assert.equal(five.rows.length, 5, "The five-agent lead does not list five");
  assert.equal(reports["few-light"].shown.managed.rows.length, 2);
  assert.equal(many.rows.length, 12);
  assert.ok(many.body.scrollHeight > many.body.clientHeight, "Many agents do not scroll within their cap");
  assert.ok(near(folded.headerBeforeFold, folded.headerAfterFold, 0.5), "Folding moved what is above it");
  assert.deepEqual(pinned.columns, ["qa-lead-five", "qa-solo"], "The pinned column is not beside the selection");
  assert.equal(pinned.beside?.managed ?? null, null, "The selection beside the pin shows a managed part");
} catch (error) {
  failures.push(error.message);
}

const report = { result: failures.length === 0 ? "passed" : "failed", failures, images, reports };
writeFileSync(join(evidence, "work-detail-layout.json"), JSON.stringify(report, null, 2));
writeFileSync(join(imageDir, "work-detail-layout.json"), JSON.stringify(report, null, 2));
assert.deepEqual(failures, [], JSON.stringify(failures));
console.log("PASS: Work detail shows the managed agents, a hairline and the labelled conversation in light and dark, folded and pinned", { imageDir });
