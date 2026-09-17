import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const hook = path.resolve("src-tauri/resources/managed-claude-hook.py");
const claude = process.env.HEBBIAN_QA_CLAUDE_BIN || "claude";
const root = await mkdtemp(path.join(tmpdir(), "dure-claude-handoff-"));
const requests = { stale: [], unsafe: [], live: [] };

function fixtureServer(kind, descriptor) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const authorization = request.headers.authorization;
      requests[kind].push({
        path: request.url,
        authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
      });
      const acceptedToken =
        kind === "live" ? descriptor.reportToken : "reused-port-report-token";
      if (authorization !== `Bearer ${acceptedToken}`) {
        response.writeHead(401).end("{}");
        return;
      }
      if (request.url === "/ping") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              ok: true,
              channel: descriptor.channel,
              generation: descriptor.generation,
              processId: descriptor.processId,
              capabilities: ["managed_claude_host_report_v1", "managed_claude_host_report_causality_v1"],
            }),
          );
        return;
      }
      if (request.url === "/hooks/claude" && kind === "live") {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      response.writeHead(409).end("{}");
    });
  });
  return server;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  return address.port;
}

async function writeDescriptor(directory, descriptor, mode = 0o600) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "server.json");
  await writeFile(file, `${JSON.stringify(descriptor)}\n`, { mode });
  await chmod(file, mode);
}

async function runChild(command, args, { cwd, env, input, timeoutMs }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  if (input !== undefined) child.stdin.end(input);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  let result;
  try {
    result = await Promise.race([
      once(child, "close").then(([code, signal]) => ({ code, signal })),
      once(child, "error").then(([error]) => Promise.reject(error)),
    ]);
  } finally {
    clearTimeout(timeout);
    child.stdin.destroy();
  }
  if (timedOut) throw new Error(`${command} timed out after ${timeoutMs}ms`);
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

let staleServer;
let unsafeServer;
let liveServer;
try {
  const stale = {
    channel: "stable",
    generation: "stale-generation",
    processId: 1001,
    reportToken: "stale-report-token",
  };
  const live = {
    channel: "dev-live-a1b2c3d4",
    generation: "live-generation",
    processId: 1002,
    reportToken: "live-report-token",
  };
  const unsafe = {
    channel: "dev-unsafe-a1b2c3d4",
    generation: "unsafe-generation",
    processId: 1003,
    reportToken: "unsafe-report-token",
  };
  staleServer = fixtureServer("stale", stale);
  unsafeServer = fixtureServer("unsafe", unsafe);
  liveServer = fixtureServer("live", live);
  stale.port = await listen(staleServer);
  unsafe.port = await listen(unsafeServer);
  live.port = await listen(liveServer);
  // The stale descriptor is deliberately newer, but its old token now points
  // at a reused port. Authenticated generation probing must move to live.
  await writeDescriptor(path.join(root, "channels", unsafe.channel), unsafe, 0o644);
  await writeDescriptor(path.join(root, "channels", live.channel), live);
  await writeDescriptor(root, stale);
  const publishedHook = path.join(root, "managed-claude-hook-v1.py");
  await writeFile(publishedHook, await readFile(hook), { mode: 0o700 });
  await chmod(publishedHook, 0o700);
  const codexReportsPath = path.join(root, "codex-hmux-reports.jsonl");
  const codexDescendantStatePath = path.join(root, "codex-descendant-state.json");
  const fakeHmuxRuntime = path.join(root, "hmux-runtime");
  await writeFile(
    fakeHmuxRuntime,
    `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify([
    "--no-autostart",
    "internal-hmux-managed-agent-state-report",
  ])) process.exit(2);
  const framed = Buffer.concat(chunks);
  if (framed.length < 4) process.exit(3);
  const declared = framed.readUInt32BE(0);
  if (framed.length !== 4 + declared) process.exit(4);
  const request = JSON.parse(framed.subarray(4).toString("utf8"));
  fs.appendFileSync(${JSON.stringify(codexReportsPath)}, JSON.stringify(request) + "\\n");
  let response = { state: "completed", payload: "applied" };
  if (request.expectedFence?.session_id === "managed-session-descendant") {
    const statePath = ${JSON.stringify(codexDescendantStatePath)};
    const state = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, "utf8"))
      : { conversationId: null, activity: "waiting", turnCompletedCount: 0 };
    const conversationId = request.report?.conversation_identity?.conversation_id;
    if (
      state.conversationId &&
      conversationId &&
      conversationId !== state.conversationId
    ) {
      response = {
        state: "refused",
        payload: {
          code: "hmux_identity_mismatch",
          message: "descendant conversation does not own the parent Host session",
        },
      };
    } else {
      if (!state.conversationId && conversationId) state.conversationId = conversationId;
      state.activity = request.report.activity;
      if (request.report.turn_completed) state.turnCompletedCount += 1;
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
  }
  const payload = Buffer.from(JSON.stringify(response));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
});
`,
    { mode: 0o700 },
  );
  await chmod(fakeHmuxRuntime, 0o700);
  const codexGoalQueriesPath = path.join(root, "codex-goal-queries.jsonl");
  const fakeCodex = path.join(root, "codex");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv[2] !== "app-server") process.exit(64);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }) + "\\n");
    return;
  }
  if (message.method !== "thread/goal/get") return;
  const threadId = message.params?.threadId;
  const priorQueries = fs.existsSync(${JSON.stringify(codexGoalQueriesPath)})
    ? fs.readFileSync(${JSON.stringify(codexGoalQueriesPath)}, "utf8")
        .trim()
        .split("\\n")
        .filter(Boolean)
        .map((entry) => JSON.parse(entry))
    : [];
  fs.appendFileSync(${JSON.stringify(codexGoalQueriesPath)}, JSON.stringify(message.params) + "\\n");
  const attempt = priorQueries.filter((query) => query.threadId === threadId).length + 1;
  if (
    threadId === "codex-conversation-unavailable" ||
    (threadId === "codex-conversation-transient" && attempt === 1)
  ) {
    process.stdout.write(JSON.stringify({
      id: message.id,
      error: { code: -32001, message: "goal state is temporarily unavailable" },
    }) + "\\n");
    return;
  }
  const goal = threadId === "codex-conversation-active"
    ? { threadId, objective: "keep working", status: "active" }
    : threadId === "codex-conversation-blocked"
      ? { threadId, objective: "needs user input", status: "blocked" }
      : null;
  process.stdout.write(JSON.stringify({ id: message.id, result: { goal } }) + "\\n");
});
`,
    { mode: 0o700 },
  );
  await chmod(fakeCodex, 0o700);
  const publishedCodexHook = path.join(root, "managed-codex-notify.sh");
  const codexHookSource = await readFile(hook, "utf8");
  const renderedCodexHook = codexHookSource.replace(
    '"__DURE_HMUX_RUNTIME_EXECUTABLE__"',
    JSON.stringify(fakeHmuxRuntime),
  );
  if (renderedCodexHook.includes("__DURE_HMUX_RUNTIME_EXECUTABLE__")) {
    throw new Error("Codex hook runtime path was not rendered");
  }
  await writeFile(publishedCodexHook, renderedCodexHook, { mode: 0o700 });
  await chmod(publishedCodexHook, 0o700);
  const publishedRemoteClaudeHook = path.join(root, "remote-claude-hook.py");
  await writeFile(publishedRemoteClaudeHook, renderedCodexHook, { mode: 0o700 });
  await chmod(publishedRemoteClaudeHook, 0o700);

  const codexReports = async () =>
    (await readFile(codexReportsPath, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  const hookEnvironment = {
    PATH: `${root}${path.delimiter}${process.env.PATH}`,
    HOME: root,
    DURE_HOME: root,
    HMUX: "1",
    HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
    HMUX_SESSION_ID: "managed-session-1",
    HMUX_WORKSPACE_ID: "workspace-1",
    HMUX_RUNNER_PRINCIPAL: "local-user",
    HMUX_RUNNER_INSTANCE: "runner-1",
    HMUX_CHANNEL_EPOCH: "7",
    HMUX_HOST_INSTANCE_ID: "host-1",
    HMUX_TERMINAL_EPOCH: "terminal-1",
  };
  const direct = await runChild(
    "python3",
    [hook, "claude", "--managed-direct", "--terminal-events"],
    {
      env: hookEnvironment,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "claude-conversation-1",
        prompt: "Continue the production readiness review",
      }),
      timeoutMs: 5_000,
    },
  );
  if (direct.code !== 0) throw new Error(direct.stderr || `hook exited ${direct.code}`);
  if (direct.stdout.length !== 0) throw new Error("managed hook wrote stdout");

  const report = requests.live.find((request) => request.path === "/hooks/claude");
  if (!report) throw new Error("live channel did not receive the Claude Host report");
  if (report.authorization !== "Bearer live-report-token") {
    throw new Error("live channel report used the wrong scoped token");
  }
  if (JSON.parse(report.body).session_id !== "claude-conversation-1") {
    throw new Error("Claude native body was not preserved");
  }
  for (const [header, expected] of Object.entries({
    "x-hebbian-hmux-session-id": "managed-session-1",
    "x-hebbian-hmux-workspace-id": "workspace-1",
    "x-hebbian-hmux-runner-principal": "local-user",
    "x-hebbian-hmux-runner-instance": "runner-1",
    "x-hebbian-hmux-channel-epoch": "7",
    "x-hebbian-hmux-host-instance-id": "host-1",
    "x-hebbian-hmux-terminal-epoch": "terminal-1",
  })) {
    if (report.headers[header] !== expected) {
      throw new Error(`missing exact Host fence header ${header}`);
    }
  }
  if (requests.stale.some((request) => request.path === "/hooks/claude")) {
    throw new Error("stale-token channel was treated as durable Host ingress");
  }
  if (requests.unsafe.length !== 0) {
    throw new Error("non-owner-only descriptor was probed");
  }

  const oversizedStop = await runChild(
    "python3",
    [hook, "claude", "--managed-direct", "--terminal-events"],
    {
      env: hookEnvironment,
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "claude-conversation-oversized",
        prompt_id: "claude-turn-oversized",
        background_tasks: [],
        session_crons: [],
        debug_payload: "x".repeat(70_000),
      }),
      timeoutMs: 5_000,
    },
  );
  if (oversizedStop.code !== 0 || oversizedStop.stdout.length !== 0) {
    throw new Error(oversizedStop.stderr || "oversized Claude Stop hook failed");
  }
  const oversizedStopReport = requests.live
    .filter((request) => request.path === "/hooks/claude")
    .map((request) => JSON.parse(request.body))
    .find((body) => body.session_id === "claude-conversation-oversized");
  if (
    oversizedStopReport?.prompt_id !== "claude-turn-oversized" ||
    !Array.isArray(oversizedStopReport.background_tasks) || oversizedStopReport.background_tasks.length !== 0 ||
    !Array.isArray(oversizedStopReport.session_crons) || oversizedStopReport.session_crons.length !== 0 ||
    "debug_payload" in oversizedStopReport
  ) {
    throw new Error("slimmed Claude Stop lost its stable completion identity");
  }

  const directClaudeCases = [
    [
      { hook_event_name: "SessionStart", source: "startup" },
      "waiting",
      "none",
      false,
      undefined,
    ],
    [
      { hook_event_name: "SessionStart", source: "resume" },
      "waiting",
      "none",
      false,
      undefined,
    ],
    [{ hook_event_name: "UserPromptSubmit", prompt: "first turn" }, "working", "none", false, "86400000"],
    [{ hook_event_name: "PreToolUse", tool_name: "Read" }, "working", "none", false, "86400000"],
    [
      { hook_event_name: "Notification", notification_type: "permission_prompt" },
      "waiting",
      "approval_required",
      false,
      undefined,
    ],
    [{ hook_event_name: "Stop", prompt_id: "claude-turn-1", background_tasks: [], session_crons: [] }, "waiting", "none", true, undefined],
  ];
  const reportOffset = (await codexReports()).length;
  const localClaudeReportCount = requests.live.filter(
    (request) => request.path === "/hooks/claude",
  ).length;
  const claudeTranscript = path.join(root, "claude-conversation-direct.jsonl");
  for (const [native] of directClaudeCases) {
    if (native.hook_event_name === "UserPromptSubmit") {
      await writeFile(claudeTranscript, "{}\n", { mode: 0o600, flag: "wx" });
    }
    const result = await runChild(
      publishedRemoteClaudeHook,
      ["claude", "--managed-direct", "--terminal-events"],
      {
        env: hookEnvironment,
        input: JSON.stringify({
          ...native,
          session_id: "claude-conversation-direct",
          transcript_path: claudeTranscript,
        }),
        timeoutMs: 5_000,
      },
    );
    if (result.code !== 0 || result.stdout.length !== 0) {
      throw new Error(result.stderr || "remote Claude direct hook failed");
    }
  }
  const directClaudeReports = (await codexReports()).slice(reportOffset);
  if (directClaudeReports.length !== directClaudeCases.length) {
    throw new Error("remote Claude lifecycle did not reach direct Hmux ingress exactly once");
  }
  for (const [index, [, activity, attention, completed, ttl]] of directClaudeCases.entries()) {
    const request = directClaudeReports[index];
    const expectedIdentity = index < 2
      ? undefined
      : { provider_id: "claude", conversation_id: "claude-conversation-direct" };
    if (
      request.report?.activity !== activity ||
      request.report?.attention !== attention ||
      request.report?.turn_completed !== completed ||
      request.report?.working_ttl_ms !== ttl ||
      request.schema !== "hmux-managed-agent-state-report-v1" ||
      request.schemaVersion !== 1 ||
      request.report?.request_id !== "claude-conversation-direct" ||
      request.report?.identity_only !== false ||
      JSON.stringify(request.report?.conversation_identity) !== JSON.stringify(expectedIdentity) ||
      request.expectedFence?.session_id !== "managed-session-1" ||
      request.expectedFence?.workspace_id !== "workspace-1" ||
      request.expectedFence?.runner_principal !== "local-user" ||
      request.expectedFence?.runner_instance !== "runner-1" ||
      request.expectedFence?.channel_epoch !== "7" ||
      request.expectedFence?.host_instance_id !== "host-1" ||
      request.expectedFence?.terminal_epoch !== "terminal-1"
    ) {
      throw new Error(`remote Claude direct lifecycle projection ${index} was invalid`);
    }
  }
  if (directClaudeReports.at(-1)?.report?.turn_completion_id !== "claude-turn-1") {
    throw new Error("remote Claude Stop lost its stable completion identity");
  }
  if (
    requests.live.filter((request) => request.path === "/hooks/claude").length !==
    localClaudeReportCount
  ) {
    throw new Error("remote Claude direct mode called the desktop HTTP channel");
  }

  const secondHostOffset = (await codexReports()).length;
  const secondHostPreTool = await runChild(
    publishedRemoteClaudeHook,
    ["claude", "--managed-direct", "--terminal-events"],
    {
      env: { ...hookEnvironment, HMUX_SESSION_ID: "managed-session-2" },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "claude-conversation-direct",
        transcript_path: claudeTranscript,
        tool_name: "Read",
      }),
      timeoutMs: 5_000,
    },
  );
  if (secondHostPreTool.code !== 0 || secondHostPreTool.stdout.length !== 0) {
    throw new Error(secondHostPreTool.stderr || "second Host Claude PreToolUse hook failed");
  }
  const secondHostReports = (await codexReports()).slice(secondHostOffset);
  if (
    secondHostReports.length !== 1 ||
    secondHostReports[0].expectedFence?.session_id !== "managed-session-2" ||
    secondHostReports[0].report?.conversation_identity?.conversation_id !==
      "claude-conversation-direct"
  ) {
    throw new Error("Claude PreToolUse coalescing leaked across Host sessions");
  }

  const codexSessionStart = await runChild(publishedCodexHook, [], {
    env: hookEnvironment,
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "codex-conversation-ready",
      cwd: root,
      model: "gpt-5.6",
      permission_mode: "never",
      source: "startup",
    }),
    timeoutMs: 5_000,
  });
  if (codexSessionStart.code !== 0) {
    throw new Error(
      codexSessionStart.stderr || `Codex SessionStart hook exited ${codexSessionStart.code}`,
    );
  }
  const sessionStartReport = (await codexReports()).find(
    (request) => request.report?.request_id === "codex-conversation-ready",
  );
  if (
    sessionStartReport?.report.activity !== "waiting" ||
    sessionStartReport.report.attention !== "none" ||
    sessionStartReport.report.identity_only !== false ||
    sessionStartReport.report.turn_completed !== false ||
    sessionStartReport.report.conversation_identity?.provider_id !== "codex" ||
    sessionStartReport.report.conversation_identity?.conversation_id !==
      "codex-conversation-ready"
  ) {
    throw new Error("Codex SessionStart did not establish provider-ready Host authority");
  }

  const codexStart = await runChild(publishedCodexHook, [], {
    env: hookEnvironment,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-conversation-1",
      turn_id: "codex-turn-2",
      prompt: "Continue immediately after the preceding goal turn",
    }),
    timeoutMs: 5_000,
  });
  if (codexStart.code !== 0) {
    throw new Error(codexStart.stderr || `Codex start hook exited ${codexStart.code}`);
  }
  const startReport = (await codexReports()).find(
    (request) => request.report?.request_id === "codex-turn-2",
  );
  if (!startReport) throw new Error("Hmux runtime did not receive the Codex start report");
  const startBody = startReport.report.conversation_identity;
  if (
    startBody.conversation_id !== "codex-conversation-1" ||
    startReport.report.request_id !== "codex-turn-2" ||
    startReport.report.working_ttl_ms !== "86400000"
  ) {
    throw new Error("Codex start was not reduced to its stable lifecycle identity");
  }

  const codexStop = await runChild(publishedCodexHook, [], {
    env: hookEnvironment,
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "codex-conversation-stop",
      turn_id: "codex-turn-stop",
      last_assistant_message: "done",
    }),
    timeoutMs: 5_000,
  });
  if (codexStop.code !== 0) {
    throw new Error(codexStop.stderr || `Codex Stop hook exited ${codexStop.code}`);
  }
  const stopReport = (await codexReports()).find(
    (request) => request.report?.turn_completion_id === "codex-turn-stop",
  );
  if (stopReport) {
    throw new Error("a retained Codex Stop hook duplicated the notify completion path");
  }

  const chainedPayload = path.join(root, "codex-user-notify.json");
  const userNotify = path.join(root, "codex-user-notify.sh");
  await writeFile(
    userNotify,
    `#!/bin/sh\nprintf '%s' "$1" > "${chainedPayload}"\n`,
    { mode: 0o700 },
  );
  await chmod(userNotify, 0o700);
  const activeGoalPayload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "codex-conversation-active",
    "turn-id": "codex-turn-active",
    "last-assistant-message": "continuing",
  });
  const codexActiveGoalBoundary = await runChild(
    publishedCodexHook,
    [userNotify, activeGoalPayload],
    { env: hookEnvironment, input: "", timeoutMs: 5_000 },
  );
  if (codexActiveGoalBoundary.code !== 0) {
    throw new Error(
      codexActiveGoalBoundary.stderr ||
        `Codex active-goal hook exited ${codexActiveGoalBoundary.code}`,
    );
  }
  const activeGoalReport = (await codexReports()).find(
    (request) => request.report?.request_id === "codex-turn-active",
  );
  if (
    !activeGoalReport ||
    activeGoalReport.report.activity !== "working" ||
    activeGoalReport.report.turn_completed !== false ||
    "turn_completion_id" in activeGoalReport.report
  ) {
    throw new Error("an active Codex goal was projected as a completed user task");
  }
  if (
    activeGoalReport.report.conversation_identity?.conversation_id !==
    "codex-conversation-active"
  ) {
    throw new Error("the active Codex goal report lost its conversation identity");
  }
  if ((await readFile(chainedPayload, "utf8")) !== activeGoalPayload) {
    throw new Error("active-goal filtering changed the existing user notify payload");
  }
  const blockedGoalPayload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "codex-conversation-blocked",
    "turn-id": "codex-turn-blocked",
    "last-assistant-message": "blocked",
  });
  const codexBlockedGoalBoundary = await runChild(
    publishedCodexHook,
    [userNotify, blockedGoalPayload],
    { env: hookEnvironment, input: "", timeoutMs: 5_000 },
  );
  if (codexBlockedGoalBoundary.code !== 0) {
    throw new Error(
      codexBlockedGoalBoundary.stderr ||
        `Codex blocked-goal hook exited ${codexBlockedGoalBoundary.code}`,
    );
  }
  const blockedGoalReport = (await codexReports()).find(
    (request) => request.report?.request_id === "codex-turn-blocked",
  );
  if (
    !blockedGoalReport ||
    blockedGoalReport.report.activity !== "waiting" ||
    blockedGoalReport.report.attention !== "input_required" ||
    blockedGoalReport.report.turn_completed !== false ||
    blockedGoalReport.report.conversation_identity?.conversation_id !==
      "codex-conversation-blocked" ||
    "turn_completion_id" in blockedGoalReport.report
  ) {
    throw new Error("a blocked Codex goal was projected as completed instead of input-required");
  }
  const completionPayload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "codex-conversation-complete",
    "turn-id": "codex-turn-1",
    "last-assistant-message": "done",
  });
  const codexCompletion = await runChild(
    publishedCodexHook,
    [userNotify, completionPayload],
    { env: hookEnvironment, input: "", timeoutMs: 5_000 },
  );
  if (codexCompletion.code !== 0) {
    throw new Error(
      codexCompletion.stderr || `Codex completion hook exited ${codexCompletion.code}`,
    );
  }
  const completionReport = (await codexReports()).find(
    (request) => request.report?.turn_completion_id === "codex-turn-1",
  );
  if (!completionReport) {
    throw new Error("Hmux runtime did not receive the Codex completion report");
  }
  const completionBody = completionReport.report;
  if (
    completionBody.activity !== "waiting" ||
    completionBody.turn_completed !== true ||
    completionBody.conversation_identity?.conversation_id !== "codex-conversation-complete"
  ) {
    throw new Error("Codex completion was not reduced to its stable turn identity");
  }
  if ((await readFile(chainedPayload, "utf8")) !== completionPayload) {
    throw new Error("the existing user Codex notify command was not chained exactly");
  }
  const transientPayload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "codex-conversation-transient",
    "turn-id": "codex-turn-transient",
    "last-assistant-message": "done after a transient goal read failure",
  });
  const transientCompletion = await runChild(
    publishedCodexHook,
    [userNotify, transientPayload],
    { env: hookEnvironment, input: "", timeoutMs: 5_000 },
  );
  if (transientCompletion.code !== 0) {
    throw new Error(
      transientCompletion.stderr ||
        `Codex transient completion hook exited ${transientCompletion.code}`,
    );
  }
  const transientReport = (await codexReports()).find(
    (request) => request.report?.request_id === "codex-turn-transient",
  );
  if (
    transientReport?.report.activity !== "waiting" ||
    transientReport.report.turn_completed !== true ||
    transientReport.report.turn_completion_id !== "codex-turn-transient" ||
    transientReport.report.conversation_identity?.conversation_id !==
      "codex-conversation-transient"
  ) {
    throw new Error("a transient Codex goal read stranded a completed pane in working state");
  }
  const unavailablePayload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "codex-conversation-unavailable",
    "turn-id": "codex-turn-unavailable",
    "last-assistant-message": "turn ended while goal state was unavailable",
  });
  const unavailableCompletion = await runChild(
    publishedCodexHook,
    [userNotify, unavailablePayload],
    { env: hookEnvironment, input: "", timeoutMs: 5_000 },
  );
  if (unavailableCompletion.code !== 0) {
    throw new Error(
      unavailableCompletion.stderr ||
        `Codex unavailable-goal hook exited ${unavailableCompletion.code}`,
    );
  }
  const unavailableReport = (await codexReports()).find(
    (request) => request.report?.request_id === "codex-turn-unavailable",
  );
  if (
    unavailableReport?.report.activity !== "waiting" ||
    unavailableReport.report.turn_completed !== false ||
    unavailableReport.report.conversation_identity?.conversation_id !==
      "codex-conversation-unavailable" ||
    "turn_completion_id" in unavailableReport.report
  ) {
    throw new Error(
      "an unavailable Codex goal read either stranded working state or invented task completion",
    );
  }
  const descendantEnvironment = {
    ...hookEnvironment,
    HMUX_SESSION_ID: "managed-session-descendant",
  };
  const parentStart = await runChild(publishedCodexHook, [], {
    env: descendantEnvironment,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-conversation-parent",
      turn_id: "codex-turn-parent-start",
      prompt: "Continue the parent task while delegated work runs",
    }),
    timeoutMs: 5_000,
  });
  if (parentStart.code !== 0) {
    throw new Error(parentStart.stderr || `Codex parent start hook exited ${parentStart.code}`);
  }
  const descendantPayload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "codex-conversation-child",
    "turn-id": "codex-turn-child",
    "last-assistant-message": "delegated work finished",
  });
  const descendantCompletion = await runChild(
    publishedCodexHook,
    [userNotify, descendantPayload],
    { env: descendantEnvironment, input: "", timeoutMs: 5_000 },
  );
  if (descendantCompletion.code !== 0) {
    throw new Error(
      descendantCompletion.stderr ||
        `Codex descendant completion hook exited ${descendantCompletion.code}`,
    );
  }
  const descendantState = JSON.parse(await readFile(codexDescendantStatePath, "utf8"));
  if (
    descendantState.conversationId !== "codex-conversation-parent" ||
    descendantState.activity !== "working" ||
    descendantState.turnCompletedCount !== 0
  ) {
    throw new Error("a descendant Codex completion mutated its working parent Host session");
  }
  const reportsAfterDescendant = await codexReports();
  const parentStartReport = reportsAfterDescendant.find(
    (request) => request.report?.request_id === "codex-turn-parent-start",
  );
  const descendantReport = reportsAfterDescendant.find(
    (request) => request.report?.request_id === "codex-turn-child",
  );
  if (
    !parentStartReport ||
    descendantReport?.report.conversation_identity?.conversation_id !==
      "codex-conversation-child"
  ) {
    throw new Error("a descendant Codex completion escaped the canonical identity fence");
  }
  if ((await readFile(chainedPayload, "utf8")) !== unavailablePayload) {
    throw new Error("a rejected descendant completion reached the user notify command");
  }
  const unsupportedPayload = JSON.stringify({ type: "future-notification", opaque: "value" });
  const unsupportedNotification = await runChild(
    publishedCodexHook,
    [userNotify, unsupportedPayload],
    {
      env: hookEnvironment,
      // Keep stdin open: argv-based notify dispatch must never wait on the
      // provider's interactive input stream, even for a future event type.
      input: undefined,
      timeoutMs: 5_000,
    },
  );
  if (unsupportedNotification.code !== 0) {
    throw new Error("an unsupported managed event blocked the existing user notify command");
  }
  if ((await readFile(chainedPayload, "utf8")) !== unsupportedPayload) {
    throw new Error("an unsupported managed event changed the existing user notify payload");
  }
  const codexLifecycleReports = (await codexReports()).filter(
    (request) => request.report?.conversation_identity?.provider_id === "codex",
  );
  if (codexLifecycleReports.length !== 9) {
    throw new Error("an unsupported Codex notification reached managed lifecycle ingress");
  }
  const goalQueries = (await readFile(codexGoalQueriesPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (
    goalQueries.filter((query) => query.threadId === "codex-conversation-active").length !== 1 ||
    goalQueries.filter((query) => query.threadId === "codex-conversation-blocked").length !== 1 ||
    goalQueries.some((query) => query.threadId === "codex-conversation-stop") ||
    goalQueries.filter((query) => query.threadId === "codex-conversation-complete").length !== 1 ||
    goalQueries.filter((query) => query.threadId === "codex-conversation-transient").length !== 2 ||
    goalQueries.filter((query) => query.threadId === "codex-conversation-unavailable").length !== 3 ||
    goalQueries.filter((query) => query.threadId === "codex-conversation-child").length !== 1
  ) {
    throw new Error("Codex completion did not consult the exact provider goal authority");
  }
  for (const report of [
    sessionStartReport,
    startReport,
    activeGoalReport,
    blockedGoalReport,
    completionReport,
    transientReport,
    unavailableReport,
  ]) {
    for (const [field, expected] of Object.entries({
      session_id: "managed-session-1",
      workspace_id: "workspace-1",
      runner_principal: "local-user",
      runner_instance: "runner-1",
      channel_epoch: "7",
      host_instance_id: "host-1",
      terminal_epoch: "terminal-1",
    })) {
      if (report.expectedFence[field] !== expected) {
        throw new Error(`Codex lifecycle report missed exact Host fence field ${field}`);
      }
    }
  }
  for (const report of [parentStartReport, descendantReport]) {
    for (const [field, expected] of Object.entries({
      session_id: "managed-session-descendant",
      workspace_id: "workspace-1",
      runner_principal: "local-user",
      runner_instance: "runner-1",
      channel_epoch: "7",
      host_instance_id: "host-1",
      terminal_epoch: "terminal-1",
    })) {
      if (report.expectedFence[field] !== expected) {
        throw new Error(`descendant report missed exact Host fence field ${field}`);
      }
    }
  }

  const settingsPath = path.join(root, "managed-claude-smoke-settings.json");
  const commandHook = {
    type: "command",
    command: publishedHook,
    args: ["claude", "--managed-direct", "--terminal-events"],
    timeout: 3,
  };
  await writeFile(
    settingsPath,
    `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [commandHook] }] } })}\n`,
    { mode: 0o600 },
  );
  const debugPath = path.join(root, "claude-hook-debug.log");
  const claudeResult = await runChild(
    claude,
    [
      "--settings",
      settingsPath,
      "--debug",
      "hooks",
      "--debug-file",
      debugPath,
      "--init-only",
    ],
    {
      cwd: root,
      env: hookEnvironment,
      input: "",
      timeoutMs: 30_000,
    },
  );
  if (claudeResult.code !== 0) {
    throw new Error(
      `real Claude hook probe failed (${claudeResult.code}): ${
        claudeResult.stderr || claudeResult.stdout
      }`,
    );
  }
  const sessionStart = requests.live.find((request) => {
    if (request.path !== "/hooks/claude") return false;
    try {
      return JSON.parse(request.body).hook_event_name === "SessionStart";
    } catch {
      return false;
    }
  });
  if (!sessionStart) {
    const debug = await readFile(debugPath, "utf8")
      .then((contents) => contents.slice(-4_000))
      .catch(() => "debug log unavailable");
    throw new Error(`real Claude did not execute the channel handoff hook\n${debug}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      staleProbes: requests.stale.length,
      liveReports: requests.live.filter((request) => request.path === "/hooks/claude").length,
      codexLifecycleReports: codexLifecycleReports.length,
      remoteClaudeLifecycleReports: directClaudeReports.length,
      realClaudeSessionStart: true,
    })}\n`,
  );
} finally {
  for (const server of [staleServer, unsafeServer, liveServer]) {
    if (!server) continue;
    server.close();
    server.closeAllConnections();
  }
  await rm(root, { recursive: true, force: true });
}
