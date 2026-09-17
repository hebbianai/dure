// The disposable provider speaks to the real native driver over local sockets.
// Rendering remains owned by the existing fake TUI; this is not a driver stub.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const args = process.argv.slice(2);
const root = realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
function localSocket(option) {
  const endpoint = args[args.indexOf(option) + 1];
  assert(args.includes(option) && endpoint?.startsWith("unix://"));
  const socket = endpoint.slice("unix://".length);
  const parent = realpathSync(dirname(socket));
  assert(parent.startsWith(`${root}/`), "native fixture socket must stay in its QA root");
  assert(!relative(parent, socket).includes("/"));
  return socket;
}

function reply(request, selected) {
  const { id, method, params } = request;
  if (method === "initialized" && id === undefined) return undefined;
  assert(id !== undefined, "fixture request requires an id");
  let result;
  if (method === "initialize") {
    result = { userAgent: "codex-cli/0.0.0-dure-qa" };
  } else if (method === "thread/resume") {
    assert.match(params.threadId, /^[a-zA-Z0-9._-]+$/);
    selected.id = params.threadId;
    result = { thread: { id: selected.id, status: { type: "idle" }, turns: [] } };
  } else if (method === "thread/read" && params.threadId === selected.id) {
    result = { thread: { id: selected.id, status: { type: "idle" } } };
  } else if (method === "thread/goal/get" && params.threadId === selected.id) {
    result = { goal: null };
  } else {
    return { id, error: { code: -32601, message: "Unsupported fixture request" } };
  }
  return { id, result };
}

if (args[0] === "app-server") {
  const server = createServer();
  const peers = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  peers.on("connection", (peer) => {
    const selected = {};
    peer.on("message", (data) => {
      const response = reply(JSON.parse(data.toString()), selected);
      if (response) peer.send(JSON.stringify(response));
    });
  });
  server.listen(localSocket("--listen"));
  await once(server, "listening");
} else if (args[0] === "--remote") {
  const resume = args.indexOf("resume");
  assert(resume >= 0 && args[resume + 1], "native fixture requires an exact resume");
  const peer = new WebSocket("ws://localhost", {
    createConnection: () => connect(localSocket("--remote")),
    maxPayload: 16 * 1024,
    perMessageDeflate: false,
  });
  await once(peer, "open");
  async function request(id, method, params) {
    const response = once(peer, "message");
    peer.send(JSON.stringify({ id, method, params }));
    const [data] = await response;
    const value = JSON.parse(data.toString());
    assert.equal(value.id, id);
    assert(!value.error, JSON.stringify(value.error));
    return value.result;
  }
  await request(1, "initialize", { clientInfo: { name: "dure-qa", version: "1" } });
  peer.send(JSON.stringify({ method: "initialized" }));
  const result = await request(2, "thread/resume", { threadId: args[resume + 1] });
  assert.equal(result.thread.id, args[resume + 1]);
  await runTui(args.slice(2));
  peer.close();
} else {
  const resume = args.indexOf("resume");
  assert(resume >= 0 && args[resume + 1], "fixture requires an exact resume");
  await runTui(args);
}

async function runTui(tuiArgs) {
  // A cursor reply proves the actual Host consumed the preceding color probes.
  // No WebView has attached and no absence-by-timeout assertion is needed.
  assert(process.stdin.isTTY);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let colors = "";
  try {
    const signal = AbortSignal.timeout(3000);
    const responses = () => [...colors.matchAll(/\x1b\](10|11);rgb:([\da-f/]+)(?:\x07|\x1b\\)/gi)];
    process.stdout.write("\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[6n");
    while (!/\x1b\[\d+;\d+R/.test(colors)) {
      const [chunk] = await once(process.stdin, "data", { signal });
      colors += chunk.toString();
      assert(colors.length <= 4096, "unexpected fixture terminal response");
    }
    const capture = realpathSync(process.env.DURE_QA_CAPTURE_DIR);
    assert(capture.startsWith(`${root}/`));
    assert.match(process.env.HMUX_SESSION_ID, /^[a-zA-Z0-9._-]+$/);
    const receipts = join(capture, "terminal-colors");
    mkdirSync(receipts, { recursive: true, mode: 0o700 });
    writeFileSync(join(receipts, `${process.env.HMUX_SESSION_ID}.json`),
      JSON.stringify(Object.fromEntries(responses().map((match) => [match[1], match[2]]))),
      { flag: "wx", mode: 0o600 });
  } finally {
    process.stdin.pause();
    process.stdin.setRawMode(wasRaw);
  }
  const tui = spawn(join(dirname(fileURLToPath(import.meta.url)), "codex"), tuiArgs, {
    stdio: "inherit",
  });
  const [code, signal] = await once(tui, "exit");
  process.exitCode = signal ? 1 : code;
}
