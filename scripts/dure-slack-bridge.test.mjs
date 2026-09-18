import assert from "node:assert/strict";
import { test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SlackJournal } from "../cli/lib/slack/journal.mjs";
import { SlackBridge } from "../cli/lib/slack/bridge.mjs";
import { DureSlackBackend } from "../cli/lib/slack/backend.mjs";
import { SlackApi } from "../cli/lib/slack/api.mjs";
import { incomingSlackMessage, slackInput, validateSlackConfig, slackKey } from "../cli/lib/slack/event.mjs";
import { consumeSlackSocket } from "../cli/lib/slack/socket.mjs";
import { succeededStructuredReceipt } from "./fixtures/agent-spawn-receipts.mjs";

const config = { schemaVersion: 1, teamId: "T1", channels: [{ channelId: "C1", projectId: "project-1", providerId: "claude" }] };
const payload = (overrides = {}) => ({ type: "event_callback", team_id: "T1", event: {
  type: "app_mention", user: "U1", channel: "C1", ts: "100.001", text: "<@U0> Improve onboarding", ...overrides,
} });
const binding = { interactionSessionId: "interaction-1", timelineEpoch: "epoch-1", runtime: { generation: "generation-1" } };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-slack-test-"));
  const file = path.join(root, "deliveries.json");
  const journal = new SlackJournal(file, config);
  await journal.acquire();
  t.onTestFinished(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = { starts: [], inputs: [], writes: [], recoveries: [] };
  let page = { binding, activeTurn: null, latestFailure: null, rows: [], finalCursor: { epoch: "epoch-1", sequence: 0 } };
  const backend = {
    async bind() { return { profileId: "local", backendId: "backend-1" }; },
    async start(message) { calls.starts.push(message); return "agent-1"; },
    async read() { return page; },
    async deliver(thread, intent, operation) { calls.inputs.push({ thread, intent, operation }); },
  };
  const slack = {
    async write(thread, text, key, ts) { calls.writes.push({ thread, text, key, ts }); return { ts: ts ?? `200.${calls.writes.length}` }; },
    async findDelivery(thread, key) { calls.recoveries.push({ thread, key }); return "200.1"; },
  };
  const bridge = new SlackBridge({ config, botUserId: "U0", journal, backend, slack });
  return { root, file, journal, calls, backend, slack, bridge, setPage(value) { page = { ...page, ...value }; } };
}

test("a mention and its message subscription create one task, including after reconnect", async (t) => {
  const f = await fixture(t);
  assert.equal(f.bridge.accept(payload()), true);
  assert.equal(f.bridge.accept(payload({ type: "message" })), false);
  await f.bridge.tick();
  assert.equal(f.calls.starts.length, 1);
  f.journal.close();
  const restarted = new SlackJournal(f.file, config);
  await restarted.acquire();
  try {
    const bridge = new SlackBridge({ config, botUserId: "U0", journal: restarted, backend: f.backend, slack: f.slack });
    assert.equal(bridge.accept(payload()), false);
    await bridge.tick();
    assert.equal(f.calls.starts.length, 1);
  } finally { restarted.close(); }
});

test("teammates continue the same thread with their identities and the current turn", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  f.setPage({ activeTurn: { turnId: "turn-running" } });
  f.bridge.accept(payload({ type: "message", ts: "101.001", thread_ts: "100.001", user: "U2", text: "<@U0> Start with the empty state" }));
  await f.bridge.tick();
  assert.equal(f.calls.starts.length, 1);
  assert.equal(f.calls.inputs[0].operation, "agent_conversation.steer_turn");
  assert.equal(f.calls.inputs[0].intent.turnId, "turn-running");
  assert.match(f.calls.inputs[0].intent.input, /T1\/U2/);
  f.setPage({ activeTurn: null });
  f.bridge.accept(payload({ type: "message", ts: "102.001", thread_ts: "100.001", user: "U3", text: "<@U0> Now improve the welcome copy" }));
  await f.bridge.tick();
  assert.equal(f.calls.inputs[1].operation, "agent_conversation.start_turn");
  assert.equal(f.calls.inputs[1].intent.interactionSessionId, binding.interactionSessionId);
});

test("unconnected channels, other workspaces, bot messages and unrelated conversation do not start work", () => {
  validateSlackConfig(config);
  for (const event of [payload({ channel: "C2" }), payload({ user: "U0" }), payload({ bot_id: "B1" }),
    payload({ type: "message", text: "ordinary chat" }), payload({ subtype: "message_changed" }),
    { ...payload(), team_id: "T2" }]) {
    assert.equal(incomingSlackMessage(event, config, "U0", {}), null);
  }
  const dm = { ...config, channels: [{ ...config.channels[0], channelId: "D1" }] };
  assert.ok(incomingSlackMessage(payload({ channel: "D1", channel_type: "im", type: "message", text: "Help with onboarding" }), dm, "U0", {}));
});

test("human thread conversation never starts or steers work without an explicit mention", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  for (const activeTurn of [null, { turnId: "running" }]) {
    f.setPage({ activeTurn });
    for (const [index, extra] of [{}, { subtype: "file_share", files: [{ id: "FIMAGE", name: "image.png" }] }].entries()) {
      const event = payload({ type: "message", ts: `${activeTurn ? 103 : 102}.00${index + 1}`,
        thread_ts: "100.001", user: "U2", text: "Discussing this with a teammate", ...extra });
      assert.equal(f.bridge.accept(event), true);
      assert.equal(f.bridge.accept(event), false);
    }
    await f.bridge.tick();
  }
  assert.equal(f.calls.inputs.length, 0);
  assert.equal(Object.keys(f.journal.data.inbox).length, 5);
  assert.equal(f.calls.writes.length, 0);
});

test("untagged discussion survives reconnect and enters only the next mention in its own thread", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  f.bridge.accept(payload({ ts: "200.001" }));
  await f.bridge.tick();
  f.bridge.accept(payload({ type: "message", thread_ts: "100.001", ts: "102.001", user: "U3", text: "Keep the blue version" }));
  f.bridge.accept(payload({ type: "message", thread_ts: "100.001", ts: "101.001", user: "U2", text: "Can we try blue?" }));
  f.bridge.accept(payload({ type: "message", thread_ts: "200.001", ts: "201.001", text: "Other task discussion" }));
  await f.bridge.tick();
  assert.equal(f.calls.inputs.length, 0);
  f.journal.close();
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  try {
    const bridge = new SlackBridge({ config, botUserId: "U0", journal, backend: f.backend, slack: f.slack });
    bridge.accept(payload({ type: "message", thread_ts: "100.001", ts: "103.001", text: "<@U0> Apply what we agreed" }));
    bridge.accept(payload({ type: "message", thread_ts: "100.001", ts: "104.001", text: "Discuss the next change later" }));
    await bridge.tick(error => { throw error; });
    const first = f.calls.inputs[0].intent.input;
    assert.match(first, /context only/);
    assert.match(first, /T1\/U2[\s\S]*Can we try blue\?[\s\S]*T1\/U3[\s\S]*Keep the blue version[\s\S]*Apply what we agreed/);
    assert.doesNotMatch(first, /Other task discussion|Discuss the next change later/);
    f.setPage({ rows: [{ item: { itemId: "echo", body: { type: "message", role: "user", markdown: first } } }] });
    const read = f.backend.read;
    f.backend.read = async (thread) => thread.threadTs === "200.001" ? { ...await read(), rows: [] } : read();
    await bridge.tick();
    assert.equal(f.calls.writes.length, 0, "context must not echo back into Slack");
    bridge.accept(payload({ type: "message", thread_ts: "100.001", ts: "105.001", text: "<@U0> Continue" }));
    await bridge.tick(error => { throw error; });
    assert.match(f.calls.inputs[1].intent.input, /Discuss the next change later/);
    assert.doesNotMatch(f.calls.inputs[1].intent.input, /Keep the blue version|Can we try blue|Other task discussion/);
  } finally { journal.close(); }
});

test("failed delivery preserves background discussion for the next explicit request", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  f.bridge.accept(payload({ type: "message", thread_ts: "100.001", ts: "101.001", text: "Use the smaller version" }));
  f.bridge.accept(payload({ type: "message", thread_ts: "100.001", ts: "102.001", text: "<@U0> Apply it" }));
  const deliver = f.backend.deliver;
  f.backend.deliver = async () => { throw new Error("Delivery refused"); };
  await f.bridge.tick();
  f.backend.deliver = deliver;
  f.bridge.accept(payload({ type: "message", thread_ts: "100.001", ts: "103.001", text: "<@U0> Try again" }));
  await f.bridge.tick(error => { throw error; });
  assert.match(f.calls.inputs[0].intent.input, /Use the smaller version/);
});

test("a teammate's image reply reaches the active turn with its caption and attachment identity", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  f.setPage({ activeTurn: { turnId: "turn-running" } });
  const event = payload({ type: "message", subtype: "file_share", ts: "101.001", thread_ts: "100.001",
    text: "<@U0> This is what I see", files: [{ id: "FIMAGE", name: "image.png", mimetype: "image/png", size: 100 }] });
  assert.equal(f.bridge.accept(event), true);
  assert.equal(f.bridge.accept(event), false);
  await f.bridge.tick();
  assert.equal(f.calls.inputs.length, 1);
  assert.equal(f.calls.inputs[0].operation, "agent_conversation.steer_turn");
  assert.match(f.calls.inputs[0].intent.input, /This is what I see/);
  assert.match(f.calls.inputs[0].intent.input, /image\.png/);
});

test("an image-only reply is retained, while edited and bot attachment events remain excluded", () => {
  const event = payload({ type: "message", subtype: "file_share", text: "<@U0>", ts: "101.001", thread_ts: "100.001",
    files: [{ id: "FIMAGE", name: "image.png", mimetype: "image/png", size: 100 }] });
  const threads = { [slackKey("T1", "C1", "100.001")]: {} };
  assert.equal(incomingSlackMessage(event, config, "U0", threads)?.files[0].id, "FIMAGE");
  for (const change of [{ subtype: "message_changed" }, { bot_id: "B1" }, { user: "U0" }]) {
    assert.equal(incomingSlackMessage({ ...event, event: { ...event.event, ...change } }, config, "U0", threads), null);
  }
});

test("channel defaults enter only a new task's initial context and survive both config versions", () => {
  const route = {...config.channels[0], model: "model-fixture", effort: "high", accountId: "team", permissionOverride: "require_approvals", instructions: "Review before publishing."};
  for (const schemaVersion of [1, 2]) {
    const configured = validateSlackConfig({...config, schemaVersion, channels: [route]});
    const message = incomingSlackMessage(payload(), configured, "U0", {});
    assert.match(slackInput(message, {initial: true}), /Shared instructions: Review before publishing/);
    assert.doesNotMatch(slackInput(message), /Review before publishing/);
  }
  for (const change of [{model: "--unsafe"}, {effort: "high;exit"}, {accountId: "../private"}, {instructions: 3}, {permissionOverride: "unknown"}]) {
    assert.throws(() => validateSlackConfig({...config, channels: [{...route, ...change}]}));
  }
});

test("Slack passes the channel model, effort, approval mode and exact server credential into the real spawn client", async () => {
  const requests = [];
  const executionProfile = {kind: "credential_reference", reference_id: "team", credential_generation: "credential-current"};
  let receipt;
  const backend = new DureSlackBackend(async () => ({profile: {id: "team", transport: {kind: "local"}, expected: {backendId: "backend-1", scopeId: "scope-1", capabilities: []}}}), {
    requestBackend: async (profile, request) => {
      assert.equal(profile.expected.scopeId, "scope-1");
      requests.push(request);
      if (request.operation === "provider_recovery.get") return {result: {schemaVersion: 1, profiles: [
        {schemaVersion: 1, providerId: "claude", referenceId: "team", credentialGeneration: "credential-current"},
      ]}};
      if (request.operation === "agent_spawn.preview") {
        assert.deepEqual(request.body.executionProfile, executionProfile);
        assert.equal(request.body.model, "model-fixture");
        assert.equal(request.body.effort, "high");
        assert.equal(request.body.permissionOverride, "require_approvals");
        receipt = succeededStructuredReceipt({...request.body, worktree: {...request.body.worktree, base_commit_sha: "a".repeat(40)}});
        receipt.plan.request.executionProfile = executionProfile;
        receipt.completed[1].inputs.execution_profile = executionProfile;
        receipt.completed[1].evidence.binding.executionProfile = executionProfile;
        receipt.plan.authority.projectId = request.body.projectId;
        receipt.completed[0].evidence.lease.directory_name = request.body.worktree.branch.split("/").at(-1);
      }
      return {backend: {id: "backend-1", generation: "g1", protocol: {major: 1, minor: 0}, capabilities: [], observedAtMs: Date.now()}, result: {schemaVersion: 1, receipt}};
    },
  });
  const configured = {...config, channels: [{...config.channels[0], model: "model-fixture", effort: "high", accountId: "team", permissionOverride: "require_approvals"}]};
  const message = incomingSlackMessage(payload(), configured, "U0", {});
  await backend.start(message, {backend: {profileId: "team", backendId: "backend-1", scopeId: "scope-1"}});
  assert.deepEqual(requests.map(({operation}) => operation), ["provider_recovery.get", "agent_spawn.preview", "agent_spawn.apply"]);
});

test("a missing server account prevents a Slack task launch without using the default account", async () => {
  const requests = [];
  const backend = new DureSlackBackend(async () => ({profile: {id: "team", expected: {backendId: "backend-1", capabilities: []}}}), {
    requestBackend: async (_profile, request) => { requests.push(request.operation); return {result: {profiles: []}}; },
  });
  const message = incomingSlackMessage(payload(), {...config, channels: [{...config.channels[0], accountId: "private"}]}, "U0", {});
  await assert.rejects(backend.start(message, {backend: {profileId: "team", backendId: "backend-1", scopeId: "scope-1"}}), {code: "slack_account_unavailable"});
  assert.deepEqual(requests, ["provider_recovery.get"]);
});

test("Dure messages and agent replies reach Slack once; Slack input and reasoning are not echoed", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  const first = f.calls.starts[0];
  const bodies = [
    { type: "message", role: "user", markdown: slackInput(first, { initial: true }) },
    { type: "reasoning", text: "private reasoning" },
    { type: "message", role: "assistant", markdown: "Updated the empty state." },
    { type: "message", role: "user", markdown: "Also update the mobile layout." },
  ];
  f.setPage({ rows: bodies.map((body, index) => ({ item: { itemId: `item-${index}`, body } })), finalCursor: { epoch: "epoch-1", sequence: 4 } });
  await f.bridge.tick();
  await f.bridge.tick();
  assert.deepEqual(f.calls.writes.map((call) => call.text), ["Updated the empty state.", "Dure:\nAlso update the mobile layout."]);
  assert.equal(Object.values(f.journal.data.threads)[0].cursor.sequence, 4);
});

test("goal changes reach the same thread without conversation rows and survive reconnect", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  const goal = { agentId: "agent-1", revision: 1, objective: "Improve onboarding", status: "active", detail: null };
  f.setPage({ goal });
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.writes.length, 1);
  assert.match(f.calls.writes[0].text, /active/i);
  assert.ok(f.calls.writes[0].text.includes(goal.objective));
  f.setPage({ goal: { ...goal, revision: 2, objective: "Improve mobile onboarding", status: "paused" }, activeTurn: { turnId: "already-running" } });
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.writes.length, 2);
  assert.match(f.calls.writes[1].text, /paused/i);
  assert.ok(f.calls.writes[1].text.includes("Improve mobile onboarding"));
  assert.equal(f.calls.inputs.length, 0, "observing goal state must not control provider work");
  assert.ok(f.calls.writes.every(({ thread }) => thread.threadTs === "100.001"));
  f.journal.close();
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  try {
    const bridge = new SlackBridge({ config, botUserId: "U0", journal, backend: f.backend, slack: f.slack });
    await bridge.tick((error) => { throw error; });
    assert.equal(f.calls.writes.length, 2);
    for (const [revision, status, detail] of [[3, "complete", "Verified the mobile flow"], [4, "failed", "Provider unavailable"]]) {
      f.setPage({ goal: { ...goal, revision, status, detail } });
      await bridge.tick((error) => { throw error; });
      assert.ok(f.calls.writes.at(-1).text.includes(detail));
      assert.match(f.calls.writes.at(-1).text, new RegExp(status, "i"));
    }
    assert.equal(f.calls.writes.length, 4);
    f.setPage({ goal });
    await bridge.tick((error) => { throw error; });
    assert.equal(f.calls.writes.length, 4, "an older snapshot cannot regress the published revision");
  } finally { journal.close(); }
});

test("older journals establish a goal baseline without publishing private history", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  const thread = Object.values(f.journal.data.threads)[0];
  delete thread.goalRevision;
  f.journal.save();
  const goal = { agentId: thread.agentId, revision: 8, objective: "Earlier private goal", status: "paused" };
  f.setPage({ goal });
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.writes.length, 0);
  f.setPage({ goal: { ...goal, revision: 9, objective: "Shared next goal", status: "active" } });
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.writes.length, 1);
  assert.ok(f.calls.writes[0].text.includes("Shared next goal"));
  assert.ok(!f.calls.writes[0].text.includes("Earlier private goal"));
});

test("failed goal delivery is not resent and another thread keeps receiving updates", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  f.bridge.accept(payload({ ts: "101.001" }));
  f.setPage({ goal: { agentId: "agent-1", revision: 1, objective: "Shared goal", status: "active" } });
  const write = f.slack.write;
  f.slack.write = async (...args) => {
    await write(...args);
    if (args[0].threadTs === "100.001") throw new Error("Slack unavailable");
    return { ts: "200.2" };
  };
  const errors = [];
  await f.bridge.tick((error) => errors.push(error));
  await f.bridge.tick((error) => errors.push(error));
  assert.equal(errors.length, 1);
  assert.deepEqual(f.calls.writes.map(({ thread }) => thread.threadTs), ["100.001", "101.001"]);
  assert.equal(f.calls.starts.length, 2);
  assert.equal(f.calls.inputs.length, 0);
});

test("long goal updates use bounded Unicode message chunks with stable delivery keys", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  const objective = "🚀".repeat(4000);
  f.setPage({ goal: { agentId: "agent-1", revision: 1, objective, status: "active" } });
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.writes.length, 2);
  assert.ok(f.calls.writes.every(({ text }) => Array.from(text).length <= 3500));
  assert.ok(f.calls.writes.map(({ text }) => text).join("").includes(objective));
  await f.bridge.tick((error) => { throw error; });
  assert.equal(f.calls.writes.length, 2);
});

test("a failed task delivery stays failed and does not block another thread or get retried", async (t) => {
  const f = await fixture(t);
  f.backend.start = async (message) => { f.calls.starts.push(message); if (message.text === "fail") throw new Error("provider failed"); return "agent-2"; };
  f.bridge.accept(payload({ text: "<@U0> fail" }));
  f.bridge.accept(payload({ ts: "103.001" }));
  const errors = [];
  await f.bridge.tick((error) => errors.push(error));
  await f.bridge.tick();
  assert.equal(errors.length, 1);
  assert.equal(f.calls.starts.length, 2);
  assert.deepEqual(Object.values(f.journal.data.inbox).map((entry) => entry.state), ["failed", "delivered"]);
  assert.equal(f.calls.writes.length, 1, "the failed request must have a result in its Slack thread");
  assert.equal(f.calls.writes[0].thread.threadTs, "100.001");
  assert.match(f.calls.writes[0].text, /could not confirm/i);
  assert.doesNotMatch(f.calls.writes[0].text, /provider failed/);
});

test("common terminal failures and cancellation reach their Slack thread once across reconnect", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  const events = [
    ["session_ready", null], ["turn_started", null],
    ["turn_failed", "authentication_failed"],
    ["turn_failed", "private provider detail xoxb-secret"],
    ["turn_canceled", null], ["session_failed", "private session detail"],
    ["turn_completed", null], ["session_exited", '{"code":0,"signal":null}'],
  ];
  f.setPage({ rows: events.map(([state, detail], index) => ({ item: {
    itemId: `lifecycle-${index}`, body: { type: "lifecycle", state, detail },
  } })), finalCursor: { epoch: "epoch-1", sequence: events.length } });
  await f.bridge.tick();
  assert.equal(f.calls.writes.length, 4, "terminal failures and cancellation are visible without assistant output");
  assert.match(f.calls.writes[0].text, /authentication/i);
  assert.match(f.calls.writes[1].text, /failed/i);
  assert.match(f.calls.writes[2].text, /canceled/i);
  assert.match(f.calls.writes[3].text, /session.*failed/i);
  assert.ok(f.calls.writes.every(({ thread, text }) =>
    thread.threadTs === "100.001" && !/private|xoxb-secret/.test(text)));
  f.journal.close();
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  try {
    const bridge = new SlackBridge({ config, botUserId: "U0", journal, backend: f.backend, slack: f.slack });
    await bridge.tick();
    assert.equal(f.calls.writes.length, 4, "replayed lifecycle facts keep their original delivery identities");
    assert.equal(f.calls.starts.length, 1);
    assert.equal(f.calls.inputs.length, 0);
  } finally { journal.close(); }
});

test("an unconfirmed direction change stays failed and its Slack notice is not resent", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  f.setPage({ activeTurn: { turnId: "turn-running" } });
  f.backend.deliver = async (_thread, intent, operation) => {
    f.calls.inputs.push({ intent, operation });
    throw new Error("private transport detail");
  };
  f.bridge.accept(payload({ type: "message", ts: "101.001", thread_ts: "100.001", user: "U2", text: "<@U0> Change the direction" }));
  const write = f.slack.write;
  f.slack.write = async (...args) => { await write(...args); throw new Error("Slack unavailable"); };
  await f.bridge.tick();
  f.journal.close();
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  try {
    await new SlackBridge({ config, botUserId: "U0", journal, backend: f.backend, slack: f.slack }).tick();
    assert.equal(f.calls.inputs.length, 1, "an uncertain provider request is not automatically replayed");
    assert.equal(f.calls.inputs[0].operation, "agent_conversation.steer_turn");
    assert.equal(f.calls.writes.length, 1, "a failed Slack notification is attempted only once");
    assert.match(f.calls.writes[0].text, /could not confirm/i);
    assert.doesNotMatch(f.calls.writes[0].text, /private transport detail|never started/);
    assert.equal(Object.values(journal.data.inbox)[1].state, "failed");
  } finally { journal.close(); }
});

test("Slack send failure is recorded, without an automatic resend", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  let writes = 0;
  f.slack.write = async () => { writes++; throw new Error("Slack rejected message"); };
  f.setPage({ rows: [{ item: { itemId: "result", body: { type: "message", role: "assistant", markdown: "Done" } } }] });
  await f.bridge.tick();
  await f.bridge.tick();
  assert.equal(writes, 1);
  assert.equal(Object.values(f.journal.data.outbound)[0].failed, true);
});

test("Pro capability travels on the existing conversation request without a Slack task API", async () => {
  const requests = [];
  const backend = new DureSlackBackend(async () => ({ profile: { id: "local", expected: { backendId: "backend-1" } } }), { requestBackend: async (_profile, request) => {
    if (request.operation === "backend.scope") return { result: { schemaVersion: 1, scopeId: "scope-local" } };
    requests.push(request); return { result: { receipt: { state: "accepted" } } };
  } });
  await backend.deliver({ backend: await backend.bind({}) }, { input: "Continue" }, "agent_conversation.start_turn");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, "agent_conversation.start_turn");
  assert.ok(requests[0].requiredCapabilities.includes("plugin.slack"));
  assert.equal(requests[0].scopeId, "scope-local");
  assert.deepEqual(requests[0].body, { input: "Continue" });
});

test("Socket Mode acknowledges only after persistence, without waiting for an agent", async () => {
  const order = [];
  let socket;
  class Socket extends EventTarget {
    constructor() { super(); socket = this; }
    send(value) { order.push(JSON.parse(value)); }
    close() { this.dispatchEvent(new Event("close")); }
  }
  const controller = new AbortController();
  const running = consumeSlackSocket({ url: "wss://wss.slack.com/link", signal: controller.signal, WebSocketImpl: Socket,
    bridge: { accept() { order.push("persisted"); } } });
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "events_api", envelope_id: "envelope-1", payload: payload() }) }));
  assert.deepEqual(order, ["persisted", { envelope_id: "envelope-1" }]);
  controller.abort();
  await running;
});

test("a journal persistence failure never acknowledges the Slack envelope", async () => {
  const sent = [];
  let socket;
  class Socket extends EventTarget {
    constructor() { super(); socket = this; }
    send(value) { sent.push(value); }
    close() { /* Let the originating failure reject the transport. */ }
  }
  const controller = new AbortController();
  const running = consumeSlackSocket({ url: "wss://wss.slack.com/link", signal: controller.signal, WebSocketImpl: Socket,
    bridge: { accept() { throw new Error("disk full"); } } });
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "events_api", envelope_id: "envelope-1", payload: payload() }) }));
  await assert.rejects(running, /not acknowledged/);
  assert.deepEqual(sent, []);
});

test("failed persistence never exposes an unrecorded message to the task worker", async (t) => {
  const f = await fixture(t);
  f.journal.save = () => { throw new Error("disk full"); };
  assert.throws(() => f.bridge.accept(payload()), /disk full/);
  await f.bridge.tick();
  assert.equal(f.calls.starts.length, 0);
  assert.deepEqual(f.journal.data.inbox, {});
});

test("assistant output cannot create Slack mentions and updates use the same delivery identity", async () => {
  const requests = [];
  const slack = new SlackApi({ appToken: "xapp-test", botToken: "xoxb-test", fetchApi: async (url, request) => {
    requests.push({ url, body: JSON.parse(request.body) });
    return { ok: true, headers: new Headers(), json: async () => ({ ok: true, ts: "200.1" }) };
  } });
  const thread = { channelId: "C1", threadTs: "100.1" };
  const blocks = [{ type: "section", text: { type: "plain_text", text: "<@U1> Choose a database" } },
    { type: "actions", elements: [{ type: "button", action_id: "dure.pending.open", value: "delivery-1", text: { type: "plain_text", text: "Answer" } }] }];
  await slack.write(thread, "<!channel> <@U1> & text", "delivery-1", undefined, blocks);
  slack.nextPost.clear();
  await slack.write(thread, "Updated", "delivery-1", "200.1", []);
  assert.equal(requests[0].body.text, "&lt;!channel&gt; &lt;@U1&gt; &amp; text");
  assert.ok(requests[1].url.endsWith("chat.update"));
  assert.equal(requests[1].body.ts, "200.1");
  assert.equal(requests[1].body.metadata.event_payload.key, "delivery-1");
  assert.equal(requests[1].body.thread_ts, undefined);
  assert.deepEqual(requests[0].body.blocks, blocks);
  assert.deepEqual(requests[1].body.blocks, [], "resolving a request can remove its old controls");
});

test("Slack credentials stay in the correct HTTP authorization header and errors omit them", async () => {
  const calls = [];
  const slack = new SlackApi({ appToken: "opaque-app-token", botToken: "opaque-bot-token", fetchApi: async (url, request) => {
    calls.push({ url, request }); return { ok: true, headers: new Headers(), json: async () => ({ ok: true, user_id: "U0" }) };
  } });
  await slack.call("auth.test");
  await slack.call("apps.connections.open");
  assert.equal(calls[0].request.headers.Authorization, "Bearer opaque-bot-token");
  assert.equal(calls[1].request.headers.Authorization, "Bearer opaque-app-token");
  assert.ok(calls.every((call) => call.request.body === "{}"));
  assert.ok(calls.every((call) => !call.url.includes("opaque-")));
  slack.fetch = async () => ({ ok: true, headers: new Headers(), json: async () => ({ ok: false, error: "xoxb-secret" }) });
  await assert.rejects(slack.call("auth.test"), /Slack API: request_failed/);
});

test("a second connector cannot overwrite the journal, and disconnect leaves Dure bindings intact", async (t) => {
  const f = await fixture(t);
  const second = new SlackJournal(f.file, config);
  f.bridge.accept(payload());
  await assert.rejects(second.acquire(), { code: "EEXIST" });
  f.journal.close();
  await assert.rejects(new SlackJournal(f.file, { ...config, teamId: "T2" }).acquire(), /another workspace/);
  await second.acquire();
  assert.equal(Object.keys(second.data.threads).length, 1);
  second.close();
});

test("Slack uses the real spawn client and keeps the task when its Dure view fails", async () => {
  const requests = [];
  const presentations = [];
  const viewFailures = [];
  let receipt;
  const backend = new DureSlackBackend(async () => ({ profile: { id: "local", transport: { kind: "local" }, expected: { backendId: "backend-1", capabilities: ["plugin.slack", "agent_spawn.preview.v2", "agent_spawn.apply", "agent_spawn.presentation_project.v1"] } } }), {
    presentRun: async (run) => { presentations.push(run); throw new Error("Dure window closed"); },
    onPresentationError: (_error, agentId) => viewFailures.push(agentId),
    requestBackend: async (_profile, request) => {
      if (request.operation === "backend.scope") return { result: { schemaVersion: 1, scopeId: "scope-local" } };
      requests.push(request);
      const preview = request.operation === "agent_spawn.preview";
      if (preview) {
        const { includePresentationProject: _include, ...intent } = request.body;
        receipt = succeededStructuredReceipt({ ...intent, worktree: { ...intent.worktree, base_commit_sha: "a".repeat(40) } });
        receipt.plan.authority.projectId = request.body.projectId;
        receipt.completed[0].evidence.lease.directory_name = request.body.worktree.branch.split("/").at(-1);
      }
      const presentationProject = { projectId: receipt.plan.authority.projectId, rootId: receipt.plan.authority.rootId, repositoryId: receipt.plan.authority.repositoryId, root: "/repo" };
      return { backend: { id: "local", generation: "generation-1", protocol: { major: 1, minor: 0 }, capabilities: [], observedAtMs: Date.now() }, result: { schemaVersion: 1, receipt, ...(preview ? { presentationProject } : {}) } };
    },
  });
  const message = incomingSlackMessage(payload(), config, "U0", {});
  const agentId = await backend.start(message, { backend: await backend.bind(message.route) });
  assert.equal(agentId, receipt.plan.agentId);
  assert.deepEqual(requests.map((request) => request.operation), ["agent_spawn.preview", "agent_spawn.apply"]);
  assert.match(requests[0].body.worktree.branch, /^slack\//);
  assert.equal(receipt.plan.launch.interactionProfile, "structured_protocol");
  assert.equal(requests[1].body.prompt, slackInput(message, { initial: true }));
  assert.ok(requests.every((request) => request.requiredCapabilities.includes("plugin.slack")));
  assert.equal(presentations[0].report.receipt.plan.agentId, agentId);
  assert.equal(presentations[0].projectPath, "/repo");
  assert.deepEqual(viewFailures, [agentId]);
});

test("one Slack bot routes two channels to their saved servers across a default change and restart", async (t) => {
  const f = await fixture(t);
  const routedConfig = { ...config, channels: [
    { ...config.channels[0], backend: "server-a" },
    { ...config.channels[0], channelId: "C2", backend: "server-b" },
  ] };
  const selected = [];
  const requests = [];
  const receipts = new Map();
  const createBackend = () => new DureSlackBackend(async ({ backend }) => {
    selected.push(backend);
    assert.ok(["server-a", "server-b"].includes(backend), "do not resolve an unused default server");
    return { profile: { id: backend, transport: { kind: "local" }, expected: {
      backendId: "dure-local", capabilities: ["plugin.slack", "agent_spawn.preview.v2", "agent_spawn.apply"],
    } } };
  }, { requestBackend: async (profile, request) => {
    if (request.operation === "backend.scope") return { result: { schemaVersion: 1, scopeId: `scope-${profile.id}` } };
    requests.push({ profile, request });
    assert.equal(request.scopeId, `scope-${profile.id}`);
    let result;
    if (request.operation === "agent_spawn.preview") {
      const receipt = succeededStructuredReceipt({ ...request.body, worktree: { ...request.body.worktree, base_commit_sha: "a".repeat(40) } });
      receipt.plan.authority.projectId = request.body.projectId;
      receipt.completed[0].evidence.lease.directory_name = request.body.worktree.branch.split("/").at(-1);
      receipts.set(profile.id, receipt);
      // The routing identity is durable before the first task mutation.
      const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
      assert.ok(Object.values(saved.threads).some((thread) => thread.backend?.scopeId === request.scopeId));
      result = { receipt };
    } else if (request.operation === "agent_spawn.apply") result = { receipt: receipts.get(profile.id) };
    else if (request.operation === "agent_runtime.projection.inspect") result = { state: "stable", receipt: { agentId: request.body.agentId, authority: { interactionProfile: "structured_protocol" } } };
    else if (request.operation === "agent_conversation.inspect") result = { binding };
    else if (request.operation === "agent_conversation.read") result = { read: { type: "page", page: {
      binding, activeTurn: { turnId: "running" }, rows: [{ item: { itemId: "reply", body: {
        type: "message", role: "assistant", markdown: `Result from ${profile.id}`,
      } } }], finalCursor: { epoch: binding.timelineEpoch, sequence: 1 },
    } } };
    else result = { receipt: { state: "accepted" } };
    return { backend: { id: profile.expected.backendId, generation: "generation-1", protocol: { major: 1, minor: 0 }, capabilities: [] }, result: { schemaVersion: 1, ...result } };
  } });
  const bridge = new SlackBridge({ config: routedConfig, botUserId: "U0", journal: f.journal, backend: createBackend(), slack: f.slack });
  bridge.accept(payload());
  bridge.accept(payload({ channel: "C2" }));
  await bridge.tick((error) => { throw error; });
  assert.deepEqual(selected, ["server-a", "server-b"]);
  assert.deepEqual(f.calls.writes.map(({ thread, text }) => [thread.channelId, text]), [
    ["C1", "Result from server-a"], ["C2", "Result from server-b"],
  ]);
  f.journal.close();
  const changedConfig = { ...routedConfig, channels: routedConfig.channels.map((route) => ({ ...route, backend: "server-b" })) };
  const restarted = new SlackJournal(f.file, changedConfig);
  await restarted.acquire();
  try {
    const again = new SlackBridge({ config: changedConfig, botUserId: "U0", journal: restarted, backend: createBackend(), slack: f.slack });
    again.accept(payload({ type: "message", thread_ts: "100.001", ts: "102.001", user: "U2", text: "<@U0> Change the approach" }));
    again.accept(payload({ ts: "103.001", text: "<@U0> A new task" }));
    await again.tick((error) => { throw error; });
    assert.deepEqual(requests.filter(({ request }) => request.operation === "agent_spawn.apply").map(({ profile }) => profile.id), ["server-a", "server-b", "server-b"]);
    const [followup] = requests.filter(({ request }) => request.operation === "agent_conversation.steer_turn");
    assert.equal(followup.profile.id, "server-a");
    assert.match(followup.request.body.input, /T1\/U2/);
    assert.equal(f.calls.writes.filter(({ text }) => text === "Result from server-a").length, 1);
  } finally { restarted.close(); }
});

test("a renamed default cannot migrate a legacy journal onto a different backend", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  const original = { ...f.journal.data, schemaVersion: 1, identity: slackKey(config.teamId, "backend-1") };
  const [thread] = Object.values(original.threads);
  thread.agentId = "existing-agent";
  const [entry] = Object.values(original.inbox);
  entry.intent = { interactionSessionId: "existing-conversation", input: "existing input" };
  f.journal.close();
  fs.writeFileSync(f.file, JSON.stringify(original));
  const wrong = new SlackJournal(f.file, config);
  await assert.rejects(wrong.acquire(async () => ({ profileId: "new", backendId: "backend-2" })), /original workspace and backend/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), original);
  assert.equal(fs.existsSync(`${f.file}.lock`), false);
  const migrated = new SlackJournal(f.file, config);
  await migrated.acquire(async () => ({ profileId: "old", backendId: "backend-1", scopeId: "current-scope-is-not-historical-evidence" }));
  try {
    assert.equal(migrated.data.schemaVersion, 2);
    assert.deepEqual(Object.values(migrated.data.threads)[0], { ...thread, backend: { profileId: "old", backendId: "backend-1" } });
    assert.deepEqual(migrated.data.inbox, original.inbox);
  } finally { migrated.close(); }
});

test("a repointed profile sends the saved backend identity to the existing transport", async () => {
  let target;
  const backend = new DureSlackBackend(async () => ({ profile: { id: "team", expected: { backendId: "replacement" } } }), {
    requestBackend: async (profile) => { target = profile; throw new Error("backend identity mismatch"); },
  });
  await assert.rejects(backend.deliver({ backend: { profileId: "team", backendId: "original", scopeId: "scope-original" } }, { input: "Continue" }, "agent_conversation.start_turn"), /identity mismatch/);
  assert.equal(target.expected.backendId, "original");
  assert.equal(target.expected.scopeId, "scope-original");
});

test("a legacy link never invents its original server scope from a repointed profile", async () => {
  const calls = [];
  const backend = new DureSlackBackend(async () => { calls.push("select"); return {}; }, {
    requestBackend: async () => { calls.push("request"); },
  });
  await assert.rejects(backend.deliver({ backend: { profileId: "team", backendId: "dure-local" } }, { input: "Continue" }, "agent_conversation.start_turn"), { code: "slack_backend_scope_missing" });
  assert.deepEqual(calls, []);
});

for (const blockedOperation of ["deliver", "read"]) {
  test(`a deferred ${blockedOperation} preserves thread order without blocking another task`, async (t) => {
    const f = await fixture(t);
    for (const ts of ["100.001", "101.001"]) f.bridge.accept(payload({ ts }));
    await f.bridge.tick();
    const held = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const original = f.backend[blockedOperation];
    f.backend[blockedOperation] = async (thread, ...args) => {
      if (thread.threadTs === "100.001") { entered.resolve(); await held.promise; }
      return original(thread, ...args);
    };
    f.setPage({ rows: [{ item: { itemId: "completion", body: { type: "message", role: "assistant", markdown: "Work complete" } } }] });
    for (const [ts, thread_ts, text] of [["102.001", "100.001", "First"], ["103.001", "100.001", "Second"], ["104.001", "101.001", "Independent"]]) {
      f.bridge.accept(payload({ type: "message", ts, thread_ts, text: `<@U0> ${text}` }));
    }
    const ticking = f.bridge.tick();
    try {
      await entered.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.calls.inputs.length, 1, "the healthy thread receives input while the other is pending");
      assert.match(f.calls.inputs[0].intent.input, /Independent/);
      assert.deepEqual(f.calls.writes.map(({ thread }) => thread.threadTs), ["101.001"]);
    } finally { held.resolve(); await ticking; }
    assert.deepEqual(f.calls.inputs.filter(({ thread }) => thread.threadTs === "100.001").map(({ intent }) => intent.input.split("\n").at(-1)), ["First", "Second"]);
  });
}

test("a thread follows chat-to-terminal selection and does not replay uncertain PTY input after restart", async (t) => {
  const f = await fixture(t);
  f.bridge.accept(payload());
  await f.bridge.tick();
  let native = false;
  let completed = "0";
  const requests = [];
  const backend = new DureSlackBackend(async () => ({ profile: { id: "local", expected: { backendId: "backend-1" } } }), {
    requestBackend: async (_profile, request) => {
      requests.push(request);
      if (request.operation === "agent_runtime.projection.inspect") return { result: { state: "stable", receipt: {
        agentId: "agent-1", selectionRevision: 3, authority: { interactionProfile: native ? "native_cli" : "structured_protocol",
          authority: { binding: { agentId: "agent-1" }, terminalEpoch: "terminal-1" } },
      } } };
      if (request.operation === "agent_conversation.read") return { result: { read: { type: "page", page: {
        binding, activeTurn: null, latestFailure: null, rows: [], finalCursor: { epoch: "epoch-1", sequence: 0 },
      } } } };
      if (request.operation === "agent_runtime.native.read") return { result: { schemaVersion: 1,
        cursor: { terminalEpoch: "terminal-1", turnCompletedCount: completed, conversationId: "provider-1" },
        waiting: true, finalResponse: completed === "1" ? "Native answer" : null,
      } };
      if (request.operation === "agent_runtime.native.input") {
        assert.equal(Object.values(f.journal.data.inbox).at(-1).state, "sending");
        assert.equal(request.body.expectedSelectionRevision, 3);
        assert.equal(request.body.expectedTerminalEpoch, "terminal-1");
        throw new Error("Response lost after possible PTY write");
      }
      throw new Error(request.operation);
    },
  });
  const thread = Object.values(f.journal.data.threads)[0];
  thread.backend.scopeId = "scope-1";
  const bridge = new SlackBridge({ config, botUserId: "U0", journal: f.journal, backend, slack: f.slack });
  await bridge.tick((error) => { throw error; });
  native = true;
  bridge.accept(payload({ type: "message", thread_ts: "100.001", ts: "104.001", text: "<@U0> Continue" }));
  await bridge.tick();
  assert.equal(requests.filter(({ operation }) => operation === "agent_conversation.start_turn").length, 0);
  assert.equal(requests.filter(({ operation }) => operation === "agent_runtime.native.input").length, 1);
  // A connector dying during the write would retain "sending", not "failed".
  Object.values(f.journal.data.inbox).at(-1).state = "sending";
  f.journal.save();
  f.journal.close();
  const journal = new SlackJournal(f.file, config);
  await journal.acquire();
  try {
    completed = "1";
    const resumed = new SlackBridge({ config, botUserId: "U0", journal, backend, slack: f.slack });
    await resumed.tick((error) => { throw error; });
    await resumed.tick((error) => { throw error; });
    assert.equal(requests.filter(({ operation }) => operation === "agent_runtime.native.input").length, 1);
    assert.equal(f.calls.writes.filter(({ text }) => text === "Native answer").length, 1);
    assert.equal(journal.data.threads[Object.keys(journal.data.threads)[0]].interactionSessionId, "interaction-1");
  } finally { journal.close(); }
});

test("agent Markdown uses Slack's Markdown block for tables, bold text, links and code", async () => {
  const requests = [];
  const slack = new SlackApi({ appToken: "fixture-app", botToken: "fixture-bot", fetchApi: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return { ok: true, headers: new Headers(), json: async () => ({ ok: true, ts: "200.1" }) };
  } });
  const text = "**SEO review**\n\n| Area | Result |\n| --- | --- |\n| Content | Improve |\n\n[Website](https://www.dureai.dev/) and `lang=cn`, `<div>` and `a & b`.";
  await slack.write({ channelId: "C1", threadTs: "100.1" }, text, "markdown-1");
  assert.deepEqual(requests[0].blocks, [{ type: "markdown", text }]);
  assert.equal(requests[0].thread_ts, "100.1");
  assert.equal(requests[0].metadata.event_payload.key, "markdown-1");
});
