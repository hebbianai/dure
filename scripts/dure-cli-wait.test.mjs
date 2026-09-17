import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { collectWait, parseWaitArguments, runWaitCommand } from "../cli/lib/wait-command.mjs";
import { projectSession } from "../cli/lib/session-runtime-projection.mjs";
import { collectSessionQuery } from "../cli/lib/session-query.mjs";
import { collectAgentSpawnQuery } from "../cli/lib/agent-spawn-query.mjs";
import { readDelegatedWorkflow } from "../cli/lib/workflow-completion.mjs";
import { receipt, succeededNativeReceipt } from "./fixtures/agent-spawn-receipts.mjs";
import { hmuxSession, hostGeneration, installHmuxStub, installRemoteBackendFixture, writeRegistry } from "./lib/dure-session-test-fixture.mjs";

const roots = [];
const cli = path.resolve(import.meta.dirname, "../cli/dure.mjs");
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ count = "1", status = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-wait-"));
  roots.push(root);
  const session = hmuxSession(1, {
    agentRuntimeState: {
      terminal_epoch: "terminal-1", revision: "2", observed_through_output_seq: "12",
      lifecycle: "running", activity: "waiting", attention: "none", attention_id: null,
      source: "provider_event", turn_completed_count: count,
    },
  });
  const hmux = installHmuxStub(root, session, { status });
  writeRegistry(root, [{
    id: "agent-1", name: "worker", sessionId: "session-1", provider: "codex", kind: "pty",
    runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", ...hostGeneration() },
  }]);
  return {
    root, session,
    run: (...args) => spawnSync(process.execPath, [cli, "wait", ...args], {
      encoding: "utf8", timeout: 10000,
      env: { PATH: process.env.PATH, HOME: root, DURE_HOME: root, DURE_APP_CHANNEL: "stable", DURE_HMUX_BIN: hmux, HMUX_DISCOVERY_ROOT: path.join(root, "discovery") },
    }),
  };
}

test("a failed runtime observation is unknown, never successful session completion", () => {
  const { run } = fixture({ status: 2 });
  const result = run("worker", "--timeout", "1", "--json");
  expect(result.status, result.stdout + result.stderr).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ apiVersion: "dure.wait/v1", state: "unknown" });
});

function snapshot({ count = "0", revision = "1", runtime = {}, session = {} } = {}) {
  return { session: projectSession(hmuxSession(1, {
    agentRuntimeState: {
      terminal_epoch: "terminal-1", revision, observed_through_output_seq: "12",
      lifecycle: "running", activity: "working", attention: "none", attention_id: null,
      source: "provider_event", turn_completed_count: count, ...runtime,
    }, ...session,
  }), 1000) };
}

function sequence(reports) {
  let index = 0;
  return vi.fn(async () => reports[Math.min(index++, reports.length - 1)]);
}

function observe(reports, { args = ["session-1", "--workspace", "workspace-1"], ...adapters } = {}) {
  let elapsed = 0;
  const querySession = sequence(reports);
  const options = parseWaitArguments([...args, "--timeout", "2"]);
  return {
    querySession,
    result: collectWait(options, { querySession, now: () => elapsed,
      pause: async (ms) => { elapsed += ms; }, ...adapters }),
  };
}

test("unchanged output and waiting activity cannot replace a completion event", async () => {
  const { result, querySession } = observe([snapshot({ runtime: { activity: "waiting" } })]);
  expect(await result).toMatchObject({ state: "unknown", exitCode: 124, error: { code: "wait_timeout" } });
  expect(querySession).toHaveBeenCalledTimes(4);
});

test("ignores an older revision and completes only the pinned next counter", async () => {
  const { result, querySession } = observe([
    snapshot({ revision: "10", count: "4" }),
    snapshot({ revision: "9", count: "99" }),
    snapshot({ revision: "10", count: "4" }),
    snapshot({ revision: "11", count: "5" }),
  ]);
  expect(await result).toMatchObject({ state: "completed", target: { afterTurn: "4" }, observation: { revision: "11", turnCompletedCount: "5" } });
  expect(querySession).toHaveBeenCalledTimes(4);
});

test("duplicate completion snapshots do not count as a new response", async () => {
  const { result } = observe([snapshot({ count: "1" })]);
  expect(await result).toMatchObject({ state: "unknown", target: { afterTurn: "1" }, exitCode: 124 });
});

test("a replacement generation cannot complete the original response", async () => {
  const { result } = observe([snapshot(), snapshot({ count: "1", session: { host_instance_id: "host-2" } })]);
  expect(await result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_generation_changed" }, target: { generation: { hostInstanceId: "host-1" } } });
});

test("counter comparisons preserve values above JavaScript's safe integer range", async () => {
  const { result } = observe([snapshot({ count: "9007199254740993" }), snapshot({ count: "9007199254740994", revision: "2" })]);
  expect(await result).toMatchObject({ state: "completed", target: { afterTurn: "9007199254740993" } });
});

test("lost observation preserves the response cursor so a later invocation can resume", async () => {
  const first = await observe([snapshot({ count: "4" }), { error: { code: "hmux_session_query_unavailable" } }]).result;
  expect(first).toMatchObject({ state: "unknown", exitCode: 2, target: { afterTurn: "4", terminalEpoch: "terminal-1" } });
  const second = await observe([snapshot({ count: "5" })], {
    args: [first.target.sessionId, "--workspace", first.target.workspaceId, "--after-turn", first.target.afterTurn, "--terminal-epoch", first.target.terminalEpoch],
  }).result;
  expect(second).toMatchObject({ state: "completed", exitCode: 0 });
});

test.each([
  [snapshot({ runtime: { lifecycle: "exited" }, session: { health: "exited" } }), "unknown", "wait_response_exited"],
  [snapshot({ runtime: { attention: "approval_required" } }), "unknown", "wait_response_attention_required"],
  [snapshot({ session: { health: "unprobed" } }), "unknown", "wait_response_unavailable"],
])("does not turn exit, attention or missing observation into success", async (report, state, code) => {
  expect(await observe([report]).result).toMatchObject({ state, error: { code } });
});

test("interrupting the observer does not submit control operations", async () => {
  const abort = new AbortController();
  const { result, querySession } = observe([snapshot()], { signal: abort.signal, pause: async () => abort.abort() });
  expect(await result).toMatchObject({ state: "unknown", exitCode: 130 });
  expect(querySession).toHaveBeenCalledTimes(1);
  expect(querySession.mock.calls[0][0]).toMatchObject({ action: "show", sessionId: "session-1", workspaceId: "workspace-1" });
});

test("resolves a name once even if the registry changes during observation", async () => {
  const registry = { state: "available", agents: [{ name: "worker", runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", ...hostGeneration() } }] };
  const querySession = sequence([snapshot(), snapshot({ count: "1", revision: "2" })]);
  const { result } = observe([], {
    args: ["worker"], registry, querySession,
    pause: async () => { registry.agents[0].runtimeBinding.sessionId = "replacement-session"; },
  });
  expect(await result).toMatchObject({ state: "completed", target: { sessionId: "session-1" } });
  expect(querySession.mock.calls.map(([request]) => request.sessionId)).toEqual(["session-1", "session-1"]);
});

test("run waiting reuses status only and does not imply response or task completion", async () => {
  const completed = succeededNativeReceipt();
  const requestBackend = sequence([
    { result: { schemaVersion: 1, receipt: receipt() } },
    { result: { schemaVersion: 1, receipt: completed } },
  ]);
  const { result } = observe([], {
    args: ["--operation-id", completed.operationId],
    backend: { profile: { id: "fixture", transport: { kind: "local" } } },
    queryRun: (options) => collectAgentSpawnQuery({ ...options, requestBackend }),
  });
  expect(await result).toMatchObject({ state: "completed", subject: "run", observation: { state: "succeeded" } });
  expect(requestBackend.mock.calls.map(([, request]) => request.operation)).toEqual(["agent_spawn.status", "agent_spawn.status"]);
});

test.each([
  ["failed", "failed", 1], ["manual_intervention_required", "failed", 1],
  ["prompt_delivery_uncertain", "unknown", 2], ["retry_required", "unknown", 2],
])("run %s never becomes a successful wait or a new execution", async (state, outcome, exitCode) => {
  const queryRun = sequence([{ receipt: { operationId: "op-1", state, lastSequence: 1, terminalCode: "fixture_failure" } }]);
  expect(await observe([], { args: ["--operation-id", "op-1"], queryRun }).result)
    .toMatchObject({ state: outcome, exitCode });
  expect(queryRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: "status", operationId: "op-1" }));
});

test("task waiting keeps the exact dispatch generation separate from runtime idleness", async () => {
  const queryTask = sequence([{ receipt: { status: "active" } }, { receipt: { status: "completed", result: "verified" } }]);
  const { result } = observe([], { args: ["--task", "task.a", "--dispatch", "dispatch.a", "--generation", "7"], queryTask });
  expect(await result).toMatchObject({ state: "completed", subject: "task", target: { taskId: "task.a", dispatchId: "dispatch.a", generation: 7 } });
  for (const [request] of queryTask.mock.calls) expect(request).toMatchObject({ taskId: "task.a", dispatchId: "dispatch.a", generation: 7 });
});

test.each([
  ["worker", "--after-turn", "0"], ["worker", "--timeout", "nope"],
  ["--operation-id", "op-1", "--task", "task.a"], ["--task", "task.a"],
])("invalid targets fail before backend or runtime selection: %j", async (...args) => {
  const resolveContext = vi.fn();
  const output = vi.fn();
  expect(await runWaitCommand([...args, "--json"], { resolveContext, output })).toBe(2);
  expect(resolveContext).not.toHaveBeenCalled();
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ state: "unknown", error: { code: "wait_arguments_invalid" } });
});

test("exact-session response waiting needs no registry or app server", () => {
  const { run, root } = fixture();
  fs.unlinkSync(path.join(root, "agents.json"));
  const result = run("session-1", "--workspace", "workspace-1", "--after-turn", "0", "--terminal-epoch", "terminal-1", "--json");
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ state: "completed", subject: "response" });
});

test("the real SSH adapter inspects the pinned remote session without a local fallback", () => {
  const { root, session } = fixture();
  const remote = installRemoteBackendFixture(root, [session]);
  const result = spawnSync(process.execPath, [cli, "wait", "session-1", "--workspace", "workspace-1", "--backend", "remote-build", "--after-turn", "0", "--terminal-epoch", "terminal-1", "--json"], {
    encoding: "utf8", timeout: 10000,
    env: {
      PATH: `${remote.bin}${path.delimiter}${process.env.PATH}`, HOME: root,
      DURE_HOME: root, DURE_APP_CHANNEL: "stable", HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
      DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
      DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
      DURE_SESSION_REQUEST_LOG: remote.requestLog,
    },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ state: "completed", backendId: "remote-build" });
  const requests = fs.readFileSync(remote.requestLog, "utf8").trim().split("\n").map(JSON.parse);
  expect(requests).toEqual([expect.objectContaining({ operation: "sessions.show", body: { schemaVersion: 1, sessionId: "session-1", workspaceId: "workspace-1" } })]);
});

test("a transient observation timeout re-queries the same response without changing its cursor", async () => {
  const { result, querySession } = observe([snapshot(), { error: { code: "hmux_session_query_timeout" } }, snapshot({ count: "1", revision: "2" })]);
  expect(await result).toMatchObject({ state: "completed", target: { afterTurn: "0" } });
  expect(querySession).toHaveBeenCalledTimes(3);
});

test("the existing session boundary refuses a different session's completion", async () => {
  const wrong = hmuxSession(2);
  const { result } = observe([], {
    querySession: (options) => collectSessionQuery({ ...options,
      execute: async () => ({ kind: "success", stdout: JSON.stringify(wrong), stderr: "" }),
    }),
  });
  expect(await result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "dure_session_query_identity_mismatch" } });
});

test("the existing task boundary refuses an earlier dispatch generation's completion", async () => {
  const { result } = observe([], {
    args: ["--task", "task.a", "--dispatch", "dispatch.a", "--generation", "7"],
    backend: { profile: { id: "fixture", transport: { kind: "local" } } },
    queryTask: (options) => readDelegatedWorkflow({ ...options,
      requestBackend: async () => ({ result: { schemaVersion: 1, receipt: {
        schemaVersion: 1, taskId: "task.a", dispatchId: "dispatch.a", generation: 6, status: "completed",
      } } }),
    }),
  });
  expect(await result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "workflow_show_receipt_invalid" } });
});

test.each([
  ["run", ["--operation-id", succeededNativeReceipt().operationId], "agent_spawn.status", { schemaVersion: 1, receipt: succeededNativeReceipt() }],
  ["task", ["--task", "task.a", "--dispatch", "dispatch.a", "--generation", "7"], "workflow.delegate_once.show", { schemaVersion: 1, receipt: { schemaVersion: 1, taskId: "task.a", dispatchId: "dispatch.a", generation: 7, status: "completed" } }],
])("the real CLI %s wait reads the backend contract without submitting work", (subject, args, operation, payload) => {
  const { root } = fixture();
  fs.unlinkSync(path.join(root, "agents.json"));
  const remote = installRemoteBackendFixture(root, [], { capabilities: [operation], results: { [operation]: payload } });
  const result = spawnSync(process.execPath, [cli, "wait", ...args, "--backend", "remote-build", "--json"], {
    encoding: "utf8", timeout: 10000,
    env: {
      PATH: `${remote.bin}${path.delimiter}${process.env.PATH}`, HOME: root, DURE_HOME: root,
      DURE_APP_CHANNEL: "stable", HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
      DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
      DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build", DURE_SESSION_REQUEST_LOG: remote.requestLog,
    },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ subject, state: "completed" });
  const requests = fs.readFileSync(remote.requestLog, "utf8").trim().split("\n").map(JSON.parse);
  expect(requests.map(request => request.operation)).toEqual([operation]);
});

test("a truncated name projection cannot certify an unambiguous target", async () => {
  const { result, querySession } = observe([], { args: ["worker"], registry: { state: "truncated", agents: [{ name: "worker", runtimeBinding: hostGeneration() }] } });
  expect(await result).toMatchObject({ state: "unknown", exitCode: 2 });
  expect(querySession).not.toHaveBeenCalled();
});

test("a prior Host completion cursor observes a fast response without reading terminal text", () => {
  const { run } = fixture();
  const result = run("worker", "--after-turn", "0", "--terminal-epoch", "terminal-1", "--timeout", "1", "--json");
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    apiVersion: "dure.wait/v1", state: "completed", subject: "response",
    target: { sessionId: "session-1", workspaceId: "workspace-1", afterTurn: "0" },
    observation: { turnCompletedCount: "1", source: "provider_event" },
  });
});
