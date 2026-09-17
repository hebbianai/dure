import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";

// This is an actual CLI protocol probe, not a product adapter or Basic promotion gate.
assert(process.env.DURE_HMUX_TEST_STATE_ROOT, "run through scripts/run-hmux-tests.mjs");
assert(process.env.HMUX_DISCOVERY_ROOT, "the QA guardian must own discovery");
const root = path.join(fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT), "gemini-acp");
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
const profile = path.join(home, ".gemini");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const gemini = fs.realpathSync(process.env.DURE_QA_GEMINI_BIN);
const evidencePath = process.env.DURE_QA_GEMINI_ACP_EVIDENCE ?? `/tmp/dure-gemini-acp-${process.pid}.json`;
const bundle = path.dirname(gemini);
const caseNames = ["initial", "allow", "reject", "cancel_permission", "cancel_tool", "shell_error", "read_error", "yolo",
  "model_error", "cancel_model", "cancel_partial", "repeat", "resume", "missing_resume"];
const transcriptDigests = () => Object.fromEntries(fs.readdirSync(profile, { recursive: true })
  .filter((file) => file.includes(`${path.sep}chats${path.sep}`) && /\.jsonl?$/u.test(file))
  .sort().map((file) => [file, createHash("sha256").update(fs.readFileSync(path.join(profile, file))).digest("hex")]));
const evidence = {
  schema: "dure-gemini-acp-conformance/v1", root, executable: gemini,
  // The entry point imports bundled modules; fingerprint those as well.
  modules: Object.fromEntries(fs.readdirSync(bundle).filter((name) => name.endsWith(".js")).sort()
    .map((name) => [name, createHash("sha256").update(fs.readFileSync(path.join(bundle, name))).digest("hex")])),
  cases: [], processes: [], qualification: {},
};
const save = () => fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const waitFor = async (observe, label) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = observe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Missing observation: ${label}`);
};
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
  security: { auth: { selectedType: "gemini-api-key" } },
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  telemetry: { enabled: false },
}));
fs.writeFileSync(path.join(profile, "trustedFolders.json"), JSON.stringify({ [workspace]: "TRUST_FOLDER" }));
const environment = {
  HOME: home, GEMINI_CLI_HOME: home, DURE_HOME: path.join(home, ".dure"),
  GEMINI_API_KEY: "fixture-only", GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, "system.json"),
  GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(root, "system.json"),
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  LANG: "en_US.UTF-8", TMPDIR: root, HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT,
};
let active;
const toolCases = new Set(["allow", "reject", "cancel_permission", "cancel_tool", "shell_error", "yolo"]);
const server = http.createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const chunk of request) {
      bytes += chunk;
      assert(bytes.length < 2_000_000, "fixture model request exceeded its bound");
    }
    const body = JSON.parse(bytes);
    const owner = active;
    const streaming = request.url.includes("streamGenerateContent");
    if (streaming) {
      assert(owner, "model calls must belong to a probe case");
      assert(owner.modelRequests.length < 8, "unexpected model retry or tool loop");
      owner.modelRequests.push({ url: request.url, contents: body.contents });
      response.on("close", () => { if (!response.writableEnded) owner.modelAborted = true; });
      if (owner.name === "cancel_model" || owner.name === "cancel_partial") {
        if (owner.name === "cancel_partial") {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model",
            parts: [{ text: "DURE_ACP_PARTIAL" }] }, index: 0 }] })}\n\n`);
        }
        return;
      }
      if (owner.name === "model_error") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: 400, message: "DURE_ACP_MODEL_ERROR", status: "INVALID_ARGUMENT" } }));
        return;
      }
    }
    let part = { text: `DURE_ACP_OK_${owner?.name}` };
    if (streaming && toolCases.has(owner.name) && owner.modelRequests.length === 1) {
      const command = owner.name === "shell_error"
        ? `printf 'DURE_ACP_TOOL_ERROR\\n' >&2; exit 7`
        : `touch ${quote(owner.started)}; while [ ! -e ${quote(owner.release)} ]; do sleep 0.05; done; printf done > ${quote(owner.effect)}`;
      part = { functionCall: { name: "run_shell_command", args: { command, description: "Exercise the disposable ACP fixture" } } };
    }
    if (streaming && owner.name === "read_error" && owner.modelRequests.length === 1) {
      part = { functionCall: { name: "read_file", args: { file_path: path.join(workspace, "missing.txt") } } };
    }
    const answer = { candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
    response.writeHead(200, { "Content-Type": streaming ? "text/event-stream" : "application/json" });
    response.end(streaming ? `data: ${JSON.stringify(answer)}\n\n` : JSON.stringify(answer));
  } catch (error) {
    evidence.serverError = String(error);
    response.writeHead(500).end();
  }
});

function connect() {
  const record = { executable: gemini, cwd: workspace, arguments: ["--acp", "--model", "gemini-2.5-flash"], wire: [], stderr: "" };
  evidence.processes.push(record);
  const child = spawn(gemini, record.arguments, { cwd: workspace, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  record.pid = child.pid;
  child.on("error", (error) => { record.error = String(error); });
  child.stdin.on("error", (error) => { record.inputError = String(error); });
  child.stderr.on("data", (bytes) => { record.stderr = (record.stderr + bytes.toString()).slice(-65_536); });
  child.on("close", (code, signal) => { record.exit = { code, signal }; });
  const responses = new Map();
  const permissions = [];
  const write = (message) => {
    record.wire.push({ direction: "client", case: active?.name, message });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      assert(line.length < 1_000_000 && record.wire.length < 2_048, "ACP transcript exceeded its bound");
      const message = JSON.parse(line);
      record.wire.push({ direction: "agent", case: active?.name, message });
      if (message.method === "session/request_permission") permissions.push(message);
      else if (message.id !== undefined && !message.method) responses.set(message.id, message);
      else if (message.id !== undefined) {
        write({ id: message.id, error: { code: -32601, message: "Client capability not advertised" } });
      }
    } catch (error) {
      record.protocolError = `${String(error)}: ${line.slice(0, 1_024)}`;
    }
  });
  let sequence = 0;
  const begin = (method, params) => {
    const id = ++sequence;
    write({ id, method, params });
    return id;
  };
  const result = async (id) => {
    const message = await waitFor(() => {
      assert(!record.protocolError, record.protocolError);
      assert(!record.error, record.error);
      assert(!record.exit, `Gemini exited before response ${id}`);
      return responses.get(id);
    }, `RPC response ${id}`);
    responses.delete(id);
    return message;
  };
  const request = async (method, params) => {
    const message = await result(begin(method, params));
    assert(!message.error, JSON.stringify(message));
    return message.result;
  };
  return {
    record, write, begin, result, request, permissions,
    async close() {
      child.stdin.end();
      try {
        await waitFor(() => record.exit, "Gemini exit after stdin EOF");
        assert.deepEqual(record.exit, { code: 0, signal: null });
      } finally {
        if (!record.exit) {
          // Let the launch guardian reconcile its owned closure after a failed EOF shutdown.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
      }
    },
  };
}

let connection;
const initialize = async () => {
  connection = connect();
  const result = await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {},
    clientInfo: { name: "dure-acp-conformance", version: "1" } });
  connection.record.initialization = result;
  assert.equal(result.agentInfo.version, "0.60.0", "explicitly requalify a new CLI version");
  assert.equal(result.protocolVersion, 1);
  assert(result.authMethods.some((method) => method.id === "gemini-api-key"));
  await connection.request("authenticate", { methodId: "gemini-api-key" });
};
const updates = () => connection.record.wire.slice(active.wireOffset)
  .filter((entry) => entry.direction === "agent" && entry.message.method === "session/update")
  .map((entry) => entry.message.params);
const states = (id) => updates().filter(({ update }) => update.toolCallId === id && update.status)
  .map(({ update }) => update.status);
const answerPermission = (permission, kind) => {
  const option = permission.params.options.find((entry) => entry.kind === kind);
  assert(option, `Gemini must advertise ${kind}`);
  connection.write({ id: permission.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } });
};
const cancel = (sessionId) => connection.write({ method: "session/cancel", params: { sessionId } });

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  environment.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  await initialize();
  let originalSession;
  for (const name of caseNames) {
    active = { name, modelRequests: [], started: path.join(workspace, `${name}-started`),
      release: path.join(workspace, `${name}-release`), effect: path.join(workspace, `${name}-effect`) };
    evidence.cases.push(active);
    if (name === "missing_resume") {
      active.transcriptsBefore = transcriptDigests();
      active.loaded = await connection.result(connection.begin("session/load", {
        sessionId: "00000000-0000-4000-8000-000000000000", cwd: workspace, mcpServers: [],
      }));
      active.transcriptsAfter = transcriptDigests();
      evidence.qualification.missingResumeNoWrite = !!active.loaded.error
        && JSON.stringify(active.transcriptsBefore) === JSON.stringify(active.transcriptsAfter);
      active.observed = true;
      save();
      console.log("Gemini ACP observed: missing_resume");
      continue;
    }
    if (name === "resume") {
      await connection.close();
      active.persistedSessions = fs.readdirSync(profile, { recursive: true })
        .filter((file) => file.includes(`${path.sep}chats${path.sep}`) && /\.jsonl?$/u.test(file))
        .map((file) => {
          const bytes = fs.readFileSync(path.join(profile, file), "utf8");
          const records = file.endsWith(".jsonl") ? bytes.trim().split("\n").map(JSON.parse) : [JSON.parse(bytes)];
          return { file, sessionIds: [...new Set(records.flatMap((record) => [record.sessionId, record.$set?.sessionId].filter(Boolean)))],
            containsInitial: bytes.includes("DURE_ACP_OK_initial") };
        });
      await initialize();
      assert.equal(connection.record.initialization.agentCapabilities.loadSession, true);
      active.wireOffset = connection.record.wire.length;
      active.sessionId = originalSession;
      active.loaded = await connection.result(connection.begin("session/load", { sessionId: originalSession, cwd: workspace, mcpServers: [] }));
      active.replay = updates();
      evidence.qualification.resumeHistory = active.replay.some(({ update }) => update.content?.text?.includes("DURE_ACP_OK_initial"));
      if (active.loaded.error) {
        evidence.qualification.resume = false;
        active.observed = true;
        save();
        console.log("Gemini ACP observed: resume rejected");
        continue;
      }
    }
    const session = name === "repeat" || name === "resume" ? { sessionId: originalSession }
      : await connection.request("session/new", { cwd: workspace, mcpServers: [] });
    const { sessionId } = session;
    assert(sessionId);
    active.sessionId = sessionId;
    if (name === "initial") originalSession = sessionId;
    if (name === "yolo") await connection.request("session/set_mode", { sessionId, modeId: "yolo" });
    active.wireOffset = connection.record.wire.length;
    const permissionOffset = connection.permissions.length;
    const prompt = connection.begin("session/prompt", { sessionId, prompt: [{ type: "text", text: `DURE_ACP_${name}` }] });
    let permission;
    if (toolCases.has(name) && name !== "yolo") {
      permission = await waitFor(() => connection.permissions[permissionOffset], `${name}: permission request`);
      assert.equal(permission.params.sessionId, sessionId);
      assert.equal(permission.params.toolCall.status, "pending");
      assert(!fs.existsSync(active.started), "tool must wait for the permission response");
      active.permission = permission.params;
      if (name === "cancel_permission") {
        cancel(sessionId);
        connection.write({ id: permission.id, result: { outcome: { outcome: "cancelled" } } });
      } else answerPermission(permission, name === "reject" ? "reject_once" : "allow_once");
    }
    if (["allow", "cancel_tool", "yolo"].includes(name)) {
      await waitFor(() => fs.existsSync(active.started), `${name}: real shell started`);
      assert(!fs.existsSync(active.effect), "shell must remain held before release");
      active.heldUpdates = updates();
      if (name === "cancel_tool") cancel(sessionId);
      else fs.writeFileSync(active.release, "release");
    }
    if (name === "cancel_model" || name === "cancel_partial") {
      await waitFor(() => active.modelRequests.length > 0, `${name}: model request`);
      if (name === "cancel_partial") await waitFor(() => updates().some(({ update }) => update.content?.text === "DURE_ACP_PARTIAL"), "partial text reached ACP client");
      cancel(sessionId);
    }
    active.response = await connection.result(prompt);
    active.updates = updates();
    assert(active.updates.every((entry) => entry.sessionId === sessionId), "updates must retain the exact session identity");
    active.effectExists = fs.existsSync(active.effect);
    if (permission) active.toolStates = states(permission.params.toolCall.toolCallId);
    if (name.startsWith("cancel_")) {
      evidence.qualification[name] = active.response.result?.stopReason === "cancelled" && !active.effectExists;
      if (name === "cancel_model" || name === "cancel_partial") {
        await waitFor(() => active.modelAborted, `${name}: model HTTP connection aborted`);
      }
    } else if (name === "model_error") {
      evidence.qualification.modelError = active.response.error?.code === 400;
    } else {
      assert.equal(active.response.result?.stopReason, "end_turn", JSON.stringify(active.response));
    }
    if (name === "allow") {
      assert(active.effectExists, "approved tool must actually execute");
      evidence.qualification.approvalExecution = active.toolStates.includes("in_progress")
        && active.heldUpdates.some(({ update }) => update.toolCallId === permission.params.toolCall.toolCallId && update.status === "in_progress");
      evidence.qualification.toolCompletion = active.toolStates.at(-1) === "completed";
    }
    if (name === "reject") {
      assert(!active.effectExists && !fs.existsSync(active.started), "rejected tool must not execute");
      evidence.qualification.rejectionTerminal = active.toolStates.at(-1) === "failed";
    }
    if (name === "shell_error") {
      assert(JSON.stringify(active.modelRequests).includes("Exit Code: 7"), "observe the actual failed shell result");
      evidence.qualification.shellExitFailure = active.toolStates.at(-1) === "failed";
    }
    if (name === "read_error") evidence.qualification.toolError = active.updates.some(({ update }) => update.status === "failed");
    if (name === "yolo") {
      assert.equal(connection.permissions.length, permissionOffset);
      evidence.qualification.yoloExecution = active.effectExists && active.heldUpdates.some(({ update }) => update.status === "in_progress");
    }
    if (name === "repeat" || name === "resume") {
      evidence.qualification[name] = active.modelRequests.some((request) => JSON.stringify(request.contents).includes("DURE_ACP_OK_initial"));
      assert(!JSON.stringify(active.modelRequests).includes("DURE_ACP_OK_allow"), "another session's history must not leak into this conversation");
      if (name === "resume") evidence.qualification.resumeLatestTurn = active.modelRequests
        .some((request) => JSON.stringify(request.contents).includes("DURE_ACP_OK_repeat"));
    }
    active.observed = true;
    save();
    console.log(`Gemini ACP observed: ${name}`);
  }
  assert(!evidence.serverError, evidence.serverError);
} catch (error) {
  evidence.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  // Release fixture shells on a probe failure; the existing guardian owns forced cleanup.
  for (const entry of evidence.cases) fs.writeFileSync(entry.release, "cleanup");
  if (connection && !connection.record.exit) {
    try {
      if (active?.sessionId && !active.observed) cancel(active.sessionId);
      for (const permission of connection.permissions) {
        const answered = connection.record.wire.some((entry) => entry.direction === "client" && entry.message.id === permission.id && "result" in entry.message);
        if (!answered) connection.write({ id: permission.id, result: { outcome: { outcome: "cancelled" } } });
      }
      await connection.close();
    } catch (error) {
      evidence.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // Recheck after releasing held fixtures and closing the provider: a late side effect
  // would disprove cancellation even if the prompt had already returned "cancelled".
  evidence.qualification.cancellationQuiescence = evidence.cases
    .filter((entry) => entry.name.startsWith("cancel_") || entry.name === "reject")
    .every((entry) => !fs.existsSync(entry.effect));
  evidence.qualified = !evidence.failure && !evidence.cleanupError
    && evidence.cases.length === caseNames.length && evidence.cases.every((entry) => entry.observed)
    && evidence.processes.every((entry) => entry.exit?.code === 0 && entry.exit.signal === null
      && !entry.error && !entry.inputError && !entry.protocolError)
    && Object.values(evidence.qualification).every((value) => value === true);
  if (!evidence.qualified) process.exitCode = 1;
  save();
  console.log(`Unsupported observations: ${Object.entries(evidence.qualification).filter(([, supported]) => !supported).map(([name]) => name).join(", ")}`);
  console.log(`Gemini ACP qualified: ${evidence.qualified}; evidence: ${evidencePath}`);
}
