import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fs.realpathSync(new URL("../..", import.meta.url));
const root = path.join(fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT), "pi-activity");
const home = path.join(root, "home");
const profile = path.join(home, ".pi", "agent");
fs.mkdirSync(path.join(profile, "extensions"), { recursive: true, mode: 0o700 });
const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
const pi = fs.realpathSync(process.env.DURE_QA_PI_BIN);
const environment = {
  HOME: home, DURE_HOME: path.join(home, ".dure"), PI_CODING_AGENT_DIR: profile,
  PI_OFFLINE: "1", TERM: "xterm-256color", LANG: "en_US.UTF-8",
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT, TMPDIR: root,
};
const evidence = { observations: [], modelRequests: [], cases: [] };
const evidencePath = process.env.DURE_QA_PI_EVIDENCE ?? `/tmp/dure-pi-activity-${process.pid}.json`;
const eventsPath = path.join(root, "events.jsonl");
// This normal user extension observes the public Pi events without changing
// provider input or reporting any Host state. It also proves additive loading.
fs.writeFileSync(path.join(profile, "extensions", "observe.ts"), `
import { appendFileSync } from "node:fs";
export default function(pi) {
  for (const name of ["session_start", "model_select", "agent_start", "agent_settled"]) {
    pi.on(name, (event, ctx) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({
      name, model: ctx.model?.id, idle: ctx.isIdle(), session: ctx.sessionManager.getSessionId()
    }) + "\\n"));
  }
}
`);
const readEvents = () => fs.existsSync(eventsPath)
  ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const waitFor = async (observe, label) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await observe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Missing observation: ${label}`);
};
let release;
const server = http.createServer(async (request, response) => {
  let bytes = "";
  for await (const chunk of request) bytes += chunk;
  const body = JSON.parse(bytes);
  evidence.modelRequests.push({ model: body.model });
  await new Promise((resolve) => { release = resolve; });
  if (response.destroyed) return;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish] of [[{ role: "assistant", content: "Pi activity fixture completed." }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: "pi-activity", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
let session;
const command = async (args) => {
  const { stdout } = await execute(cli, ["--json", ...args], { env: environment, cwd: root, timeout: 20_000 });
  return JSON.parse(stdout);
};
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(profile, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture-only",
    models: ["model-a", "model-b"].map((id) => ({ id, name: id, contextWindow: 8192, maxTokens: 1024 })),
  } } }));
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "model-a" }));
  const extension = path.join(repository, "src-tauri/resources/managed-pi-extension.mjs");
  const extensionArguments = [];
  // Before the integration exists, exercise the current uninstrumented launch.
  // The RED observation must be actual wrong Host activity, never a load error.
  if (fs.existsSync(extension)) {
    const published = path.join(root, "managed-pi-extension.mjs");
    fs.writeFileSync(published, fs.readFileSync(extension, "utf8")
      .replace('"__DURE_HMUX_RUNTIME_EXECUTABLE__"', JSON.stringify(runtime)));
    extensionArguments.push("--extension", published);
  }
  const request = Buffer.from(JSON.stringify({
    schema: "hmux-managed-create-v1", schemaVersion: 1,
    idempotencyKey: "native-pi-activity", sessionId: "native-pi-activity",
    workspaceId: "native-pi-activity-workspace", providerId: "pi", permissionMode: "default",
    providerCwd: root, initialRows: 40, initialColumns: 100,
    command: ["python3", path.join(repository, "scripts/qa/fixtures/native-provider-input-bridge.py"), pi,
      ...extensionArguments, "--provider", "fixture", "--model", "model-a", "--thinking", "off"],
  }));
  const frame = Buffer.alloc(4 + request.length);
  frame.writeUInt32BE(request.length); request.copy(frame, 4);
  const created = await new Promise((resolve, reject) => {
    const child = execFile(runtime, ["--no-autostart", "internal-hmux-managed-create"],
      { env: environment, cwd: root, encoding: "buffer", timeout: 20_000 },
      (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout.subarray(4).toString())));
    child.stdin.end(frame);
  });
  assert.equal(created.state, "completed", JSON.stringify(created));
  [session] = await command(["ls"]);
  assert.equal(session.session_id, "native-pi-activity");
  evidence.session = session;
  const fence = Object.fromEntries(["workspace_id", "session_id", "runner_principal", "runner_instance",
    "channel_epoch", "host_instance_id", "terminal_epoch"].map((key) => [key, session[key]]));
  const current = () => command(["session", "show", session.session_id]);
  const send = (text) => command(["command-input", "--target", session.session_id,
    "--expected-fence-json", JSON.stringify(fence), "--text", text, "--submit"]);
  const selectModel = async (model) => {
    const before = readEvents().length;
    await send(`/model fixture/${model}`);
    await waitFor(() => readEvents().slice(before).find((event) => event.name === "model_select" && event.model === model), "actual model selection");
    return (await current()).agentRuntimeState;
  };
  await waitFor(() => readEvents().find((event) => event.name === "session_start"), "Pi session ready");
  await waitFor(async () => (await current()).agentRuntimeState, "initial Host activity");
  const selected = await selectModel("model-b");
  evidence.cases.push({ name: "idle model selection", state: selected });
  assert.equal(evidence.modelRequests.length, 0, "model selection must not start a model request");
  assert.equal((await current()).providerConversationIdentity, null,
    "a fresh Pi session must not promise a transcript before it is persisted");
  assert.equal(selected.activity, "waiting", "model selection was incorrectly classified as work");
  assert.equal(selected.turn_completed_count, "0");
  await send("Reply with the fixture response.");
  await waitFor(() => evidence.modelRequests.length === 1, "actual model request");
  const working = (await current()).agentRuntimeState;
  evidence.cases.push({ name: "active model request", state: working });
  assert.equal(working.activity, "working");
  const busySelection = await selectModel("model-a");
  evidence.cases.push({ name: "model selection during a request", state: busySelection });
  assert.equal(busySelection.activity, "working");
  assert.equal(evidence.modelRequests.length, 1);
  release();
  await waitFor(() => readEvents().find((event) => event.name === "agent_settled"), "Pi settled");
  await waitFor(async () => (await current()).agentRuntimeState.activity === "waiting", "Host settled");
  const settledSession = await current();
  const settled = settledSession.agentRuntimeState;
  evidence.conversationIdentity = settledSession.providerConversationIdentity;
  assert.equal(evidence.conversationIdentity.conversation_id, readEvents()[0].session);
  evidence.cases.push({ name: "completed request", state: settled });
  assert.equal(settled.source, "provider_event");
  assert.equal(settled.turn_completed_count, "1");
  const afterSelection = await selectModel("model-b");
  assert.equal(afterSelection.activity, "waiting");
  assert.equal(afterSelection.turn_completed_count, settled.turn_completed_count);
  assert.equal(evidence.modelRequests.length, 1);
  const settledEvents = readEvents().filter((event) => event.name === "agent_settled").length;
  await send("Start the second fixture request.");
  await waitFor(() => evidence.modelRequests.length === 2, "second request started");
  await command(["command-input", "--target", session.session_id,
    "--expected-fence-json", JSON.stringify(fence), "--key", "Escape"]);
  await waitFor(() => readEvents().filter((event) => event.name === "agent_settled").length > settledEvents, "Pi interruption settled");
  await waitFor(async () => (await current()).agentRuntimeState.activity === "waiting", "Host interruption settled");
  const interrupted = (await current()).agentRuntimeState;
  evidence.cases.push({ name: "interrupted request", state: interrupted });
  assert.equal(interrupted.turn_completed_count, settled.turn_completed_count);
  assert.equal((await current()).providerConversationIdentity.conversation_id,
    evidence.conversationIdentity.conversation_id);
  assert.equal(new Set(readEvents().map((event) => event.session)).size, 1);
  evidence.passed = true;
} finally {
  release?.();
  evidence.observations = readEvents();
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  if (session) {
    fs.writeFileSync(path.join(root, "stop-provider"), "stop");
    await waitFor(() => fs.existsSync(path.join(root, "provider-exit.json")), "owned Pi child reaped");
    evidence.childExit = JSON.parse(fs.readFileSync(path.join(root, "provider-exit.json"), "utf8"));
    const child = JSON.parse(fs.readFileSync(path.join(root, "provider-child.json"), "utf8"));
    assert.equal(evidence.childExit.waitedPid, child.pid, "cleanup must reap the exact owned Pi child");
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log(JSON.stringify({ passed: evidence.passed ?? false, evidencePath, root }));
}
