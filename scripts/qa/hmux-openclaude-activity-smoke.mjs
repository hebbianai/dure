import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

// Native OpenClaude activity smoke: a real OpenClaude CLI in a real Hmux
// session, driven against a local model fixture, reports working, approval
// required and idle through the channel launcher Dure publishes. Run it
// through scripts/run-hmux-tests.mjs with DURE_QA_HMUX_RUNTIME,
// DURE_QA_HMUX_BIN and DURE_QA_OPENCLAUDE_BIN naming exact executables.
const execute = promisify(execFile);
const repository = fs.realpathSync(new URL("../..", import.meta.url));
const root = path.join(fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT), "openclaude");
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
const control = path.join(root, "control");
for (const directory of [home, workspace, control]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
const openclaude = fs.realpathSync(process.env.DURE_QA_OPENCLAUDE_BIN);
const evidencePath = process.env.DURE_QA_OPENCLAUDE_EVIDENCE ?? `/tmp/dure-openclaude-activity-${process.pid}.json`;
const evidence = { cases: [], modelRequests: [], binaries: {} };
for (const [name, executable] of Object.entries({ runtime, cli, openclaude })) {
  evidence.binaries[name] = { executable, sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") };
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const writeEvidence = () => fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });

// Materialize the channel files exactly as src-tauri/src/managed_hooks/openclaude.rs
// publishes them: reporter, shared report helper, settings and launcher.
const hook = path.join(control, "managed-openclaude-hook.mjs");
fs.writeFileSync(hook, fs.readFileSync(path.join(repository, "src-tauri/resources/managed-openclaude-hook.mjs"), "utf8")
  .replace('"__DURE_HMUX_RUNTIME_EXECUTABLE__"', JSON.stringify(runtime)), { mode: 0o600 });
fs.copyFileSync(path.join(repository, "src-tauri/resources/managed-hook-report.mjs"), path.join(control, "managed-hook-report.mjs"));
const settings = path.join(control, "managed-openclaude-settings.json");
fs.writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "PostToolUse",
  "PostToolUseFailure", "PermissionRequest", "Stop", "StopFailure", "SessionEnd"].map((event) => [event, [{
  hooks: [{ type: "command", command: `node ${quote(hook)}`, timeout: 3 }],
}]])) }, null, 2), { mode: 0o600 });
const launcher = path.join(control, "managed-openclaude-launch.sh");
fs.writeFileSync(launcher, `#!/bin/sh\nset -eu\nprovider=$1\nshift\nexec "$provider" --settings ${quote(settings)} "$@"\n`, { mode: 0o700 });

// A person's own hook must keep running beside the managed one; it also lets
// the smoke see the provider's events independently of the Host.
const eventsPath = path.join(root, "events.jsonl");
const observer = path.join(root, "observe.cjs");
fs.writeFileSync(observer, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(eventsPath)}, fs.readFileSync(0, 'utf8').trim() + '\\n');
process.stdout.write('{}');
`);
const profile = path.join(home, ".openclaude");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
const userSettings = JSON.stringify({ hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "PermissionRequest",
  "PostToolUse", "Stop"].map((event) => [event, [{ hooks: [{ type: "command",
  command: `${quote(process.execPath)} ${quote(observer)}` }] }]])) }, null, 2);
fs.writeFileSync(path.join(profile, "settings.json"), userSettings);
fs.writeFileSync(path.join(home, ".openclaude.json"), JSON.stringify({
  hasCompletedOnboarding: true, theme: "dark", autoUpdates: false,
  projects: { [workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}));

const environment = {
  HOME: home, DURE_HOME: path.join(home, ".dure"), TERM: "xterm-256color", LANG: "en_US.UTF-8",
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT, TMPDIR: root,
  CLAUDE_CODE_USE_OPENAI: "1", OPENAI_API_KEY: "fixture-only", OPENAI_MODEL: "fixture-model",
  DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
const readEvents = () => fs.existsSync(eventsPath)
  ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const waitFor = async (observe, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await observe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Missing observation: ${label}`);
};

// Each model request is held until the smoke has read the Host state.
let releaseModel;
const server = http.createServer(async (request, response) => {
  let bytes = "";
  for await (const chunk of request) bytes += chunk;
  if (!request.url.endsWith("/chat/completions")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] }));
    return;
  }
  const body = JSON.parse(bytes);
  const toolResults = (body.messages ?? []).filter((message) => message.role === "tool").length;
  const mainTurn = body.tools?.some((tool) => tool.function?.name === "Bash") === true;
  if (!mainTurn) {
    // Side requests such as titles or summaries answer at once.
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "fixture-side", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  evidence.modelRequests.push({ toolResults, stream: body.stream });
  await new Promise((resolve) => { releaseModel = resolve; });
  if (response.destroyed) return;
  const delta = toolResults === 0
    ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-call-1", type: "function", function: {
      name: "Bash", arguments: JSON.stringify({ command: "printf fixture > approved.txt", description: "Write the fixture file" }),
    } }] }
    : { role: "assistant", content: "DURE_OPENCLAUDE_OK" };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [chunk, finish] of [[delta, null], [{}, toolResults === 0 ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: "fixture-answer", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: chunk, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});

const command = async (args) => {
  const { stdout } = await execute(cli, ["--json", ...args], { env: environment, cwd: workspace, timeout: 20_000 });
  return JSON.parse(stdout);
};
let session;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  environment.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  evidence.version = (await execute(openclaude, ["--version"], { env: environment, cwd: workspace, timeout: 30_000 })).stdout.trim();
  assert(["0.32.0 (OpenClaude)", "0.34.0 (OpenClaude)"].includes(evidence.version),
    "requalify explicitly when upgrading the fixture CLI");
  const request = Buffer.from(JSON.stringify({
    schema: "hmux-managed-create-v1", schemaVersion: 1,
    idempotencyKey: "native-openclaude-activity", sessionId: "native-openclaude-activity",
    workspaceId: "native-openclaude-workspace", providerId: "openclaude", permissionMode: "default",
    providerCwd: workspace, initialRows: 40, initialColumns: 120,
    command: ["python3", path.join(repository, "scripts/qa/fixtures/native-provider-input-bridge.py"), launcher, openclaude],
  }));
  const frame = Buffer.alloc(4 + request.length);
  frame.writeUInt32BE(request.length); request.copy(frame, 4);
  const created = await new Promise((resolve, reject) => {
    const child = execFile(runtime, ["--no-autostart", "internal-hmux-managed-create"],
      { env: environment, cwd: workspace, encoding: "buffer", timeout: 20_000 },
      (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout.subarray(4).toString())));
    child.stdin.end(frame);
  });
  assert.equal(created.state, "completed", JSON.stringify(created));
  [session] = await command(["ls"]);
  assert.equal(session.session_id, "native-openclaude-activity");
  const fence = Object.fromEntries(["workspace_id", "session_id", "runner_principal", "runner_instance",
    "channel_epoch", "host_instance_id", "terminal_epoch"].map((key) => [key, session[key]]));
  const current = async () => (await command(["session", "show", session.session_id])).agentRuntimeState;
  const screen = async () => (await command(["read", session.session_id, "--workspace", session.workspace_id,
    "--lines", "40"])).lines.join("\n");
  const observe = async (name) => {
    const state = await current();
    evidence.cases.push({ name, state });
    writeEvidence();
    return state;
  };

  // A cold Node start on a busy machine can take most of a minute.
  await waitFor(() => readEvents().find((event) => event.hook_event_name === "SessionStart"), "OpenClaude session start", 120_000);
  const idle = await waitFor(async () => {
    const state = await current();
    return state?.source === "provider_event" && state;
  }, "provider-reported idle state");
  evidence.cases.push({ name: "started", state: idle });
  assert.equal(idle.activity, "waiting");
  assert.equal(idle.attention, "none");

  // Type, see the draft, then press Enter as a person would: a submit in the
  // same write as the text reaches the editor as part of a paste.
  const input = (args) => command(["command-input", "--target", session.session_id,
    "--expected-fence-json", JSON.stringify(fence), ...args]);
  await input(["--text", "Write the fixture file."]);
  await waitFor(async () => /❯\s+Write the fixture file\./u.test(await screen()), "prompt draft rendered");
  await input(["--key", "Enter"]);
  await waitFor(() => evidence.modelRequests.length === 1 && releaseModel, "first model request");
  const working = await observe("model request");
  assert.equal(working.activity, "working");
  assert.equal(working.attention, "none");
  assert.equal(working.source, "provider_event");
  releaseModel(); releaseModel = undefined;

  await waitFor(() => readEvents().find((event) => event.hook_event_name === "PermissionRequest"), "permission requested");
  await waitFor(async () => (await current())?.attention === "approval_required", "Host approval attention");
  const approval = await observe("permission prompt");
  assert.equal(approval.activity, "waiting");
  assert(!fs.existsSync(path.join(workspace, "approved.txt")), "the tool must wait for approval");
  evidence.permissionScreen = await screen();
  await input(["--key", "Enter"]);

  await waitFor(() => evidence.modelRequests.length === 2 && releaseModel, "model request after the approved tool");
  assert.equal(fs.readFileSync(path.join(workspace, "approved.txt"), "utf8"), "fixture");
  // The approved tool's result hook may land after the next model request starts.
  await waitFor(async () => (await current())?.activity === "working", "Host working after the approved tool");
  const resumed = await observe("after approval");
  assert.equal(resumed.activity, "working");
  assert.equal(resumed.attention, "none");
  releaseModel(); releaseModel = undefined;

  const stopped = await waitFor(() => readEvents().find((event) => event.hook_event_name === "Stop"), "turn stopped");
  assert.equal(stopped.last_assistant_message, "DURE_OPENCLAUDE_OK");
  await waitFor(async () => (await current())?.turn_completed_count === "1", "Host turn completion");
  const settled = await observe("turn completed");
  assert.equal(settled.activity, "waiting");
  assert.equal(settled.attention, "none");
  // OpenClaude may rewrite its own settings file; Dure must never add to it.
  evidence.userSettingsAfter = fs.readFileSync(path.join(profile, "settings.json"), "utf8");
  assert(!evidence.userSettingsAfter.includes(control), "user settings must not reference the channel files");
  assert.deepEqual(JSON.parse(evidence.userSettingsAfter).hooks, JSON.parse(userSettings).hooks,
    "the person's own hooks stay as they were");

  // A replayed stop and a background subagent after the turn cannot move the Host.
  const mainFence = { ...environment, ...Object.fromEntries(Object.entries(fence)
    .map(([key, value]) => [`HMUX_${key.toUpperCase()}`, value])) };
  const invokeHook = (input, env = mainFence) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hook], { env, timeout: 20_000 },
      (error, output) => error ? reject(error) : resolve(assert.equal(output, "{}")));
    child.stdin.end(JSON.stringify(input));
  });
  await invokeHook(stopped);
  await invokeHook({ ...stopped, hook_event_name: "PostToolUse", tool_name: "Bash", agent_id: "fixture-subagent" });
  const replayed = await current();
  assert.equal(replayed.turn_completed_count, "1", "a replayed stop is one completion");
  assert.equal(replayed.activity, "waiting", "a background subagent cannot make the agent look busy");
  for (const stale of [{ HMUX_TERMINAL_EPOCH: `${fence.terminal_epoch}-stale` }, { HMUX_TERMINAL_EPOCH: "" }]) {
    await invokeHook({ ...stopped, hook_event_name: "UserPromptSubmit" }, { ...mainFence, ...stale });
    assert.equal((await current()).activity, "waiting", "a stale or incomplete fence cannot report");
  }
  evidence.passed = true;
  console.log("OpenClaude activity smoke passed: working, approval required and idle reached the Host");
} catch (error) {
  evidence.error = String(error?.stack ?? error);
  if (session) {
    try { evidence.screen = await (async () => (await command(["read", session.session_id, "--workspace",
      session.workspace_id, "--lines", "40"])).lines.join("\n"))(); } catch { /* best effort */ }
  }
  throw error;
} finally {
  releaseModel?.();
  evidence.events = readEvents();
  // The bridge owns and reaps its direct child; no PID discovery or pattern kill.
  if (fs.existsSync(path.join(workspace, "provider-child.json"))) {
    fs.writeFileSync(path.join(workspace, "stop-provider"), "stop");
    try {
      await waitFor(() => fs.existsSync(path.join(workspace, "provider-exit.json")), "owned OpenClaude child reaped", 15_000);
      evidence.exit = JSON.parse(fs.readFileSync(path.join(workspace, "provider-exit.json"), "utf8"));
    } catch (error) { evidence.cleanupError = String(error); }
  }
  writeEvidence();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  console.log(JSON.stringify({ passed: evidence.passed ?? false, evidencePath }));
}
