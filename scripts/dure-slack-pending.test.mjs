import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { SlackBridge } from "../cli/lib/slack/bridge.mjs";
import { DureSlackBackend } from "../cli/lib/slack/backend.mjs";
import { SlackJournal } from "../cli/lib/slack/journal.mjs";
import { slackKey } from "../cli/lib/slack/event.mjs";
import { consumeSlackSocket } from "../cli/lib/slack/socket.mjs";

const config = { schemaVersion: 1, teamId: "T1", channels: [{ channelId: "C1", projectId: "project", providerId: "claude" }] };
const runtime = { runtimeGeneration: "generation-1", providerEpoch: "provider-1" };
const binding = { interactionSessionId: "conversation-1", timelineEpoch: "epoch-1", runtime };
const pending = { interactionSessionId: binding.interactionSessionId, runtime, request: {
  requestId: "request-1", clientMessageId: "original-message", kind: "question",
  payload: { input: { questions: [
    { id: "database", question: "Which approach?", options: [{ label: "SQLite" }, { label: "Postgres" }], allowOther: true },
    { id: "scope", question: "Which approach?", options: [{ label: "Personal" }, { label: "Team" }], multiSelect: true },
  ] } },
} };

async function fixture(t, request = pending) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-slack-pending-"));
  const file = path.join(root, "deliveries.json");
  const journal = new SlackJournal(file, config);
  await journal.acquire();
  t.onTestFinished(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const thread = { teamId: "T1", channelId: "C1", threadTs: "100.001", agentId: "agent-1", interactionSessionId: binding.interactionSessionId,
    backend: { profileId: "team", backendId: "backend-1", scopeId: "scope-team" }, cursor: { epoch: "epoch-1", sequence: 0 }, route: config.channels[0] };
  journal.data.threads[slackKey("T1", "C1", thread.threadTs)] = thread;
  journal.save();
  const state = { pending: [structuredClone(request)], rows: [], outcome: "succeeded" };
  const calls = { backend: [], slack: [], writes: [] };
  const backend = new DureSlackBackend(async () => ({ profile: { id: "team", expected: { backendId: "backend-1" } } }), {
    requestBackend: async (profile, operation) => {
      assert.equal(profile.expected.backendId, "backend-1");
      assert.equal(operation.scopeId, "scope-team");
      assert.ok(operation.requiredCapabilities.includes("plugin.slack"));
      if (operation.operation === "agent_runtime.projection.inspect") return { result: { state: "stable", receipt: { agentId: operation.body.agentId, authority: { interactionProfile: "structured_protocol" } } } };
      calls.backend.push(operation);
      if (operation.operation === "agent_conversation.read") return { result: { read: { type: "page", page: {
        binding, pendingRequests: state.pending, activeTurn: { turnId: "turn-1" }, rows: state.rows,
        finalCursor: { epoch: "epoch-1", sequence: 0 },
      } } } };
      if (operation.operation === "agent_conversation.steer_turn") return { result: { receipt: { state: "accepted" } } };
      assert.equal(operation.operation, "agent_conversation.answer_pending", "answers never spawn, steer or inspect another task");
      const recorded = Object.values(JSON.parse(fs.readFileSync(file, "utf8")).inbox).find((entry) => entry.intent?.idempotencyKey === operation.body.idempotencyKey);
      assert.deepEqual(recorded.intent, operation.body, "the exact answer is durable before the provider call");
      if (state.outcome instanceof Error) throw state.outcome;
      if (state.outcome === "succeeded") {
        state.pending = [];
        state.rows.push({ item: { itemId: operation.body.idempotencyKey, body: { type: "pending_answer",
          idempotency_key: operation.body.idempotencyKey, request: structuredClone(request), answer: operation.body.answer } } });
      }
      return { result: { receipt: { state: state.outcome } } };
    },
  });
  const slack = {
    async write(target, text, key, ts, blocks) {
      const result = { ts: ts ?? `200.${String(calls.writes.length + 1).padStart(3, "0")}` };
      calls.writes.push({ target: structuredClone(target), text, key, ts: result.ts, blocks });
      return result;
    },
    async call(method, body) { calls.slack.push({ method, body }); return { ok: true }; },
    async findDelivery() { throw new Error("No unconfirmed delivery in this fixture"); },
  };
  const bridge = new SlackBridge({ config, botUserId: "U0", journal, backend, slack });
  await bridge.tick((error) => { throw error; });
  const entry = Object.values(journal.data.pending)[0];
  const action = (name, user = "U2", ts = "300.001") => ({ type: "block_actions", team: { id: "T1" }, user: { id: user },
    container: { channel_id: "C1", message_ts: journal.data.outbound[entry.key].ts }, message: { user: "U0" }, trigger_id: "transient-trigger",
    actions: [{ action_id: `dure.pending.${name}`, value: entry.key, action_ts: ts }] });
  const submission = (user = "U2", id = "V1") => ({ type: "view_submission", team: { id: "T1" }, user: { id: user, name: user === "U2" ? "Jay" : "Teammate" }, view: {
    id, callback_id: "dure.pending.answer", private_metadata: entry.key,
    state: { values: { q0: { choice: { selected_option: { value: "0" } } }, other0: { answer: { value: "Use our existing database" } },
      q1: { choice: { selected_options: [{ value: "1" }, { value: "0" }] } } } },
  } });
  return { root, file, journal, state, calls, bridge, entry, action, submission, thread, slack, backend };
}

test("Slack opens the core question immediately and delivers choices/free text with its exact identity", async (t) => {
  const f = await fixture(t);
  assert.match(f.calls.writes[0].text, /Which approach/);
  assert.ok(f.calls.writes[0].blocks.some((block) => block.type === "actions"));
  const callsBeforeOpen = f.calls.backend.length;
  await f.bridge.interact(f.action("open")).run();
  assert.equal(f.calls.backend.length, callsBeforeOpen, "opening a question does not wait for a backend read");
  const modal = f.calls.slack[0];
  assert.equal(modal.method, "views.open");
  assert.equal(modal.body.trigger_id, "transient-trigger");
  assert.equal(modal.body.view.blocks.filter((block) => block.type === "input").length, 3);
  const submitted = f.submission();
  f.bridge.interact(submitted);
  f.bridge.interact(submitted);
  assert.equal(Object.keys(f.journal.data.inbox).length, 1);
  assert.equal(f.calls.backend.length, callsBeforeOpen, "acknowledgement does not run the answer");
  await f.bridge.tick((error) => { throw error; });
  const [answer] = f.calls.backend.filter((call) => call.operation === "agent_conversation.answer_pending");
  assert.deepEqual(answer.body.answer, { answers: { database: "Use our existing database", scope: "Personal, Team" } });
  assert.equal(answer.body.interactionSessionId, binding.interactionSessionId);
  assert.deepEqual(answer.body.runtime, runtime);
  assert.equal(answer.body.requestId, "request-1");
  assert.equal(answer.body.clientMessageId, "original-message");
  assert.match(f.calls.writes.at(-1).text, /Answer delivered from Jay/);
  assert.match(f.calls.writes.at(-1).text, /Use our existing database/);
  assert.match(f.calls.writes.at(-1).text, /Personal, Team/);
  assert.ok(f.calls.writes.at(-1).blocks.every((block) => block.type !== "actions"));
  const posts = f.calls.writes.length;
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.writes.length, posts);
  assert.ok(!fs.readFileSync(f.file, "utf8").includes("transient-trigger"));
});

test("another teammate may answer and the core decides a stale concurrent answer", async (t) => {
  const f = await fixture(t);
  const second = f.submission("U3", "V2");
  f.bridge.interact(f.submission());
  await f.bridge.tick((error) => { throw error; });
  f.state.outcome = Object.assign(new Error("The request is already answered"), { code: "answer_stale" });
  f.bridge.interact(second);
  const errors = [];
  await f.bridge.tick((error) => errors.push(error.code));
  assert.deepEqual(errors, ["answer_stale"]);
  const answers = f.calls.backend.filter((call) => call.operation === "agent_conversation.answer_pending");
  assert.equal(answers.length, 2, "the second teammate reaches the same authority rather than an adapter ownership gate");
  assert.equal(answers[1].body.requestId, answers[0].body.requestId);
  assert.deepEqual(Object.values(f.journal.data.inbox).map((entry) => [entry.message.userId, entry.state]), [["U2", "delivered"], ["U3", "failed"]]);
  assert.match(f.calls.writes.at(-1).text, /Use our existing database/, "a rejected second answer does not hide the answer the provider received");
  assert.match(f.calls.writes.at(-1).text, /answer from Teammate could not be delivered/);
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.answer_pending").length, 2);
});

test("permissions use the provider's existing allow/deny path and actual failed attempts are not replayed", async (t) => {
  const f = await fixture(t, { ...pending, request: { ...pending.request, kind: "permission", payload: {
    toolName: "Read", input: { file_path: "README.md" }, presentation: { title: "Read README.md", description: "Read the project instructions" },
  } } });
  assert.match(f.calls.writes[0].text, /README.md/);
  f.state.outcome = "uncertain";
  const original = f.action("allow");
  f.bridge.interact(original);
  const errors = [];
  await f.bridge.tick((error) => errors.push(error.code));
  assert.equal(errors.length, 1);
  assert.match(f.calls.writes.at(-1).text, /could not be delivered/);
  f.bridge.interact(original);
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.answer_pending").length, 1);
  f.state.outcome = "succeeded";
  f.bridge.interact(f.action("deny", "U3", "301.001"));
  await f.bridge.tick((error) => { throw error; });
  const answers = f.calls.backend.filter((call) => call.operation === "agent_conversation.answer_pending");
  assert.deepEqual(answers.map((call) => call.body.answer), [{ decision: "allow" }, { decision: "deny" }]);
  assert.deepEqual(Object.values(f.journal.data.inbox).map((entry) => entry.state), ["failed", "delivered"]);
});

test("Dure-side resolution updates the existing Slack prompt without inventing a Slack answer", async (t) => {
  const f = await fixture(t);
  f.state.pending = [];
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.writes.length, 2);
  assert.equal(f.calls.writes[0].ts, f.calls.writes[1].ts);
  assert.match(f.calls.writes[1].text, /no longer pending/);
  assert.deepEqual(f.journal.data.inbox, {});
});

test("confirmed Dure answers remain on the shared prompt after reconnect without exposing sensitive answers", async (t) => {
  const question = structuredClone(pending);
  question.request.payload.input.questions[1].isSecret = true;
  const f = await fixture(t, question);
  f.state.pending = [];
  f.state.rows = [{ item: { itemId: "answer-1", body: { type: "pending_answer", request: question,
    idempotency_key: "dure-answer", answer: { answers: { database: "Use SQLite", scope: "private-answer" } } } } }];
  await f.bridge.tick((error) => { throw error; });
  assert.match(f.calls.writes.at(-1).text, /Use SQLite/);
  assert.doesNotMatch(JSON.stringify(f.calls.writes), /private-answer/);
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /private-answer/);
  assert.equal(f.calls.writes.at(-1).ts, f.calls.writes[0].ts);
  assert.ok(f.calls.writes.at(-1).blocks.every((block) => block.type !== "actions"));
  f.journal.close();
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  try {
    const count = f.calls.writes.length;
    f.state.rows = [];
    await new SlackBridge({ config, journal, backend: f.backend, slack: f.slack, botUserId: "U0" }).tick((error) => { throw error; });
    assert.equal(f.calls.writes.length, count);
  } finally { journal.close(); }
});

test("question actions retain their original target across connector restart", async (t) => {
  const f = await fixture(t);
  f.bridge.interact(f.submission());
  f.journal.close();
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  try {
    const bridge = new SlackBridge({ config, journal, slack: f.slack, backend: f.backend, botUserId: "U0" });
    await bridge.tick((error) => { throw error; });
    bridge.interact(f.submission());
    await bridge.tick((error) => { throw error; });
    assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.answer_pending").length, 1);
    assert.equal(Object.values(journal.data.inbox)[0].intent.clientMessageId, "original-message");
  } finally { journal.close(); }
});

test("ordinary thread replies remain steering while a question is pending", async (t) => {
  const f = await fixture(t);
  f.bridge.accept({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "U3", ts: "301.001", thread_ts: "100.001", text: "<@U0> Also keep the existing API" } });
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.steer_turn").length, 1);
  assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.answer_pending").length, 0);
  f.bridge.interact(f.submission());
  f.state.rows = [{ item: { itemId: "dure-message", body: { type: "message", role: "user", markdown: "Keep it simple" } } }];
  await f.bridge.tick((error) => { throw error; });
  assert.ok(f.calls.writes.some((write) => write.text === "Dure:\nKeep it simple"));
});

test("only an exact workspace/message control can submit and sensitive questions keep decline only", async (t) => {
  const f = await fixture(t, { ...pending, request: { ...pending.request, payload: { input: { questions: [
    { id: "secret", question: "Enter a secret", options: [], isSecret: true },
  ] } } } });
  const actions = f.calls.writes[0].blocks.find((block) => block.type === "actions").elements;
  assert.deepEqual(actions.map((action) => action.action_id), ["dure.pending.deny"]);
  assert.deepEqual(f.bridge.interact(f.action("open")), {});
  f.bridge.interact({ ...f.action("deny"), team: { id: "T2" } });
  f.bridge.interact({ ...f.action("deny"), container: { channel_id: "C2", message_ts: f.calls.writes[0].ts } });
  f.bridge.interact({ ...f.action("deny"), message: { user: "UOTHER" } });
  f.bridge.interact(f.submission());
  assert.deepEqual(f.journal.data.inbox, {});
  f.bridge.interact(f.action("deny"));
  await f.bridge.tick((error) => { throw error; });
  assert.deepEqual(f.calls.backend.find((call) => call.operation === "agent_conversation.answer_pending").body.answer, { decision: "deny" });
});

test("Socket Mode persists submitted answers before acknowledgement and opens modals after acknowledgement", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let socket;
  const acknowledgements = [];
  class Socket extends EventTarget {
    constructor() { super(); socket = this; }
    send(data) {
      const ack = JSON.parse(data);
      if (ack.envelope_id === "submission") assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.file, "utf8")).inbox).length, 1);
      acknowledgements.push(ack);
    }
    close() {}
  }
  const finish = Promise.withResolvers();
  f.slack.call = async (method) => {
    assert.equal(method, "views.open");
    assert.equal(acknowledgements[0].envelope_id, "open");
    await finish.promise;
  };
  const running = consumeSlackSocket({ url: "wss://wss.slack.com/link", bridge: f.bridge, signal: controller.signal, WebSocketImpl: Socket });
  const send = (id, payload) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "interactive", envelope_id: id, accepts_response_payload: true, payload }) }));
  send("open", f.action("open"));
  const incomplete = f.submission();
  incomplete.view.state.values = {};
  send("incomplete", incomplete);
  assert.equal(acknowledgements[1].payload.response_action, "errors");
  send("submission", f.submission());
  assert.equal(acknowledgements.length, 3);
  assert.equal(f.calls.backend.filter((call) => call.operation === "agent_conversation.answer_pending").length, 0);
  controller.abort();
  let stopped = false;
  void running.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finish.resolve();
  await running;
});
