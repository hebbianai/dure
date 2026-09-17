import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { DureSlackBackend } from "../../cli/lib/slack/backend.mjs";
import { SlackBridge } from "../../cli/lib/slack/bridge.mjs";
import { SlackJournal } from "../../cli/lib/slack/journal.mjs";
import { SlackShares } from "../../cli/lib/slack/share.mjs";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";

const [endpoint, root, agentId] = process.argv.slice(2);
const socket = net.createConnection(endpoint);
const requests = new Map();
let sequence = 0;
readline.createInterface({ input: socket }).on("line", (line) => {
  const response = JSON.parse(line);
  const request = requests.get(response.id);
  requests.delete(response.id);
  if (response.error) request.reject(Object.assign(new Error(response.error.code), response.error));
  else request.resolve({ result: response.result });
});
socket.on("error", (error) => { for (const request of requests.values()) request.reject(error); });
socket.on("close", () => { for (const request of requests.values()) request.reject(new Error("QA conversation transport closed")); });
const profile = { id: "qa", expected: { backendId: "qa-backend" } };
const backend = new DureSlackBackend(async () => ({ profile }), { requestBackend: async (_profile, request) => {
  // This harness isolates the real conversation API, not backend discovery.
  if (request.operation === "backend.scope") return { result: { schemaVersion: 1, scopeId: "qa-backend-scope" } };
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    socket.write(`${JSON.stringify({ id, operation: request.operation, body: request.body })}\n`);
  });
} });
const config = { schemaVersion: 1, teamId: "TQA", channels: [{ channelId: "CQA", projectId: "project-codex-runtime-scale", providerId: "codex" }] };
const journalFile = path.join(root, "slack-deliveries.json");
let journal = new SlackJournal(journalFile, config);
await journal.acquire();
const messages = new Map();
let writes = 0;
const slack = {
  async write(thread, text, key, previous, blocks) {
    writes += 1;
    const ts = previous ?? `100.${String(writes).padStart(6, "0")}`;
    messages.set(key, { ts, text, blocks, channelId: thread.channelId });
    return { ts };
  },
  async findDelivery(_thread, key) { return messages.get(key)?.ts ?? null; },
};
let bridge = new SlackBridge({ config, botUserId: "UBOT", journal, backend, slack });
const initial = { agentId, backend: { profileId: "qa", backendId: "qa-backend", scopeId: "qa-backend-scope" } };
const workspace = path.join(root, "workspace-0");
const artifact = path.join(workspace, "result.txt");
execFileSync("git", ["init", "--quiet"], { cwd: workspace, env: withoutLocalGitOverrides() });
const shownPermissions = new Set();
let answeredPermissions = 0;
let commandPermissions = 0;
let permissionOrigin = "slack";
let dureAnswers = 0;
let sharedThread;
let steeredTurnId;
let steerMessageIds;
let steerOnPending = steerWhilePending;

async function steerWhilePending(page) {
  assert.ok(page.activeTurn, "steering must target an actual running turn");
  const turnId = page.activeTurn.turnId;
  slackTurn("UQA2", "Also create teammate.txt containing exactly TEAM followed by a newline before finishing this same task. Preserve result.txt as FIRST and still reply QA_FIRST_DONE when all requested files are verified.", "200.001001", sharedThread.threadTs);
  await bridge.tick((error) => { throw error; });
  const entry = Object.values(journal.data.inbox).find(({ message }) => message.messageTs === "200.001001");
  assert.equal(entry.operation, "agent_conversation.steer_turn");
  assert.equal(entry.intent.turnId, turnId);
  assert.equal(entry.state, "delivered", "the provider must confirm the Slack steering request");
  const clientMessageId = "qa-dure-steer";
  const result = await backend.call(initial, "agent_conversation.steer_turn", {
    schemaVersion: 1, interactionSessionId: page.binding.interactionSessionId, runtime: page.binding.runtime,
    turnId, clientMessageId, requestedAtMs: Date.now(),
    input: "Also create handoff.txt containing exactly DURE STEER followed by a newline before finishing this same task. Preserve result.txt as FIRST and teammate.txt as TEAM. Verify all three files before replying QA_FIRST_DONE.",
  });
  assert.equal(result.receipt.state, "accepted", "the provider must confirm the Dure steering request");
  steeredTurnId = turnId;
  steerMessageIds = [entry.intent.clientMessageId, clientMessageId];
  console.log(JSON.stringify({ steeringAccepted: { turnId, clientMessageIds: steerMessageIds } }));
}

async function answerPermission(request) {
  await bridge.tick((error) => { throw error; });
  const entry = Object.values(journal.data.pending ?? {}).find((entry) => !entry.resolved && entry.target.requestId === request.request.requestId);
  assert.ok(entry, "the real request must be projected by the production Slack adapter");
  assert.equal(entry.presentation.kind, "permission", "unexpected questions need a separate QA scenario");
  const providerRequest = request.request.payload.providerRequest;
  const isCommand = providerRequest?.method === "item/commandExecution/requestApproval";
  if (isCommand) {
    assert.equal(typeof entry.presentation.input?.command, "string", "the actual command must be visible in the Slack permission card");
    assert.equal(entry.presentation.permission.blockedPath, providerRequest.params.cwd);
    assert.ok(journal.data.outbound[entry.key].text.includes(JSON.stringify(entry.presentation.input, null, 2)), "the rendered Slack message must include the command");
  }
  const answerFile = path.join(root, "permission-answer.json");
  if (!shownPermissions.has(entry.key)) {
    shownPermissions.add(entry.key);
    if (isCommand) commandPermissions += 1;
    console.log(JSON.stringify({ permissionReview: { key: entry.key, presentation: entry.presentation, answerFile, origin: permissionOrigin } }));
  }
  if (!fs.existsSync(answerFile)) return;
  const answer = JSON.parse(fs.readFileSync(answerFile, "utf8"));
  assert.equal(answer.key, entry.key, "QA answers must target the reviewed request");
  assert.ok(["allow", "deny"].includes(answer.decision));
  fs.unlinkSync(answerFile);
  answeredPermissions += 1;
  if (permissionOrigin === "dure") {
    const idempotencyKey = `qa-dure-${entry.key}`;
    await backend.deliver(initial, { ...entry.target, idempotencyKey, answer: { decision: answer.decision }, requestedAtMs: Date.now() }, "agent_conversation.answer_pending");
    await bridge.tick((error) => { throw error; });
    assert.equal(entry.completion?.idempotencyKey, idempotencyKey, "the Dure-side answer must reach the Slack prompt through the common timeline");
    dureAnswers += 1;
    return;
  }
  bridge.interact({ type: "block_actions", team: { id: "TQA" }, user: { id: "UQA2", name: "QA teammate" },
    container: { channel_id: "CQA", message_ts: journal.data.outbound[entry.key].ts }, message: { user: "UBOT" },
    actions: [{ action_id: `dure.pending.${answer.decision}`, value: entry.key, action_ts: `300.${answeredPermissions}` }] });
  await bridge.tick((error) => { throw error; });
  const delivered = Object.values(journal.data.inbox).find((attempt) => attempt.message.pendingKey === entry.key);
  assert.equal(delivered?.state, "delivered", "the actual provider must confirm the Slack answer");
}

async function dureTurn(input, turnId) {
  const page = await backend.tail(initial);
  const operation = page.activeTurn ? "agent_conversation.steer_turn" : "agent_conversation.start_turn";
  const result = await backend.call(initial, operation, {
    schemaVersion: 1, interactionSessionId: page.binding.interactionSessionId, runtime: page.binding.runtime,
    turnId: page.activeTurn?.turnId ?? turnId, clientMessageId: turnId, input, requestedAtMs: Date.now(),
  });
  assert.equal(result.receipt.state, "accepted");
}

function completed(marker, shared = false) {
  return observed(marker, shared, (page) => !page.activeTurn && page.rows.some(({ item }) =>
    item.body.role === "assistant" && item.body.markdown?.includes(marker)));
}

async function observed(label, shared, ready) {
  const deadline = Date.now() + 120_000;
  let lastPage;
  while (Date.now() < deadline) {
    if (shared) await bridge.tick((error) => { throw error; });
    const { read } = await backend.call(initial, "agent_conversation.read", {
      schemaVersion: 1, interactionSessionId: (await backend.tail(initial)).binding.interactionSessionId, direction: "tail", limit: 100,
    });
    const page = read.page;
    lastPage = page;
    if (page.pendingRequests.length) {
      assert.ok(shared, "the private setup turn must not request permissions");
      if (steerOnPending) {
        const steer = steerOnPending;
        steerOnPending = null;
        await steer(page);
      }
      await answerPermission(page.pendingRequests[0]);
    }
    if (ready(page)) {
      if (shared) await bridge.tick((error) => { throw error; });
      return page;
    }
    await delay(300);
  }
  console.log(JSON.stringify({ observationExpired: { label, activeTurn: lastPage?.activeTurn,
    pending: lastPage?.pendingRequests.map(({ request }) => ({ requestId: request.requestId, kind: request.kind })),
    recentRows: lastPage?.rows.slice(-8) } }));
  throw new Error(`The actual provider did not reach ${label} within the observation deadline.`);
}

function slackTurn(user, text, ts, threadTs) {
  assert.equal(bridge.accept({ type: "event_callback", team_id: "TQA", event: {
    type: "message", channel: "CQA", user, text, ts, thread_ts: threadTs,
  } }), true);
}

try {
  await dureTurn("Reply with exactly QA_PRIVATE_READY. Do not use tools.", "qa-private");
  const first = await completed("QA_PRIVATE_READY");
  assert.ok(first.binding.providerConversationRef, "the real provider must establish its conversation identity");
  console.log("slack-real-conversation: first provider turn completed");
  const sharing = new SlackShares({ config, journal, backend, slack });
  const shared = await sharing.share({ schemaVersion: 1, teamId: "TQA", channelId: "CQA", agentId, requestId: "qa-share" });
  sharedThread = shared;
  assert.equal(shared.interactionSessionId, first.binding.interactionSessionId);
  slackTurn("UQA1", "Use a shell command in this disposable QA repository to create result.txt containing exactly FIRST followed by a newline. Work only in the current directory. Do not use network services or inspect credentials. Then reply QA_FIRST_DONE.", "200.001", shared.threadTs);
  const firstShared = await completed("QA_FIRST_DONE", true);
  assert.equal(fs.readFileSync(artifact, "utf8"), "FIRST\n");
  assert.ok(steeredTurnId, "both additional directions must arrive before the first shared turn finishes");
  assert.equal(fs.readFileSync(path.join(workspace, "teammate.txt"), "utf8"), "TEAM\n");
  assert.equal(fs.readFileSync(path.join(workspace, "handoff.txt"), "utf8"), "DURE STEER\n");
  for (const id of steerMessageIds) {
    const rows = firstShared.rows.filter(({ item }) => item.clientMessageId === id && item.body.role === "user");
    assert.equal(rows.length, 1, "each direction must appear once in the common conversation");
    assert.equal(rows[0].item.turnId, steeredTurnId, "steering must remain on the original active turn");
  }
  assert.equal(firstShared.rows.filter(({ item }) => item.turnId === steeredTurnId && item.body.state === "turn_completed").length, 1);
  assert.ok([...messages.values()].some((message) => message.text.startsWith("Dure:\nAlso create handoff.txt")));
  console.log("slack-real-conversation: the first shared turn applied both Slack and Dure steering");
  slackTurn("UQA2", "Replace result.txt with exactly SECOND followed by a newline. Keep the same task and reply QA_SECOND_DONE when finished.", "200.002", shared.threadTs);
  await completed("QA_SECOND_DONE", true);
  assert.equal(fs.readFileSync(artifact, "utf8"), "SECOND\n");
  console.log("slack-real-conversation: second Slack participant changed the same artifact");
  permissionOrigin = "dure";
  await dureTurn("Change result.txt to exactly DURE followed by a newline. Reply QA_DURE_DONE when finished.", "qa-dure-followup");
  let final = await completed("QA_DURE_DONE", true);
  assert.equal(fs.readFileSync(artifact, "utf8"), "DURE\n");
  assert.equal(fs.readFileSync(path.join(workspace, "teammate.txt"), "utf8"), "TEAM\n");
  assert.equal(fs.readFileSync(path.join(workspace, "handoff.txt"), "utf8"), "DURE STEER\n");
  assert.equal(final.binding.interactionSessionId, first.binding.interactionSessionId);
  assert.deepEqual(final.binding.runtime, first.binding.runtime);
  assert.equal(final.binding.providerConversationRef, first.binding.providerConversationRef);
  let conflictingMessageId;
  steerOnPending = async (page) => {
    assert.ok(page.activeTurn);
    assert.equal(fs.existsSync(path.join(workspace, "release-region.txt")), false);
    assert.ok(!JSON.stringify(page.pendingRequests[0].request.payload.input ?? {}).includes("release-region.txt"), "QA must inject the conflict before the provider proposes a region write");
    slackTurn("UQA2", "For this same release-region.txt I require exactly US followed by a newline. I do not agree to EU. Also create checklist.txt containing exactly CHECKED followed by a newline; that checklist is independent of the region choice.", "200.003001", shared.threadTs);
    await bridge.tick((error) => { throw error; });
    const entry = Object.values(journal.data.inbox).find(({ message }) => message.messageTs === "200.003001");
    assert.equal(entry.state, "delivered");
    assert.equal(entry.operation, "agent_conversation.steer_turn");
    assert.equal(entry.intent.turnId, page.activeTurn.turnId);
    conflictingMessageId = entry.intent.clientMessageId;
  };
  permissionOrigin = "slack";
  slackTurn("UQA1", "Prepare a release-region.txt for our team. It must contain exactly EU followed by a newline; do not change this region requirement without agreement with me. Before preparing the region file, first create common-note.txt containing exactly READY followed by a newline using a separate shell command, and wait for that command's output. This note is independent of the region. Preserve our existing files. This is local preparation only; do not deploy or contact external services.", "200.003", shared.threadTs);
  await bridge.tick((error) => { throw error; });
  const conflictTurnId = Object.values(journal.data.inbox).find(({ message }) => message.messageTs === "200.003").intent.turnId;
  const repliesForConflict = (page) => page.rows.filter(({ item }) => item.turnId === conflictTurnId && item.body.role === "assistant")
    .map(({ item }) => item.body.markdown ?? "");
  const conflict = await observed("the shared region question and independent work", true, (page) => {
    const reply = repliesForConflict(page).join("\n");
    return /\bEU\b/.test(reply) && /\bUS\b/.test(reply) && /\?|confirm|choose|decide/i.test(reply)
      && fs.existsSync(path.join(workspace, "common-note.txt")) && fs.existsSync(path.join(workspace, "checklist.txt"));
  });
  assert.ok(conflictingMessageId, "both incompatible requirements must reach the active provider turn");
  assert.equal(fs.existsSync(path.join(workspace, "release-region.txt")), false, "the provider must not choose a disputed region without the team's decision");
  assert.equal(fs.readFileSync(path.join(workspace, "common-note.txt"), "utf8"), "READY\n");
  assert.equal(fs.readFileSync(path.join(workspace, "checklist.txt"), "utf8"), "CHECKED\n");
  const conflictReplies = repliesForConflict(conflict);
  const conflictReply = conflictReplies.join("\n");
  assert.match(conflictReply, /\bEU\b/);
  assert.match(conflictReply, /\bUS\b/);
  assert.match(conflictReply, /\?|confirm|choose|decide/i, "the provider must ask about the actual conflict");
  assert.ok([...messages.values()].some(({ text }) => conflictReplies.includes(text) && /\bEU\b/.test(text) && /\bUS\b/.test(text)), "the shared thread must see the assistant's question");
  const conflictRows = conflict.rows.filter(({ item }) => item.clientMessageId === conflictingMessageId && item.body.role === "user");
  assert.equal(conflictRows.length, 1);
  assert.equal(conflictRows[0].item.turnId, conflictTurnId);
  console.log(JSON.stringify({ conflictObserved: { turnId: conflictTurnId, conflictingMessageId, reply: conflictReply, independentFilesComplete: true, disputedFileAbsent: true } }));
  permissionOrigin = "dure";
  await dureTurn("The team has now agreed on EU. Create release-region.txt containing exactly EU followed by a newline. Preserve all existing files, including the common note and checklist, verify the result, and reply QA_REGION_DONE.", "qa-dure-region-decision");
  final = await completed("QA_REGION_DONE", true);
  assert.equal(fs.readFileSync(path.join(workspace, "release-region.txt"), "utf8"), "EU\n");
  assert.equal(fs.readFileSync(path.join(workspace, "common-note.txt"), "utf8"), "READY\n");
  assert.equal(fs.readFileSync(path.join(workspace, "checklist.txt"), "utf8"), "CHECKED\n");
  assert.equal(fs.readFileSync(artifact, "utf8"), "DURE\n");
  assert.equal(fs.readFileSync(path.join(workspace, "teammate.txt"), "utf8"), "TEAM\n");
  assert.equal(fs.readFileSync(path.join(workspace, "handoff.txt"), "utf8"), "DURE STEER\n");
  assert.equal(final.binding.interactionSessionId, first.binding.interactionSessionId);
  assert.deepEqual(final.binding.runtime, first.binding.runtime);
  assert.equal(final.binding.providerConversationRef, first.binding.providerConversationRef);
  const confirmedAnswers = final.rows.filter(({ item }) => item.body.type === "pending_answer");
  assert.equal(confirmedAnswers.length, answeredPermissions, "every real provider-confirmed answer must remain in the common history");
  assert.ok(confirmedAnswers.every(({ item }) => item.body.answer.decision === "allow"));
  assert.ok(commandPermissions > 0, "the actual scenario must exercise command permission presentation");
  assert.ok([...messages.values()].some((message) => message.text.includes("QA_DURE_DONE")));
  assert.ok([...messages.values()].every((message) => !message.text.includes("QA_PRIVATE_READY")));
  const beforeReconnect = writes;
  journal.close();
  journal = new SlackJournal(journalFile, config);
  await journal.acquire();
  bridge = new SlackBridge({ config, botUserId: "UBOT", journal, backend, slack });
  await bridge.tick((error) => { throw error; });
  assert.equal(writes, beforeReconnect, "connector restart must not duplicate old output");
  const evidence = { schemaVersion: 1, provider: "codex", realProvider: true, realSlack: false,
    agentId, interactionSessionId: final.binding.interactionSessionId, runtime: final.binding.runtime,
    providerConversationRef: final.binding.providerConversationRef, syntheticSlackParticipants: 2,
    artifact: fs.readFileSync(artifact, "utf8"), steeredTurnId, steerMessageIds,
    steeringArtifacts: { teammate: "TEAM\n", handoff: "DURE STEER\n" },
    conflict: { turnId: conflictTurnId, conflictingMessageId, askedTeam: true, independentFilesComplete: true, agreedRegion: "EU\n" },
    privateHistoryExcluded: true, restartPreserved: true, answeredPermissions, commandPermissions, dureAnswers, confirmedAnswerHistory: confirmedAnswers.length };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  journal.close();
  socket.end();
}
