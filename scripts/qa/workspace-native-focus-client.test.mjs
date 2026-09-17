import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { QA_EVIDENCE_FILENAMES } from "./lib/evidence-bundle.mjs";
import { assertNativePaneFocusEvidence, readNativePaneFocusReport, writeNativePaneFocusEvidence } from "./workspace-native-focus-client.mjs";

function fixture() {
  return { qaStatus: { state: "complete", nativeFocus: { samples: [{
    panelId: "term:qa", surfaceId: "main:qa:term:qa", pointerDowns: 1, keyDowns: 1, inputEvents: 1,
    text: "x", trusted: true, focusMs: 2, inputMs: 3,
    focusedAfterInput: true,
    trace: { terminalId: "main:qa:term:qa", source: "keydown", outcome: "complete", hostReceiptMs: 4, echoPaintMs: 8 },
  }] } } };
}

test("accepts a single native click, first character, receipt and paint", () => {
  assert.equal(assertNativePaneFocusEvidence(fixture(), 1, 1).length, 1);
});

for (const [name, mutate] of [
  ["failed workload", (r) => { r.qaStatus.state = "failed"; }],
  ["missing click", (r) => { r.qaStatus.nativeFocus.samples[0].pointerDowns = 0; }],
  ["second click repairs focus", (r) => { r.qaStatus.nativeFocus.samples[0].pointerDowns = 2; }],
  ["lost first key", (r) => { r.qaStatus.nativeFocus.samples[0].keyDowns = 0; }],
  ["focus without text input", (r) => { r.qaStatus.nativeFocus.samples[0].inputEvents = 0; }],
  ["wrong text", (r) => { r.qaStatus.nativeFocus.samples[0].text = ""; }],
  ["synthetic input", (r) => { r.qaStatus.nativeFocus.samples[0].trusted = false; }],
  ["focus before the click", (r) => { r.qaStatus.nativeFocus.samples[0].focusMs = null; }],
  ["input before focus", (r) => { r.qaStatus.nativeFocus.samples[0].inputMs = 1; }],
  ["another pane owns input", (r) => { r.qaStatus.nativeFocus.samples[0].focusedAfterInput = false; }],
  ["another pane supplied the trace", (r) => { r.qaStatus.nativeFocus.samples[0].trace.terminalId = "other"; }],
  ["direct semantic dispatch", (r) => { r.qaStatus.nativeFocus.samples[0].trace.source = "input"; }],
  ["missing Host receipt", (r) => { r.qaStatus.nativeFocus.samples[0].trace.hostReceiptMs = null; }],
  ["missing echo paint", (r) => { r.qaStatus.nativeFocus.samples[0].trace.echoPaintMs = null; }],
  ["paint preceding Host receipt", (r) => { r.qaStatus.nativeFocus.samples[0].trace.echoPaintMs = 1; }],
  ["timed out input", (r) => { r.qaStatus.nativeFocus.samples[0].trace.outcome = "timed_out"; }],
]) {
  test(`rejects ${name}`, () => {
    const report = fixture();
    mutate(report);
    assert.throws(() => assertNativePaneFocusEvidence(report, 1, 1));
  });
}

test("requires all samples and exactly one post per sample", () => {
  assert.throws(() => assertNativePaneFocusEvidence(fixture(), 2, 1));
  assert.throws(() => assertNativePaneFocusEvidence(fixture(), 1, 0));
  assert.throws(() => assertNativePaneFocusEvidence(fixture(), 1, 2));
});

test("preserves the actual failed report receipt instead of masking the server error", async () => {
  const receipt = { ok: false, error: { code: "frontend_timeout", deliveryState: "unclaimed", message: "Dure did not claim the pane request" } };
  await assert.rejects(readNativePaneFocusReport(Response.json(receipt, { status: 504 })), (error) => {
    assert.deepEqual(error.cause, { status: 504, receipt });
    assert.match(error.message, /504.*frontend_timeout.*Dure did not claim/);
    return true;
  });
});

test("normalizes a successful report without changing its measured evidence", async () => {
  const report = { paneFocus: { paint: { count: 1, p95: 7 } } };
  const qaStatus = fixture().qaStatus;
  assert.deepEqual(await readNativePaneFocusReport(Response.json({ ok: true, report, qaStatus })), { ...report, qaStatus });
});

test("failure evidence is collected by the existing QA artifact contract", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dure-native-focus-evidence-"));
  const evidence = { posts: [], failure: { message: "report unavailable", response: { status: 504 } } };
  try {
    writeNativePaneFocusEvidence(directory, evidence);
    const collected = fs.readdirSync(directory).filter((name) => QA_EVIDENCE_FILENAMES.includes(name));
    assert.equal(collected.length, 1);
    const filename = path.join(directory, collected[0]);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), evidence);
    assert.equal(fs.statSync(filename).mode & 0o077, 0);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
