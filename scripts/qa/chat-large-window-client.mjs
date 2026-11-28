import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_CHAT_LARGE_WINDOW_PROOF;
const root = process.env.DURE_QA_STATE_ROOT;
assert.ok(proof && root, "Run through chat-large-window-smoke.sh");
const receipt = await waitForQaLogReceipt("chat-large-window", proof, { timeoutMs: 180_000 });
if (receipt.result === "passed") {
  try {
    verifyReceipt(receipt);
  } catch (error) {
    receipt.result = "failed";
    receipt.error = error.message;
  }
}
fs.writeFileSync(path.join(root, "evidence", "chat-large-window.json"), JSON.stringify(receipt, null, 2));
const artifacts = process.env.DURE_QA_ARTIFACT_ROOT ?? "artifacts/qa";
fs.mkdirSync(artifacts, { recursive: true });
fs.writeFileSync(path.join(artifacts, `chat-large-window-${proof}.json`), JSON.stringify(receipt, null, 2), { flag: "wx" });
assert.equal(receipt.result, "passed", JSON.stringify(receipt));
console.log("Native Chat large window toolbar, send, source proxy, View round trip and keep on top: PASS", { proof });

/** The large window rendered the pane's Chat toolbar, sent through its own
 * session, made the source pane hand over its composer, and followed the
 * Agent's View into its Terminal and back, with the switch run on the pane.
 * Its keep-on-top toggle put the native window on top, the reopened window
 * came back on top, and turning it off returned it to the normal level, as
 * both windows read it natively. */
function verifyReceipt(report) {
  const phases = [
    "ready", "send", "view-terminal", "terminal-followed", "chat-followed",
    "keep-on-top", "reopened", "keep-on-top-off",
  ];
  assert.deepEqual(report.observations.map(({ phase }) => phase), phases);
  assert.ok(report.label && report.largeLabel && report.label !== report.largeLabel, "Two native windows are required");
  for (const observed of report.observations) {
    assert.equal(observed.proof, proof, `Wrong run at ${observed.phase}`);
    assert.equal(observed.label, report.largeLabel, `Wrong window at ${observed.phase}`);
    assert.equal(observed.error, undefined, `${observed.phase}: ${observed.error}`);
  }
  const [ready, sent, , terminal, chat, kept, reopened, released] = report.observations;
  assert.equal(ready.toolbar, true, "The large window has no Chat toolbar");
  assert.equal(ready.viewEnabled, true, "The large window's View control is locked");
  assert.equal(ready.composer, true, "The large window has no composer");
  assert.equal(ready.agentView, "chat");
  assert.equal(report.proxyShown, true, "The source pane kept its composer");
  assert.deepEqual(sent.sent, [report.typed], "The message did not reach the session");
  assert.equal(report.sourceSent, 0, "The source pane sent the large window's message");
  assert.deepEqual(report.switchRequests, [{ sourceStopPolicy: "preserve" }], "The View switch did not run on the source pane");
  assert.equal(terminal.agentView, "terminal");
  assert.equal(terminal.composer, false, "The large window kept the Chat after the switch");
  assert.equal(chat.agentView, "chat");
  assert.equal(chat.composer && chat.toolbar, true, "The large window did not return to Chat");
  assert.equal(ready.keepOnTopPressed, "false", "The large window has no keep-on-top toggle, or it started on");
  assert.deepEqual([kept.keepOnTopPressed, kept.alwaysOnTop], ["true", true], "Keep on top did not put the window on top");
  assert.deepEqual([reopened.keepOnTopPressed, reopened.alwaysOnTop], ["true", true], "The reopened window did not come back on top");
  assert.deepEqual([released.keepOnTopPressed, released.alwaysOnTop], ["false", false], "Turning it off left the window on top");
  assert.deepEqual(
    report.sourceReads,
    { keptOnTop: true, reopenedAtCreation: true, released: false },
    "The source window read another native level",
  );
  assert.match(report.userAgent, /AppleWebKit/u);
  assert.doesNotMatch(report.userAgent, /Chrom(?:e|ium)/u);
}
