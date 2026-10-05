// Protocol fixture for the real native driver. No terminal text drives progress.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const root = realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
const fixture = realpathSync(process.cwd());
assert.equal(fixture, join(root, "codex-progress"));
const args = process.argv.slice(2);
const endpoint = args[args.indexOf(args[0] === "app-server" ? "--listen" : "--remote") + 1];
assert(endpoint.startsWith("unix://"));
const socketPath = endpoint.slice(7);
assert(realpathSync(dirname(socketPath)).startsWith(`${fixture}/`));

if (args[0] === "app-server") {
  const server = createServer();
  const peers = new WebSocketServer({ server });
  peers.on("connection", (peer) => {
    let selected = false;
    let revision = 0;
    let status = { type: "idle" };
    peer.on("message", (bytes) => {
      const { id, method } = JSON.parse(bytes.toString());
      if (id === undefined) return;
      let result;
      if (method === "initialize") result = { userAgent: "codex-progress-fixture" };
      else if (method === "thread/start" || method === "thread/read") {
        if (method === "thread/start") selected = true;
        result = { thread: { id: "thread-progress", path: join(fixture, "rollout.jsonl"), status } };
      } else {
        peer.send(JSON.stringify({ id, error: { code: -32601, message: "Unsupported fixture method" } }));
        return;
      }
      peer.send(JSON.stringify({ id, result }));
      if (method === "thread/start") {
        peer.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "thread-progress", status } }));
      }
    });
    const timer = setInterval(() => {
      if (!selected || peer.readyState !== WebSocket.OPEN) return;
      let control;
      try {
        control = JSON.parse(readFileSync(join(fixture, "notifications.json"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (control.revision <= revision) return;
      revision = control.revision;
      for (const notification of control.notifications) {
        if (notification.method === "turn/started") status = { type: "active", activeFlags: [] };
        if (notification.method === "turn/completed") status = { type: "idle" };
        peer.send(JSON.stringify(notification));
      }
      // A response barrier on this connection follows every notification.
      peer.send(JSON.stringify({ method: "fixture/barrier", params: { revision } }));
    }, 20);
    peer.once("close", () => clearInterval(timer));
  });
  server.listen(socketPath);
  await once(server, "listening");
} else {
  assert.equal(args[0], "--remote");
  const peer = new WebSocket("ws://localhost", { createConnection: () => connect(socketPath) });
  await once(peer, "open");
  for (const [id, method, params] of [[1, "initialize", { clientInfo: { name: "dure-qa", version: "1" } }],
    [2, "thread/start", {}]]) {
    const response = once(peer, "message");
    peer.send(JSON.stringify({ id, method, params }));
    const [bytes] = await response;
    assert.equal(JSON.parse(bytes.toString()).id, id);
    if (method === "initialize") peer.send(JSON.stringify({ method: "initialized" }));
  }
  peer.on("message", (bytes) => {
    const notification = JSON.parse(bytes.toString());
    if (notification.method === "fixture/barrier") {
      const temporary = join(fixture, "observed.tmp");
      writeFileSync(temporary, JSON.stringify(notification.params));
      // One writer, parent waits for this exact monotonically increasing revision.
      renameSync(temporary, join(fixture, "observed.json"));
    }
  });
  await once(peer, "close");
}
