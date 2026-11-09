import { describe, expect, it, vi } from "vitest";
import {
  AGENT_SPAWN_PARENT_LINK_CAPABILITY,
  collectAgentSpawnQuery,
} from "../cli/lib/agent-spawn-query.mjs";
import {
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
