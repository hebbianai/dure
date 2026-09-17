import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { run, cargoArtifact } from "./managed-provider-fixture.mjs";

assert(process.env.DURE_HMUX_TEST_STATE_ROOT, "run through scripts/run-hmux-tests.mjs");
const root = path.join(fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT), "pi");
const home = path.join(root, "home");
const profile = path.join(home, "pi");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(profile, "extensions"), { mode: 0o700 });
fs.copyFileSync(new URL("./fixtures/pi-provider-extension.ts", import.meta.url), path.join(profile, "extensions", "dure-fixture.ts"));
const pi = fs.realpathSync(process.env.DURE_QA_PI_BIN);
const hmux = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const observations = [];
const released = new Set();
const waiting = new Map();
const server = http.createServer(async (request, response) => {
  const release = request.url.match(/^\/release\/(\d+)$/u);
  if (release) {
    released.add(release[1]);
    waiting.get(release[1])?.();
    response.writeHead(204).end();
    return;
  }
  let bytes = "";
  for await (const chunk of request) bytes += chunk;
  const body = JSON.parse(bytes);
  const user = JSON.stringify(body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "");
  const block = user.includes("DURE_PI_ALLOCATE") ? "0" : user.match(/DURE_PI_BLOCK_(\d+)/u)?.[1];
  const toolResult = body.messages.at(-1)?.role === "tool";
  const question = user.includes("DURE_PI_QUESTION") && !toolResult;
  observations.push({ model: body.model, effort: body.reasoning_effort, user, toolResult });
  if (block && !released.has(block)) await new Promise((resolve) => waiting.set(block, resolve));
  const tool = question || (block && block !== "0" && !toolResult);
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: question ? "pi-question" : `pi-tool-${block}`, type: "function", function: { name: question ? "dure_qa_question" : "bash", arguments: JSON.stringify(question ? {} : { command: "printf dure_pi_fixture" }) } }] } : { role: "assistant", content: "Pi fixture answer." };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [part, finish] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: "pi-fixture-answer", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: part, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});

try {
  const test = await cargoArtifact(["test", "--locked", "--manifest-path", "crates/dure-app/Cargo.toml", "--package", "dure-control-plane", "--lib", "--no-run"], "dure_control_plane");
  const controlPlane = await cargoArtifact(["build", "--locked", "--manifest-path", "crates/dure-app/Cargo.toml", "--package", "dure-control-plane", "--bin", "dure-control-plane"], "dure-control-plane");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(profile, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `${url}/v1`, api: "openai-completions", apiKey: "fixture-only", compat: { supportsReasoningEffort: true, supportsDeveloperRole: false }, models: ["model-a", "model-b"].map((id) => ({ id, name: id, reasoning: true, contextWindow: 8192, maxTokens: 1024 })) } } }), { mode: 0o600 });
  const env = {
    HOME: home, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: "1", DURE_HOME: path.join(home, "dure"),
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "en_US.UTF-8", TMPDIR: root,
    HMUX_DISCOVERY_ROOT: path.join(root, "discovery"), DURE_QA_PI_RUNTIME_ROOT: root, DURE_QA_PI_BIN: pi,
    DURE_QA_CONTROL_PLANE_BIN: controlPlane, DURE_QA_HMUX_RUNTIME: hmux, DURE_QA_PI_FIXTURE_URL: url,
  };
  assert.equal((await run(pi, ["--version"], { env })).trim(), "0.85.1", "qualify the exact public Pi protocol before changing its pin");
  process.stdout.write(await run(test, ["--ignored", "--exact", "managed_structured_runtime::pi_tests::live_pi_preserves_conversation_across_settings_busy_turns_and_reconnect", "--nocapture"], { env }));
  for (const [model, effort] of [["model-a", "high"], ["model-b", "high"], ["model-b", "low"]]) {
    assert(observations.some((entry) => entry.model === model && entry.effort === effort));
  }
  assert.equal(observations.filter((entry) => entry.toolResult && entry.user.includes("DURE_PI_BLOCK_")).length, 3, "each blocked turn must execute its real Pi bash tool exactly once");
  assert.equal(observations.filter((entry) => entry.toolResult && entry.user.includes("DURE_PI_QUESTION")).length, 1);
  const evidence = process.env.DURE_QA_PI_EVIDENCE ?? `/tmp/dure-pi-conformance-${process.pid}.json`;
  fs.writeFileSync(evidence, JSON.stringify({ version: "0.85.1", observations }, null, 2), { mode: 0o600 });
  console.log(`Pi 0.85.1 conformance passed; evidence: ${evidence}`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log(`Isolated Pi fixture root: ${root}`);
}
