import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_SLACK_CONNECTIONS_PROOF;
const live = process.env.DURE_QA_SLACK_LIVE === "1";
const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
assert.equal(home, path.join(root, "home"));
assert.ok(path.basename(root).startsWith("dure-slack-share."));
assert.equal(fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT), path.join(root, "hmux-discovery"));
console.log(JSON.stringify({ root, proof, realSlack: live }));
const receipt = await waitForQaLogReceipt("slack-share", proof, { timeoutMs: live ? 1_800_000 : 360_000 });
fs.writeFileSync(path.join(root, "evidence", "slack-share.json"), JSON.stringify(receipt, null, 2));
assert.equal(receipt.result, "passed", JSON.stringify(receipt));
for (const key of ["realWebview", "realBackend", "realProvider", "visible", "privateHistoryPreserved", "reloadPreserved", "providerStopped"]) assert.equal(receipt[key], true, key);
assert.equal(receipt.realSlack, live);
assert.equal(receipt.focused, false);
assert.equal(receipt.duplicateThreads, 0);
if (live) {
  const observation = JSON.parse(fs.readFileSync(path.join(home, "slack-live-observation.json"), "utf8"));
  assert.equal(observation.proof, proof);
  assert.equal(observation.threadTs, receipt.threadTs);
  assert.equal(observation.matchingThreads, 1);
  assert.ok(!JSON.stringify(observation).includes(`QA_PRIVATE_${proof}`));
  for (const reply of receipt.assistantReplies) assert.ok(observation.messages.some((message) => message.user === observation.botUserId && message.text.trim() === reply));
  assert.equal(fs.readFileSync(path.join(home, "project", "result.txt"), "utf8"), "Total parcels: 43\n");
  fs.copyFileSync(path.join(home, "slack-live-observation.json"), path.join(root, "evidence", "slack-live-observation.json"));
  fs.copyFileSync(path.join(home, "project", "result.txt"), path.join(root, "evidence", "result.txt"));
} else {
  const source = fs.readFileSync(path.join(home, "slack-share-posts.jsonl"), "utf8");
  assert.ok(!source.includes(`QA_PRIVATE_${proof}`));
  const posts = source.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(posts.filter((post) => post.method === "chat.postMessage" && !post.body.thread_ts).length, 1);
  assert.ok(receipt.assistantReply.includes(`QA_PUBLIC_${proof}`));
  assert.ok(posts.some((post) => post.body.text.trim() === receipt.assistantReply));
  fs.copyFileSync(path.join(home, "slack-share-posts.jsonl"), path.join(root, "evidence", "slack-share-posts.jsonl"));
}
assert.equal(receipt.binding.agentId, receipt.agentId);
console.log(JSON.stringify(receipt));
