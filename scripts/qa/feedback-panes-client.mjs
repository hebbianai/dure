import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_FEEDBACK_PROOF;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
assert.ok(proof && evidence);
const transcript = [];
function record(receipt) {
  transcript.push(receipt);
  writeFileSync(join(evidence, "feedback-panes.json"), JSON.stringify(transcript, null, 2));
}
function action(pane, actionId, key, expectedCode = 0) {
  const args = ["client", "pane", "act", pane, actionId, "--idempotency-key", key, "--json"];
  const result = spawnSync(process.execPath, [resolve("cli/dure.mjs"), ...args], { env: process.env, encoding: "utf8", timeout: 65000 });
  if (result.error) throw result.error;
  const receipt = JSON.parse(result.stdout || result.stderr);
  record({ args, receipt });
  assert.equal(result.status, expectedCode, JSON.stringify(receipt));
  return receipt;
}
const main = await waitForQaLogReceipt("feedback-pane-main", proof);
const peer = await waitForQaLogReceipt("feedback-pane-peer", proof);
assert.notEqual(main.windowLabel, peer.windowLabel);
const before = action("qa-feedback-recovered", "qa.mutate", "absent-first", 2);
assert.equal(before.error.execution, "not_started");
assert.match(before.error.nextAction, /new idempotency key/);
action(main.controlId, "qa.mount", "mount");
const descriptor = JSON.parse(readFileSync(process.env.DURE_QA_SERVER_DESCRIPTOR, "utf8"));
const state = await requestAppControl({ descriptor, path: "/pane/state", body: { targetPanelId: "qa-feedback-recovered" } });
assert.ok(state.pane.actions.includes("qa.mutate"));
assert.deepEqual(action("qa-feedback-recovered", "qa.mutate", "absent-first", 2).error, before.error);
const applied = action("qa-feedback-recovered", "qa.mutate", "recovered-new");
assert.equal(applied.pane.result.outcome, "pending");
assert.deepEqual(action("qa-feedback-recovered", "qa.mutate", "recovered-new").pane, applied.pane);
assert.equal(action(main.controlId, "qa.count", "count-1").pane.result.value, 1);
const failed = action("qa-feedback-recovered", "qa.fail", "invoked-failure", 2);
assert.equal(failed.error.code, "pane_action_failed");
assert.equal(failed.error.execution, undefined);
action("qa-feedback-recovered", "qa.fail", "invoked-failure", 2);
assert.equal(action(main.controlId, "qa.count", "count-2").pane.result.value, 2);
for (const window of [main, peer]) {
  const receipt = await requestAppControl({ descriptor, path: "/pane/act", body: {
    targetPanelId: window.controlId, actionId: "qa.profiles", idempotencyKey: `profiles-${window.controlId}`, windowLabel: window.windowLabel,
  } });
  record(receipt);
  assert.equal(receipt.pane.result.outcome, "applied", JSON.stringify(receipt));
  assert.equal(receipt.pane.result.value.remounted, true);
  assert.match(receipt.pane.result.value.userAgent, /AppleWebKit/);
}
// A real PTY in the runner's disposable discovery root verifies that the wrapper
// forwards JSON mode to Hmux rather than reporting raw text as JSON success.
const discovery = process.env.HMUX_DISCOVERY_ROOT;
assert.ok(discovery?.startsWith(process.env.DURE_QA_STATE_ROOT + "/"));
function hmux(args) {
  const result = spawnSync(process.env.DURE_QA_HMUX_CLI, ["--discovery-root", discovery, "--json", ...args], {
    env: process.env, cwd: process.env.HOME, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
let session;
try {
  hmux(["new", "--name", "feedback-json-read", "--runtime", process.env.DURE_HMUX_RUNTIME_BIN,
    "--", process.execPath, "-e", "console.log('FEEDBACK_JSON_READY');setInterval(()=>{},1000)"]);
  session = hmux(["ls"]).find((item) => item.name === "feedback-json-read" || item.session_name === "feedback-json-read");
  assert.ok(session, "owned terminal should be discoverable");
  const deadline = Date.now() + 10000;
  for (;;) {
    const result = spawnSync(process.execPath, [resolve("cli/dure.mjs"), "read", session.session_id,
      "--workspace", session.workspace_id, "--json"], { env: process.env, encoding: "utf8", timeout: 12000 });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(typeof receipt.sequenceThrough, "string");
    if (receipt.lines.some((line) => line.includes("FEEDBACK_JSON_READY"))) {
      record({ nativeRead: receipt });
      break;
    }
    assert.ok(Date.now() < deadline, "PTY did not publish the expected marker");
    await new Promise((done) => setTimeout(done, 50));
  }
} finally {
  if (session) hmux(["kill", session.session_id, "--workspace", session.workspace_id]);
}
record({ result: "passed", windows: [main.windowLabel, peer.windowLabel], mutations: 2 });
console.log("PASS: native profile readback/remount, refusal recovery/deduplication, and Hmux-backed read JSON");
