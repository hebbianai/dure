import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, vi } from "vitest";
import { runSlackCommand } from "../cli/lib/slack-command.mjs";
import { DureSlackBackend } from "../cli/lib/slack/backend.mjs";
import { SlackJournal } from "../cli/lib/slack/journal.mjs";
import { slackKey } from "../cli/lib/slack/event.mjs";
import { SlackPoller } from "../cli/lib/slack/poll.mjs";

async function connector(t, { stalledShare = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-slack-isolation-"));
  const file = path.join(root, "config.json");
  const config = { schemaVersion: 1, teamId: "T1", channels: ["C1", "C2"].map((channelId) => ({ channelId, projectId: "project-1", providerId: "claude" })) };
  fs.writeFileSync(file, JSON.stringify(config));
  const journal = new SlackJournal(`${file}.deliveries.json`, config);
  await journal.acquire();
  for (const [index, route] of config.channels.entries()) {
    const thread = { teamId: "T1", channelId: route.channelId, threadTs: "100.001", agentId: `agent-${index}`,
      interactionSessionId: `conversation-${index}`, backend: { profileId: "local", backendId: "backend-1", scopeId: "scope-1" },
      route, cursor: { epoch: "epoch-1", sequence: 0 }, goalRevision: 0 };
    journal.data.threads[slackKey("T1", route.channelId, thread.threadTs)] = thread;
  }
  if (stalledShare) {
    const thread = { ...Object.values(journal.data.threads)[0], agentId: "sharing" };
    delete thread.threadTs;
    const request = { schemaVersion: 1, teamId: "T1", channelId: "C1", agentId: "sharing", requestId: "share-1" };
    const key = slackKey("T1", "share-1");
    journal.data.shares = { [key]: { key, request, thread, state: "posting", fingerprint: slackKey("C1", "sharing", null) } };
  }
  journal.save();
  journal.close();
  const held = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const controller = new AbortController();
  const reads = [0, 0];
  const deliveries = [];
  const posts = [];
  const events = [];
  const call = vi.spyOn(DureSlackBackend.prototype, "call").mockImplementation(async (thread, operation, body) => {
    if (operation === "agent_runtime.projection.inspect") return { state: "stable", receipt: {
      agentId: thread.agentId, authority: { interactionProfile: "structured_protocol" },
    } };
    if (operation !== "agent_conversation.read") {
      deliveries.push({ thread, operation, body });
      return { receipt: { state: "accepted" } };
    }
    const index = thread.channelId === "C1" ? 0 : 1;
    reads[index]++;
    if (index === 0 && !stalledShare) { entered.resolve(); await held.promise; }
    return { read: { type: "page", page: {
      binding: { interactionSessionId: thread.interactionSessionId, timelineEpoch: "epoch-1", runtime: { generation: "generation-1" } },
      activeTurn: null, latestFailure: null, finalCursor: { epoch: "epoch-1", sequence: reads[index] },
      rows: [{ item: { itemId: `output-${reads[index]}`, body: { type: "message", role: "assistant", markdown: `Result ${reads[index]}` } } }],
    } } };
  });
  class Socket extends EventTarget {
    constructor() { super(); ready.resolve(this); }
    receive(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
    send() {}
    close() { this.dispatchEvent(new Event("close")); }
  }
  const running = runSlackCommand(["serve", "--config", file], {
    signal: controller.signal, environment: {}, WebSocketImpl: Socket, output: (text) => events.push(JSON.parse(text)),
    async fetchApi(url, options) {
      if (url.endsWith("/auth.test")) return Response.json({ ok: true, team_id: "T1", bot_id: "B1", user_id: "U0" });
      if (url.endsWith("/apps.connections.open")) return Response.json({ ok: true, url: "wss://wss.slack.com/fixture" });
      if (new URL(url).pathname === "/api/conversations.history" && stalledShare) {
        assert.equal(options.method, "GET");
        entered.resolve(); await held.promise;
        return Response.json({ ok: true, messages: [{ ts: "200.001", user: "U0", metadata: { event_type: "dure_delivery", event_payload: { key: slackKey("T1", "share-1") } } }] });
      }
      assert.ok(url.endsWith("/chat.postMessage"));
      posts.push(JSON.parse(options.body));
      return Response.json({ ok: true, ts: `200.${posts.length}` });
    },
  }).then(() => undefined, (error) => error);
  t.onTestFinished(async () => {
    controller.abort(); held.resolve(); await running; call.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { file, held, entered: entered.promise, socket: ready.promise, controller, running, reads, posts, deliveries, events };
}

for (const stalledShare of [false, true]) {
  test(`a stalled ${stalledShare ? "share reconciliation" : "thread read"} leaves later healthy polling and input independent`, async (t) => {
    const f = await connector(t, { stalledShare });
    const socket = await f.socket;
    await f.entered;
    await vi.waitFor(() => assert.ok(f.posts.some((post) => post.channel === "C2")), { timeout: 5000 });
    socket.receive({ type: "events_api", envelope_id: "direction", payload: { type: "event_callback", team_id: "T1", event: {
      type: "message", channel: "C2", user: "U2", ts: "101.001", thread_ts: "100.001", text: "<@U0> Continue the independent task",
    } } });
    await vi.waitFor(() => assert.equal(f.deliveries.length, 1), { timeout: 5000 });
    assert.match(f.deliveries[0].body.input, /Continue the independent task/);
    assert.equal(f.deliveries[0].thread.channelId, "C2");
    await vi.waitFor(() => assert.ok(f.posts.filter((post) => post.channel === "C2").length >= 2), { timeout: 5000 });
    if (!stalledShare) assert.equal(f.reads[0], 1, "a pending thread must not get an overlapping poll");
    assert.equal(f.events.some(({ event }) => event === "slack.delivery_failed"), false);
  });
}

for (const stop of ["owner cancellation", "socket failure"]) {
  test(`${stop} retains journal ownership until in-flight polls settle`, async (t) => {
    const f = await connector(t);
    const socket = await f.socket;
    await f.entered;
    if (stop === "owner cancellation") f.controller.abort();
    else socket.dispatchEvent(new Event("error"));
    await delay(20);
    assert.equal(fs.existsSync(`${f.file}.deliveries.json.lock`), true);
    const reads = [...f.reads];
    f.held.resolve();
    const error = await f.running;
    if (stop === "socket failure") assert.match(error.message, /disconnected/);
    else assert.equal(error, undefined);
    assert.equal(fs.existsSync(`${f.file}.deliveries.json.lock`), false);
    assert.equal(fs.existsSync(`${f.file}.connector.json`), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.reads, reads, "shutdown does not start another poll");
    assert.equal(f.events.at(-1).event, error ? "slack.failed" : "slack.stopped");
  });
}

test("polling bounds in-flight I/O and gives unvisited work priority over repeat polls", async () => {
  const controller = new AbortController();
  const held = Promise.withResolvers();
  const starts = [];
  const active = new Set();
  let peak = 0;
  const poller = new SlackPoller({ signal: controller.signal, onError(error) { throw error; },
    polls: () => Array.from({ length: 40 }, (_, id) => [id, async () => {
      assert.equal(active.has(id), false);
      active.add(id); starts.push(id); peak = Math.max(peak, active.size);
      if (starts.length <= 16) await held.promise;
      active.delete(id);
    }]),
  });
  const running = poller.run().catch((error) => error);
  try {
    await vi.waitFor(() => assert.equal(active.size, 16));
    await delay(1600);
    assert.equal(starts.length, 16, "a full pool does not start more I/O");
    held.resolve();
    await vi.waitFor(() => assert.ok(new Set(starts).size === 40), { timeout: 5000 });
    assert.deepEqual(starts.slice(0, 40), Array.from({ length: 40 }, (_, id) => id));
    assert.equal(peak, 16);
  } finally { controller.abort(); held.resolve(); await running; await poller.settle(); }
});

test("a fatal poll failure reaches the connector owner while already-started work remains joinable", async () => {
  const controller = new AbortController();
  const held = Promise.withResolvers();
  const failure = new Error("fixture journal failure");
  let finished = false;
  const poller = new SlackPoller({ signal: controller.signal, onError(error) { throw error; }, polls: () => [
    ["held", async () => { await held.promise; finished = true; }],
    ["failed", async () => { throw failure; }],
  ] });
  try {
    await assert.rejects(poller.run(), (error) => error === failure);
    controller.abort();
    assert.equal(finished, false);
    held.resolve();
    await poller.settle();
    assert.equal(finished, true);
  } finally { controller.abort(); held.resolve(); await poller.settle(); }
});

test("continuous new threads cannot starve already-due conversations", async () => {
  const controller = new AbortController();
  const visits = new Map();
  let size = 16;
  const poller = new SlackPoller({ signal: controller.signal, onError(error) { throw error; },
    polls: () => Array.from({ length: size }, (_, id) => [id, async () => {
      visits.set(id, (visits.get(id) ?? 0) + 1);
      if (id === size - 16) size += 16;
    }]),
  });
  const running = poller.run().catch((error) => error);
  try {
    await vi.waitFor(() => assert.ok(visits.get(0) >= 2), { timeout: 5000 });
    await vi.waitFor(() => assert.ok(visits.has(16)), { timeout: 5000 });
  } finally { controller.abort(); await running; await poller.settle(); }
});
