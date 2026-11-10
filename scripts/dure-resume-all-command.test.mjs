import { describe, expect, it, vi } from "vitest";
import {
  classifyRuntime,
  classifySession,
  collectResumeAll,
  formatResumeAll,
  parseResumeOptions,
} from "../cli/lib/resume-all-command.mjs";

const generation = (id) => ({ runnerPrincipal: "principal", runnerInstance: "runner", channelEpoch: "1",
  hostInstanceId: `host-${id}`, terminalEpoch: `terminal-${id}` });

function runtimeFor(id, { conversation = `conversation-${id}`, profile = "native_cli", providerId = "claude" } = {}) {
  const agentId = `agent-${id}`;
  return { schemaVersion: 1, state: "stable", receipt: { schemaVersion: 1, agentId, selectionRevision: 1, providerId,
    executionProfile: { kind: "provider_default" }, permissionMode: "default",
    authority: { interactionProfile: profile, authority: { ...generation(id), runtimeWorkspaceId: "workspace",
      binding: { agentId, sessionId: `session-${id}`, runtimeKindId: "runtime.hmux",
        ...(conversation ? { providerConversationId: conversation } : {}) } } } },
    projectionContext: { schemaVersion: 1, identity: { kind: "registered" },
      agent: { agentId, providerId, workspaceId: "workspace" },
      workspace: { workspaceId: "workspace", projectId: "project", rootPath: "/repo" },
      project: { projectId: "project", rootPath: "/repo" } } };
}

const sessionFor = (id, health) => ({ health, host_instance_id: `host-${id}`, terminal_epoch: `terminal-${id}` });
const receiptFor = (sessionId, operationId) => ({ schema: "hmux-managed-rehost-v1", schemaVersion: 1, operationId, replayed: false,
  sourceStopReceipt: { sessionId, workspaceId: "workspace" }, replacementReceipt: { sessionId: `${sessionId}-next` } });

/** agents: id -> { runtime, session, rehost(args) }. Backend and Hmux are the only seams. */
function fixture(agents, { capabilities = ["managed_rehost_host_absent_start_v1"] } = {}) {
  const started = [];
  const published = [];
  const backend = { profile: { id: "local", transport: { kind: "local" } } };
  const requestBackend = vi.fn(async (_profile, request) => {
    if (request.operation === "agent_spawn.list") return { result: { schemaVersion: 1, runs: [], nextCursor: null } };
    if (request.operation === "agent_runtime.projection.inspect") {
      return { result: agents[request.body.agentId.replace("agent-", "")].runtime };
    }
    if (request.operation === "agent_runtime.native_rehost.reconcile") {
      published.push(request.body);
      return { result: agents[request.body.agentId.replace("agent-", "")].runtime };
    }
    throw new Error(`Unexpected operation ${request.operation}`);
  });
  const run = vi.fn(async (argv) => {
    if (argv[1] === "capabilities") return { kind: "success", stdout: JSON.stringify({ schemaVersion: 1, capabilities }) };
    if (argv[2] === "session") {
      const session = agents[argv[4].replace("session-", "")].session;
      return session ? { kind: "success", stdout: JSON.stringify(session) } : { kind: "nonzero", stdout: "", stderr: "missing" };
    }
    if (argv[1] === "managed-rehost-reconcile") {
      return { kind: "nonzero", stdout: JSON.stringify({ state: "refused", error: { code: "hmux_managed_rehost_intent_not_found" } }) };
    }
    if (argv[1] === "managed-rehost-start") {
      started.push(argv);
      const sessionId = argv[argv.indexOf("--session") + 1];
      const operationId = argv[argv.indexOf("--operation-id") + 1];
      const custom = agents[sessionId.replace("session-", "")].rehost;
      return custom ? custom(argv) : { kind: "success", stdout: JSON.stringify(receiptFor(sessionId, operationId)) };
    }
    throw new Error(`Unexpected argv ${argv.join(" ")}`);
  });
  const registry = { state: "available", agents: Object.keys(agents).map((id) => ({ id: `agent-${id}`, name: `worker-${id}`,
    ...(agents[id].worktree ? { worktree: agents[id].worktree } : {}) })) };
  return { started, published, requestBackend, run, command: "/bin/hmux", loadRegistry: () => registry,
    resolveBackend: async () => backend, worktreeExists: (path) => path !== "/gone",
    opts: { all: true, rest: [], ...{} } };
}

const reasons = (report) => Object.fromEntries(report.skipped.map((entry) => [entry.agentId, entry.reason]));

describe("dure resume --all", () => {
  it("restores each gone Host into its own conversation behind the Host-absence fence", async () => {
    const f = fixture({ a: { runtime: runtimeFor("a"), session: sessionFor("a", "stale_transport") },
      b: { runtime: runtimeFor("b"), session: sessionFor("b", "stale_transport") } });
    const report = await collectResumeAll(f);
    expect(report).toMatchObject({ ok: true, skipped: [], failed: [], alreadyRunning: [] });
    expect(report.restored.map((entry) => [entry.agentId, entry.conversationId, entry.sessionId]).sort()).toEqual([
      ["agent-a", "conversation-a", "session-a-next"], ["agent-b", "conversation-b", "session-b-next"]]);
    for (const argv of f.started) {
      expect(argv).toContain("--require-host-absent");
      expect(argv).toContain("--confirm-restart");
      const session = argv[argv.indexOf("--session") + 1];
      expect(argv[argv.indexOf("--expected-conversation") + 1]).toBe(session.replace("session-", "conversation-"));
    }
    expect(f.published.map((body) => body.agentId).sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("never touches a healthy Host and reports it as already running", async () => {
    const f = fixture({ a: { runtime: runtimeFor("a"), session: sessionFor("a", "healthy") } });
    const report = await collectResumeAll(f);
    expect(report.alreadyRunning.map((entry) => entry.agentId)).toEqual(["agent-a"]);
    expect(f.started).toEqual([]);
  });

  it("lists every agent it cannot restore with a reason", async () => {
    const asleep = { schemaVersion: 1, state: "transitioning", agentId: "agent-sleep", projectionContext: runtimeFor("sleep").projectionContext,
      operationId: "sleep-op", stage: "source_stopped", journalRevision: 3, targetInteractionProfile: "native_cli",
      targetExecutionProfile: { kind: "provider_default" }, deferredTarget: { state: "waiting" } };
    const stale = (id) => sessionFor(id, "stale_transport");
    const report = await collectResumeAll(fixture({
      sleep: { runtime: asleep },
      unmanaged: { runtime: { schemaVersion: 1, state: "unmanaged", agentId: "agent-unmanaged" } },
      chat: { runtime: runtimeFor("chat", { profile: "structured_protocol" }) },
      noconv: { runtime: runtimeFor("noconv", { conversation: null }), session: stale("noconv") },
      noresume: { runtime: runtimeFor("noresume", { providerId: "rovo-dev" }), session: stale("noresume") },
      exited: { runtime: runtimeFor("exited"), session: sessionFor("exited", "exited") },
      lost: { runtime: runtimeFor("lost") },
      unknown: { runtime: runtimeFor("unknown"), session: sessionFor("unknown", "unprobed") },
      gone: { runtime: runtimeFor("gone"), session: stale("gone"), worktree: "/gone" },
    }));
    expect(report.restored).toEqual([]);
    expect(reasons(report)).toEqual({
      "agent-sleep": "hibernated", "agent-unmanaged": "not_managed", "agent-chat": "chat_runtime",
      "agent-noconv": "no_conversation_id", "agent-noresume": "provider_without_resume", "agent-exited": "provider_exited",
      "agent-lost": "host_state_unknown", "agent-unknown": "host_state_unknown", "agent-gone": "worktree_missing",
    });
    expect(report.skipped.every((entry) => entry.message)).toBe(true);
  });

  it("treats a Host that fails the absence proof as skipped, not failed", async () => {
    const refusal = (code, message) => () => ({ kind: "nonzero", stdout: JSON.stringify({ state: "refused", error: { code, message } }) });
    const report = await collectResumeAll(fixture({
      hung: { runtime: runtimeFor("hung"), session: sessionFor("hung", "stale_transport"),
        rehost: refusal("managed_rehost_socket_owner_absence_required", "still owns a socket") },
      moved: { runtime: runtimeFor("moved"), session: sessionFor("moved", "stale_transport"),
        rehost: refusal("hmux_managed_rehost_recipe_invalid", "source provider cwd is unavailable before retirement") },
    }));
    expect(report.ok).toBe(true);
    expect(reasons(report)).toEqual({ "agent-hung": "host_still_running", "agent-moved": "worktree_missing" });
  });

  it("restores an exited provider only when asked, without the live-Host fence", async () => {
    const agents = { a: { runtime: runtimeFor("a"), session: sessionFor("a", "exited") } };
    const f = fixture(agents);
    const report = await collectResumeAll({ ...f, opts: { ...f.opts, includeExited: true } });
    expect(report.restored).toHaveLength(1);
    expect(f.started[0]).not.toContain("--require-host-absent");
    expect(f.started[0]).toContain("--expected-conversation");
  });

  it("reports a real failure and exits unsuccessful", async () => {
    const report = await collectResumeAll(fixture({ a: { runtime: runtimeFor("a"), session: sessionFor("a", "stale_transport"),
      rehost: () => ({ kind: "nonzero", stdout: JSON.stringify({ state: "refused", error: { code: "hmux_managed_runtime_failed", message: "boom" } }) }) } }));
    expect(report.ok).toBe(false);
    expect(report.failed[0]).toMatchObject({ agentId: "agent-a", reason: "hmux_managed_runtime_failed", message: "boom" });
    expect(formatResumeAll(report)).toContain("failed 1");
  });

  it("uses one stable operation per source so a rerun continues the same restore", async () => {
    const ids = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const f = fixture({ a: { runtime: runtimeFor("a"), session: sessionFor("a", "stale_transport") } });
      await collectResumeAll(f);
      ids.push(f.started[0][f.started[0].indexOf("--operation-id") + 1]);
    }
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^resume-all-[0-9a-f]{48}$/);
  });

  it("dry run plans without starting or publishing", async () => {
    const f = fixture({ a: { runtime: runtimeFor("a"), session: sessionFor("a", "stale_transport") } });
    const report = await collectResumeAll({ ...f, opts: { ...f.opts, dryRun: true } });
    expect(report.restorable.map((entry) => entry.agentId)).toEqual(["agent-a"]);
    expect(report.restored).toEqual([]);
    expect(f.started).toEqual([]);
    expect(f.published).toEqual([]);
    expect(formatResumeAll(report)).toContain("Would restore 1");
  });

  it("refuses before any change on an older runtime or a remote backend", async () => {
    const older = fixture({ a: { runtime: runtimeFor("a"), session: sessionFor("a", "stale_transport") } }, { capabilities: [] });
    expect((await collectResumeAll(older)).error.code).toBe("resume_all_runtime_update_required");
    expect(older.started).toEqual([]);
    const remote = fixture({});
    const report = await collectResumeAll({ ...remote, resolveBackend: async () => ({ profile: { id: "ssh", transport: { kind: "ssh" } } }) });
    expect(report.error.code).toBe("resume_all_local_only");
  });

  it("requires --all and rejects a selector", async () => {
    const f = fixture({});
    expect((await collectResumeAll({ ...f, opts: { rest: [] } })).error.code).toBe("resume_request_invalid");
    expect((await collectResumeAll({ ...f, opts: { all: true, rest: ["worker"] } })).error.code).toBe("resume_request_invalid");
    expect(parseResumeOptions(["--all", "--dry-run", "--include-exited", "--json"])).toMatchObject({ all: true, dryRun: true, includeExited: true, json: true });
    expect(() => parseResumeOptions(["--all", "--confirm-restart"])).toThrow();
  });

  it("classifies a replaced generation by what is running now", () => {
    const target = classifyRuntime(runtimeFor("a"));
    expect(classifySession(sessionFor("other", "healthy"), target, {})).toEqual({ outcome: "running" });
    expect(classifySession(sessionFor("other", "stale_transport"), target, {})).toMatchObject({ reason: "runtime_generation_changed" });
  });
});
