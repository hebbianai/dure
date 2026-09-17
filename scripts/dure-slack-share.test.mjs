import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DureSlackBackend } from "../cli/lib/slack/backend.mjs";
import { SlackApi } from "../cli/lib/slack/api.mjs";
import { SlackBridge } from "../cli/lib/slack/bridge.mjs";
import { requestSlackShare, serveSlackControl } from "../cli/lib/slack/control.mjs";
import { SlackJournal } from "../cli/lib/slack/journal.mjs";
import { SlackShares } from "../cli/lib/slack/share.mjs";
import { runSlackCommand } from "../cli/lib/slack-command.mjs";

const config = { schemaVersion: 1, teamId: "T1", channels: [{ channelId: "C1", projectId: "project-1", providerId: "claude", backend: "team" }] };
const request = { schemaVersion: 1, requestId: "share-1", teamId: "T1", channelId: "C1", agentId: "existing-agent" };
const binding = { interactionSessionId: "original-conversation", timelineEpoch: "epoch-1", runtime: { runtimeGeneration: "generation-1", providerEpoch: "provider-1" } };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-slack-share-"));
  const file = path.join(root, "deliveries.json");
  const journal = new SlackJournal(file, config);
  await journal.acquire();
  t.onTestFinished(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = { backend: [], posts: [], find: [] };
  let goal = null;
  const backend = new DureSlackBackend(async ({ backend: id }) => ({ profile: { id, expected: { backendId: "backend-1" } } }), {
    requestBackend: async (_profile, operation) => {
      if (operation.operation === "backend.scope") return { result: { schemaVersion: 1, scopeId: "scope-team" } };
      calls.backend.push(operation);
      if (operation.operation === "agent_runtime.projection.inspect") return { result: { state: "stable", receipt: { agentId: operation.body.agentId, authority: { interactionProfile: "structured_protocol" } } } };
      if (operation.operation === "agent_conversation.inspect") return { result: { binding } };
      if (operation.operation === "agent_conversation.read") {
        assert.equal(operation.body.interactionSessionId, binding.interactionSessionId);
        const tail = operation.body.direction === "tail";
        return { result: { read: { type: "page", page: { binding, goal,
          activeTurn: { turnId: "running-turn" }, finalCursor: { epoch: "epoch-1", sequence: tail ? 5 : 6 },
          rows: [{ item: { itemId: tail ? "private" : "shared", body: {
            type: "message", role: "assistant", markdown: tail ? "Earlier private conversation" : "Update after sharing",
          } } }],
        } } } };
      }
      assert.equal(operation.operation, "agent_conversation.steer_turn", "sharing cannot spawn a new task");
      return { result: { receipt: { state: "accepted" } } };
    },
  });
  const slack = {
    async write(thread, text, key) { calls.posts.push({ thread: structuredClone(thread), text, key }); return { ts: "200.001" }; },
    async findDelivery(thread, key) { calls.find.push({ thread: structuredClone(thread), key }); return "200.001"; },
  };
  const sharing = new SlackShares({ config, journal, backend, slack });
  const bridge = new SlackBridge({ config, botUserId: "U0", journal, backend, slack });
  return { root, file, journal, calls, backend, slack, sharing, bridge, setGoal(value) { goal = value; } };
}

test("native sharing rejects a different conversation before publishing and preserves an existing link", async (t) => {
  const f = await fixture(t);
  const wrong = { ...request, interactionSessionId: "another-conversation" };
  await assert.rejects(f.sharing.share(wrong), { code: "slack_share_conversation_changed" });
  assert.equal(f.calls.posts.length, 0);
  assert.deepEqual(f.journal.data.shares, {});
  const exact = { ...request, interactionSessionId: binding.interactionSessionId };
  const receipt = await f.sharing.share(exact);
  assert.equal(receipt.interactionSessionId, binding.interactionSessionId);
  await assert.rejects(f.sharing.share({ ...wrong, requestId: "different-native-share" }), { code: "slack_share_conversation_changed" });
  assert.equal(f.calls.posts.length, 1);
  assert.equal(Object.keys(f.journal.data.shares).length, 1);
  await assert.rejects(f.sharing.share(wrong), { code: "slack_share_request_conflict" });
});

test("sharing starts at the current goal revision and publishes only later goal changes", async (t) => {
  const f = await fixture(t);
  const goal = { agentId: request.agentId, revision: 4, objective: "Earlier private goal", status: "paused" };
  f.setGoal(goal);
  const result = await f.sharing.share(request);
  await f.bridge.tick((error) => { throw error; });
  assert.ok(f.calls.posts.every(({ text }) => !text.includes(goal.objective)));
  const count = f.calls.posts.length;
  f.setGoal({ ...goal, revision: 5, objective: "Shared follow-up", status: "active" });
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.posts.length, count + 1);
  assert.ok(f.calls.posts.at(-1).text.includes("Shared follow-up"));
  assert.equal(f.calls.posts.at(-1).thread.threadTs, result.threadTs);
  assert.equal(f.calls.posts.at(-1).thread.agentId, request.agentId);
});

test("Dure-origin sharing starts at the current cursor and Slack replies steer the existing conversation", async (t) => {
  const f = await fixture(t);
  const result = await f.sharing.share(request);
  assert.equal(result.agentId, "existing-agent");
  assert.equal(result.interactionSessionId, "original-conversation");
  assert.equal(f.calls.posts[0].thread.threadTs, undefined, "share creates a root message");
  assert.equal(f.calls.posts[0].thread.cursor.sequence, 5);
  assert.equal(f.bridge.accept({ type: "event_callback", team_id: "T1", event: {
    type: "message", channel: "C1", user: "U2", thread_ts: result.threadTs, ts: "201.001", text: "Change the approach",
  } }), true);
  await f.bridge.tick((error) => { throw error; });
  const input = f.calls.backend.find((call) => call.operation === "agent_conversation.steer_turn");
  assert.equal(input.body.interactionSessionId, "original-conversation");
  assert.equal(input.body.turnId, "running-turn");
  assert.match(input.body.input, /T1\/U2/);
  assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.inspect").length, 1);
  assert.ok(f.calls.posts.some((post) => post.text === "Update after sharing"));
  assert.ok(f.calls.posts.every((post) => !post.text.includes("Earlier private conversation")));
  assert.deepEqual(f.calls.backend.filter((call) => call.operation === "agent_conversation.read" && call.body.direction === "after").map((call) => call.body.cursor.sequence), [5, 5]);
  f.journal.close();
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  try {
    const sharing = new SlackShares({ config, journal, backend: f.backend, slack: f.slack });
    assert.deepEqual(await sharing.share(request), result);
    assert.deepEqual(await sharing.share({ ...request, requestId: "share-again" }), result);
    const bridge = new SlackBridge({ config, journal, backend: f.backend, slack: f.slack, botUserId: "U0" });
    await bridge.tick((error) => { throw error; });
    assert.equal(f.calls.posts.length, 2);
    assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.inspect").length, 1);
  } finally { journal.close(); }
});

test("simultaneous share requests attach one thread without a second task or root message", async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.sharing.share(request), f.sharing.share({ ...request, requestId: "share-2" })]);
  assert.deepEqual(a, b);
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.inspect").length, 1);
  await assert.rejects(f.sharing.share({ ...request, requestId: "share-2", agentId: "different-agent" }), { code: "slack_share_request_conflict" });
});

test("equal agent IDs on two dure-local servers remain separate Slack conversations", async (t) => {
  const f = await fixture(t);
  const backend = new DureSlackBackend(async ({ backend: id }) => ({ profile: { id, expected: { backendId: "dure-local" } } }), {
    requestBackend: async (profile, operation) => {
      if (operation.operation === "backend.scope") return { result: { schemaVersion: 1, scopeId: `scope-${profile.id}` } };
      if (operation.operation === "agent_runtime.projection.inspect") return { result: { state: "stable", receipt: { agentId: operation.body.agentId, authority: { interactionProfile: "structured_protocol" } } } };
      const scoped = { ...binding, interactionSessionId: `conversation-${profile.id}` };
      if (operation.operation === "agent_conversation.inspect") return { result: { binding: scoped } };
      assert.equal(operation.operation, "agent_conversation.read");
      return { result: { read: { type: "page", page: { binding: scoped, finalCursor: { epoch: "epoch-1", sequence: 0 } } } } };
    },
  });
  f.slack.write = async (thread) => { f.calls.posts.push(thread); return { ts: `200.${f.calls.posts.length}` }; };
  const sharing = new SlackShares({ config, journal: f.journal, backend, slack: f.slack });
  const [left, right] = await Promise.all([
    sharing.share({ ...request, requestId: "server-a", backend: "server-a" }),
    sharing.share({ ...request, requestId: "server-b", backend: "server-b" }),
  ]);
  assert.equal(f.calls.posts.length, 2);
  assert.equal(left.interactionSessionId, "conversation-server-a");
  assert.equal(right.interactionSessionId, "conversation-server-b");
  assert.notEqual(left.threadTs, right.threadTs);
});

test("two profile aliases of the same backend data share one Slack conversation", async (t) => {
  const f = await fixture(t);
  const [left, right] = await Promise.all([
    f.sharing.share({ ...request, requestId: "alias-a", backend: "alias-a" }),
    f.sharing.share({ ...request, requestId: "alias-b", backend: "alias-b" }),
  ]);
  assert.deepEqual(left, right);
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.inspect").length, 1);
});

test("an in-flight request ID cannot be reassigned to another task before its first send", async (t) => {
  const f = await fixture(t);
  const first = f.sharing.share(request);
  await assert.rejects(f.sharing.share({ ...request, agentId: "different-agent" }), { code: "slack_share_request_conflict" });
  await first;
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.inspect").length, 1);
});

test("an interrupted share reconciles the posted root before restoring its exact conversation", async (t) => {
  const f = await fixture(t);
  let interrupted;
  f.slack.write = async () => { interrupted = fs.readFileSync(f.file, "utf8"); return { ts: "200.001" }; };
  await f.sharing.share(request);
  f.journal.close();
  fs.writeFileSync(f.file, interrupted);
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  try {
    const sharing = new SlackShares({ config, journal, backend: f.backend, slack: f.slack });
    await sharing.share({ ...request, requestId: "new-command-after-interruption" });
    await sharing.reconcile((error) => { throw error; });
    const [thread] = Object.values(journal.data.threads);
    assert.equal(thread.threadTs, "200.001");
    assert.equal(thread.interactionSessionId, "original-conversation");
    assert.equal(thread.cursor.sequence, 5);
    assert.equal(f.calls.find.length, 1);
    assert.equal(f.calls.find[0].thread.threadTs, undefined);
    assert.equal(f.calls.backend.length, 3, "reconnect does not select another conversation or cursor");
    assert.equal(Object.values(journal.data.shares)[0].state, "succeeded");
  } finally { journal.close(); }
});

test("an unconfirmed or failed share stays failed until a new explicit request", async (t) => {
  const f = await fixture(t);
  let interrupted;
  f.slack.write = async () => { interrupted = fs.readFileSync(f.file, "utf8"); throw new Error("Network failed"); };
  await assert.rejects(f.sharing.share(request));
  await assert.rejects(f.sharing.share(request));
  assert.equal(f.calls.backend.length, 3);
  f.journal.close();
  fs.writeFileSync(f.file, interrupted);
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  f.slack.findDelivery = async () => null;
  try {
    const sharing = new SlackShares({ config, journal, backend: f.backend, slack: f.slack });
    const errors = [];
    await sharing.reconcile((error) => errors.push(error.code));
    await sharing.reconcile((error) => errors.push(error.code));
    assert.deepEqual(errors, ["slack_share_unconfirmed"]);
    assert.deepEqual(journal.data.threads, {});
    f.slack.write = async () => ({ ts: "300.001" });
    assert.equal((await sharing.share({ ...request, requestId: "explicit-new-attempt" })).threadTs, "300.001");
    await assert.rejects(sharing.share({ ...request, agentId: "another-agent" }), { code: "slack_share_request_conflict" });
  } finally { journal.close(); }
});

test("the running connector accepts CLI share requests through a private authenticated endpoint", async (t) => {
  const f = await fixture(t);
  const configFile = path.join(f.root, "slack.json");
  const controlFile = `${configFile}.connector.json`;
  fs.writeFileSync(configFile, JSON.stringify(config));
  const control = await serveSlackControl({ file: controlFile, teamId: "T1", share: (value) => f.sharing.share(value) });
  try {
    const descriptor = JSON.parse(fs.readFileSync(controlFile, "utf8"));
    assert.equal(fs.statSync(controlFile).mode & 0o777, 0o600);
    const url = `http://127.0.0.1:${descriptor.port}/slack/share`;
    const missingAuth = await fetch(url, { method: "POST", body: JSON.stringify(request) });
    assert.equal(missingAuth.status, 403);
    const browser = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${descriptor.token}`, Origin: "https://unrelated.example" }, body: JSON.stringify(request) });
    assert.equal(browser.status, 403);
    assert.equal(f.calls.backend.length, 0);
    await assert.rejects(requestSlackShare(controlFile, { ...request, teamId: "T2" }), /another workspace/);
    const output = [];
    await runSlackCommand(["share", "--config", configFile, "--agent", request.agentId, "--channel", request.channelId, "--request-id", request.requestId], {
      resolveBackend() { throw new Error("The running connector owns backend selection"); }, output: (value) => output.push(value),
    });
    assert.equal(JSON.parse(output[0]).state, "succeeded");
    assert.equal(JSON.parse(output[0]).interactionSessionId, "original-conversation");
    assert.ok(!output[0].includes(descriptor.token));
    assert.equal((await requestSlackShare(controlFile, request)).threadTs, "200.001");
    assert.equal(f.calls.posts.length, 1);
  } finally { await control.close(); }
  assert.equal(fs.existsSync(controlFile), false);
});

test("a failed request keeps its result while another explicit share is running", async (t) => {
  const f = await fixture(t);
  f.slack.write = async () => { throw Object.assign(new Error("Send failed"), { code: "slack_http_failed" }); };
  await assert.rejects(f.sharing.share(request), { code: "slack_http_failed" });
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  f.slack.write = async () => { entered.resolve(); await finish.promise; return { ts: "300.001" }; };
  const next = f.sharing.share({ ...request, requestId: "new-request" });
  await entered.promise;
  const previous = assert.rejects(f.sharing.share(request), { code: "slack_http_failed" });
  finish.resolve();
  await Promise.all([previous, next]);
});

test("root-message reconciliation paginates channel history and only accepts this bot's delivery", async () => {
  const calls = [];
  const slack = new SlackApi({ botToken: "test-only", fetchApi: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, messages: [{
      user: calls.length === 1 ? "UOTHER" : "U0", ts: calls.length === 1 ? "100.001" : "200.001",
      metadata: { event_type: "dure_delivery", event_payload: { key: "share-key" } },
    }], response_metadata: { next_cursor: calls.length === 1 ? "page-2" : "" } }) };
  } });
  slack.botUserId = "U0";
  assert.equal(await slack.findDelivery({ channelId: "C1" }, "share-key"), "200.001");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ url, body }) => url.endsWith("conversations.history") && body.include_all_metadata && body.ts === undefined));
  assert.equal(calls[1].body.cursor, "page-2");
});

test("connector shutdown waits for its active share operation before releasing ownership", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "connector.json");
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const control = await serveSlackControl({ file, teamId: "T1", share: async () => {
    entered.resolve();
    await finish.promise;
    assert.equal(f.journal.acquired, true);
    f.journal.save();
    return { state: "succeeded" };
  } });
  const client = requestSlackShare(file, request).catch(() => undefined);
  await entered.promise;
  let closed = false;
  const closing = control.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finish.resolve();
  await closing;
  await client;
  assert.equal(fs.existsSync(file), false);
});

test("concurrent shares and task updates retain Slack's per-channel send spacing", async () => {
  const sent = [];
  const slack = new SlackApi({ botToken: "test-only", fetchApi: async (_url, options) => {
    sent.push({ at: Date.now(), channel: JSON.parse(options.body).channel });
    return { ok: true, json: async () => ({ ok: true, ts: "200.001" }) };
  } });
  await Promise.all([
    slack.write({ channelId: "C1" }, "First share", "one"),
    slack.write({ channelId: "C1" }, "Second share", "two"),
    slack.write({ channelId: "C1", threadTs: "100.001" }, "Task update", "three"),
    slack.write({ channelId: "C2" }, "Another channel", "four"),
  ]);
  const sameChannel = sent.filter((entry) => entry.channel === "C1");
  assert.ok(sameChannel[1].at - sameChannel[0].at >= 1000);
  assert.ok(sameChannel[2].at - sameChannel[1].at >= 1000);
  assert.equal(sent[1].channel, "C2", "another channel does not wait behind this channel's sends");
});
