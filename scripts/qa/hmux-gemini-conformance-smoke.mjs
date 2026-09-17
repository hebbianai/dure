import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { cargoArtifact, run } from "./managed-provider-fixture.mjs";
import { prepareGeminiExtension } from "../../src-tauri/resources/managed-gemini-extension.mjs";

const execute = promisify(execFile);
const repository = fs.realpathSync(new URL("../..", import.meta.url));
const root = path.join(fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT), "gemini");
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
const profile = path.join(home, ".gemini");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const runtime = fs.realpathSync(process.env.DURE_QA_HMUX_RUNTIME);
const cli = fs.realpathSync(process.env.DURE_QA_HMUX_BIN);
const gemini = fs.realpathSync(process.env.DURE_QA_GEMINI_BIN);
const evidencePath = process.env.DURE_QA_GEMINI_EVIDENCE ?? `/tmp/dure-gemini-conformance-${process.pid}.json`;
const evidence = { cases: [], modelRequests: [], binaries: {} };
const qualify = process.argv.includes("--qualify");
for (const [name, executable] of Object.entries({ runtime, cli, gemini })) {
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
  security: { auth: { selectedType: "gemini-api-key" } },
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  telemetry: { enabled: false },
  hooks: Object.fromEntries(["SessionStart", "BeforeAgent", "AfterAgent", "Notification", "AfterTool", "AfterModel"].map((name) => [name, [{
    hooks: [{ type: "command", name: "fixture-observer", command: `${quote(process.execPath)} ${quote(observer)}` }],
  }]])),
};
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify(settings));
fs.writeFileSync(path.join(profile, "trustedFolders.json"), JSON.stringify({ [workspace]: "TRUST_FOLDER" }));
const systemSettings = path.join(root, "system-settings.json");
const environment = {
  HOME: home, GEMINI_CLI_HOME: home, DURE_HOME: path.join(home, ".dure"),
  GEMINI_API_KEY: "fixture-only", GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettings,
  GEMINI_CLI_SYSTEM_DEFAULTS_PATH: systemSettings,
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
    if (request.url.includes("streamGenerateContent")) {
      const owner = active;
      response.on("close", () => { if (!response.writableEnded) owner.modelAborted = true; });
      if (owner.name === "cancel_partial") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model",
          parts: [{ text: "DURE_PARTIAL_CANCELLED" }] }, index: 0 }] })}\n\n`);
      }
      await new Promise((resolve) => { releaseModel = resolve; });
      if (response.destroyed) return;
      if (active?.name === "model_error") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: 400, message: "DURE_FIXTURE_MODEL_ERROR", status: "INVALID_ARGUMENT" } }));
        return;
      }
    }
    const parts = (body.contents ?? []).flatMap((content) => content.parts ?? []);
    const permissionCase = request.url.includes("streamGenerateContent") && ["default", "auto_edit", "yolo"].includes(active?.name);
    const responses = parts.flatMap((part) => part.functionResponse ? [part.functionResponse.name] : []);
    let result = { text: `DURE_GEMINI_OK_${active?.name}` };
    if (request.url.includes("streamGenerateContent") && active?.name === "tool_error" && !responses.includes("run_shell_command")) {
      result = { functionCall: { name: "run_shell_command", args: {
        command: "printf 'DURE_FIXTURE_TOOL_ERROR\\n' >&2; exit 7", description: "Exercise a failed tool",
      } } };
    } else if (permissionCase && !responses.includes("write_file")) {
      result = { functionCall: { name: "write_file", args: { file_path: active.editPath, content: "fixture edit\n" } } };
    } else if (permissionCase && !responses.includes("run_shell_command")) {
      result = { functionCall: { name: "run_shell_command", args: {
        command: `touch ${quote(active.shellStartedPath)}; while [ ! -e ${quote(active.shellReleasePath)} ]; do sleep 0.05; done; printf 'fixture shell\\n' > ${quote(active.shellPath)}`,
        description: "Write the disposable permission fixture",
      } } };
    }
    const answer = { candidates: [{ content: { role: "model", parts: [result] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
    if (request.url.includes("streamGenerateContent")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(answer)}\n\n`);
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer));
    }
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
    await waitFor(() => fs.existsSync(path.join(workspace, "provider-exit.json")), "owned Gemini child reaped");
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
    "-p", "dure-provider-adapter", "--test", "gemini", "--no-run"], "gemini");
  const plansPath = path.join(root, "plans.json");
  await run(artifact, ["--ignored", "--exact", "publish_gemini_conformance_launches"], {
    env: { ...process.env, DURE_QA_GEMINI_PLANS: plansPath },
  });
  const plans = JSON.parse(fs.readFileSync(plansPath, "utf8"));
  const control = path.join(root, "control");
  fs.mkdirSync(control, { mode: 0o700 });
  fs.copyFileSync(path.join(repository, "src-tauri/resources/managed-hook-report.mjs"), path.join(control, "managed-hook-report.mjs"));
  const hookPath = path.join(control, "managed-gemini-hook.mjs");
  fs.writeFileSync(hookPath, fs.readFileSync(path.join(repository, "src-tauri/resources/managed-gemini-hook.mjs"), "utf8")
    .replace('"__DURE_HMUX_RUNTIME_EXECUTABLE__"', JSON.stringify(runtime)), { mode: 0o600 });
  const originalSettings = fs.readFileSync(path.join(profile, "settings.json"), "utf8");
  environment.DURE_GEMINI_HOOK_PATH = prepareGeminiExtension(control, environment);
  evidence.version = (await execute(gemini, ["--version"], { env: environment, cwd: workspace, timeout: 20_000 })).stdout.trim();
  assert.equal(evidence.version, "0.60.0", "requalify explicitly when upgrading the fixture CLI");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  environment.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  let original;
  let decoy;
  for (const name of ["initial", "default", "auto_edit", "yolo", "decoy", "resume",
    ...(qualify ? ["repeat", "tool_error", "model_error", "cancel", "cancel_partial"] : [])]) {
    for (const file of ["stop-provider", "provider-child.json", "provider-exit.json", "provider-output.bin"]) {
      fs.rmSync(path.join(workspace, file), { force: true });
    }
    const plan = plans[name] ?? plans[name === "tool_error" ? "yolo" : "initial"];
    assert.equal(plan.executable, "gemini");
    active = { name, eventOffset: readEvents().length,
      editPath: path.join(workspace, `${name}-edit.txt`), shellPath: path.join(workspace, `${name}-shell.txt`),
      shellStartedPath: path.join(workspace, `${name}-shell-started`),
      shellReleasePath: path.join(workspace, `${name}-shell-release`),
      arguments: plan.arguments.map((argument) => argument === "__DURE_RESUME__" ? original.session_id : argument),
    };
    evidence.cases.push(active);
    const request = Buffer.from(JSON.stringify({
      schema: "hmux-managed-create-v1", schemaVersion: 1,
      idempotencyKey: `native-gemini-${name}`, sessionId: `native-gemini-${name}`,
      workspaceId: "native-gemini-workspace", providerId: "gemini",
      permissionMode: ["yolo", "tool_error"].includes(name) ? "bypass_approvals" : "default",
      providerCwd: workspace, initialRows: 40, initialColumns: 100,
      command: ["python3", path.join(repository, "scripts/qa/fixtures/native-provider-input-bridge.py"), gemini, ...active.arguments],
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
    const session = (await command(["ls"])).find((entry) => entry.session_id === `native-gemini-${name}`);
    assert(session);
    const fence = Object.fromEntries(["workspace_id", "session_id", "runner_principal", "runner_instance",
      "channel_epoch", "host_instance_id", "terminal_epoch"].map((key) => [key, session[key]]));
    const events = () => readEvents().slice(active.eventOffset);
    const current = () => command(["session", "show", session.session_id]);
    const advanceModel = async () => {
      await waitFor(() => releaseModel, `${name}: model request started`);
      const state = (await current()).agentRuntimeState;
      (active.working ??= []).push(state);
      assert.equal(state?.activity, "working", "Gemini model work must reach Host activity");
      assert.equal(state?.source, "provider_event");
      assert.equal(state.attention, "none");
      const release = releaseModel; releaseModel = undefined; release();
    };
    const notifications = () => events().filter((event) => event.hook_event_name === "Notification" && event.notification_type === "ToolPermission");
    const screen = async () => (await command(["read", session.session_id, "--workspace", session.workspace_id, "--lines", "40"])).lines.join("\n");
    const enter = () => command(["command-input", "--target", session.session_id,
      "--expected-fence-json", JSON.stringify(fence), "--key", "Enter"]);
    const approve = async () => {
      await waitFor(async () => (await screen()).includes("Allow once"), `${name}: permission menu rendered`);
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
    if (["cancel", "cancel_partial", "model_error"].includes(name)) {
      try {
        if (name.startsWith("cancel")) {
          await waitFor(() => releaseModel, "cancel: held model request");
          if (name === "cancel_partial") {
            await waitFor(async () => (await screen()).includes("DURE_PARTIAL_CANCELLED"), "partial response rendered before cancellation");
          }
          active.beforeCancel = (await current()).agentRuntimeState;
          assert.equal(active.beforeCancel.activity, "working");
          await command(["command-input", "--target", session.session_id,
            "--expected-fence-json", JSON.stringify(fence), "--key", "Escape"]);
          await waitFor(() => active.modelAborted, "cancel: provider aborted its HTTP request");
          const release = releaseModel; releaseModel = undefined; release();
        } else await advanceModel();
        await waitFor(() => events().some((event) => event.hook_event_name === "AfterAgent"), `${name}: AfterAgent`);
        await waitFor(async () => (await current()).agentRuntimeState?.activity === "waiting", `${name}: working lease cleared`);
        active.settled = (await current()).agentRuntimeState;
        assert.equal(active.settled.turn_completed_count, "0", `${name}: no false completion`);
        assert.equal(active.settled.attention, "none");
        await quit();
        active.passed = true;
      } catch (error) {
        active.qualificationError = String(error);
        active.settled = (await current()).agentRuntimeState;
        active.passed = false;
        await quit();
      }
      releaseModel?.(); releaseModel = undefined;
      await cleanup();
      continue;
    }
    await advanceModel();
    if (name === "tool_error") {
      const failed = await waitFor(() => events().find((event) => event.hook_event_name === "AfterTool"), "failed tool returned");
      assert.match(failed.tool_response.llmContent, /DURE_FIXTURE_TOOL_ERROR[\s\S]*Exit Code: 7/u);
      assert.equal((await current()).agentRuntimeState.turn_completed_count, "0", "tool failure alone must not complete the turn");
      await advanceModel();
    }
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
      // Gemini 0.60 emits BeforeTool before approval and has no approval-accepted
      // hook. Record that boundary during execution without freezing it as a contract.
      active.executingShell = (await current()).agentRuntimeState;
      fs.writeFileSync(active.shellReleasePath, "release");
      await waitFor(() => fs.existsSync(active.shellPath), `${name}: shell executed`);
      assert.equal(fs.readFileSync(active.editPath, "utf8"), "fixture edit\n");
      assert.equal(fs.readFileSync(active.shellPath, "utf8"), "fixture shell\n");
      await advanceModel();
    }
    const ended = await waitFor(() => events().find((event) => event.hook_event_name === "AfterAgent"), `${name}: response completed`);
    assert.equal(ended.session_id, started.session_id);
    assert.equal(ended.prompt_response, `DURE_GEMINI_OK_${name}`);
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
    await invokeHook({ ...ended, hook_event_name: "BeforeAgent", transcript_path: subagentTranscript });
    assert.deepEqual((await current()).agentRuntimeState, active.settled, "subagent hooks cannot replace main activity");
    for (const missing of [false, true]) {
      const reportEnvironment = { ...mainFence };
      if (missing) delete reportEnvironment.HMUX_TERMINAL_EPOCH;
      else reportEnvironment.HMUX_TERMINAL_EPOCH += "-stale";
      await invokeHook({ ...ended, hook_event_name: "BeforeAgent" }, reportEnvironment);
      assert.deepEqual((await current()).agentRuntimeState, active.settled, "incomplete or stale hooks cannot mutate the Host");
    }
    active.approvals = notifications().length;
    assert.equal(active.approvals, name === "default" ? 2 : name === "auto_edit" ? 1 : 0);
    const prompts = events().filter((event) => event.hook_event_name === "BeforeAgent").map((event) => event.prompt);
    assert.deepEqual(prompts, [plan.prompt], "initial prompt must be submitted once, preserving its bytes");
    const requests = evidence.modelRequests.filter((entry) => entry.case === name && entry.url.includes("streamGenerateContent"));
    assert.equal(requests.length, ["default", "auto_edit", "yolo"].includes(name) ? 3 : name === "tool_error" ? 2 : 1);
    assert(requests.every((entry) => entry.url.includes(`/models/${plan.model}:`)), "the CLI must use the explicitly selected model");
    active.transcriptPath = ended.transcript_path;
    assert(path.resolve(ended.transcript_path).startsWith(`${profile}${path.sep}`), "history must stay inside the private profile");
    active.transcript = fs.readFileSync(ended.transcript_path, "utf8");
    const header = JSON.parse(active.transcript.split("\n")[0]);
    assert.equal(header.sessionId, started.session_id);
    active.startedAt = header.startTime;
    if (name === "initial") original = ended;
    if (name === "decoy") decoy = ended;
    if (name === "resume") {
      assert.notEqual(original.session_id, decoy.session_id);
      assert.equal(started.session_id, original.session_id, "resume must select the exact original, not the newer decoy");
      assert.equal(started.source, "resume");
      assert(Date.parse(evidence.cases.find((entry) => entry.name === "decoy").startedAt)
        > Date.parse(evidence.cases[0].startedAt), "the decoy must actually be newer");
      const history = JSON.stringify(requests[0].body.contents);
      assert(history.includes("DURE_GEMINI_INITIAL"), "resumed model request needs original history");
      assert(!history.includes("DURE_GEMINI_DECOY"), "newer decoy history must not leak into exact resume");
      assert(active.transcript.includes("DURE_GEMINI_RESUME"));
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
    console.log(`Gemini conformance: ${name} passed`);
  }
  assert(!evidence.serverError, evidence.serverError);
  evidence.qualification = {
    approvalExecution: evidence.cases.filter((entry) => entry.executingShell)
      .every((entry) => entry.executingShell.activity === "working" && entry.executingShell.attention === "none"),
    lifecycle: qualify ? evidence.cases.every((entry) => entry.passed) : null,
  };
  if (qualify) assert(Object.values(evidence.qualification).every(Boolean), "Gemini lifecycle qualification remains incomplete; see #826");
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
