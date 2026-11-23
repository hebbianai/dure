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
console.log("Native Chat large window toolbar, send, source proxy and View round trip: PASS", { proof });

/** The large window rendered the pane's Chat toolbar, sent through its own
 * session, made the source pane hand over its composer, and followed the
 * Agent's View into its Terminal and back, with the switch run on the pane. */
function verifyReceipt(report) {
  const phases = ["ready", "send", "view-terminal", "terminal-followed", "chat-followed"];
  assert.deepEqual(report.observations.map(({ phase }) => phase), phases);
  assert.ok(report.label && report.largeLabel && report.label !== report.largeLabel, "Two native windows are required");
  for (const observed of report.observations) {
    assert.equal(observed.proof, proof, `Wrong run at ${observed.phase}`);
    assert.equal(observed.label, report.largeLabel, `Wrong window at ${observed.phase}`);
    assert.equal(observed.error, undefined, `${observed.phase}: ${observed.error}`);
  }
  const [ready, sent, , terminal, chat] = report.observations;
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
  assert.match(report.userAgent, /AppleWebKit/u);
  assert.doesNotMatch(report.userAgent, /Chrom(?:e|ium)/u);
}
