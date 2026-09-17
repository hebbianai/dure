import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { processIdentity } from "../lib/process-identity.mjs";
import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";
import { performBackendProfileRequest } from "../../cli/lib/backend-transport.mjs";
import { loadBackendProfiles } from "../../cli/lib/backend-profiles.mjs";

const proof = process.env.DURE_QA_SLACK_CONNECTIONS_PROOF;
const live = process.env.DURE_QA_SLACK_LIVE === "1";
const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
assert.equal(home, path.join(root, "home"));
assert.ok(path.basename(root).startsWith("dure-slack-share."));
assert.equal(fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT), path.join(root, "hmux-discovery"));
console.log(JSON.stringify({ root, proof, realSlack: live }));
const completion = waitForQaLogReceipt("slack-share", proof, { timeoutMs: live ? 1_800_000 : 360_000 });
if (!live) {
  const ready = await Promise.race([
    waitForQaLogReceipt("slack-tag-reconnect", proof, { timeoutMs: 360_000 }),
    completion.then((receipt) => { throw new Error(`Sharing ended before backend recovery: ${JSON.stringify(receipt)}`); }),
  ]);
  const descriptorPath = path.join(home, ".dure/backend/control-plane.json");
  const before = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  assert.equal(before.generation, ready.generation);
  assert.ok(before.controlPlaneIdentity.executablePath.startsWith(home + "/"), "restart owns the isolated installed executable");
  const identity = processIdentity(before.processId);
  assert.ok(identity, "restart records the exact backend process");
  fs.writeFileSync(path.join(root, "evidence", "tag-backend-before.json"), JSON.stringify({ ...before, identity }));
  const catalogPath = path.join(home, ".dure/backend-profiles.json");
  const request = async (operation, body) => {
    const profile = loadBackendProfiles({ configPath: catalogPath }).profiles.find((entry) => entry.id === "local");
    const response = await performBackendProfileRequest(profile, {
      operation, requiredCapabilities: [operation === "agent_conversation.read" ? "agent_conversation.read.v5" : operation], body,
    }, { maxResponseBytes: 2 * 1024 * 1024 });
    return response.result;
  };
  const read = await request("agent_conversation.read", {
    schemaVersion: 1, interactionSessionId: ready.interactionSessionId, direction: "tail", cursor: null, limit: 100,
  });
  assert.equal(read.read.page.queuedInputs.inputs[0].clientMessageId, ready.queuedMessageId);
  assert.ok(read.read.page.activeTurn, "the actual provider tool still owns the active turn");
  const cliInput = {
    schemaVersion: 1, interactionSessionId: ready.interactionSessionId,
    runtime: read.read.page.binding.runtime, turnId: `cli-turn-${proof}`, clientMessageId: `cli-input-${proof}`,
    input: ready.secondClientInput, requestedAtMs: Date.now(),
  };
  const admitted = await request("agent_conversation.enqueue_turn", cliInput);
  assert.equal(admitted.receipt.state, "queued");
  fs.writeFileSync(path.join(root, "evidence", "queue-before-replacement.json"), JSON.stringify({ read, admitted }));
  // An ordinary stop/reconcile preserves the backend generation. Activate a
  // second disposable installation through the same replacement owner as deploy.
  const bundle = path.dirname(path.dirname(before.controlPlaneIdentity.executablePath));
  const replacement = path.join(home, "replacement-cli", path.basename(bundle));
  const previousMask = process.umask(0);
  try {
    fs.cpSync(bundle, replacement, {
      recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
    });
  } finally { process.umask(previousMask); }
  await promisify(execFile)(process.execPath, [path.join(replacement, "bin/dure.mjs"), "backend", "activate", "--backend", "local", "--json"], { timeout: 60_000 });
  const after = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  assert.notEqual(after.generation, before.generation);
  assert.equal(after.backendId, before.backendId);
  fs.writeFileSync(path.join(root, "evidence", "tag-backend-after.json"), JSON.stringify(after));
  const pending = await request("agent_conversation.read_queue", {
    schemaVersion: 1, interactionSessionId: ready.interactionSessionId, afterSequence: 0,
  });
  assert.deepEqual(pending.page.inputs.map((input) => input.clientMessageId), [ready.queuedMessageId, cliInput.clientMessageId]);
  assert.deepEqual(await request("agent_conversation.enqueue_turn", cliInput), admitted, "replaying admission across replacement preserves its receipt");
  fs.writeFileSync(path.join(root, "evidence", "queue-after-replacement.json"), JSON.stringify(pending));
  await Promise.race([
    waitForQaLogReceipt("slack-queue-recovered", proof, { timeoutMs: 120_000 }),
    completion.then((receipt) => { throw new Error(`Sharing ended before queue recovery: ${JSON.stringify(receipt)}`); }),
  ]);
  fs.writeFileSync(path.join(home, "project/queue-release"), "release", { flag: "wx", mode: 0o600 });
}
const receipt = await completion;
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
  assert.equal(receipt.noViewQueueAfterReload, true);
  assert.equal(receipt.queuedAcrossBackendReplacement, true);
  assert.equal(receipt.independentQueueClients, true);
  const log = fs.readFileSync(path.join(root, "qa.log"), "utf8");
  const queueCompleted = log.indexOf("queue-completed-without-view-after-reload");
  assert.ok(queueCompleted >= 0, "the new WebView observed queued completion");
  const orphanedCallbacks = log.slice(queueCompleted).split("\n").filter((line) => line.includes("Couldn't find callback id"));
  assert.equal(orphanedCallbacks.length, 0, "the retired WebView must stop receiving conversation updates");
  assert.equal(receipt.sharedTaskComposer, true);
  assert.equal(receipt.tagSidebarConversation, true);
  assert.equal(receipt.tagGenerationRecovered, true);
  assert.equal(receipt.nativeThreadReply, true);
  const source = fs.readFileSync(path.join(home, "slack-share-posts.jsonl"), "utf8");
  assert.ok(!source.includes(`QA_PRIVATE_${proof}`));
  const posts = source.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(posts.filter((post) => post.method === "chat.postMessage" && !post.body.thread_ts).length, 1);
  assert.ok(receipt.assistantReply.includes(`QA_PUBLIC_${proof}`));
  assert.ok(posts.some((post) => post.body.text.trim() === receipt.assistantReply));
  assert.equal(typeof receipt.nativeAssistantReply, "string");
  assert.ok(receipt.nativeAssistantReply.includes(`QA_NATIVE_${proof}`));
  assert.ok(posts.some((post) => post.body.thread_ts === receipt.threadTs &&
    post.body.text.trim() === receipt.nativeAssistantReply.trim()));
  fs.copyFileSync(path.join(home, "slack-share-posts.jsonl"), path.join(root, "evidence", "slack-share-posts.jsonl"));
}
assert.equal(receipt.binding.agentId, receipt.agentId);
console.log(JSON.stringify(receipt));
