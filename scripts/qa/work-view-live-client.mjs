import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appWindowId, captureAppWindow } from "./lib/app-window-capture.mjs";
import { replyClaudeMessage } from "./lib/claude-messages-reply.mjs";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_WORK_VIEW_LIVE_PROOF;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const home = process.env.HOME;
const port = Number(process.env.DURE_QA_WORK_VIEW_LIVE_API_PORT);
assert.ok(proof && evidence && stateRoot && home && port, "Run through work-view-live-smoke.sh");
assert.ok(home.startsWith(`${stateRoot}/`), "QA HOME must stay inside its state root");
const fixture = JSON.parse(readFileSync(join(home, "work-view-live-fixture.json"), "utf8"));

/** How long the stand-in API thinks before each step of a turn, so each step
 * lands in the transcript on its own. */
const STEP_MS = 2_500;
/** The longest a step may take from the API's answer to the Work detail. */
const MAX_SHOW_MS = 3_000;
const THEMES = ["light", "dark"];

const answered = [];
const errors = [];

function userTexts(message) {
  if (message.role !== "user") return [];
  if (typeof message.content === "string") return [message.content];
  return message.content.filter((block) => block.type === "text").map((block) => block.text);
}

/** Which turn and step a main request asks for: the newest prompt it holds,
 * and the tool results after it. */
function position(messages) {
  let turn = -1;
  let start = 0;
  messages.forEach((message, index) => {
    const found = fixture.turns.findIndex((candidate) =>
      userTexts(message).some((text) => text.includes(candidate.prompt)));
    if (found > turn) { turn = found; start = index; }
  });
  const step = messages.slice(start).filter((message) => message.role === "user"
    && Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")).length;
  return { turn, step };
}

function answer(response, body, content, stopReason) {
  if (body.stream) return replyClaudeMessage(response, body.model, content, stopReason);
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "msg_fixture", type: "message", role: "assistant", model: body.model, content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  }));
}

const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (bytes) => { raw += bytes; if (raw.length > 8 * 1024 * 1024) request.destroy(); });
  request.on("end", async () => {
    try {
      if (request.url?.startsWith("/v1/messages/count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (!request.url?.startsWith("/v1/messages")) { response.writeHead(200).end("{}"); return; }
      assert.equal(request.headers["x-api-key"], "qa-no-real-provider-access");
      const body = JSON.parse(raw);
      const main = body.tools?.some((tool) => tool.name === "Read") === true;
      const { turn, step } = position(body.messages ?? []);
      const script = fixture.turns[turn]?.steps;
      if (!main || !script) {
        // Side requests (a title, a topic check) answer at once.
        answer(response, body, [{ type: "text", text: "Release walkthrough" }], "end_turn");
        return;
      }
      const next = script[Math.min(step, script.length - 1)];
      await delay(STEP_MS);
      if (response.destroyed) return;
      const content = [{ type: "text", text: next.text }];
      if (next.tool) {
        content.push({ type: "tool_use", id: `toolu_fixture_${turn}_${step}`, name: next.tool.name, input: next.tool.input });
      }
      answer(response, body, content, next.tool ? "tool_use" : "end_turn");
      answered.push({ turn, step, at: Date.now() });
    } catch (error) {
      errors.push(error.message);
      response.writeHead(500).end("{}");
    }
  });
});
server.listen(port, "127.0.0.1");
await once(server, "listening");
writeFileSync(join(home, "work-view-live-api-ready"), "");

function receipt(phase, timeoutMs = 240_000) {
  return waitForQaLogReceipt(`work-view-live-${phase}`, proof, {
    timeoutMs, failedName: "work-view-live-failed",
  });
}

const artifacts = process.env.DURE_QA_ARTIFACT_ROOT ?? "artifacts/qa";
const imageDir = join(artifacts, `work-view-live-${proof}`);
mkdirSync(imageDir, { recursive: true });
const capture = (windowId, name) => {
  captureAppWindow(windowId, join(evidence, name));
  copyFileSync(join(evidence, name), join(imageDir, name));
  return name;
};

/** Frames of one turn while it streams: from the first prompt the Work
 * detail shows until the turn has ended there. */
async function captureTurn(windowId, theme) {
  await receipt(`${theme}-working`, 300_000);
  let ended;
  const settled = receipt(`${theme}-ended`, 180_000).then(
    (facts) => { ended = { facts }; },
    (error) => { ended = { error }; },
  );
  const frames = [];
  while (!ended) {
    frames.push(capture(windowId, `${theme}-${String(frames.length).padStart(2, "0")}.png`));
    await delay(600);
  }
  await settled;
  if (ended.error) throw ended.error;
  await delay(1_000);
  frames.push(capture(windowId, `${theme}-ended.png`));
  writeFileSync(join(home, `work-view-live-captured-${theme}`), "");
  return { facts: ended.facts, frames };
}

/** Each step but the last shows while the agent still works, and within
 * MAX_SHOW_MS of the API's answer. */
function verifyTurn(theme, turn, { facts }) {
  const steps = fixture.turns[turn].steps;
  const shownAt = steps.map((_, index) =>
    facts.timeline.find((sample) => sample.steps > index)?.at);
  const failures = [];
  steps.forEach((_, index) => {
    const at = shownAt[index];
    const sent = answered.find((entry) => entry.turn === turn && entry.step === index)?.at;
    if (at === undefined || sent === undefined) {
      failures.push(`${theme}: step ${index + 1} never showed`);
      return;
    }
    if (at - sent > MAX_SHOW_MS) failures.push(`${theme}: step ${index + 1} took ${at - sent} ms to show`);
    const working = facts.timeline.find((sample) => sample.steps > index)?.working;
    if (index < steps.length - 1 && !working) failures.push(`${theme}: step ${index + 1} showed only after the turn ended`);
  });
  return { failures, latencies: shownAt.map((at, index) =>
    at - (answered.find((entry) => entry.turn === turn && entry.step === index)?.at ?? at)) };
}

try {
  await receipt("started", 480_000);
  const windowId = appWindowId();
  const turns = {};
  const failures = [];
  for (const [turn, theme] of THEMES.entries()) {
    turns[theme] = await captureTurn(windowId, theme);
    const verdict = verifyTurn(theme, turn, turns[theme]);
    turns[theme].latencies = verdict.latencies;
    failures.push(...verdict.failures);
    if (turns[theme].facts.dark !== (theme === "dark")) failures.push(`${theme}: wrong theme`);
  }
  await receipt("done");
  failures.push(...errors);
  const report = { result: failures.length === 0 ? "passed" : "failed", failures, answered, turns };
  writeFileSync(join(evidence, "work-view-live.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(imageDir, "work-view-live.json"), JSON.stringify(report, null, 2));
  assert.deepEqual(failures, [], JSON.stringify(failures));
  console.log("PASS: the Work detail follows a working Claude Code agent's transcript step by step, in light and dark", { imageDir });
} finally {
  server.close();
  server.closeAllConnections();
}
