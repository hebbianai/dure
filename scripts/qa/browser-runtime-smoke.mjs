#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { startBrowserRuntimeFixture } from "./lib/browser-runtime-fixture.mjs";
import { probeBrowserNative } from "./lib/browser-native-probe.mjs";
import { proveBrowserViewer } from "./lib/browser-viewer-proof.mjs";
import { proveBrowserStreamBoundary } from "./lib/browser-stream-boundary-proof.mjs";
import { browserViewerRequest } from "./lib/browser-viewer-channel.mjs";

const run = promisify(execFile);
const [
  binaryArgument = process.env.DURE_BROWSER_QA_BINARY,
  chromeArgument = process.env.DURE_BROWSER_QA_CHROME,
] = process.argv.slice(2);
if (!binaryArgument || !chromeArgument)
  throw new Error(
    "usage: browser-runtime-smoke.mjs <agent-browser-v0.36.0> <chromium-executable>",
  );
const binary = resolve(binaryArgument);
const chrome = resolve(chromeArgument);
const root = await mkdtemp("/tmp/dure-browser-");
const artifacts = resolve(
  "output/playwright/browser-runtime",
  root.split("/").at(-1),
);
await mkdir(artifacts, { recursive: true });
await writeFile(join(root, "config.json"), "{}\n", { mode: 0o600 });
const environment = {
  PATH: process.env.PATH,
  TMPDIR: root,
  LANG: "en_US.UTF-8",
  AGENT_BROWSER_SOCKET_DIR: join(root, "sockets"),
  AGENT_BROWSER_EXECUTABLE_PATH: chrome,
  AGENT_BROWSER_CONFIG: join(root, "config.json"),
  AGENT_BROWSER_NO_WEBMCP: "1",
  AGENT_BROWSER_IDLE_TIMEOUT_MS: "120000",
  AGENT_BROWSER_DEFAULT_TIMEOUT: "5000",
  AGENT_BROWSER_STREAM_MAX_WIDTH: "1000",
  AGENT_BROWSER_STREAM_MAX_HEIGHT: "750",
};
const evidence = {
  schemaVersion: 1,
  scope: "engine-feasibility",
  productReady: false,
  fixtureRoot: root,
  artifacts,
  startedAt: new Date().toISOString(),
  commands: [],
  checks: [],
  upstreamFindings: [],
  limitations: [
    "Korean text insertion is not proof of native IME composition.",
    "Upstream stream is probed directly in isolated QA; production must enforce its own input authority.",
    "No Tauri viewer is exercised by this command.",
  ],
};
let fixture;
const streams = [];
const sessions = new Set();
async function command(session, args, { allowFailure = false } = {}) {
  const started = performance.now();
  sessions.add(session);
  let output;
  try {
    output = await run(binary, ["--session", session, "--json", ...args], {
      cwd: root,
      env: environment,
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    output = { stdout: error.stdout, stderr: error.stderr };
    if (!allowFailure)
      throw new Error(
        `${session} ${args[0]} failed: ${error.stderr || error.stdout || error.message}`,
      );
  }
  const result = JSON.parse(output.stdout.trim());
  evidence.commands.push({
    session,
    command: args[0],
    durationMs: Math.round(performance.now() - started),
    success: result.success,
  });
  if (!allowFailure) assert.equal(result.success, true, JSON.stringify(result));
  return result;
}
function ref(snapshot, name) {
  const entry = Object.entries(snapshot.data.refs).find(
    ([, v]) => v.name === name,
  );
  assert.ok(entry, `missing snapshot ref: ${name}`);
  return `@${entry[0]}`;
}
async function connectStream(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=10`);
  streams.push(socket);
  const received = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    received.push(message);
    if (received.length > 32) received.shift();
    if (message.type === "frame" && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "ack", seq: message.seq }));
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("stream open timeout"));
    }, 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("stream connection failed"));
      },
      { once: true },
    );
  });
  return { socket, received };
}
async function waitFor(check, description) {
  const deadline = performance.now() + 6000;
  while (!check()) {
    if (performance.now() > deadline)
      throw new Error(`timeout: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
try {
  const version = await run(binary, ["--version"], {
    env: environment,
    timeout: 5000,
  });
  assert.equal(version.stdout.trim(), "agent-browser 0.36.0");
  evidence.binary = {
    path: binary,
    version: version.stdout.trim(),
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  };
  evidence.environment = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
    chromiumVersion: (
      await run(chrome, ["--version"], { env: environment, timeout: 5000 })
    ).stdout.trim(),
  };
  fixture = await startBrowserRuntimeFixture();
  await command("a", ["open", `${fixture.url}/?owner=A`]);
  await command("a", ["set", "viewport", "1000", "750"]);
  const initial = await command("a", ["snapshot", "-i"]);
  await writeFile(
    join(artifacts, "snapshot-initial.json"),
    JSON.stringify(initial, null, 2),
  );
  await command("b", ["open", `${fixture.url}/?owner=B`]);
  for (const [session, expected] of [
    ["a", "A"],
    ["b", "B"],
  ]) {
    const result = await command(session, [
      "eval",
      '({owner:localStorage.getItem("owner"),cookie:document.cookie,instance:window.fixture.instance})',
    ]);
    assert.equal(result.data.result.owner, expected);
    assert.equal(result.data.result.cookie, `owner=${expected}`);
  }
  evidence.checks.push(
    "contexts have separate cookies and localStorage on the same origin",
  );
  const identity = (await command("a", ["eval", "window.fixture.instance"]))
    .data.result;
  const streaming = await command("a", ["stream", "status"]);
  const stream = await connectStream(streaming.data.port);
  await waitFor(
    () => stream.received.some((v) => v.type === "frame"),
    "initial browser frame",
  );
  const firstFrame = stream.received.find((v) => v.type === "frame");
  await writeFile(
    join(artifacts, "stream-before.jpg"),
    Buffer.from(firstFrame.data, "base64"),
  );
  await command("a", ["fill", ref(initial, "Name"), "두레 브라우저 검증"]);
  const filled = await command("a", ["snapshot", "-i"]);
  await command("a", ["click", ref(filled, "Apply")]);
  await command("a", ["wait", "--text", "Saved: 두레 브라우저 검증"]);
  assert.equal(fixture.submissions.length, 1);
  assert.equal(fixture.submissions[0].value, "두레 브라우저 검증");
  assert.equal(fixture.submissions[0].cookie, "owner=A");
  await waitFor(
    () =>
      stream.received.some(
        (v) =>
          v.type === "frame" &&
          v.seq > firstFrame.seq &&
          v.data !== firstFrame.data,
      ),
    "updated browser frame",
  );
  assert.equal(
    (await command("a", ["eval", "window.fixture.instance"])).data.result,
    identity,
  );
  evidence.checks.push(
    "ref-based Korean fill/submit changes the same streamed page instance",
  );
  const latest = stream.received.filter((v) => v.type === "frame").at(-1);
  await writeFile(
    join(artifacts, "stream-after.jpg"),
    Buffer.from(latest.data, "base64"),
  );
  await command("a", ["screenshot", join(artifacts, "page.png")]);
  const snapshot = await command("a", ["snapshot", "-i"]);
  await command("a", ["focus", ref(snapshot, "Name")]);
  stream.socket.send(
    JSON.stringify({
      type: "input_keyboard",
      eventType: "char",
      text: " 한글",
    }),
  );
  await command("a", [
    "wait",
    "--fn",
    'document.querySelector("input").value.endsWith(" 한글")',
  ]);
  evidence.checks.push(
    "upstream stream text event inserts Korean text into the CLI-selected input",
  );
  await command("a", ["fill", ref(snapshot, "Rich text"), "한글 편집 가능"]);
  const rawRichText = (
    await command("a", ["get", "text", ref(snapshot, "Rich text")])
  ).data.text;
  if (rawRichText !== "한글 편집 가능") {
    evidence.upstreamFindings.push({
      command: "fill contenteditable",
      expected: "한글 편집 가능",
      actual: rawRichText,
    });
  }
  // Probe an explicit replacement sequence; do not report upstream fill as fixed.
  const selected = await probeBrowserNative(join(root, "sockets", "a.sock"), {
    action: "selectall",
    selector: ref(snapshot, "Rich text"),
  });
  assert.equal(selected.success, true, JSON.stringify(selected));
  await command("a", ["keyboard", "inserttext", "한글 편집 가능"]);
  assert.equal(
    (await command("a", ["get", "text", ref(snapshot, "Rich text")])).data.text,
    "한글 편집 가능",
  );
  evidence.checks.push(
    "native ref-based select-all + insert-text replaces contenteditable Korean text",
  );
  const shadow = await command("a", ["snapshot", "-i"]);
  await command("a", ["click", ref(shadow, "Shadow action")]);
  await command("a", [
    "wait",
    "--fn",
    'document.querySelector("#shadow").shadowRoot.querySelector("button").textContent === "Shadow complete"',
  ]);
  evidence.checks.push("snapshot ref targets an open shadow-root button");
  const badWait = await command("a", ["wait", "#never-present"], {
    allowFailure: true,
  });
  assert.equal(badWait.success, false);
  assert.equal(
    (await command("a", ["eval", "window.fixture.instance"])).data.result,
    identity,
  );
  evidence.checks.push(
    "missing-element timeout releases subsequent commands without replacing the page",
  );
  stream.socket.close();
  const reconnect = await connectStream(streaming.data.port);
  await waitFor(
    () => reconnect.received.some((v) => v.type === "frame"),
    "reconnected stream",
  );
  assert.equal(
    (await command("a", ["eval", "window.fixture.instance"])).data.result,
    identity,
  );
  assert.equal(
    (await command("b", ["eval", "window.fixture.submissions"])).data.result,
    0,
  );
  evidence.checks.push(
    "viewer disconnect/reconnect preserves page identity and other context remains untouched",
  );
  const viewerEnabled = Boolean(process.env.VITE_DURE_BROWSER_QA_CHANNEL);
  evidence.streamBoundary = await proveBrowserStreamBoundary({
    command,
    port: streaming.data.port,
    identity,
    artifacts,
    publishFrame: viewerEnabled
      ? (frame) => browserViewerRequest("/frame", frame)
      : undefined,
    observe: viewerEnabled
      ? () => proveBrowserViewer({ command, identity, artifacts })
      : undefined,
  });
  if (evidence.streamBoundary.viewer) {
    evidence.viewer = evidence.streamBoundary.viewer;
    evidence.limitations = evidence.limitations.filter(
      (value) => !value.startsWith("No Tauri"),
    );
    evidence.checks.push(
      "WKWebView observes authenticated CDP frames with upstream streaming disabled, relays one Korean composition commit, and reattaches to the same page",
    );
    const untrustedStatus = (
      await command("b", [
        "eval",
        `fetch(${JSON.stringify(process.env.VITE_DURE_BROWSER_QA_CHANNEL + "/frame")}).then(response => response.status)`,
      ])
    ).data.result;
    assert.equal(untrustedStatus, 401);
    evidence.checks.push(
      "fixture page without the QA relay token cannot read relayed frames",
    );
  }
  if (evidence.streamBoundary.rawStream.injected) {
    evidence.upstreamFindings.push({
      command: "raw stream input",
      problem:
        "A loopback page in context B can inject input into context A without Dure admission.",
    });
  } else if (!evidence.streamBoundary.rawStream.isolated) {
    evidence.upstreamFindings.push({
      command: "raw stream input",
      problem:
        "A loopback page in context B can connect to context A; input injection was not observed.",
    });
  }
  evidence.checks.push(
    "disabled upstream listener rejects page connections; browser-origin CDP is rejected while a native CDP observer streams the same page",
  );
  await command("c", ["stream", "disable"]);
  await command("c", ["open", `${fixture.url}/?owner=C`]);
  assert.equal((await command("c", ["stream", "status"])).data.enabled, false);
  evidence.checks.push(
    "upstream stream can be disabled before loading a page and remains disabled after navigation",
  );
  const oldRef = ref(await command("c", ["snapshot", "-i"]), "Name");
  await command("c", ["open", `${fixture.url}/next`]);
  await command("c", ["snapshot", "-i"]);
  const staleClick = await command("c", ["click", oldRef], {
    allowFailure: true,
  });
  const wrongTargetClicked = (
    await command("c", [
      "eval",
      'document.querySelector("button").dataset.clicked === "yes"',
    ])
  ).data.result;
  evidence.refBinding = {
    oldRef,
    staleClickSucceeded: staleClick.success,
    wrongTargetClicked,
  };
  if (wrongTargetClicked)
    evidence.upstreamFindings.push({
      command: "snapshot ref reuse",
      problem:
        "An old ref resolves to a different element after navigation and a new snapshot; Dure must fence refs by document/snapshot generation.",
    });
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  for (const socket of streams) socket.close();
  evidence.cleanup = [];
  for (const session of sessions) {
    try {
      await command(session, ["close"]);
      evidence.cleanup.push({ session, closed: true });
    } catch (error) {
      evidence.cleanup.push({ session, closed: false, error: String(error) });
      process.exitCode = 1;
    }
  }
  await fixture?.close();
  evidence.finishedAt = new Date().toISOString();
  if (evidence.cleanup.some((item) => !item.closed)) evidence.status = "failed";
  await writeFile(
    join(artifacts, "receipt.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        status: evidence.status,
        scope: evidence.scope,
        productReady: evidence.productReady,
        checks: evidence.checks,
        upstreamFindings: evidence.upstreamFindings,
        cleanup: evidence.cleanup,
        error: evidence.error,
        receipt: join(artifacts, "receipt.json"),
      },
      null,
      2,
    ),
  );
}
