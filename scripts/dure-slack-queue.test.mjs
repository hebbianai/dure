import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import { DureSlackBackend } from "../cli/lib/slack/backend.mjs";
import { SlackBridge } from "../cli/lib/slack/bridge.mjs";
import { slackKey } from "../cli/lib/slack/event.mjs";
import { SlackJournal } from "../cli/lib/slack/journal.mjs";

const config = { schemaVersion: 1, teamId: "T1", channels: [{ channelId: "C1", projectId: "project-1", providerId: "claude" }] };
const binding = { interactionSessionId: "conversation-1", timelineEpoch: "timeline-1",
  runtime: { runtimeGeneration: "runtime-1", providerEpoch: "provider-1" } };
const unsupported = () => new BackendTransportError("backend_transport_remote_error", {
  details: { code: "agent_conversation_steer_unsupported", disposition: "terminal" },
});
const message = (user = "U2", ts = "101.001") => ({ type: "event_callback", team_id: "T1", event: {
  type: "message", user, channel: "C1", thread_ts: "100.001", ts, text: `<@U0> Include the changes from ${user}`,
} });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-slack-queue-"));
  const file = path.join(root, "deliveries.json");
  let journal = new SlackJournal(file, config);
  await journal.acquire();
  t.onTestFinished(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const thread = { teamId: "T1", channelId: "C1", threadTs: "100.001", agentId: "agent-1",
    backend: { profileId: "team", backendId: "backend-1", scopeId: "scope-team" },
    interactionSessionId: binding.interactionSessionId, cursor: { epoch: binding.timelineEpoch, sequence: 0 }, route: config.channels[0] };
  journal.data.threads[slackKey("T1", "C1", thread.threadTs)] = thread;
  journal.save();
  const calls = [], writes = [], admissions = new Map();
  const state = { steer: unsupported(), queue: "queued", binding: structuredClone(binding) };
  const backend = new DureSlackBackend(async () => ({ profile: { id: "team", expected: { backendId: "backend-1" } } }), {
    requestBackend: async (profile, request) => {
      assert.equal(profile.expected.backendId, "backend-1");
      assert.equal(request.scopeId, "scope-team");
      assert.ok(request.requiredCapabilities.includes("plugin.slack"));
      if (request.operation === "agent_runtime.projection.inspect") return { result: { state: "stable",
        receipt: { agentId: "agent-1", authority: { interactionProfile: "structured_protocol" } } } };
      if (request.operation === "agent_conversation.read") return { result: { read: { type: "page", page: {
        binding: state.binding, activeTurn: { turnId: "active-turn" }, rows: [], pendingRequests: [],
        finalCursor: { epoch: binding.timelineEpoch, sequence: 0 },
      } } } };
      calls.push(structuredClone(request));
      const persisted = Object.values(JSON.parse(fs.readFileSync(file, "utf8")).inbox)
        .find((entry) => entry.intent?.clientMessageId === request.body.clientMessageId);
      assert.equal(persisted.operation, request.operation);
      assert.deepEqual(persisted.intent, request.body, "persist the exact target and input before each delivery");
      if (request.operation === "agent_conversation.steer_turn") {
        if (state.steer instanceof Error) throw state.steer;
        return { result: { receipt: { state: state.steer, providerReceipt: { errorCode: "steer_unsupported" } } } };
      }
      assert.equal(request.operation, "agent_conversation.enqueue_turn", "do not start another task or bypass the common queue");
      const previous = admissions.get(request.body.clientMessageId);
      if (previous) assert.deepEqual(request.body, previous);
      else admissions.set(request.body.clientMessageId, structuredClone(request.body));
      if (state.queue instanceof Error) throw state.queue;
      return { result: { receipt: { intent: request.body, state: state.queue } } };
    },
  });
  const slack = {
    async write(target, text, key) { writes.push({ target, text, key }); return { ts: `200.${writes.length}` }; },
    async findDelivery() { throw new Error("No unconfirmed Slack write in this fixture"); },
  };
  const bridge = () => new SlackBridge({ config, botUserId: "U0", journal, backend, slack });
  return { file, state, calls, writes, admissions, bridge: bridge(), get journal() { return journal; }, async restart() {
    journal.close();
    journal = new SlackJournal(file, config);
    await journal.acquire();
    return bridge();
  } };
}

test("unsupported Slack steering queues teammate input once with its original target and order", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(message());
  f.bridge.accept(message("U3", "102.001"));
  const errors = [];
  await f.bridge.tick((error) => errors.push(error));
  assert.deepEqual(errors, [], "an explicit unsupported-steering refusal should use the common queue");
  assert.deepEqual(f.calls.map((call) => call.operation), [
    "agent_conversation.steer_turn", "agent_conversation.enqueue_turn",
    "agent_conversation.steer_turn", "agent_conversation.enqueue_turn",
  ]);
  const queued = [...f.admissions.values()];
  assert.equal(queued.length, 2);
  for (const [index, user] of ["U2", "U3"].entries()) {
    const intent = queued[index];
    const steer = f.calls[index * 2].body;
    assert.equal(intent.interactionSessionId, binding.interactionSessionId);
    assert.deepEqual(intent.runtime, binding.runtime);
    assert.equal(intent.input, steer.input);
    assert.equal(intent.requestedAtMs, steer.requestedAtMs);
    assert.ok(intent.input.includes(`T1/${user}`));
    assert.notEqual(intent.turnId, "active-turn");
    assert.notEqual(intent.clientMessageId, steer.clientMessageId);
  }
  assert.notEqual(queued[0].clientMessageId, queued[1].clientMessageId);
  assert.deepEqual(Object.values(f.journal.data.inbox).map((entry) => entry.state), ["delivered", "delivered"]);
  f.state.binding.runtime.runtimeGeneration = "replacement-runtime";
  const restarted = await f.restart();
  assert.equal(restarted.accept(message()), false);
  await restarted.tick((error) => { throw error; });
  assert.equal(f.calls.length, 4);
  assert.equal(f.writes.length, 0, "queue acceptance must not publish a failure or invent completion");
});

for (const [label, outcome] of [
  ["transport loss", new BackendTransportError("backend_transport_timeout")],
  ["ordinary provider failure", new BackendTransportError("backend_transport_remote_error", { details: { code: "agent_conversation_provider_failed", disposition: "terminal" } })],
  ["stale target", new BackendTransportError("backend_transport_remote_error", { details: { code: "agent_conversation_conflict", disposition: "stale_generation" } })],
  ["unsupported text in an unrelated error", Object.assign(new Error("agent_conversation_steer_unsupported"), { code: "agent_conversation_steer_unsupported" })],
  ["unconfirmed disposition", new BackendTransportError("backend_transport_remote_error", { details: { code: "agent_conversation_steer_unsupported", disposition: "retry_same" } })],
  ["prepared receipt", "prepared"], ["uncertain receipt", "uncertain"], ["failed receipt", "failed"],
]) {
  test(`${label} never authorizes another Slack input delivery`, async (t) => {
    const f = await fixture(t);
    f.state.steer = outcome;
    f.bridge.accept(message());
    const errors = [];
    await f.bridge.tick((error) => errors.push(error));
    assert.equal(errors.length, 1);
    const restarted = await f.restart();
    await restarted.tick((error) => { throw error; });
    assert.equal(f.calls.length, 1);
    assert.equal(f.admissions.size, 0);
    assert.equal(Object.values(f.journal.data.inbox)[0].state, "failed");
    assert.equal(f.writes.length, 1);
  });
}

for (const boundary of ["before queue journal", "after queue journal", "after queue admission"]) {
  test(`a crash ${boundary} resumes the saved intent without duplicating queue admission`, async (t) => {
    const f = await fixture(t);
    f.bridge.accept(message());
    const entry = Object.values(f.journal.data.inbox)[0];
    const save = f.journal.save.bind(f.journal);
    let crashed = false;
    f.journal.save = () => {
      if (!crashed && entry.operation === "agent_conversation.enqueue_turn" &&
          (boundary === "after queue admission" ? entry.state === "delivered" : entry.state === "queued")) {
        crashed = true;
        if (boundary === "after queue journal") save();
        throw new Error("simulated process crash");
      }
      save();
    };
    await assert.rejects(f.bridge.receive(entry), /simulated process crash/);
    assert.equal(crashed, true);
    const queueTarget = structuredClone(entry.intent);
    const persisted = Object.values(JSON.parse(fs.readFileSync(f.file, "utf8")).inbox)[0];
    assert.equal(persisted.state, "queued");
    assert.equal(persisted.operation, boundary === "before queue journal" ?
      "agent_conversation.steer_turn" : "agent_conversation.enqueue_turn");
    if (boundary === "after queue admission") f.state.queue = "dispatched";
    const restarted = await f.restart();
    await restarted.tick((error) => { throw error; });
    const reloaded = Object.values(f.journal.data.inbox)[0];
    assert.deepEqual(reloaded.intent, queueTarget);
    assert.equal(reloaded.state, "delivered");
    assert.equal(f.admissions.size, 1);
    assert.equal(f.calls.filter((call) => call.operation === "agent_conversation.steer_turn").length,
      boundary === "before queue journal" ? 2 : 1);
    const admissions = f.calls.filter((call) => call.operation === "agent_conversation.enqueue_turn");
    assert.equal(admissions.length, boundary === "after queue admission" ? 2 : 1);
    for (const admission of admissions) assert.deepEqual(admission.body, queueTarget);
    assert.equal(f.writes.length, 0);
  });
}

for (const [label, outcome] of [
  ["canceled", "canceled"], ["unconfirmed", "uncertain"],
  ["response lost", new BackendTransportError("backend_transport_timeout")],
]) {
  test(`a ${label} queue admission is not reported as delivered or resent`, async (t) => {
    const f = await fixture(t);
    f.state.queue = outcome;
    f.bridge.accept(message());
    const errors = [];
    await f.bridge.tick((error) => errors.push(error));
    assert.equal(errors.length, 1);
    assert.equal(Object.values(f.journal.data.inbox)[0].state, "failed");
    const restarted = await f.restart();
    await restarted.tick((error) => { throw error; });
    assert.deepEqual(f.calls.map((call) => call.operation), ["agent_conversation.steer_turn", "agent_conversation.enqueue_turn"]);
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].text, /could not confirm/);
  });
}
