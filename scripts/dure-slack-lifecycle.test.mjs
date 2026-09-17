import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test, vi } from "vitest";
import { runSlackCommand } from "../cli/lib/slack-command.mjs";
import { consumeSlackSocket } from "../cli/lib/slack/socket.mjs";
import { requestSlackStatus } from "../cli/lib/slack/control.mjs";
import { incomingSlackMessage, validateSlackConfig } from "../cli/lib/slack/event.mjs";

const config = { schemaVersion: 1, teamId: "T1", channels: [{ channelId: "C1", projectId: "project-1", providerId: "claude" }] };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-slack-lifecycle-"));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return file;
}

test("a workspace can connect before channels are chosen and does not accept task input", () => {
  const idle = validateSlackConfig({ ...config, channels: [] });
  assert.equal(incomingSlackMessage({ type: "event_callback", team_id: "T1", event: {
    type: "app_mention", channel: "C1", user: "U1", text: "<@U0> Start work", ts: "100.001",
  } }, idle, "U0", {}), null);
});

test("an already cancelled connector does not begin Slack startup", async (t) => {
  const file = fixture(t);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  vi.stubGlobal("fetch", async () => { calls++; throw new Error("Unexpected startup"); });
  t.onTestFinished(() => vi.unstubAllGlobals());
  const environment = { DURE_SLACK_APP_TOKEN: "fixture-app", DURE_SLACK_BOT_TOKEN: "fixture-bot" };
  await runSlackCommand(["serve", "--config", file], { signal: controller.signal, environment, output() {} });
  assert.equal(calls, 0);
  assert.deepEqual(environment, {}, "credentials cannot leak into backend children even when cancelled");
  assert.equal(fs.existsSync(`${file}.deliveries.json.lock`), false);
});

test("a closed socket cannot accept another message or report connected again", async () => {
  let socket;
  class Socket extends EventTarget {
    constructor() { super(); socket = this; }
    close() { this.dispatchEvent(new Event("close")); }
    send() { throw new Error("Cannot acknowledge after closure"); }
  }
  const controller = new AbortController();
  let connected = 0;
  let accepted = 0;
  const running = consumeSlackSocket({ url: "wss://wss.slack.com/fixture", signal: controller.signal,
    WebSocketImpl: Socket, onConnected() { connected++; }, bridge: { accept() { accepted++; } } });
  const receive = (value) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  receive({ type: "hello" });
  controller.abort();
  await running;
  receive({ type: "hello" });
  receive({ type: "events_api", envelope_id: "late", payload: {} });
  assert.equal(connected, 1);
  assert.equal(accepted, 0);
});

test("a disconnect is observed before an already admitted interaction finishes", async () => {
  let socket;
  class Socket extends EventTarget {
    constructor() { super(); socket = this; }
    close() { this.dispatchEvent(new Event("close")); }
    send() {}
  }
  const interaction = Promise.withResolvers();
  let disconnected = false;
  const running = consumeSlackSocket({ url: "wss://wss.slack.com/fixture", signal: new AbortController().signal,
    WebSocketImpl: Socket, onDisconnected() { disconnected = true; },
    bridge: { interact: () => ({ run: () => interaction.promise }) },
  });
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "interactive", envelope_id: "answer", payload: {} }) }));
  socket.dispatchEvent(new Event("error"));
  assert.equal(disconnected, true);
  interaction.resolve();
  await assert.rejects(running, /disconnected/);
});

test("owner EOF cancels authentication and removes startup listeners", async (t) => {
  const file = fixture(t);
  const input = new PassThrough();
  const called = Promise.withResolvers();
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let aborted = false;
  const running = runSlackCommand(["serve", "--config", file, "--owner-lifetime", "stdin"], {
    input, environment: {}, output() {}, fetchApi: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
      called.resolve();
    }),
  });
  await called.promise;
  input.end();
  await running;
  assert.equal(aborted, true);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("close"), 0);
  assert.equal(input.listenerCount("error"), 0);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  assert.equal(fs.existsSync(`${file}.deliveries.json.lock`), false);
  assert.equal(fs.existsSync(`${file}.connector.json`), false);
});

function launch(file, { input, open = async () => {} } = {}) {
  const controller = new AbortController();
  const events = [];
  const sockets = [];
  let nextSocket = Promise.withResolvers();
  class Socket extends EventTarget {
    constructor() {
      super(); sockets.push(this); nextSocket.resolve(this); nextSocket = Promise.withResolvers();
    }
    receive(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
    send() { throw new Error("This lifecycle fixture does not submit Slack messages"); }
    close() { this.dispatchEvent(new Event("close")); }
  }
  let opens = 0;
  const socket = nextSocket.promise;
  const running = runSlackCommand(["serve", "--config", file, ...(input ? ["--owner-lifetime", "stdin"] : [])], {
    signal: controller.signal, input, environment: {}, WebSocketImpl: Socket,
    output: (text) => events.push(JSON.parse(text)),
    async fetchApi(url) {
      if (url.endsWith("/auth.test")) return Response.json({ ok: true, team_id: "T1", bot_id: "B1", user_id: "U0" });
      assert.ok(url.endsWith("/apps.connections.open"));
      await open(++opens);
      return Response.json({ ok: true, url: "wss://wss.slack.com/fixture" });
    },
  }).then(() => undefined, (error) => error);
  return { socket, sockets, events, running, controller, nextSocket: () => nextSocket.promise, opens: () => opens };
}

async function commandStatus(file) {
  let status;
  await runSlackCommand(["status", "--config", file], { output: (text) => { status = JSON.parse(text); } });
  return status;
}

test("live status follows Slack hello, refresh and owner shutdown instead of a lock file", async (t) => {
  const file = fixture(t);
  const refreshing = Promise.withResolvers();
  const refreshed = Promise.withResolvers();
  const input = new PassThrough();
  const f = launch(file, { input, open: async (attempt) => {
    if (attempt === 2) { refreshing.resolve(); await refreshed.promise; }
  } });
  try {
    const socket = await f.socket;
    const first = await commandStatus(file);
    assert.equal(first.connection, "connecting");
    assert.equal(first.connectorLockPresent, true);
    assert.equal(typeof first.generation, "string");
    socket.receive({ type: "hello" });
    assert.equal((await requestSlackStatus(`${file}.connector.json`, "T1")).connection, "connected");
    const descriptor = JSON.parse(fs.readFileSync(`${file}.connector.json`, "utf8"));
    const unauthorized = await fetch(`http://127.0.0.1:${descriptor.port}/slack/status`, { method: "POST", body: JSON.stringify({ schemaVersion: 1, teamId: "T1" }) });
    assert.equal(unauthorized.status, 403);
    const crossTeam = await fetch(`http://127.0.0.1:${descriptor.port}/slack/status`, { method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` }, body: JSON.stringify({ schemaVersion: 1, teamId: "T2" }) });
    assert.equal((await crossTeam.json()).error.code, "slack_control_workspace_mismatch");
    assert.equal(JSON.stringify(await commandStatus(file)).includes(descriptor.token), false);
    const next = f.nextSocket();
    socket.receive({ type: "disconnect", reason: "refresh_requested" });
    await refreshing.promise;
    socket.receive({ type: "hello" });
    assert.equal((await commandStatus(file)).connection, "connecting");
    refreshed.resolve();
    (await next).receive({ type: "hello" });
    const connected = await commandStatus(file);
    assert.equal(connected.connection, "connected");
    assert.equal(connected.generation, first.generation);
    input.end();
    assert.equal(await f.running, undefined);
    assert.equal(f.events.at(-1).event, "slack.stopped");
    assert.equal(fs.existsSync(`${file}.connector.json`), false);
    assert.equal(fs.existsSync(`${file}.deliveries.json.lock`), false);
    assert.equal((await commandStatus(file)).connection, "unavailable");
    // A dead owner's persisted files are not evidence of a live connection.
    fs.writeFileSync(`${file}.connector.json`, JSON.stringify(descriptor), { mode: 0o600 });
    fs.writeFileSync(`${file}.deliveries.json.lock`, "fixture-stale-lock", { mode: 0o600 });
    const stale = await commandStatus(file);
    assert.equal(stale.connection, "unavailable");
    assert.equal(stale.connectorLockPresent, true);
    assert.equal(stale.generation, undefined);
    assert.equal(fs.readFileSync(`${file}.deliveries.json.lock`, "utf8"), "fixture-stale-lock");
  } finally { refreshed.resolve(); f.controller.abort(); await f.running; }
});

test("a transport failure exits once, preserves its delivery journal and does not reconnect", async (t) => {
  const file = fixture(t);
  const f = launch(file);
  try {
    const socket = await f.socket;
    socket.receive({ type: "hello" });
    const generation = (await commandStatus(file)).generation;
    socket.dispatchEvent(new Event("error"));
    assert.match((await f.running).message, /disconnected/);
    assert.equal(f.opens(), 1);
    assert.equal(f.events.at(-1).event, "slack.failed");
    assert.equal(fs.existsSync(`${file}.deliveries.json`), true);
    assert.equal(fs.existsSync(`${file}.deliveries.json.lock`), false);
    assert.equal((await commandStatus(file)).connection, "unavailable");
    const restarted = launch(file);
    try {
      (await restarted.socket).receive({ type: "hello" });
      assert.notEqual((await commandStatus(file)).generation, generation);
    } finally { restarted.controller.abort(); assert.equal(await restarted.running, undefined); }
  } finally { f.controller.abort(); await f.running; }
});
