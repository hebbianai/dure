import { describe, expect, it, vi } from "vitest";
import {
  AGENT_SPAWN_CONVERSATION_OBSERVATION_CAPABILITY,
  AGENT_SPAWN_PARENT_AGENT_CAPABILITY,
  AGENT_SPAWN_PARENT_LINK_CAPABILITY,
  backendObservesRunConversations,
  collectAgentSpawnQuery,
  readRunConversation,
} from "../cli/lib/agent-spawn-query.mjs";
import {
  callerParent,
  callerSessionParent,
  classifyChild,
  listChildRuns,
  resolveRunParent,
} from "../cli/lib/run-parent.mjs";
import { runReceiptSummary } from "../cli/lib/run-presentation.mjs";
import { collectWait, parseWaitArguments } from "../cli/lib/wait-command.mjs";
import { projectSession } from "../cli/lib/session-runtime-projection.mjs";
import { receipt, request } from "./fixtures/agent-spawn-receipts.mjs";
import { hmuxSession } from "./lib/dure-session-test-fixture.mjs";

const prompt = "never serialize this prompt";
const PARENT = { sessionId: "session-lead", workspaceId: "workspace-lead" };
const CALLER_ENV = { HMUX_SESSION_ID: PARENT.sessionId, HMUX_WORKSPACE_ID: PARENT.workspaceId };
const PARENT_AGENT = { agentId: "agent-coordinator" };
// A Chat agent's tool shell: its structured runtime names the Agent, and the
// runtime's own managed Session may also be in the environment.
const CHAT_CALLER_ENV = {
  DURE_AGENT_ID: PARENT_AGENT.agentId,
  HMUX_SESSION_ID: "codex-chat-runtime",
  HMUX_WORKSPACE_ID: "workspace-runtime",
};
const BOTH_LINKS = [AGENT_SPAWN_PARENT_LINK_CAPABILITY, AGENT_SPAWN_PARENT_AGENT_CAPABILITY];

function backend({ kind = "local", capabilities = [AGENT_SPAWN_PARENT_LINK_CAPABILITY] } = {}) {
  return {
    profile: {
      id: kind === "local" ? "local" : "remote-a",
      transport: kind === "local"
        ? { kind: "local" }
        : { kind: "ssh", host: "dev.example.test", port: 2222, user: "dev" },
      expected: { capabilities: ["agent_spawn.preview.v2", "agent_spawn.list", ...capabilities] },
    },
    transportOptions: {},
  };
}

function registry(agents) {
  return { state: "available", agents };
}

describe("dure run records its parent", () => {
  it("records the calling agent's exact Session on the local backend", () => {
    expect(callerSessionParent(CALLER_ENV)).toEqual(PARENT);
    expect(resolveRunParent({ environment: CALLER_ENV, backend: backend() }))
      .toEqual({ parent: PARENT, source: "caller_session" });
  });

  it("records nothing outside an agent, with --no-parent, or for another backend", () => {
    expect(resolveRunParent({ environment: {}, backend: backend() }))
      .toEqual({ parent: undefined, source: "none" });
    expect(resolveRunParent({ environment: CALLER_ENV, noParent: true, backend: backend() }))
      .toEqual({ parent: undefined, source: "none" });
    // This machine's Hmux Session is not a Session on an SSH backend.
    expect(resolveRunParent({ environment: CALLER_ENV, backend: backend({ kind: "ssh" }) }))
      .toEqual({ parent: undefined, source: "none" });
  });

  it("skips the automatic link on a backend that can't record it", () => {
    expect(resolveRunParent({ environment: CALLER_ENV, backend: backend({ capabilities: [] }) }))
      .toEqual({ parent: undefined, source: "unsupported" });
  });

  it("refuses an explicit parent the backend can't record", () => {
    expect(() => resolveRunParent({
      selector: "session-x", workspaceId: "workspace-x", backend: backend({ capabilities: [] }),
    })).toThrow(expect.objectContaining({ code: "run_parent_unsupported" }));
  });

  it("resolves --parent by exact Session, Agent name or Agent ID", () => {
    const agents = [{
      id: "agent-lead", name: "lead", sessionId: PARENT.sessionId,
      runtimeBinding: { source: "local", hostId: "local", ...PARENT },
    }];
    expect(resolveRunParent({ selector: "session-x", workspaceId: "workspace-x", environment: CALLER_ENV, backend: backend() }))
      .toEqual({ parent: { sessionId: "session-x", workspaceId: "workspace-x" }, source: "explicit" });
    for (const selector of ["lead", "agent-lead", PARENT.sessionId]) {
      expect(resolveRunParent({ selector, registry: registry(agents), backend: backend() }))
        .toEqual({ parent: PARENT, source: "explicit" });
    }
    expect(() => resolveRunParent({ selector: "missing", registry: registry(agents), backend: backend() }))
      .toThrow(expect.objectContaining({ code: "run_parent_not_found" }));
    expect(() => resolveRunParent({ selector: "lead", registry: registry(agents), backend: backend({ kind: "ssh" }) }))
      .toThrow(expect.objectContaining({ code: "run_parent_backend_mismatch" }));
  });

  it("sends the parent in the spawn preview and reads it back from the Run receipt", async () => {
    const calls = [];
    const value = receipt(request({ parent: PARENT }));
    const report = await collectAgentSpawnQuery({
      action: "preview",
      ...request({ worktree: value.plan.request.worktree }),
      parent: PARENT,
      prompt,
      backend: backend({ kind: "ssh" }),
      requestBackend: async (_profile, sent) => {
        calls.push(sent);
        return { backend: { id: "remote-a-backend", generation: "g1", protocol: { major: 1, minor: 0 }, capabilities: [] }, result: { schemaVersion: 1, receipt: value } };
      },
    });
    expect(report.kind, JSON.stringify(report)).toBe("dure.agent_spawn.preview");
    expect(calls[0].body.parent).toEqual(PARENT);
    expect(calls[0].requiredCapabilities).toContain(AGENT_SPAWN_PARENT_LINK_CAPABILITY);
    expect(runReceiptSummary(report).parent).toEqual(PARENT);
  });

  it("refuses a receipt that dropped or changed the requested parent", async () => {
    for (const parent of [undefined, { sessionId: "session-other", workspaceId: PARENT.workspaceId }]) {
      const value = receipt(request(parent ? { parent } : {}));
      const report = await collectAgentSpawnQuery({
        action: "preview",
        ...request({ worktree: value.plan.request.worktree }),
        parent: PARENT,
        prompt,
        backend: backend({ kind: "ssh" }),
        requestBackend: async () => ({ backend: { id: "remote-a-backend", generation: "g1", protocol: { major: 1, minor: 0 }, capabilities: [] }, result: { schemaVersion: 1, receipt: value } }),
      });
      expect(report).toMatchObject({ kind: "dure.agent_spawn.error", error: { code: "backend_agent_spawn_identity_mismatch" } });
    }
  });
});

describe("dure run from a Chat agent records its Agent", () => {
  const chatAgent = {
    id: PARENT_AGENT.agentId, name: "coordinator", sessionId: PARENT_AGENT.agentId,
    interactionProfile: {
      schemaVersion: 1, kind: "structured_protocol", backendProfileId: "local",
      interactionSessionId: "interaction-coordinator",
    },
  };

  it("takes the caller's Agent before the runtime's own managed Session", () => {
    expect(callerParent(CHAT_CALLER_ENV)).toEqual(PARENT_AGENT);
    expect(callerParent({ DURE_AGENT_ID: PARENT_AGENT.agentId })).toEqual(PARENT_AGENT);
    expect(callerParent(CALLER_ENV)).toEqual(PARENT);
    expect(callerParent({ DURE_AGENT_ID: "has space" })).toBeNull();
    expect(resolveRunParent({ environment: CHAT_CALLER_ENV, backend: backend({ capabilities: BOTH_LINKS }) }))
      .toEqual({ parent: PARENT_AGENT, source: "caller_agent" });
  });

  it("records nothing on an older backend, for another backend, or with --no-parent", () => {
    // Without the capability the Run is started unlinked, without failing.
    expect(resolveRunParent({ environment: CHAT_CALLER_ENV, backend: backend() }))
      .toEqual({ parent: undefined, source: "unsupported" });
    expect(resolveRunParent({ environment: CHAT_CALLER_ENV, backend: backend({ kind: "ssh", capabilities: BOTH_LINKS }) }))
      .toEqual({ parent: undefined, source: "none" });
    expect(resolveRunParent({ environment: CHAT_CALLER_ENV, noParent: true, backend: backend({ capabilities: BOTH_LINKS }) }))
      .toEqual({ parent: undefined, source: "none" });
  });

  it("resolves --parent naming a Chat agent to its Agent ID", () => {
    for (const selector of ["coordinator", PARENT_AGENT.agentId]) {
      expect(resolveRunParent({
        selector, registry: registry([chatAgent]), backend: backend({ capabilities: BOTH_LINKS }),
      })).toEqual({ parent: PARENT_AGENT, source: "explicit" });
    }
    expect(() => resolveRunParent({ selector: "coordinator", registry: registry([chatAgent]), backend: backend() }))
      .toThrow(expect.objectContaining({ code: "run_parent_unsupported" }));
    expect(() => resolveRunParent({
      selector: "coordinator", registry: registry([chatAgent]), backend: backend({ kind: "ssh", capabilities: BOTH_LINKS }),
    })).toThrow(expect.objectContaining({ code: "run_parent_backend_mismatch" }));
    const plain = { id: "agent-plain", name: "plain", sessionId: "agent-plain" };
    expect(() => resolveRunParent({ selector: "plain", registry: registry([plain]), backend: backend({ capabilities: BOTH_LINKS }) }))
      .toThrow(expect.objectContaining({ code: "run_parent_not_found" }));
  });

  it("sends the Agent as parentAgent and reads it back from the Run receipt", async () => {
    const calls = [];
    const value = receipt(request({ parentAgent: PARENT_AGENT }));
    const report = await collectAgentSpawnQuery({
      action: "preview",
      ...request({ worktree: value.plan.request.worktree }),
      parent: PARENT_AGENT,
      prompt,
      backend: backend({ capabilities: BOTH_LINKS }),
      requestBackend: async (_profile, sent) => {
        calls.push(sent);
        return { backend: { id: "local-backend", generation: "g1", protocol: { major: 1, minor: 0 }, capabilities: [] }, result: { schemaVersion: 1, receipt: value } };
      },
    });
    expect(report.kind, JSON.stringify(report)).toBe("dure.agent_spawn.preview");
    expect(calls[0].body.parentAgent).toEqual(PARENT_AGENT);
    expect("parent" in calls[0].body).toBe(false);
    expect(calls[0].requiredCapabilities).toContain(AGENT_SPAWN_PARENT_AGENT_CAPABILITY);
    expect(calls[0].requiredCapabilities).not.toContain(AGENT_SPAWN_PARENT_LINK_CAPABILITY);
    expect(runReceiptSummary(report)).toMatchObject({ parent: null, parentAgent: PARENT_AGENT });
  });

  it("refuses a receipt that dropped the requested parent Agent", async () => {
    const value = receipt(request({}));
    const report = await collectAgentSpawnQuery({
      action: "preview",
      ...request({ worktree: value.plan.request.worktree }),
      parent: PARENT_AGENT,
      prompt,
      backend: backend({ capabilities: BOTH_LINKS }),
      requestBackend: async () => ({ backend: { id: "local-backend", generation: "g1", protocol: { major: 1, minor: 0 }, capabilities: [] }, result: { schemaVersion: 1, receipt: value } }),
    });
    expect(report).toMatchObject({ kind: "dure.agent_spawn.error", error: { code: "backend_agent_spawn_identity_mismatch" } });
  });

  it("lists the Runs a Chat agent started as its children", async () => {
    const runs = [
      run("a", { parent: undefined, parentAgent: PARENT_AGENT }),
      run("b", { parent: undefined, parentAgent: { agentId: "agent-other" } }),
      run("c"),
    ];
    const listRuns = vi.fn(async () => ({ page: { schemaVersion: 1, runs, nextCursor: null } }));
    const listed = await listChildRuns({ parent: PARENT_AGENT, backend: backend(), listRuns });
    expect(listed.children.map((child) => child.name)).toEqual(["a"]);
    const bySession = await listChildRuns({ parent: PARENT, backend: backend(), listRuns });
    expect(bySession.children.map((child) => child.name)).toEqual(["c"]);
  });

  it("waits on a Chat agent's own children from its tool shell", async () => {
    const runs = [run("a", { parent: undefined, parentAgent: PARENT_AGENT, sessionId: undefined })];
    const listRuns = vi.fn(async () => ({ page: { schemaVersion: 1, runs, nextCursor: null } }));
    const report = await collectWait(parseWaitArguments(["--children", "all", "--timeout", "5"]), {
      backend: backend(), sessionBackend: null, environment: CHAT_CALLER_ENV, listRuns,
      querySession: vi.fn(), now: () => 0, pause: async () => {},
    });
    // The link is found; observing a chat child's turns is a later step.
    expect(report).toMatchObject({
      target: { parent: PARENT_AGENT },
      state: "unknown", exitCode: 2, error: { code: "wait_children_unobservable" },
    });
  });
});

function run(name, overrides = {}) {
  return {
    agentId: `agent-${name}`, operationId: `spawn-${name}`, name, providerId: "claude",
    workspaceId: `workspace-${name}`, projectId: "dure", launchState: "succeeded",
    createdAtMs: 1, updatedAtMs: 1, sessionId: `session-${name}`, parent: PARENT, ...overrides,
  };
}

function session(runtime = {}, overrides = {}) {
  return {
    session: projectSession(hmuxSession(1, {
      agentRuntimeState: {
        terminal_epoch: "terminal-1", revision: "1", observed_through_output_seq: "12",
        lifecycle: "running", activity: "working", attention: "none", attention_id: null,
        source: "provider_event", turn_completed_count: "0", ...runtime,
      },
      ...overrides,
    }), 1000),
  };
}

describe("children of a parent", () => {
  it("lists only Runs whose recorded parent is exactly this Session, across pages", async () => {
    const pages = [
      { runs: [run("a"), run("b", { parent: { ...PARENT, workspaceId: "workspace-other" } })], nextCursor: "spawn-b" },
      { runs: [run("c"), run("d", { parent: undefined })], nextCursor: null },
    ];
    const listRuns = vi.fn(async ({ cursor }) => ({ page: { schemaVersion: 1, ...pages[cursor ? 1 : 0] } }));
    const listed = await listChildRuns({ parent: PARENT, backend: backend(), listRuns });
    expect(listed.children.map((child) => child.name)).toEqual(["a", "c"]);
    expect(listRuns).toHaveBeenCalledTimes(2);
  });

  it("settles a child only on Host-reported evidence", () => {
    expect(classifyChild(run("a", { launchState: "applying" }))).toEqual({ state: "launching" });
    expect(classifyChild(run("a", { launchState: "failed" }))).toEqual({ state: "launch_failed" });
    expect(classifyChild(run("a", { launchState: "prompt_delivery_uncertain" }))).toEqual({ state: "launch_incomplete" });
    expect(classifyChild(run("a", { sessionId: undefined }))).toMatchObject({ state: "unobservable", reason: "chat_runtime" });
    expect(classifyChild(run("a"), session())).toMatchObject({ state: "working" });
    // Idle before its first turn completes is not a finished turn.
    expect(classifyChild(run("a"), session({ activity: "waiting" }))).toMatchObject({ state: "working" });
    expect(classifyChild(run("a"), session({ activity: "waiting", turn_completed_count: "1" })))
      .toMatchObject({ state: "turn_completed", turnCompletedCount: "1" });
    expect(classifyChild(run("a"), session({ activity: "working", background_work: true, turn_completed_count: "1" })))
      .toMatchObject({ state: "working" });
    expect(classifyChild(run("a"), session({ attention: "approval_required", attention_id: "approval-1" })))
      .toMatchObject({ state: "attention_required", attention: "approval_required" });
    expect(classifyChild(run("a"), session({ lifecycle: "exited" }))).toMatchObject({ state: "exited" });
    expect(classifyChild(run("a"), { error: { code: "hmux_session_query_timeout" } }))
      .toMatchObject({ state: "working", reason: "observation_unavailable" });
  });
});

function waitFor(mode, runs, sessions, adapters = {}) {
  let elapsed = 0;
  const querySession = vi.fn(async ({ sessionId }) => {
    const reports = sessions[sessionId];
    const index = Math.min(querySession.mock.calls.filter(([call]) => call.sessionId === sessionId).length - 1, reports.length - 1);
    return reports[index];
  });
  const listRuns = vi.fn(async () => ({ page: { schemaVersion: 1, runs, nextCursor: null } }));
  return {
    querySession,
    listRuns,
    result: collectWait(parseWaitArguments(["--children", mode, "--timeout", "5"]), {
      backend: backend(), sessionBackend: null, environment: CALLER_ENV, querySession, listRuns,
      now: () => elapsed, pause: async (ms) => { elapsed += ms; }, ...adapters,
    }),
  };
}

describe("dure wait --children", () => {
  const idle = session({ activity: "waiting", turn_completed_count: "1" });

  it("waits until every child settles", async () => {
    const { result, querySession } = waitFor("all", [run("a"), run("b")], {
      "session-a": [idle],
      "session-b": [session(), session(), idle],
    });
    const report = await result;
    expect(report).toMatchObject({
      apiVersion: "dure.wait/v1", subject: "children", state: "completed", exitCode: 0,
      target: { parent: PARENT, mode: "all" },
    });
    expect(report.observation.children.map((child) => [child.name, child.state]))
      .toEqual([["a", "turn_completed"], ["b", "turn_completed"]]);
    expect(querySession.mock.calls.filter(([call]) => call.sessionId === "session-b")).toHaveLength(3);
  });

  it("returns on the first settled child with any", async () => {
    const { result } = waitFor("any", [run("a"), run("b")], {
      "session-a": [session()],
      "session-b": [idle],
    });
    expect(await result).toMatchObject({ state: "completed", exitCode: 0 });
  });

  it("exits 1 when a settled child needs action", async () => {
    const { result } = waitFor("all", [run("a"), run("b", { launchState: "failed" })], {
      "session-a": [session({ attention: "input_required", attention_id: "input-1" })],
    });
    expect(await result).toMatchObject({ state: "failed", exitCode: 1, error: { code: "wait_children_action_required" } });
  });

  it("re-reads Run records while a child is still launching", async () => {
    const launching = [run("a", { launchState: "applying" })];
    const launched = [run("a")];
    const listRuns = vi.fn()
      .mockResolvedValueOnce({ page: { schemaVersion: 1, runs: launching, nextCursor: null } })
      .mockResolvedValue({ page: { schemaVersion: 1, runs: launched, nextCursor: null } });
    const { result } = waitFor("all", launching, { "session-a": [idle] }, { listRuns });
    expect(await result).toMatchObject({ state: "completed", exitCode: 0 });
    expect(listRuns).toHaveBeenCalledTimes(2);
  });

  it("reports unknown instead of waiting on children it can't observe", async () => {
    const { result } = waitFor("all", [run("a"), run("b", { sessionId: undefined })], { "session-a": [idle] });
    expect(await result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_children_unobservable" } });
  });

  it("reports a parent without linked children", async () => {
    const { result } = waitFor("all", [run("x", { parent: undefined })], {});
    expect(await result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_children_not_found" } });
  });

  it("times out without inferring an outcome", async () => {
    const { result } = waitFor("all", [run("a")], { "session-a": [session()] });
    expect(await result).toMatchObject({ state: "unknown", exitCode: 124, error: { code: "wait_timeout" } });
  });

  it("needs a parent outside an agent's terminal", async () => {
    const { result } = waitFor("all", [run("a")], {}, { environment: {} });
    expect(await result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_arguments_invalid" } });
  });

  it("parses the children target", () => {
    expect(parseWaitArguments(["--children", "any", "session-lead", "--workspace", "workspace-lead"]))
      .toMatchObject({ subject: "children", childrenMode: "any", query: "session-lead", workspaceId: "workspace-lead" });
    expect(() => parseWaitArguments(["--children", "some"])).toThrow(/--children all/);
    expect(() => parseWaitArguments(["--children", "all", "--workspace", "w"])).toThrow(/--workspace/);
    expect(() => parseWaitArguments(["--children", "all", "--operation-id", "spawn-1"])).toThrow(/exactly one/);
  });
});

const OBSERVES = [AGENT_SPAWN_PARENT_LINK_CAPABILITY, AGENT_SPAWN_CONVERSATION_OBSERVATION_CAPABILITY];

function conversation(overrides = {}) {
  return {
    state: "observed", interactionSessionId: "chat-a", timelineEpoch: "timeline-a",
    activity: "working", attention: "none", quiescent: false, turnCompletedSequence: null,
    ...overrides,
  };
}

const finishedTurn = (sequence) => conversation({ activity: "waiting", quiescent: true, turnCompletedSequence: sequence });

function observeRunFrom(byOperation) {
  const calls = {};
  return vi.fn(async ({ operationId }) => {
    const readings = byOperation[operationId];
    const index = Math.min(calls[operationId] = (calls[operationId] ?? -1) + 1, readings.length - 1);
    return readings[index];
  });
}

describe("chat-runtime children", () => {
  it("settles a chat child from the backend's reading of its conversation", () => {
    const chat = run("a", { sessionId: undefined });
    expect(classifyChild(chat, undefined, conversation())).toEqual({ state: "working", turnCompletedSequence: null });
    // Quiet before its first finished turn is not a finished turn.
    expect(classifyChild(chat, undefined, conversation({ activity: "waiting", quiescent: true })))
      .toMatchObject({ state: "working" });
    expect(classifyChild(chat, undefined, finishedTurn("7")))
      .toEqual({ state: "turn_completed", turnCompletedSequence: "7" });
    expect(classifyChild(chat, undefined, conversation({ attention: "approval_required", turnCompletedSequence: "7" })))
      .toEqual({ state: "attention_required", attention: "approval_required", turnCompletedSequence: "7" });
    expect(classifyChild(chat, undefined, { state: "stopped" })).toEqual({ state: "exited" });
    expect(classifyChild(chat, undefined, { state: "unavailable", errorCode: "agent_runtime_observation_store_failed" }))
      .toEqual({ state: "working", reason: "observation_unavailable" });
    // A terminal child that moved into Chat is read through its conversation.
    expect(classifyChild(run("b"), session({ lifecycle: "exited" }), finishedTurn("3")))
      .toMatchObject({ state: "turn_completed" });
    // Without an observation it stays unobservable, as on an older backend.
    expect(classifyChild(chat, undefined, null)).toMatchObject({ state: "unobservable", reason: "chat_runtime" });
  });

  it("waits on chat children through their conversation, and terminal children through the Host", async () => {
    const observeRun = observeRunFrom({
      "spawn-a": [conversation(), conversation({ attention: "approval_required" })],
      "spawn-b": [null],
    });
    const { result, querySession } = waitFor("all", [run("a", { sessionId: undefined }), run("b")], {
      "session-b": [session({ activity: "waiting", turn_completed_count: "1" })],
    }, { backend: backend({ capabilities: OBSERVES }), observeRun });
    const report = await result;
    expect(report).toMatchObject({ state: "failed", exitCode: 1, error: { code: "wait_children_action_required" } });
    expect(report.observation.children.map((child) => [child.name, child.state]))
      .toEqual([["a", "attention_required"], ["b", "turn_completed"]]);
    expect(querySession.mock.calls.map(([call]) => call.sessionId)).toEqual(["session-b", "session-b"]);
    expect(observeRun).toHaveBeenCalledWith(expect.objectContaining({ operationId: "spawn-a" }));
  });

  it("settles any on a chat child that finished a turn", async () => {
    const observeRun = observeRunFrom({ "spawn-a": [conversation(), finishedTurn("4")] });
    const { result } = waitFor("any", [run("a", { sessionId: undefined })], {},
      { backend: backend({ capabilities: OBSERVES }), observeRun });
    const report = await result;
    expect(report).toMatchObject({ state: "completed", exitCode: 0 });
    expect(report.observation.children[0]).toMatchObject({ state: "turn_completed", turnCompletedSequence: "4" });
  });

  it("keeps today's unobservable result on a backend without the observation", async () => {
    const observeRun = vi.fn();
    const { result } = waitFor("all", [run("a", { sessionId: undefined })], {}, { observeRun });
    expect(await result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_children_unobservable" } });
    expect(observeRun).not.toHaveBeenCalled();
  });
});

function waitOnAgent(selector, readings, { capabilities = OBSERVES, registry: agents, runs = [run("a", { sessionId: undefined })], ...adapters } = {}) {
  let elapsed = 0;
  const observeRun = vi.fn(async () => readings[Math.min(observeRun.mock.calls.length - 1, readings.length - 1)]);
  const listRuns = vi.fn(async ({ selector: wanted }) => ({
    page: { schemaVersion: 1, runs: runs.filter((entry) => [entry.agentId, entry.name, entry.operationId].includes(wanted)), nextCursor: null },
  }));
  const querySession = vi.fn(async () => session({ activity: "waiting", turn_completed_count: "2" }));
  return {
    observeRun, listRuns, querySession,
    result: collectWait(parseWaitArguments([selector, "--timeout", "5"]), {
      backend: backend({ capabilities }), registry: agents, observeRun, listRuns, querySession,
      now: () => elapsed, pause: async (ms) => { elapsed += ms; }, ...adapters,
    }),
  };
}

describe("dure wait <chat agent>", () => {
  it("completes when the agent's next turn finishes after the wait started", async () => {
    const { result, observeRun } = waitOnAgent("agent-a", [
      finishedTurn("4"), finishedTurn("4"), conversation({ turnCompletedSequence: "4" }), finishedTurn("9"),
    ]);
    const report = await result;
    expect(report).toMatchObject({
      subject: "response", state: "completed", exitCode: 0,
      target: { agentId: "agent-a", operationId: "spawn-a", interactionSessionId: "chat-a", timelineEpoch: "timeline-a", afterTurnSequence: "4" },
      observation: { turnCompletedSequence: "9" },
    });
    expect(observeRun).toHaveBeenCalledTimes(4);
  });

  it("completes on the first finished turn of a conversation that had none", async () => {
    const { result } = waitOnAgent("a", [conversation(), conversation(), finishedTurn("2")], {
      registry: registry([{ id: "agent-a", name: "a" }]),
    });
    expect(await result).toMatchObject({ state: "completed", target: { agentId: "agent-a", afterTurnSequence: null } });
  });

  it("returns when the agent needs a person, stopped, or its conversation was replaced", async () => {
    const asking = waitOnAgent("agent-a", [conversation(), conversation({ attention: "input_required" })]);
    expect(await asking.result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_response_attention_required" } });
    const stopped = waitOnAgent("agent-a", [conversation(), { state: "stopped" }]);
    expect(await stopped.result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_response_exited" } });
    const replaced = waitOnAgent("agent-a", [conversation(), conversation(), conversation({ interactionSessionId: "chat-b" })]);
    expect(await replaced.result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_generation_changed" } });
  });

  it("keeps waiting through a failed read or a runtime switch in progress", async () => {
    const { result } = waitOnAgent("agent-a", [
      conversation(), conversation(), { state: "unavailable", errorCode: "agent_conversation_observation_unavailable" }, null, finishedTurn("1"),
    ]);
    expect(await result).toMatchObject({ state: "completed", exitCode: 0 });
  });

  it("reads a terminal Run without the app through the Session it started in", async () => {
    const { result, querySession } = waitOnAgent("agent-b", [null], { runs: [run("b")] });
    await result;
    expect(querySession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-b", workspaceId: "workspace-b" }));
  });

  it("refuses terminal resume flags for a chat agent", async () => {
    let elapsed = 0;
    const report = await collectWait(parseWaitArguments(["agent-a", "--after-turn", "1", "--terminal-epoch", "t", "--timeout", "5"]), {
      backend: backend({ capabilities: OBSERVES }), observeRun: async () => conversation(),
      listRuns: async () => ({ page: { schemaVersion: 1, runs: [run("a", { sessionId: undefined })], nextCursor: null } }),
      now: () => elapsed, pause: async (ms) => { elapsed += ms; },
    });
    expect(report).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_arguments_invalid" } });
  });

  it("behaves as today on a backend without the observation", async () => {
    const withoutApp = waitOnAgent("agent-a", [], { capabilities: [] });
    expect(await withoutApp.result).toMatchObject({ state: "unknown", exitCode: 2, error: { code: "wait_arguments_invalid", message: expect.stringContaining("name projection") } });
    const chatInApp = waitOnAgent("agent-a", [], { capabilities: [], registry: registry([{ id: "agent-a", name: "a" }]) });
    expect(await chatInApp.result).toMatchObject({ error: { code: "wait_runtime_unavailable" } });
    expect(withoutApp.listRuns).not.toHaveBeenCalled();
    expect(chatInApp.observeRun).not.toHaveBeenCalled();
  });
});

describe("the Run observation request", () => {
  const profileBackend = backend({ capabilities: OBSERVES });

  it("asks agent_spawn.status for the conversation and validates the answer", async () => {
    const sent = [];
    const observed = await readRunConversation({
      backend: profileBackend, operationId: "spawn-a", deadlineMs: 900,
      requestBackend: async (_profile, request, options) => {
        sent.push({ request, options });
        return { result: { schemaVersion: 1, receipt: { operationId: "spawn-a" }, conversation: finishedTurn("5") } };
      },
    });
    expect(observed).toEqual(finishedTurn("5"));
    expect(sent[0].request).toMatchObject({
      operation: "agent_spawn.status",
      requiredCapabilities: ["agent_spawn.status", AGENT_SPAWN_CONVERSATION_OBSERVATION_CAPABILITY],
      body: { schemaVersion: 1, operationId: "spawn-a", observeConversation: true },
    });
    expect(sent[0].options.deadlineMs).toBe(900);
    expect(backendObservesRunConversations(profileBackend)).toBe(true);
    expect(backendObservesRunConversations(backend())).toBe(false);
  });

  it("reads no conversation as null and refuses a malformed one", async () => {
    const answer = (result) => readRunConversation({ backend: profileBackend, operationId: "spawn-a", requestBackend: async () => ({ result }) });
    expect(await answer({ schemaVersion: 1, receipt: { operationId: "spawn-a" }, conversation: null })).toBeNull();
    for (const result of [
      { schemaVersion: 1, receipt: { operationId: "spawn-other" }, conversation: null },
      { schemaVersion: 1, receipt: { operationId: "spawn-a" }, conversation: { ...finishedTurn("5"), extra: true } },
      { schemaVersion: 1, receipt: { operationId: "spawn-a" }, conversation: finishedTurn("-1") },
      { schemaVersion: 1, receipt: { operationId: "spawn-a" }, conversation: conversation({ attention: "maybe" }) },
    ]) {
      await expect(answer(result)).rejects.toMatchObject({ code: "runs_response_invalid" });
    }
  });
});
