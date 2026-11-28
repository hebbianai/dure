import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appWindowId, captureAppWindow } from "./lib/app-window-capture.mjs";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_WORK_DETAIL_PROOF;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const home = process.env.HOME;
assert.ok(proof && evidence && stateRoot && home, "Run through work-detail-layout-smoke.sh");
assert.ok(home.startsWith(`${stateRoot}/`), "QA HOME must stay inside its state root");

const PHASES = [
  "five-light", "five-dark", "few-light", "few-dark", "many-light", "many-dark",
  "empty-light", "empty-dark", "many-folded-dark", "ended-few-light",
  "ended-few-dark", "ended-many-light", "ended-many-dark", "pinned-light",
];

function receipt(phase, timeoutMs = 240_000) {
  return waitForQaLogReceipt(`work-detail-layout-${phase}`, proof, {
    timeoutMs, failedName: "work-detail-layout-failed",
  });
}

const near = (value, target, slack = 1) => Math.abs(value - target) <= slack;

/** The managed agents, a hairline, then the labelled conversation: both
 * labels on one edge with the rows' dots under them, the card not saying
 * what the fold says, each request on one line, and the fold line, its rows
 * and the label within a third of the detail, the rows ending on a whole
 * row. */
function verifyLayout(phase, facts) {
  const shown = facts.shown;
  assert.ok(shown.heading, `${phase}: the conversation has no label`);
  assert.equal(shown.heading.borderTop, "1px", `${phase}: no hairline above the conversation`);
  assert.ok(shown.conversation && shown.conversation.top >= shown.heading.rect.bottom - 0.5,
    `${phase}: the conversation starts above its label`);
  assert.ok(shown.conversation.bottom <= facts.viewport.height + 0.5 && shown.conversation.height > 200,
    `${phase}: the conversation is pushed off screen`);
  assert.equal(shown.cardSaysManaged, false, `${phase}: the card repeats what it manages`);
  if (phase.startsWith("empty") || phase.startsWith("ended")) {
    assert.equal(shown.managed, null, `${phase}: an agent that manages nobody shows a managed part`);
    verifyEnded(phase, shown.transcript);
    return;
  }
  const managed = shown.managed;
  assert.ok(managed, `${phase}: no managed part`);
  assert.equal(managed.borderTop, "1px", `${phase}: no hairline above the managed agents`);
  assert.equal(managed.borderColor, shown.heading.borderColor, `${phase}: the two hairlines differ`);
  assert.ok(managed.rect.bottom <= shown.heading.rect.top + 0.5, `${phase}: the label overlaps the list`);
  assert.ok(near(managed.labelLeft, shown.heading.labelLeft),
    `${phase}: the two labels start at ${managed.labelLeft} and ${shown.heading.labelLeft}`);
  if (!facts.managedOpen) {
    assert.equal(managed.open, false);
    assert.deepEqual(managed.variants, [], `${phase}: a folded list still shows rows`);
    return;
  }
  assert.equal(managed.open, true);
  assert.ok(managed.variants.every((variant) => variant === "compact"), `${phase}: a row is not compact`);
  assert.ok(near(managed.rowDotLeft, managed.labelLeft),
    `${phase}: the rows' dots stand at ${managed.rowDotLeft}, the labels at ${managed.labelLeft}`);
  for (const activity of managed.activities) {
    assert.ok(activity, `${phase}: a row lost what it was asked`);
    assert.equal(activity.clamp, "1", `${phase}: a request is not clamped to one line`);
    assert.ok(near(activity.height, activity.lineHeight), `${phase}: a request takes more than one line`);
  }
  assert.ok(managed.rect.height + shown.heading.rect.height <= shown.detailHeight * 0.35 + 1,
    `${phase}: the managed part and the label take more than a third of the detail`);
  if (managed.scroller.scrollHeight > managed.scroller.clientHeight + 1) {
    assert.ok(managed.rowBottoms.some((bottom) => near(bottom, managed.scroller.clientHeight)),
      `${phase}: the capped rows end inside a row (${managed.scroller.clientHeight} of ${managed.rowBottoms})`);
  }
}

/** An ended agent shows its last conversation, from its first message to its
 * last in view, with no composer and nothing reported failed; one whose
 * history is gone (the solo agent) says it has no record, as before. */
function verifyEnded(phase, transcript) {
  assert.equal(transcript.composer, false, `${phase}: an ended agent offers a composer`);
  assert.equal(transcript.alert, false, `${phase}: the conversation reports a failure`);
  if (phase.startsWith("empty")) {
    assert.equal(transcript.none, true, `${phase}: a gone history does not say there is no record`);
    return;
  }
  assert.equal(transcript.none, false, `${phase}: the ended conversation says there is no record`);
  assert.ok(transcript.shows.length > 0 && transcript.shows.every(Boolean),
    `${phase}: the conversation misses a message (${transcript.shows})`);
  assert.equal(transcript.lastVisible, true, `${phase}: the last message is out of view`);
}

// A cold worktree spends minutes in Vite dependency reloads; the window
// exists once the probe has started.
await receipt("started", 480_000);
const windowId = appWindowId();
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
  captureAppWindow(windowId, join(evidence, name));
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
  assert.equal(five.variants.length, 5, "The five-agent lead does not list five");
  assert.equal(reports["few-light"].shown.managed.variants.length, 2);
  assert.equal(many.variants.length, 12);
  assert.ok(many.scroller.scrollHeight > many.scroller.clientHeight, "Many agents do not scroll within their cap");
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
console.log("PASS: Work detail shows the managed agents, a hairline and the labelled conversation in light and dark, folded and pinned, and an ended agent's last conversation read only", { imageDir });
