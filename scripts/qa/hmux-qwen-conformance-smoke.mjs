import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { cargoArtifact, run } from "./managed-provider-fixture.mjs";
import { prepareQwenExtension } from "../../src-tauri/resources/managed-qwen-extension.mjs";

const execute = promisify(execFile);
const repository = fs.realpathSync(new URL("../..", import.meta.url));
const root = path.join(fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT), "qwen");
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
const profile = path.join(home, ".qwen");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
const qwen = fs.realpathSync(process.env.DURE_QA_QWEN_BIN);
const evidencePath = process.env.DURE_QA_QWEN_EVIDENCE ?? `/tmp/dure-qwen-conformance-${process.pid}.json`;
const evidence = { cases: [], modelRequests: [], binaries: {} };
for (const [name, executable] of Object.entries({ runtime, cli, qwen })) {
  evidence.binaries[name] = { executable, sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") };
}
const eventsPath = path.join(root, "events.jsonl");
const observer = path.join(root, "observe.cjs");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
// Independently observe public hooks while the product reporter updates Host state.
fs.writeFileSync(observer, `const fs = require('node:fs');
const event = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
process.stdout.write('{}');
`);
const settings = {
  $version: 4,
  ui: { enableFollowupSuggestions: false },
  memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false },
  security: { auth: { selectedType: "openai" } },
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  telemetry: { enabled: false },
  hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop", "Notification", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "StopFailure", "SessionEnd"].map((name) => [name, [{
    hooks: [{ type: "command", name: "fixture-observer", command: `${quote(process.execPath)} ${quote(observer)}` }],
  }]])),
};
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify(settings, null, 2));
fs.writeFileSync(path.join(profile, "trustedFolders.json"), JSON.stringify({ [workspace]: "TRUST_FOLDER" }));
const systemSettings = path.join(root, "system-settings.json");
const environment = {
  HOME: home, QWEN_HOME: profile, DURE_HOME: path.join(home, ".dure"),
  OPENAI_API_KEY: "fixture-only", QWEN_CODE_SYSTEM_SETTINGS_PATH: systemSettings,
  QWEN_CODE_SYSTEM_DEFAULTS_PATH: systemSettings,
  TERM: "xterm-256color", LANG: "en_US.UTF-8",
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT, TMPDIR: root,
};
const readEvents = () => fs.existsSync(eventsPath)
  ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const waitFor = async (observe, label) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await observe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Missing observation: ${label}`);
};
const writeEvidence = () => fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
let active;
let releaseModel;
const server = http.createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes);
    evidence.modelRequests.push({ case: active?.name, url: request.url, body });
    const owner = active;
    response.on("close", () => { if (!response.writableEnded) owner.modelAborted = true; });
    await new Promise((resolve) => { releaseModel = resolve; });
    if (response.destroyed) return;
    const responses = (body.messages ?? []).filter((message) => message.role === "tool");
    const permissionCase = ["default", "auto_edit", "yolo"].includes(active.name);
    let call;
    if (permissionCase && responses.length === 0) {
      call = { name: "write_file", arguments: JSON.stringify({ file_path: active.editPath, content: "fixture edit\n" }) };
    } else if (permissionCase && responses.length === 1) {
      call = { name: "run_shell_command", arguments: JSON.stringify({
        command: `touch ${quote(active.shellStartedPath)}; while [ ! -e ${quote(active.shellReleasePath)} ]; do sleep 0.05; done; printf 'fixture shell\n' > ${quote(active.shellPath)}`,
        description: "Write the disposable permission fixture",
      }) };
    }
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${responses.length}`, type: "function", function: call }] }
      : { role: "assistant", content: `DURE_QWEN_OK_${active.name}` };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [chunk, finish] of [[delta, null], [{}, call ? "tool_calls" : "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: `chatcmpl-${active.name}`, object: "chat.completion.chunk", created: 1,
        model: body.model, choices: [{ index: 0, delta: chunk, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    evidence.serverError = String(error);
    response.writeHead(500); response.end();
  }
});
const command = async (args) => {
  const { stdout } = await execute(cli, ["--json", ...args], { env: environment, cwd: workspace, timeout: 20_000 });
  return JSON.parse(stdout);
};
const cleanup = async () => {
  if (!active) return;
  active.events = readEvents().slice(active.eventOffset);
  if (fs.existsSync(path.join(workspace, "provider-output.bin"))) {
    active.terminalOutput = fs.readFileSync(path.join(workspace, "provider-output.bin"), "utf8");
  }
  writeEvidence();
  // The bridge owns and reaps its direct, unreaped child; no PID discovery or pattern kill.
  if (fs.existsSync(path.join(workspace, "provider-child.json"))) {
    fs.writeFileSync(path.join(workspace, "stop-provider"), "stop");
    await waitFor(() => fs.existsSync(path.join(workspace, "provider-exit.json")), "owned Qwen child reaped");
    active.child = JSON.parse(fs.readFileSync(path.join(workspace, "provider-child.json"), "utf8"));
    active.exit = JSON.parse(fs.readFileSync(path.join(workspace, "provider-exit.json"), "utf8"));
    assert.equal(active.exit.waitedPid, active.child.pid);
  }
  if (fs.existsSync(path.join(workspace, "provider-output.bin"))) {
    active.terminalOutput = fs.readFileSync(path.join(workspace, "provider-output.bin"), "utf8");
  }
  active.events = readEvents().slice(active.eventOffset);
  writeEvidence();
  active = undefined;
};
try {
  const artifact = await cargoArtifact(["test", "--locked", "--manifest-path", "crates/dure-app/Cargo.toml",
    "-p", "dure-provider-adapter", "--test", "qwen", "--no-run"], "qwen");
  const plansPath = path.join(root, "plans.json");
  await run(artifact, ["--ignored", "--exact", "publish_qwen_conformance_launches"], {
    env: { ...process.env, DURE_QA_QWEN_PLANS: plansPath },
  });
  const plans = JSON.parse(fs.readFileSync(plansPath, "utf8"));
  const control = path.join(root, "control");
  fs.mkdirSync(control, { mode: 0o700 });
  fs.copyFileSync(path.join(repository, "src-tauri/resources/managed-hook-report.mjs"), path.join(control, "managed-hook-report.mjs"));
  const hookPath = path.join(control, "managed-qwen-hook.mjs");
  fs.writeFileSync(hookPath, fs.readFileSync(path.join(repository, "src-tauri/resources/managed-qwen-hook.mjs"), "utf8")
    .replace('"__DURE_HMUX_RUNTIME_EXECUTABLE__"', JSON.stringify(runtime)), { mode: 0o600 });
  const originalSettings = fs.readFileSync(path.join(profile, "settings.json"), "utf8");
  environment.DURE_QWEN_HOOK_PATH = prepareQwenExtension(control, environment);
  evidence.version = (await execute(qwen, ["--version"], { env: environment, cwd: workspace, timeout: 20_000 })).stdout.trim();
  assert.equal(evidence.version, "0.24.0", "requalify explicitly when upgrading the fixture CLI");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  environment.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  let original;
  let decoy;
  for (const name of ["initial", "default", "auto_edit", "yolo", "decoy", "resume",
    "repeat"]) {
    for (const file of ["stop-provider", "provider-child.json", "provider-exit.json", "provider-output.bin"]) {
      fs.rmSync(path.join(workspace, file), { force: true });
    }
    const plan = plans[name] ?? plans.initial;
    assert.equal(plan.executable, "qwen");
    active = { name, eventOffset: readEvents().length,
      editPath: path.join(workspace, `${name}-edit.txt`), shellPath: path.join(workspace, `${name}-shell.txt`),
      shellStartedPath: path.join(workspace, `${name}-shell-started`),
      shellReleasePath: path.join(workspace, `${name}-shell-release`),
      arguments: plan.arguments.map((argument) => argument === "__DURE_RESUME__" ? original.session_id : argument),
    };
    evidence.cases.push(active);
    const request = Buffer.from(JSON.stringify({
      schema: "hmux-managed-create-v1", schemaVersion: 1,
      idempotencyKey: `native-qwen-${name}`, sessionId: `native-qwen-${name}`,
      workspaceId: "native-qwen-workspace", providerId: "qwen-code",
      permissionMode: name === "yolo" ? "bypass_approvals" : "default",
      providerCwd: workspace, initialRows: 40, initialColumns: 100,
      command: ["python3", path.join(repository, "scripts/qa/fixtures/native-provider-input-bridge.py"), qwen, ...active.arguments],
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
    const session = (await command(["ls"])).find((entry) => entry.session_id === `native-qwen-${name}`);
    assert(session);
    const fence = Object.fromEntries(["workspace_id", "session_id", "runner_principal", "runner_instance",
      "channel_epoch", "host_instance_id", "terminal_epoch"].map((key) => [key, session[key]]));
    const events = () => readEvents().slice(active.eventOffset);
    const current = () => command(["session", "show", session.session_id]);
    const advanceModel = async () => {
      await waitFor(() => releaseModel, `${name}: model request started`);
      const state = (await current()).agentRuntimeState;
      (active.working ??= []).push(state);
      assert.equal(state?.activity, "working", "Qwen model work must reach Host activity");
      assert.equal(state?.source, "provider_event");
      assert.equal(state.attention, "none");
      const release = releaseModel; releaseModel = undefined; release();
    };
    const notifications = () => events().filter((event) => event.hook_event_name === "Notification" && event.notification_type === "permission_prompt");
    const screen = async () => (await command(["read", session.session_id, "--workspace", session.workspace_id, "--lines", "40"])).lines.join("\n");
    const enter = () => command(["command-input", "--target", session.session_id,
      "--expected-fence-json", JSON.stringify(fence), "--key", "Enter"]);
    const approve = async () => {
      await waitFor(async () => (await screen()).toLowerCase().includes("allow once"), `${name}: permission menu rendered`);
      const blocked = (await current()).agentRuntimeState;
      (active.blocked ??= []).push(blocked);
      assert.equal(blocked.activity, "waiting");
      assert.equal(blocked.attention, "approval_required");
      await enter();
    };
    const quit = async () => {
      // Hook delivery precedes the CLI render. Type, observe the draft, then
      // press Enter as a user would; this is not a busy paste/submit test.
      await command(["command-input", "--target", session.session_id,
        "--expected-fence-json", JSON.stringify(fence), "--text", "/quit"]);
      await waitFor(async () => {
        const text = await screen();
        return /[>*] \/quit/u.test(text) && !text.includes("Executing Hook");
      }, `${name}: quit draft rendered after hooks`);
      await enter();
      await waitFor(() => fs.existsSync(path.join(workspace, "provider-exit.json")), `${name}: native quit reaped`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, "provider-exit.json"), "utf8")).status, 0);
      active.shutdown = (await current()).agentRuntimeState;
      assert(active.shutdown === null || active.shutdown?.activity === "waiting", "shutdown must not leave a working lease");
    };
    const started = await waitFor(() => events().find((event) => event.hook_event_name === "SessionStart"), `${name}: session start`);
    active.sessionId = started.session_id;
    await advanceModel();
    if (name === "default") {
      await waitFor(() => notifications().length === 1, "default: edit approval requested");
      assert(!fs.existsSync(active.editPath), "default must wait for edit approval");
      await approve();
    }
    if (["default", "auto_edit", "yolo"].includes(name)) {
      await waitFor(() => fs.existsSync(active.editPath), `${name}: edit executed`);
      await advanceModel();
      if (name !== "yolo") {
        await waitFor(() => notifications().length === (name === "default" ? 2 : 1), `${name}: shell approval requested`);
        assert(!fs.existsSync(active.shellPath), `${name} must wait for shell approval`);
        await approve();
      }
      await waitFor(() => fs.existsSync(active.shellStartedPath), `${name}: shell started`);
      // Observe the held tool after the provider has accepted permission.
      active.executingShell = (await current()).agentRuntimeState;
      fs.writeFileSync(active.shellReleasePath, "release");
      await waitFor(() => fs.existsSync(active.shellPath), `${name}: shell executed`);
      assert.equal(fs.readFileSync(active.editPath, "utf8"), "fixture edit\n");
      assert.equal(fs.readFileSync(active.shellPath, "utf8"), "fixture shell\n");
      await advanceModel();
    }
    const ended = await waitFor(() => events().find((event) => event.hook_event_name === "Stop"), `${name}: response completed`);
    assert.equal(ended.session_id, started.session_id);
    assert.equal(ended.last_assistant_message, `DURE_QWEN_OK_${name}`);
    await waitFor(async () => (await current()).agentRuntimeState?.turn_completed_count === "1", `${name}: Host completion`);
    const settled = await current();
    active.settled = settled.agentRuntimeState;
    assert.equal(active.settled.activity, "waiting");
    assert.equal(active.settled.attention, "none");
    assert.equal(settled.providerConversationIdentity?.conversation_id, started.session_id);
    assert.equal(fs.readFileSync(path.join(profile, "settings.json"), "utf8"), originalSettings, "user hooks must remain unchanged");
    const mainFence = { ...environment, ...Object.fromEntries(Object.entries(fence)
      .map(([key, value]) => [`HMUX_${key.toUpperCase()}`, value])) };
    const invokeHook = (input, env = mainFence) => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [hookPath], { env, timeout: 5000 },
        (error, output) => error ? reject(error) : resolve(assert.equal(output, "{}")));
      child.stdin.end(JSON.stringify(input));
    });
    await invokeHook(ended);
    assert.equal((await current()).agentRuntimeState.turn_completed_count, "1", "replayed completion must be idempotent");
    const subagentTranscript = path.join(workspace, `${name}-subagent.jsonl`);
    fs.writeFileSync(subagentTranscript, JSON.stringify({ sessionId: ended.session_id, kind: "subagent" }) + "\n");
    await invokeHook({ ...ended, hook_event_name: "UserPromptSubmit", transcript_path: subagentTranscript, agent_id: "fixture-subagent" });
    assert.deepEqual((await current()).agentRuntimeState, active.settled, "subagent hooks cannot replace main activity");
    for (const missing of [false, true]) {
      const reportEnvironment = { ...mainFence };
      if (missing) delete reportEnvironment.HMUX_TERMINAL_EPOCH;
      else reportEnvironment.HMUX_TERMINAL_EPOCH += "-stale";
      await invokeHook({ ...ended, hook_event_name: "UserPromptSubmit" }, reportEnvironment);
      assert.deepEqual((await current()).agentRuntimeState, active.settled, "incomplete or stale hooks cannot mutate the Host");
    }
    active.approvals = notifications().length;
    assert.equal(active.approvals, name === "default" ? 2 : name === "auto_edit" ? 1 : 0);
    const prompts = events().filter((event) => event.hook_event_name === "UserPromptSubmit").map((event) => event.prompt);
    assert.deepEqual(prompts.filter((prompt) => prompt === plan.prompt), [plan.prompt], "initial prompt must be submitted once, preserving its bytes");
    const requests = evidence.modelRequests.filter((entry) => entry.case === name);
    assert.equal(requests.length, ["default", "auto_edit", "yolo"].includes(name) ? 3 : 1);
    assert(requests.every((entry) => entry.body.model === plan.model), "the CLI must use the explicitly selected model");
    active.transcriptPath = ended.transcript_path;
    assert(path.resolve(ended.transcript_path).startsWith(`${profile}${path.sep}`), "history must stay inside the private profile");
    active.transcript = fs.readFileSync(ended.transcript_path, "utf8");
    const header = JSON.parse(active.transcript.split("\n")[0]);
    assert.equal(header.sessionId, started.session_id);
    active.startedAt = header.timestamp;
    if (name === "initial") original = ended;
    if (name === "decoy") decoy = ended;
    if (name === "resume") {
      assert.notEqual(original.session_id, decoy.session_id);
      assert.equal(started.session_id, original.session_id, "resume must select the exact original, not the newer decoy");
      assert.equal(started.source, "resume");
      assert(Date.parse(evidence.cases.find((entry) => entry.name === "decoy").startedAt)
        > Date.parse(evidence.cases[0].startedAt), "the decoy must actually be newer");
      const history = JSON.stringify(requests[0].body.messages);
      assert(history.includes("DURE_QWEN_INITIAL"), "resumed model request needs original history");
      assert(!history.includes("DURE_QWEN_DECOY"), "newer decoy history must not leak into exact resume");
      assert(active.transcript.includes("DURE_QWEN_RESUME"));
    }
    if (name === "repeat") {
      await command(["command-input", "--target", session.session_id,
        "--expected-fence-json", JSON.stringify(fence), "--text", "DURE_REPEAT_SECOND_TURN"]);
      await waitFor(async () => {
        const text = await screen();
        return /[>*] DURE_REPEAT_SECOND_TURN/u.test(text) && !text.includes("Executing Hook");
      }, "second turn draft rendered after hooks");
      await enter();
      await advanceModel();
      await waitFor(async () => (await current()).agentRuntimeState?.turn_completed_count === "2", "second distinct completion");
      active.repeated = (await current()).agentRuntimeState;
      assert.equal(active.repeated.activity, "waiting");
      assert.equal(active.repeated.attention, "none");
    }
    await quit();
    active.passed = true;
    await cleanup();
    console.log(`Qwen conformance: ${name} passed`);
  }
  assert(!evidence.serverError, evidence.serverError);
  evidence.qualification = {
    approvalExecution: evidence.cases.filter((entry) => entry.executingShell)
      .every((entry) => entry.executingShell.activity === "working" && entry.executingShell.attention === "none"),
    lifecycle: evidence.cases.every((entry) => entry.passed),
  };
  assert(Object.values(evidence.qualification).every(Boolean), "Qwen native smoke remains incomplete; see #951");
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  releaseModel?.();
  if (active?.shellReleasePath) fs.writeFileSync(active.shellReleasePath, "release");
  try { await cleanup(); } catch (error) {
    evidence.cleanupError = String(error);
    if (!evidence.error) throw error;
  } finally {
    writeEvidence();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    console.log(JSON.stringify({ passed: evidence.passed ?? false, evidencePath }));
  }
}
