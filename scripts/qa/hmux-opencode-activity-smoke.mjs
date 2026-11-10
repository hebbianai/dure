import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

// Native activity smoke for OpenCode and Kilo Code, which is built on it: a
// real provider in a real Hmux session, driven against a local model fixture,
// reports working, approval, input and idle through the channel launcher Dure
// publishes. Run it through scripts/run-hmux-tests.mjs with the provider ID as
// its argument (default `opencode`), and DURE_QA_HMUX_RUNTIME, DURE_QA_HMUX_BIN
// and the provider's binary variable below naming exact executables.
const providers = {
  opencode: {
    label: "OpenCode", binary: "DURE_QA_OPENCODE_BIN", variable: "OPENCODE_CONFIG_CONTENT",
    launcher: "managed-opencode-launch.sh", config: "opencode/opencode.json", versions: ["1.18.29", "1.19.5"],
    environment: { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" },
  },
  kilocode: {
    label: "Kilo Code", binary: "DURE_QA_KILO_BIN", variable: "KILO_CONFIG_CONTENT",
    launcher: "managed-kilo-launch.sh", config: "kilo/kilo.json", versions: ["7.8.27"],
    environment: {
      KILO_DISABLE_AUTOUPDATE: "1", KILO_DISABLE_DEFAULT_PLUGINS: "1", KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_SESSION_INGEST: "1", KILO_DISABLE_SHARE: "1", KILO_TELEMETRY_LEVEL: "off",
    },
  },
};
const providerId = process.argv[2] ?? "opencode";
const provider = providers[providerId];
assert(provider, `unknown provider ${providerId}; expected one of ${Object.keys(providers).join(", ")}`);
const execute = promisify(execFile);
const repository = fs.realpathSync(new URL("../..", import.meta.url));
const root = path.join(fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT), providerId);
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
// The provider must accept the channel's escaped plugin URL.
const control = path.join(root, "control with space");
for (const directory of [home, workspace, control]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
const binary = fs.realpathSync(process.env[provider.binary]);
const evidencePath = process.env.DURE_QA_OPENCODE_EVIDENCE ?? `/tmp/dure-${providerId}-activity-${process.pid}.json`;
const evidence = { provider: providerId, cases: [], modelRequests: [], binaries: {} };
for (const [name, executable] of Object.entries({ runtime, cli, [providerId]: binary })) {
  evidence.binaries[name] = { executable, sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") };
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const writeEvidence = () => fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
const fileUrl = (file) => `file://${file.split("/").map(encodeURIComponent).join("/")}`;

// Materialize the channel files exactly as src-tauri/src/managed_hooks/opencode.rs
// publishes them: plugin, state, shared report helper and this provider's launcher.
const resources = path.join(repository, "src-tauri/resources");
const plugin = path.join(control, "managed-opencode-plugin.mjs");
fs.writeFileSync(plugin, fs.readFileSync(path.join(resources, "managed-opencode-plugin.mjs"), "utf8")
  .replace('"__DURE_HMUX_RUNTIME_EXECUTABLE__"', JSON.stringify(runtime)), { mode: 0o600 });
for (const file of ["managed-opencode-state.mjs", "managed-hook-report.mjs"]) {
  fs.copyFileSync(path.join(resources, file), path.join(control, file));
}
const launcher = path.join(control, provider.launcher);
fs.writeFileSync(launcher, `#!/bin/sh
set -eu
provider=$1
shift
if [ -z "\${${provider.variable}:-}" ]; then
  ${provider.variable}=${quote(JSON.stringify({ plugin: [fileUrl(plugin)] }))}
  export ${provider.variable}
fi
unset DURE_OPENCODE_REPORTER_PID
exec "$provider" "$@"
`, { mode: 0o700 });

// The person's own configuration names the model and their own plugin. It must
// keep working beside the managed plugin and gain nothing from Dure.
const eventsPath = path.join(root, "events.jsonl");
const observer = path.join(root, "observe.mjs");
fs.writeFileSync(observer, `import fs from "node:fs";
export const Observer = async () => ({ event: async ({ event }) => {
  fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ type: event.type, properties: event.properties }) + "\\n");
} });
`);
const configPath = path.join(home, ".config", provider.config);
fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });

const environment = {
  HOME: home, DURE_HOME: path.join(home, ".dure"), TERM: "xterm-256color", LANG: "en_US.UTF-8",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT, TMPDIR: root,
  XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
  XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local/state"),
  ...provider.environment,
};
const readEvents = () => fs.existsSync(eventsPath)
  ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const waitFor = async (observe, label, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await observe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Missing observation: ${label}`);
};

// Each main-turn model request is held until the smoke has read the Host state.
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
  const mainTurn = body.tools?.some((tool) => tool.function?.name === "bash") === true;
  const afterTool = body.messages?.at(-1)?.role === "tool";
  const users = (body.messages ?? []).filter((message) => message.role === "user");
  const prompt = JSON.stringify(users.at(-1)?.content ?? "");
  let delta = { role: "assistant", content: mainTurn ? "DURE_OPENCODE_OK" : "Fixture" };
  if (mainTurn) {
    evidence.modelRequests.push({ afterTool, prompt: prompt.slice(0, 80) });
    if (prompt.includes("HOLD_UNTIL_INTERRUPTED")) {
      await new Promise((resolve) => { request.on("close", resolve); });
      return;
    }
    if (prompt.includes("FAIL_THIS_TURN")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture failure", type: "invalid_request_error" } }));
      return;
    }
    await new Promise((resolve) => { releaseModel = resolve; });
    if (response.destroyed) return;
    if (!afterTool && prompt.includes("WRITE_FIXTURE_FILE")) {
      delta = { role: "assistant", tool_calls: [{ index: 0, id: "fixture-write", type: "function", function: {
        name: "bash", arguments: JSON.stringify({ command: "printf '%s' \"$DURE_OPENCODE_REPORTER_PID\" > approved.txt", description: "Write the fixture file" }),
      } }] };
    } else if (!afterTool && prompt.includes("ASK_FIXTURE_QUESTION")) {
      delta = { role: "assistant", tool_calls: [{ index: 0, id: "fixture-question", type: "function", function: {
        name: "question", arguments: JSON.stringify({ questions: [{ question: "Pick one", header: "Pick",
          options: [{ label: "First", description: "first" }, { label: "Second", description: "second" }] }] }),
      } }] };
    }
  }
  const finish = delta.tool_calls ? "tool_calls" : "stop";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [chunk, reason] of [[delta, null], [{}, finish]]) {
    response.write(`data: ${JSON.stringify({ id: "fixture-answer", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: chunk, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});

const command = async (args) => {
  const { stdout } = await execute(cli, ["--json", ...args], { env: environment, cwd: workspace, timeout: 30_000 });
  return JSON.parse(stdout);
};
let session;
let personalConfig;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  personalConfig = `${JSON.stringify({
    plugin: [fileUrl(observer)], enabled_providers: ["fixture"], permission: { bash: "ask", edit: "ask" }, model: "fixture/fixture-model",
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: {
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only",
    }, models: { "fixture-model": { name: "Fixture model", limit: { context: 8192, output: 1024 } } } } },
  }, null, 2)}\n`;
  fs.writeFileSync(configPath, personalConfig);
  evidence.version = (await execute(binary, ["--version"], { env: environment, cwd: workspace, timeout: 60_000 })).stdout.trim();
  assert(provider.versions.includes(evidence.version), "requalify explicitly when upgrading the fixture CLI");
  const request = Buffer.from(JSON.stringify({
    schema: "hmux-managed-create-v1", schemaVersion: 1,
    idempotencyKey: `native-${providerId}-activity`, sessionId: `native-${providerId}-activity`,
    workspaceId: `native-${providerId}-workspace`, providerId, permissionMode: "default",
    providerCwd: workspace, initialRows: 40, initialColumns: 120,
    command: ["python3", path.join(repository, "scripts/qa/fixtures/native-provider-input-bridge.py"), launcher, binary],
  }));
  const frame = Buffer.alloc(4 + request.length);
  frame.writeUInt32BE(request.length); request.copy(frame, 4);
  const created = await new Promise((resolve, reject) => {
    const child = execFile(runtime, ["--no-autostart", "internal-hmux-managed-create"],
      { env: environment, cwd: workspace, encoding: "buffer", timeout: 30_000 },
      (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout.subarray(4).toString())));
    child.stdin.end(frame);
  });
  assert.equal(created.state, "completed", JSON.stringify(created));
  [session] = await command(["ls"]);
  assert.equal(session.session_id, `native-${providerId}-activity`);
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
  const input = (args) => command(["command-input", "--target", session.session_id,
    "--expected-fence-json", JSON.stringify(fence), ...args]);
  const release = () => { releaseModel(); releaseModel = undefined; };
  const heldRequest = (count) => waitFor(() => evidence.modelRequests.length === count && releaseModel, `model request ${count}`);
  const submit = async (text) => {
    await input(["--text", text]);
    await waitFor(async () => (await screen()).includes(text), `draft rendered: ${text}`);
    await input(["--key", "Enter"]);
  };

  // A cold start on a busy machine can take most of a minute.
  const idle = await waitFor(async () => {
    const state = await current();
    return state?.source === "provider_event" && state;
  }, "provider-reported idle state", 180_000);
  evidence.cases.push({ name: "started", state: idle });
  assert.equal(idle.activity, "waiting");
  assert.equal(idle.attention, "none");
  await waitFor(async () => /ctrl\+p/u.test(await screen()), "terminal interface ready", 180_000);

  await submit("WRITE_FIXTURE_FILE now");
  await heldRequest(1);
  await waitFor(async () => (await current())?.activity === "working", "Host working during the model request");
  const working = await observe("model request");
  assert.equal(working.attention, "none");
  assert.equal(working.source, "provider_event");
  release();

  await waitFor(async () => (await current())?.attention === "approval_required", "Host approval attention");
  const approval = await observe("permission prompt");
  assert.equal(approval.activity, "waiting");
  assert(!fs.existsSync(path.join(workspace, "approved.txt")), "the tool must wait for approval");
  evidence.permissionScreen = await screen();
  await input(["--key", "Enter"]);

  await heldRequest(2);
  const resumed = await waitFor(async () => {
    const state = await current();
    return state?.activity === "working" && state.attention === "none" && state;
  }, "attention cleared by the answer, before the next model reply");
  evidence.cases.push({ name: "after approval", state: resumed });
  // The child inherits the reporter's process id, so a nested provider stays quiet.
  assert.match(fs.readFileSync(path.join(workspace, "approved.txt"), "utf8"), /^\d+$/u);
  release();

  await waitFor(async () => (await current())?.turn_completed_count === "1", "Host turn completion");
  const settled = await observe("turn completed");
  assert.equal(settled.activity, "waiting");
  assert.equal(settled.attention, "none");

  await submit("ASK_FIXTURE_QUESTION now");
  await heldRequest(3);
  release();
  await waitFor(async () => (await current())?.attention === "input_required", "Host input attention");
  const question = await observe("question");
  assert.equal(question.activity, "waiting");
  evidence.questionScreen = await screen();
  await input(["--key", "Enter"]);
  await heldRequest(4);
  release();
  await waitFor(async () => (await current())?.turn_completed_count === "2", "second turn completion");
  assert.equal((await observe("question answered")).attention, "none");

  await submit("FAIL_THIS_TURN now");
  await waitFor(async () => (await current())?.attention === "error", "Host error attention");
  const failed = await observe("failed turn");
  assert.equal(failed.activity, "waiting");
  assert.equal(failed.turn_completed_count, "2", "a failed turn does not complete");

  await submit("HOLD_UNTIL_INTERRUPTED now");
  await waitFor(async () => {
    const state = await current();
    return state?.activity === "working" && state.attention === "none" && state.source === "provider_event";
  }, "the next turn clears the failure");
  await waitFor(() => evidence.modelRequests.some((entry) => entry.prompt.includes("HOLD_UNTIL_INTERRUPTED")), "held model request");
  await input(["--key", "Escape"]);
  await input(["--key", "Escape"]);
  await waitFor(async () => {
    const state = await current();
    return state?.activity === "waiting" && state;
  }, "interrupt reaches idle");
  const interrupted = await observe("interrupted turn");
  assert.equal(interrupted.attention, "none", "an interrupt is not an error");
  assert.equal(interrupted.turn_completed_count, "2", "an interrupted turn does not complete");

  assert(readEvents().some((event) => event.type === "session.status"), "the person's plugin keeps running");
  // The provider may add its own $schema key; Dure must never add to this file.
  const configAfter = fs.readFileSync(configPath, "utf8");
  assert(!configAfter.includes("managed-opencode"), "the configuration must not reference the channel files");
  const { $schema: _schema, ...configFields } = JSON.parse(configAfter);
  assert.deepEqual(configFields, JSON.parse(personalConfig), "the person's configuration stays as it was");
  evidence.passed = true;
  console.log(`${provider.label} activity smoke passed: working, approval, input, failure, interrupt and idle reached the Host`);
} catch (error) {
  evidence.error = String(error?.stack ?? error);
  if (session) {
    try { evidence.screen = (await command(["read", session.session_id, "--workspace", session.workspace_id, "--lines", "40"])).lines.join("\n"); } catch { /* best effort */ }
    try { evidence.state = (await command(["session", "show", session.session_id])).agentRuntimeState; } catch { /* best effort */ }
  }
  throw error;
} finally {
  releaseModel?.();
  evidence.events = readEvents().filter((event) => /^(session\.(status|error|idle)|permission|question)/u.test(event.type));
  // The bridge owns and reaps its direct child; no PID discovery or pattern kill.
  if (fs.existsSync(path.join(workspace, "provider-child.json"))) {
    fs.writeFileSync(path.join(workspace, "stop-provider"), "stop");
    try {
      await waitFor(() => fs.existsSync(path.join(workspace, "provider-exit.json")), "owned provider child reaped", 15_000);
      evidence.exit = JSON.parse(fs.readFileSync(path.join(workspace, "provider-exit.json"), "utf8"));
    } catch (error) { evidence.cleanupError = String(error); }
  }
  writeEvidence();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  console.log(JSON.stringify({ passed: evidence.passed ?? false, evidencePath }));
}
