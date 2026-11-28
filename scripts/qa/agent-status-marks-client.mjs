import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appWindowId, captureAppWindow } from "./lib/app-window-capture.mjs";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_AGENT_STATUS_PROOF;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const home = process.env.HOME;
assert.ok(proof && evidence && stateRoot && home, "Run through agent-status-marks-smoke.sh");
assert.ok(home.startsWith(`${stateRoot}/`), "QA HOME must stay inside its state root");

const PHASES = ["work-light", "work-dark", "spaces-light", "spaces-dark", "motion-dark", "motion-light"];
/** Frames a motion phase keeps, a third of the 2.8s breath apart. */
const MOTION_FRAMES = 9;

function receipt(phase, timeoutMs = 240_000) {
  return waitForQaLogReceipt(`agent-status-marks-${phase}`, proof, {
    timeoutMs, failedName: "agent-status-marks-failed",
  });
}

/** CSS colours as the browser serialises them, for comparing a dot with a
 * token: a hex token and an rgb() background are the same colour. */
function rgb(value) {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value.trim());
  if (!hex) return value.replaceAll(" ", "");
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex[1].slice(at, at + 2), 16));
  return `rgb(${r},${g},${b})`;
}

/** Working is green and breathes; needs-you takes the accent, error red; a
 * finished turn is quiet and still; exited is hollow; nothing else moves
 * but connecting's pulse. */
function verifyMarks(phase, facts) {
  const marks = facts.marks;
  assert.ok(marks.length >= 8, `${phase}: only ${marks.length} marks on screen`);
  const tones = new Set(marks.map((mark) => mark.tone));
  for (const mark of marks) {
    const where = `${phase}: ${mark.label} (${mark.row ?? "glyph"})`;
    assert.equal(mark.ring === "agent-status-breathe", mark.motion === "breathe", `${where}: breathing does not follow the state`);
    assert.equal(mark.motion === "breathe", mark.tone === "live", `${where}: only working breathes`);
    if (mark.tone === "live") {
      assert.equal(mark.background.replaceAll(" ", ""), rgb(facts.tokens["--status-run"]), `${where}: working is not the green token`);
      assert.equal(mark.ringState, "running", `${where}: the breath is paused on screen`);
    }
    if (mark.tone === "attention")
      assert.equal(mark.background.replaceAll(" ", ""), rgb(facts.tokens["--status-blocked"]), `${where}: needs-you is not the accent`);
    if (mark.tone === "danger")
      assert.equal(mark.background.replaceAll(" ", ""), rgb(facts.tokens["--status-error"]), `${where}: error is not red`);
    if (mark.fill === "hollow") assert.equal(mark.background, "rgba(0, 0, 0, 0)", `${where}: exited is filled`);
    assert.equal(mark.pulse !== "none", mark.motion === "pulse", `${where}: pulse does not follow the state`);
  }
  for (const tone of ["live", "attention", "danger", "neutral"])
    assert.ok(tones.has(tone), `${phase}: no ${tone} mark on screen`);
  if (phase.startsWith("work")) assert.ok(tones.has("rest"), `${phase}: no resting mark in the Work view`);
}

await receipt("started", 480_000);
const windowId = appWindowId();
const images = [];
const reports = {};
const artifacts = process.env.DURE_QA_ARTIFACT_ROOT ?? "artifacts/qa";
const imageDir = join(artifacts, `agent-status-marks-${proof}`);
mkdirSync(imageDir, { recursive: true });
const capture = (name) => {
  captureAppWindow(windowId, join(evidence, name));
  copyFileSync(join(evidence, name), join(imageDir, name));
  images.push(name);
};
for (const phase of PHASES) {
  reports[phase] = await receipt(phase);
  // An off-screen WKWebView window composites after the DOM settles.
  await delay(1_000);
  if (phase.startsWith("motion")) {
    for (let frame = 0; frame < MOTION_FRAMES; frame += 1) {
      capture(`${phase}-${String(frame).padStart(2, "0")}.png`);
      await delay(280);
    }
  } else {
    capture(`${phase}.png`);
  }
  writeFileSync(join(home, `agent-status-captured-${phase}`), "");
}
await receipt("done");

const failures = [];
for (const phase of PHASES) {
  try {
    assert.equal(reports[phase].dark, phase.endsWith("dark"), `${phase}: wrong theme`);
    verifyMarks(phase, reports[phase]);
  } catch (error) {
    failures.push(error.message);
  }
}
const report = { result: failures.length === 0 ? "passed" : "failed", failures, images, reports };
writeFileSync(join(evidence, "agent-status-marks.json"), JSON.stringify(report, null, 2));
writeFileSync(join(imageDir, "agent-status-marks.json"), JSON.stringify(report, null, 2));
assert.deepEqual(failures, [], JSON.stringify(failures));
console.log("PASS: working agents read green and breathe, needs-you takes the accent, idle stays quiet, in light and dark", { imageDir });
