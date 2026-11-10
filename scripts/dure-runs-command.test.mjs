import { describe, expect, it, vi } from "vitest";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import { MANAGED_REHOST_RUNNING_EXIT_CODE } from "../cli/lib/managed-rehost-named.mjs";
import { collectRunsCommand, formatRunsCommand, parseRunsOptions, runsCommandExitCode } from "../cli/lib/runs-command.mjs";
import { AGENT_RUNTIME_PRESENTATION_CAPABILITY, agentRuntimePresentationRequest, currentRunPresentationPlan,
  presentAgentRuntime } from "../cli/lib/run-presentation.mjs";
import { canonicalNativeReceipt, request as spawnRequest, succeededNativeReceipt } from "./fixtures/agent-spawn-receipts.mjs";

function fixture() {
  const receipt = succeededNativeReceipt();
  const plan = receipt.plan;
  const session = receipt.completed.find((s) => s.stage === "runtime_launch").evidence.session;
  const entry = { operationId: receipt.operationId, agentId: plan.agentId, name: plan.request.agentName,
    providerId: plan.request.providerId, workspaceId: plan.workspaceId, projectId: plan.authority.projectId,
    launchState: receipt.state, createdAtMs: receipt.createdAtMs, updatedAtMs: receipt.updatedAtMs };
  const runtime = { schemaVersion: 1, state: "stable", receipt: { schemaVersion: 1,
    agentId: plan.agentId, selectionRevision: 1, providerId: entry.providerId,
    executionProfile: plan.request.executionProfile, permissionMode: plan.request.permissionMode,
    authority: { interactionProfile: "native_cli", authority: {
      ...session, runtimeWorkspaceId: plan.workspaceId,
      binding: { agentId: plan.agentId, sessionId: session.sessionId, runtimeKindId: "runtime.hmux" },
    } } }, projectionContext: { schemaVersion: 1, identity: { kind: "registered" },
      agent: { agentId: plan.agentId, providerId: entry.providerId, workspaceId: plan.workspaceId },
      workspace: { workspaceId: plan.workspaceId, projectId: entry.projectId, rootPath: "/repo" },
      project: { projectId: entry.projectId, rootPath: "/repo" } } };
  const page = { schemaVersion: 1, runs: [entry], nextCursor: null };
  const requestBackend = vi.fn(async (_profile, request) => ({ result:
    request.operation === "agent_spawn.list" ? page :
    request.operation === "agent_spawn.status" ? { schemaVersion: 1, receipt } : runtime }));
  const backend = { profile: { id: "local", transport: { kind: "local" } } };
  return { receipt, entry, runtime, page, requestBackend, backend,
    resolveBackend: async () => backend, opts: { rest: ["show", entry.name] } };
}

/** A virtual clock: waiting advances time instead of blocking the test. */
function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += Math.max(1, ms); } };
}

/**
 * A native broker over one in-memory recovery journal, keyed by source. Like
 * Hmux it refuses a second operation for a source that already holds one, and
 * an operation another executor is applying stays pending (`applying`) until
 * the test completes it.
 */
function fakeHmuxJournal() {
  const journal = new Map();
  const calls = [];
  const resolution = (fields) => ({ kind: "success", stdout: JSON.stringify({
    schema: "hmux-managed-rehost-resolution-v1", schemaVersion: 1, ...fields }) });
  const refused = (code) => ({ kind: "nonzero", stdout: JSON.stringify({ schema: "hmux-managed-rehost-v1",
    schemaVersion: 1, state: "refused", error: { code, message: `${code}: refused` } }) });
  const run = vi.fn(async (argv) => {
    calls.push(argv.slice(1));
    const value = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
    const source = { sessionId: value("--session"), workspaceId: value("--workspace") };
    const key = `${source.workspaceId}\0${source.sessionId}`;
    const operationId = value("--operation-id");
    const entry = journal.get(key);
    const successor = { sessionId: `successor-of-${source.sessionId}`, workspaceId: source.workspaceId };
    const receipt = (replayed) => ({ kind: "success", stdout: JSON.stringify({ schema: "hmux-managed-rehost-v1",
      schemaVersion: 1, operationId, replayed, sourceStopReceipt: source, replacementReceipt: successor }) });
    switch (argv[1]) {
      case "managed-rehost-resolve":
        if (!entry || (operationId && entry.operationId !== operationId)) return resolution({ state: "not_found", source });
        return entry.state === "completed"
          ? resolution({ state: "resolved", operationIds: [entry.operationId], sourceGeneration: source,
            currentGeneration: successor })
          : resolution({ state: "retry_required", code: "hmux_managed_rehost_retry_required",
            operationId: entry.operationId, source });
      case "managed-rehost-start":
        if (entry && entry.operationId !== operationId) return refused("hmux_managed_rehost_source_changed");
        if (!entry) {
          journal.set(key, { operationId, state: "applying" });
          return { kind: "timeout" };
        }
      // A replayed start of the same operation behaves like reconcile.
      // falls through
      case "managed-rehost-reconcile":
        if (!entry || entry.operationId !== operationId) return refused("hmux_managed_rehost_retry_required");
        return entry.state === "completed" ? receipt(true) : refused("hmux_recovery_busy");
      default:
        throw new Error(`Unexpected native command: ${argv[1]}`);
    }
  });
  return { run, calls, journal,
    complete: () => { for (const entry of journal.values()) entry.state = "completed"; } };
}

function dormantFixture() {
  const f = fixture();
  const asleep = { schemaVersion: 1, state: "transitioning", agentId: f.entry.agentId,
    projectionContext: f.runtime.projectionContext, operationId: "sleep-operation",
    stage: "source_stopped", journalRevision: 3, targetInteractionProfile: "native_cli",
    targetExecutionProfile: { kind: "provider_default" }, deferredTarget: { state: "waiting" } };
  f.requestBackend.mockImplementation(async (_profile, request) => {
    if (request.operation === "agent_spawn.list") return { result: f.page };
    if (request.operation === "agent_runtime.projection.inspect") return { result: asleep };
    if (request.operation === "agent_runtime.wake") return { result: f.runtime };
    throw new Error(`Unexpected operation: ${request.operation}`);
  });
  return { ...f, asleep, opts: { rest: ["resume", f.entry.name] }, run: vi.fn() };
}

describe("durable Run commands", () => {
  it("previews a stopped deferred source using the existing wake fence without mutation", async () => {
    const f = dormantFixture();
    const report = await collectRunsCommand(f);
    expect(report.ok).toBe(true);
    const c = report.recovery.continuation;
    expect(c).toMatchObject({ kind: "runtime_wake", operationId: "sleep-operation", expectedJournalRevision: 3 });
    expect(c.start).toEqual(["runtime", "wake", f.entry.agentId, "--operation-id", "sleep-operation",
      "--expected-revision", "3", "--idempotency-key", c.requestId, "--backend", "local", "--json"]);
    expect(c.retry).toEqual(c.start);
    expect(c.status).toEqual(["runtime", "get", f.entry.agentId, "--backend", "local", "--json"]);
    expect(c.publish).toBeUndefined();
    expect(f.requestBackend.mock.calls.map((c) => c[1].operation)).toEqual(["agent_spawn.list", "agent_runtime.projection.inspect"]);
    expect(f.run).not.toHaveBeenCalled();
    expect(formatRunsCommand(report)).toContain("Wake:");
  });

  it("confirmed resume wakes and publishes through the backend once, without native rehost", async () => {
    const f = dormantFixture();
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report).toMatchObject({ ok: true, recovery: { state: "completed", backendExecution: "completed", publication: "published", result: f.runtime } });
    const c = report.recovery.continuation;
    expect(f.requestBackend.mock.calls.map((c) => c[1].operation)).toEqual(["agent_spawn.list", "agent_runtime.projection.inspect", "agent_runtime.wake"]);
    expect(f.requestBackend.mock.calls[2][1]).toMatchObject({ requestId: c.requestId,
      requiredCapabilities: ["agent_runtime.wake"], body: { schemaVersion: 1,
        agentId: f.entry.agentId, operationId: "sleep-operation", expectedJournalRevision: 3 } });
    expect(f.run).not.toHaveBeenCalled();
    expect(formatRunsCommand(report)).toContain("backend completed");
  });

  it.each(["lost_response", "pending", "closed"])("retains exact wake commands after %s without replay or success", async (outcome) => {
    const f = dormantFixture();
    f.requestBackend.mockImplementation(async (_profile, request) => {
      if (request.operation === "agent_spawn.list") return { result: f.page };
      if (request.operation === "agent_runtime.projection.inspect") return { result: f.asleep };
      if (outcome === "lost_response") throw new Error("response lost");
      return { result: outcome === "pending" ? { ...f.asleep, stage: "target_started" } :
        { schemaVersion: 1, state: "closed", agentId: f.entry.agentId, operationId: "sleep-operation", stage: "closed" } };
    });
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report.ok).toBe(false);
    expect(report.recovery.publication).not.toBe("published");
    expect(report.recovery.continuation.retry).toEqual(report.recovery.continuation.start);
    expect(formatRunsCommand(report)).toContain("Status:");
    expect(f.requestBackend).toHaveBeenCalledTimes(3);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([
    { deferredTarget: undefined }, { deferredTarget: { state: "future" } },
    { journalRevision: 0 }, { stage: "repair_required" }, { operationId: "" },
    { targetInteractionProfile: "structured_protocol" },
  ])("refuses an incomplete or different stopped boundary: %j", async (change) => {
    const f = dormantFixture();
    Object.assign(f.asleep, change);
    expect((await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } })).ok).toBe(false);
    expect(f.requestBackend).toHaveBeenCalledTimes(2);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("lists retained launches without consulting a client or treating success as live", async () => {
    const f = fixture();
    const report = await collectRunsCommand({ ...f, opts: { rest: ["list"] } });
    expect(report).toMatchObject({ ok: true, runs: [f.entry], nextCursor: null });
    expect(f.requestBackend).toHaveBeenCalledOnce();
    expect(formatRunsCommand(report)).toContain("not liveness");
  });
  it("shows the backend's selected source without a registry", async () => {
    const f = fixture();
    expect(await collectRunsCommand(f)).toMatchObject({ ok: true, runtime: f.runtime });
  });
  it.each(["ambiguous", "partial"])("refuses %s selection before runtime or mutations", async (kind) => {
    const f = fixture();
    if (kind === "ambiguous") f.page.runs.push({ ...f.entry, agentId: "other", operationId: `${f.entry.operationId}z` });
    else f.page.nextCursor = "untrusted";
    expect(await collectRunsCommand(f)).toMatchObject({ ok: false });
    expect(f.requestBackend).toHaveBeenCalledOnce();
  });
  it("refuses a missing selection the backend does not manage after one read-only Agent inspection", async () => {
    const f = fixture();
    f.page.runs = [];
    f.requestBackend.mockImplementation(async (_profile, request) => ({ result: request.operation === "agent_spawn.list"
      ? f.page : { schemaVersion: 1, state: "unmanaged", agentId: request.body.agentId } }));
    expect(await collectRunsCommand(f)).toMatchObject({ ok: false, error: { code: "run_not_found" } });
    expect(f.requestBackend.mock.calls.map((call) => call[1].operation)).toEqual([
      "agent_spawn.list", "agent_runtime.projection.inspect"]);
  });
  it("opens the selected runtime without repeating spawn apply or delivering a prompt", async () => {
    const f = fixture();
    const present = vi.fn(async () => ({ state: "opened" }));
    const report = await collectRunsCommand({ ...f, opts: { rest: ["open", f.entry.name], space: "space-1" },
      resolveTarget: async () => ({ state: "requested", spaceId: "space-1", windowLabel: "main" }), present });
    expect(report.ok).toBe(true);
    expect(present).toHaveBeenCalledWith(expect.objectContaining({ currentRuntime: f.runtime }));
    expect(f.requestBackend.mock.calls.map((c) => c[1].operation)).toEqual([
      "agent_spawn.list", "agent_runtime.projection.inspect", "agent_spawn.status"]);
  });
  it("previews recovery from durable Agent identity without a client name projection", async () => {
    const f = fixture();
    const hmux = fakeHmuxJournal();
    const report = await collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.name] }, command: "hmux", run: hmux.run });
    expect(report).toMatchObject({ ok: true, recovery: { state: "preview", agentId: f.entry.agentId } });
    // Preview only asks the native journal whether the source already has a restart.
    expect(hmux.calls.map(([subcommand]) => subcommand)).toEqual(["managed-rehost-resolve"]);
    expect(report.recovery.continuation.retained).toBeUndefined();
    expect(report.recovery.continuation.start).toContain(f.runtime.receipt.authority.authority.binding.sessionId);
  });
  it("retains exact recovery commands after uncertain execution without another launch", async () => {
    const f = fixture();
    const run = vi.fn(async () => ({ kind: "timeout" }));
    const report = await collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.name], confirmRestart: true },
      command: "hmux", run, settle: fakeClock() });
    expect(report).toMatchObject({ ok: false, recovery: { state: "unknown", publication: "not_requested" } });
    expect(run.mock.calls.filter(([argv]) => argv[1] !== "managed-rehost-resolve")).toHaveLength(1);
    expect(report.recovery.continuation.retry).toContain(report.recovery.continuation.operationId);
    expect(f.requestBackend).toHaveBeenCalledTimes(2);
  });
  it("does not report a restart as finished while Hmux still applies the confirmed rehost", async () => {
    const f = fixture();
    const source = f.runtime.receipt.authority.authority;
    const pending = { schema: "hmux-managed-rehost-resolution-v1", schemaVersion: 1, state: "retry_required",
      code: "hmux_managed_rehost_retry_required",
      source: { sessionId: source.binding.sessionId, workspaceId: source.runtimeWorkspaceId } };
    const run = vi.fn(async (argv) => argv[1] === "managed-rehost-resolve"
      ? { kind: "success", stdout: JSON.stringify({ ...pending, operationId: argv[argv.indexOf("--operation-id") + 1] }) }
      : { kind: "timeout" });
    const report = await collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.name], confirmRestart: true },
      command: "hmux", run, settle: fakeClock() });
    // Still applying is not success: the binding is unpublished, so the Agent still names the retired source.
    expect(report).toMatchObject({ ok: false, error: { code: "rehost_still_running" },
      recovery: { ok: false, state: "running", nativeExecution: "running", publication: "not_requested" } });
    expect(runsCommandExitCode(report)).toBe(MANAGED_REHOST_RUNNING_EXIT_CODE);
    expect(MANAGED_REHOST_RUNNING_EXIT_CODE).not.toBe(0);
    expect(run.mock.calls.filter(([argv]) => argv[1] !== "managed-rehost-resolve")).toHaveLength(1);
    // Publication waits for completion; nothing was published yet.
    expect(f.requestBackend).toHaveBeenCalledTimes(2);
    const text = formatRunsCommand(report);
    expect(text).toContain(`${f.entry.agentId}: running (native running)`);
    expect(text).toContain("Hmux is still applying this rehost");
    expect(text).toContain(`Status: ${"dure 'hmux' 'rehost' 'status'"}`);
    expect(text).toContain("Publish: dure 'hmux' 'rehost' 'publish'");
  });
  it("reports a restart as finished once the native rehost and its binding publication complete", async () => {
    const f = fixture();
    const source = f.runtime.receipt.authority.authority;
    const run = vi.fn(async (argv) => {
      const value = (flag) => argv[argv.indexOf(flag) + 1];
      return { kind: "success", stdout: JSON.stringify({ schema: "hmux-managed-rehost-v1", schemaVersion: 1,
        operationId: value("--operation-id"), replayed: false,
        sourceStopReceipt: { sessionId: value("--session"), workspaceId: value("--workspace") },
        replacementReceipt: { sessionId: "successor-1", workspaceId: value("--workspace") } }) };
    });
    const published = { schemaVersion: 1, receipt: { ...f.runtime.receipt, selectionRevision: 2 } };
    let publication = "published";
    f.requestBackend.mockImplementation(async (_profile, request) => {
      if (request.operation === "agent_spawn.list") return { result: f.page };
      if (request.operation === "agent_runtime.projection.inspect") return { result: f.runtime };
      if (publication === "lost") throw new BackendTransportError("backend_response_lost");
      return { result: published };
    });
    const resume = () => collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.name], confirmRestart: true },
      command: "hmux", run, settle: fakeClock() });
    const finished = await resume();
    expect(finished).toMatchObject({ ok: true, recovery: { state: "completed", nativeExecution: "completed",
      publication: "published" } });
    expect(runsCommandExitCode(finished)).toBe(0);
    // Besides read-only journal lookups, the only native call admits the operation.
    expect(run.mock.calls.map(([argv]) => argv).filter((argv) => argv[1] !== "managed-rehost-resolve")
      .map((argv) => argv.slice(0, 5))).toEqual([["hmux", "managed-rehost-start",
      "--session", source.binding.sessionId, "--workspace"]]);
    // The last step is the binding publication; without it the restart is not finished.
    publication = "lost";
    const unpublished = await resume();
    expect(unpublished).toMatchObject({ ok: false, recovery: { state: "completed", nativeExecution: "completed",
      publication: "unconfirmed" } });
    expect(runsCommandExitCode(unpublished)).toBe(2);
  });
  describe("a restart Hmux already holds", () => {
    function retainedFixture() {
      const f = fixture();
      const hmux = fakeHmuxJournal();
      const published = { schemaVersion: 1, receipt: { ...f.runtime.receipt, selectionRevision: 2 } };
      f.requestBackend.mockImplementation(async (_profile, request) => {
        if (request.operation === "agent_spawn.list") return { result: f.page };
        if (request.operation === "agent_runtime.projection.inspect") return { result: f.runtime };
        if (request.operation === "agent_runtime.native_rehost.reconcile") return { result: published };
        throw new Error(`Unexpected operation: ${request.operation}`);
      });
      const source = f.runtime.receipt.authority.authority;
      const resume = (confirmRestart) => collectRunsCommand({ ...f,
        opts: { rest: ["resume", f.entry.name], ...(confirmRestart ? { confirmRestart } : {}) },
        command: "hmux", run: hmux.run, settle: fakeClock() });
      const publications = () => f.requestBackend.mock.calls.map(([, request]) => request)
        .filter((request) => request.operation === "agent_runtime.native_rehost.reconcile");
      const native = (subcommand) => hmux.calls.filter((argv) => argv[0] === subcommand);
      return { ...f, hmux, resume, publications, native,
        sessionId: source.binding.sessionId, workspaceId: source.runtimeWorkspaceId };
    }

    it("finishes a restart that was still applying with the same command, publishing it once", async () => {
      const f = retainedFixture();
      const first = await f.resume(true);
      expect(first.recovery).toMatchObject({ state: "running", error: { code: "rehost_still_running" } });
      expect(runsCommandExitCode(first)).toBe(MANAGED_REHOST_RUNNING_EXIT_CODE);
      const operationId = first.recovery.continuation.operationId;
      expect(first.recovery.continuation.finish).toEqual(["hmux", "rehost", "finish", f.entry.agentId,
        "--from-session", f.sessionId, "--workspace", f.workspaceId, "--operation-id", operationId,
        "--confirm-restart", "--backend", "local", "--json"]);
      expect(formatRunsCommand(first)).toContain(`Finish: dure 'hmux' 'rehost' 'finish' '${f.entry.agentId}'`);
      // Hmux finishes applying it after the first command stopped waiting.
      f.hmux.complete();
      const finished = await f.resume(true);
      expect(finished).toMatchObject({ ok: true, recovery: { ok: true, state: "completed",
        nativeExecution: "completed", publication: "published",
        continuation: { operationId, retained: { operationId, nativeState: "completed" } } } });
      expect(runsCommandExitCode(finished)).toBe(0);
      // One admission in total; the second command only continued it.
      expect(f.native("managed-rehost-start")).toHaveLength(1);
      expect(f.native("managed-rehost-reconcile")).toEqual([["managed-rehost-reconcile", "--session", f.sessionId,
        "--workspace", f.workspaceId, "--operation-id", operationId, "--confirm-restart", "--json"]]);
      expect(f.publications().map((request) => request.body)).toEqual([{ schemaVersion: 1,
        agentId: f.entry.agentId, operationId, sourceSessionId: f.sessionId, sourceWorkspaceId: f.workspaceId }]);
    });

    it("keeps waiting on the retained operation, never a new one, while Hmux still applies it", async () => {
      const f = retainedFixture();
      const first = await f.resume(true);
      const operationId = first.recovery.continuation.operationId;
      const again = await f.resume(true);
      expect(again).toMatchObject({ ok: false, error: { code: "rehost_still_running" }, recovery: {
        state: "running", nativeExecution: "running", publication: "not_requested",
        continuation: { operationId, retained: { operationId, nativeState: "running" } } } });
      expect(runsCommandExitCode(again)).toBe(MANAGED_REHOST_RUNNING_EXIT_CODE);
      expect(f.native("managed-rehost-start")).toHaveLength(1);
      expect(f.native("managed-rehost-reconcile").map((argv) => argv[6])).toEqual([operationId]);
      expect(f.publications()).toEqual([]);
    });

    it("previews the restart in progress instead of proposing another operation", async () => {
      const f = retainedFixture();
      const operationId = (await f.resume(true)).recovery.continuation.operationId;
      const preview = await f.resume(false);
      expect(preview).toMatchObject({ ok: true, recovery: { state: "preview", nativeExecution: "not_requested",
        continuation: { operationId, retained: { operationId, nativeState: "running" } } } });
      const { continuation } = preview.recovery;
      expect(continuation.start).toEqual(continuation.retry);
      expect(continuation.retry).toEqual(["hmux", "rehost", "retry", f.sessionId, "--workspace", f.workspaceId,
        "--operation-id", operationId, "--confirm-restart", "--json"]);
      const text = formatRunsCommand(preview);
      expect(text).toContain(`Hmux is still applying a restart of this Agent (operation ${operationId})`);
      expect(text).toContain(`Finish: dure 'hmux' 'rehost' 'finish' '${f.entry.agentId}'`);
      expect(continuation.finish).toContain(operationId);
      expect(text).not.toContain("Start:");
      // The preview only read the journal.
      expect(f.native("managed-rehost-start")).toHaveLength(1);
      expect(f.native("managed-rehost-reconcile")).toEqual([]);
    });

    it("publishes a natively completed restart whose binding publication was lost, without rehosting again", async () => {
      const f = retainedFixture();
      const operationId = "operation-held-by-hmux";
      f.hmux.journal.set(`${f.workspaceId}\0${f.sessionId}`, { operationId, state: "completed" });
      const preview = await f.resume(false);
      expect(formatRunsCommand(preview)).toContain(
        `Hmux already restarted this Agent (operation ${operationId}), but its binding is not published yet.`);
      const finished = await f.resume(true);
      expect(finished).toMatchObject({ ok: true, recovery: { state: "completed", publication: "published",
        receipt: { operationId, replayed: true } } });
      expect(f.native("managed-rehost-start")).toEqual([]);
      expect(f.publications().map((request) => request.body.operationId)).toEqual([operationId]);
    });

    it("refuses an operation it cannot match to this exact source instead of starting another", async () => {
      const f = retainedFixture();
      // Latest-successor resolution names a pending operation that does not belong to this source.
      f.hmux.run.mockImplementationOnce(async () => ({ kind: "success", stdout: JSON.stringify({
        schema: "hmux-managed-rehost-resolution-v1", schemaVersion: 1, state: "retry_required",
        code: "hmux_managed_rehost_retry_required", operationId: "later-operation",
        source: { sessionId: f.sessionId, workspaceId: f.workspaceId } }) }));
      const report = await f.resume(true);
      expect(report).toMatchObject({ ok: false, error: { code: "rehost_source_operation_unconfirmed" } });
      expect(report.error.message).toContain("later-operation");
      expect(runsCommandExitCode(report)).toBe(2);
      expect(f.native("managed-rehost-start")).toEqual([]);
      expect(f.native("managed-rehost-reconcile")).toEqual([]);
      expect(f.publications()).toEqual([]);
    });
  });
  it("uses a published successor, and refuses incomplete or unrelated current authority", () => {
    const f = fixture();
    const report = { kind: "dure.agent_spawn.status", receipt: f.receipt };
    const source = f.runtime.receipt.authority.authority;
    source.binding.sessionId = "successor-session";
    source.hostInstanceId = "successor-host";
    f.runtime.receipt.launchIdempotencyKey = "rehost-successor";
    f.runtime.receipt.providerConversationRef = "continued-conversation";
    expect(currentRunPresentationPlan(report, f.runtime)).toMatchObject({
      runtimeGeneration: { sessionId: "successor-session", hostInstanceId: "successor-host" },
      launchIdempotencyKey: "rehost-successor", providerConversationRef: "continued-conversation" });
    delete f.runtime.receipt.launchIdempotencyKey;
    expect(() => currentRunPresentationPlan(report, f.runtime)).toThrow();
    f.runtime.receipt.launchIdempotencyKey = "rehost-successor";
    source.binding.agentId = "another-agent";
    expect(() => currentRunPresentationPlan(report, f.runtime)).toThrow();
  });
});

describe("Run account switching", () => {
  function accountFixture(provider = "claude", kind = "local", mode = "native_cli") {
    const f = fixture();
    f.entry.providerId = provider;
    f.runtime.receipt.providerId = provider;
    f.runtime.projectionContext.agent.providerId = provider;
    f.runtime.receipt.providerConversationRef = "conversation-1";
    f.runtime.receipt.authority.interactionProfile = mode;
    f.backend.profile.transport.kind = kind;
    const profile = { schemaVersion: 1, providerId: provider, referenceId: "work",
      credentialGeneration: "generation-2" };
    f.requestBackend.mockImplementation(async (_backend, request) => {
      if (request.operation === "agent_spawn.list") return { result: f.page };
      if (request.operation === "agent_runtime.projection.inspect") return { result: f.runtime };
      if (request.operation === "provider_recovery.get") return { result: { schemaVersion: 1, profiles: [profile], policy: null } };
      if (request.operation === "agent_runtime.transition") return { result: { schemaVersion: 1, receipt: {
        ...f.runtime.receipt, selectionRevision: 2, executionProfile: request.body.targetExecutionProfile,
      } } };
      throw new Error(`Unexpected operation ${request.operation}`);
    });
    return { ...f, profile, opts: { rest: ["switch-account", f.entry.name], account: "work" } };
  }

  it.each(["claude", "codex"])("previews %s account selection with an exact replay command and no mutations", async (provider) => {
    const f = accountFixture(provider);
    const report = await collectRunsCommand(f);
    expect(report).toMatchObject({ ok: true, accountSwitch: { state: "preview", account: "work",
      providerId: provider, conversationId: "conversation-1", execution: "not_requested" } });
    const c = report.accountSwitch.continuation;
    expect(c.start).toEqual(["runtime", "switch", f.entry.agentId, "terminal", "--account", "work",
      "--credential-generation", "generation-2", "--expected-revision", "1", "--idempotency-key", c.requestId,
      "--backend", "local", "--json"]);
    expect(c.retry).toEqual(c.start);
    expect(c.status).toEqual(["runtime", "get", f.entry.agentId, "--backend", "local", "--json"]);
    expect(f.requestBackend.mock.calls.map((c) => c[1].operation)).toEqual([
      "agent_spawn.list", "agent_runtime.projection.inspect", "provider_recovery.get"]);
    expect(formatRunsCommand(report)).toContain("Apply:");
  });

  it.each(["claude", "codex"].flatMap((provider) => ["local", "ssh"].flatMap((kind) =>
    ["native_cli", "structured_protocol"].map((mode) => [provider, kind, mode]))))(
    "switches %s over %s preserving %s through the existing backend transition", async (provider, kind, mode) => {
      const f = accountFixture(provider, kind, mode);
      const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
      expect(report).toMatchObject({ ok: true, accountSwitch: { state: "completed", execution: "completed" } });
      const transition = f.requestBackend.mock.calls.at(-1)[1];
      expect(transition).toEqual({ requestId: report.accountSwitch.continuation.requestId,
        operation: "agent_runtime.transition", requiredCapabilities: ["agent_runtime.transition"],
        body: { schemaVersion: 1, agentId: f.entry.agentId, targetInteractionProfile: mode,
          expectedSourceRevision: 1, targetExecutionProfile: { kind: "credential_reference",
            reference_id: "work", credential_generation: "generation-2" } } });
      expect(f.requestBackend).toHaveBeenCalledTimes(4);
    },
  );

  it("switches explicitly to provider default without looking up another personal account", async () => {
    const f = accountFixture();
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, account: "default", confirmRestart: true } });
    expect(report.ok).toBe(true);
    expect(f.requestBackend).toHaveBeenCalledTimes(3);
    expect(f.requestBackend.mock.calls.at(-1)[1].body.targetExecutionProfile).toEqual({ kind: "provider_default" });
  });

  it("names the usable registered accounts when the requested one is missing", async () => {
    const f = accountFixture("codex");
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, account: "display-name" } });
    expect(report.accountSwitch.error).toMatchObject({ code: "account_switch_account_unavailable" });
    expect(report.accountSwitch.error.message).toContain("Usable account IDs: work.");
    expect(report.accountSwitch.error.message).toContain("dure recovery get codex --backend local");
  });

  it.each(["missing", "wrong_provider", "malformed", "duplicate"])("refuses %s account evidence before stopping anything", async (problem) => {
    const f = accountFixture();
    if (problem === "wrong_provider") f.profile.providerId = "codex";
    if (problem === "malformed") f.profile.credentialGeneration = "";
    if (problem === "missing") f.profile.referenceId = "another";
    if (problem === "duplicate") {
      const request = f.requestBackend.getMockImplementation();
      f.requestBackend.mockImplementation(async (backend, r) => r.operation === "provider_recovery.get"
        ? { result: { schemaVersion: 1, profiles: [f.profile, f.profile] } } : request(backend, r));
    }
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report.ok).toBe(false);
    expect(f.requestBackend).toHaveBeenCalledTimes(3);
  });

  it.each(["busy", "lost_response", "wrong_account", "wrong_conversation"])("retains exact retry instructions after %s without retrying", async (outcome) => {
    const f = accountFixture();
    const request = f.requestBackend.getMockImplementation();
    f.requestBackend.mockImplementation(async (backend, r) => {
      if (r.operation !== "agent_runtime.transition") return request(backend, r);
      if (outcome === "busy" || outcome === "lost_response") throw new Error(outcome);
      const response = await request(backend, r);
      if (outcome === "wrong_account") response.result.receipt.executionProfile = { kind: "provider_default" };
      else response.result.receipt.providerConversationRef = "another";
      return response;
    });
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report.ok).toBe(false);
    expect(report.accountSwitch.continuation.retry).toEqual(report.accountSwitch.continuation.start);
    expect(formatRunsCommand(report)).toContain("Retry:");
    expect(f.requestBackend).toHaveBeenCalledTimes(4);
  });

  it("lists the background work a busy refusal protects, in text and JSON", async () => {
    const f = accountFixture("claude");
    const request = f.requestBackend.getMockImplementation();
    const backgroundWork = {
      items: [
        { id: "shell-1", kind: "shell", label: "Run the release checks", startedUnixMs: 5 },
        { id: "a7f3", kind: "subagent", label: null, startedUnixMs: 6 },
      ],
      counts: { subagents: 1, workflows: 0, shells: 3, monitors: 0 }, truncated: true,
    };
    f.requestBackend.mockImplementation(async (backend, r) => {
      if (r.operation !== "agent_runtime.transition") return request(backend, r);
      throw new BackendTransportError("backend_transport_remote_error", { details: {
        code: "agent_runtime_source_busy", disposition: "retry_same", reasonCode: "agent_background_work",
        backgroundWork } });
    });
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report.accountSwitch).toMatchObject({ state: "refused", execution: "refused",
      error: { remoteCode: "agent_runtime_source_busy", reasonCode: "agent_background_work", backgroundWork } });
    const text = formatRunsCommand(report);
    expect(text).toContain("Nothing was stopped or switched.");
    expect(text).toContain("Still running in the session (1 subagent, 3 shells):\n" +
      "  shell shell-1: Run the release checks\n  subagent a7f3\n  …and 2 more");
    expect(text).toContain("Retry: dure 'runtime' 'switch'");
  });

  it.each([
    ["claude", "agent_working", "a running turn, or background shells, subagents or scheduled wakeups", true],
    ["claude", "agent_background_work", "turn ended, but background work it started", true],
    ["claude", "agent_attention_required", "waiting for an approval or an answer", false],
    ["codex", "agent_working", "a running turn, or background shells", false],
    ["claude", undefined, "busy or has unsent input", false],
  ])("explains a %s busy refusal (%s) as refused, with the exact retry and no uncertainty", async (provider, reasonCode, reason, claudeHint) => {
    const f = accountFixture(provider);
    const request = f.requestBackend.getMockImplementation();
    f.requestBackend.mockImplementation(async (backend, r) => {
      if (r.operation !== "agent_runtime.transition") return request(backend, r);
      throw new BackendTransportError("backend_transport_remote_error", { details: {
        code: "agent_runtime_source_busy", disposition: "retry_same", ...(reasonCode ? { reasonCode } : {}) } });
    });
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report).toMatchObject({ ok: false, accountSwitch: { state: "refused", execution: "refused",
      error: { remoteCode: "agent_runtime_source_busy", ...(reasonCode ? { reasonCode } : {}) } } });
    const { error, continuation } = report.accountSwitch;
    expect(error.message).toContain(reason);
    expect(error.message).toContain("Nothing was stopped or switched.");
    expect(error.message.includes("Move to background and exit")).toBe(claudeHint);
    expect(continuation.retry).toEqual(continuation.start);
    const text = formatRunsCommand(report);
    expect(text).toContain(`(refused)`);
    expect(text).toContain(`agent_runtime_source_busy${reasonCode ? ` (${reasonCode})` : ""}: `);
    expect(text).toContain("Retry: dure 'runtime' 'switch'");
    expect(text).toContain(continuation.requestId);
    expect(text).toContain("once the session is idle");
    expect(text).not.toContain("After an uncertain response");
    expect(f.requestBackend).toHaveBeenCalledTimes(4);
  });

  it.each(["transitioning", "closed", "unmanaged"])("does not switch an unconfirmed %s runtime", async (state) => {
    const f = accountFixture();
    f.runtime.state = state;
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report.ok).toBe(false);
    expect(f.requestBackend).toHaveBeenCalledTimes(2);
  });

  it("parses account selection only for switch-account", async () => {
    expect(parseRunsOptions(["switch-account", "worker", "--account", "work", "--confirm-restart"]))
      .toMatchObject({ rest: ["switch-account", "worker"], account: "work", confirmRestart: true });
    const f = accountFixture();
    for (const opts of [{ rest: ["switch-account", f.entry.name] }, { rest: ["show", f.entry.name], account: "work" }]) {
      expect((await collectRunsCommand({ ...f, opts })).ok).toBe(false);
    }
    expect(f.requestBackend).not.toHaveBeenCalled();
  });
});


it("opens a committed moved Run at its authoritative destination while retaining spawn provenance", () => {
  const f = fixture();
  const original = structuredClone(f.receipt);
  const sourceAuthority = structuredClone(f.runtime.receipt.authority.authority);
  sourceAuthority.binding.providerConversationId = "same-conversation";
  Object.assign(f.runtime.receipt, { selectionRevision: 2, launchIdempotencyKey: "move-launch", providerConversationRef: "same-conversation" });
  const authority = f.runtime.receipt.authority.authority;
  authority.runtimeWorkspaceId = "move-workspace";
  authority.binding.sessionId = "move-session";
  Object.assign(f.runtime.projectionContext, {
    agent: { ...f.runtime.projectionContext.agent, workspaceId: "move-workspace" },
    workspace: { workspaceId: "move-workspace", projectId: "destination", rootPath: "/destination" },
    project: { projectId: "destination", rootPath: "/destination" },
    workspaceMove: { operationId: "move-operation", committedSelectionRevision: 2, sourceRootPath: "/repo", sourceAuthority },
  });
  const projected = currentRunPresentationPlan({ receipt: f.receipt }, f.runtime);
  expect(projected.plan).toMatchObject({ workspaceId: "move-workspace", authority: { projectId: "destination" } });
  expect(projected.runtimeGeneration.sessionId).toBe("move-session");
  expect(projected.workspace).toEqual({ kind: "project_root" });
  expect(f.receipt).toEqual(original);
  delete f.runtime.projectionContext.workspaceMove;
  expect(() => currentRunPresentationPlan({ receipt: f.receipt }, f.runtime)).toThrow();
});

describe("Agents without a Run record", () => {
  // An app-launched or resumed Agent has a durable backend Agent, a pane and a
  // native runtime, but no spawn receipt. The client projection names it.
  function appAgentFixture({ registryState = "available", observation } = {}) {
    const f = fixture();
    const agentId = "agent-app-resumed";
    const sessionId = "runtime-native-app-1";
    const projectId = "hmux-project:proj-app";
    f.page.runs = [];
    f.runtime.receipt.agentId = agentId;
    f.runtime.receipt.providerId = "claude";
    f.runtime.receipt.selectionRevision = 7;
    f.runtime.receipt.providerConversationRef = "conversation-7";
    f.runtime.receipt.authority.authority.binding.agentId = agentId;
    f.runtime.receipt.authority.authority.binding.sessionId = sessionId;
    f.runtime.projectionContext = { schemaVersion: 1, identity: { kind: "checkpoint_bootstrap", runtimeWorkspaceId: "proj-app" },
      agent: { agentId, providerId: "claude", workspaceId: `agent-workspace:${agentId}` },
      workspace: { workspaceId: `agent-workspace:${agentId}`, projectId, rootPath: "/repo" },
      project: { projectId, rootPath: "/repo" } };
    const registry = { state: registryState, agents: registryState === "available" ? [
      { id: agentId, name: "worker-resumed", displayName: "worker-resumed", project: "project-a", provider: "claude", sessionId },
    ] : [] };
    const profile = { schemaVersion: 1, providerId: "claude", referenceId: "work", credentialGeneration: "generation-2" };
    const current = () => observation ?? f.runtime;
    f.requestBackend.mockImplementation(async (_backend, request) => {
      if (request.operation === "agent_spawn.list") return { result: f.page };
      if (request.operation === "agent_runtime.projection.inspect") {
        return { result: request.body.agentId === agentId ? current()
          : { schemaVersion: 1, state: "unmanaged", agentId: request.body.agentId } };
      }
      if (request.operation === "provider_recovery.get") return { result: { schemaVersion: 1, profiles: [profile], policy: null } };
      if (request.operation === "agent_runtime.transition") return { result: { schemaVersion: 1, receipt: {
        ...f.runtime.receipt, selectionRevision: 8,
        authority: { ...f.runtime.receipt.authority, interactionProfile: request.body.targetInteractionProfile },
        executionProfile: request.body.targetExecutionProfile ?? f.runtime.receipt.executionProfile,
      } } };
      throw new Error(`Unexpected operation ${request.operation}`);
    });
    return { ...f, agentId, sessionId, projectId, registry, loadRegistry: () => registry };
  }
  const operations = (f) => f.requestBackend.mock.calls.map((call) => call[1].operation);

  it.each(["agentId", "sessionId", "name"])("shows an app-resumed Agent selected by its %s", async (key) => {
    const f = appAgentFixture();
    const selector = { agentId: f.agentId, sessionId: f.sessionId, name: "worker-resumed" }[key];
    const report = await collectRunsCommand({ ...f, opts: { rest: ["show", selector] } });
    expect(report).toMatchObject({ ok: true, agent: { agentId: f.agentId, name: "worker-resumed",
      providerId: "claude", projectId: f.projectId }, runtime: f.runtime });
    expect(report.run).toBeUndefined();
    expect(operations(f)).toEqual(["agent_spawn.list", "agent_runtime.projection.inspect"]);
    const text = formatRunsCommand(report);
    expect(text).toContain(`worker-resumed (${f.agentId}): stable runtime selection`);
    expect(text).toContain("No Run record");
    expect(text).toContain(`dure runs switch-account ${f.agentId} --account ACCOUNT_ID`);
    expect(text).not.toContain("Operation:");
  });

  it("switches an app-resumed Agent's account through the UI's backend transition", async () => {
    const f = appAgentFixture();
    const preview = await collectRunsCommand({ ...f, opts: { rest: ["switch-account", "worker-resumed"], account: "work" } });
    expect(preview).toMatchObject({ ok: true, agent: { agentId: f.agentId }, accountSwitch: {
      state: "preview", agentId: f.agentId, conversationId: "conversation-7", execution: "not_requested" } });
    const c = preview.accountSwitch.continuation;
    expect(c.start).toEqual(["runtime", "switch", f.agentId, "terminal", "--account", "work",
      "--credential-generation", "generation-2", "--expected-revision", "7", "--idempotency-key", c.requestId,
      "--backend", "local", "--json"]);
    expect(operations(f)).toEqual(["agent_spawn.list", "agent_runtime.projection.inspect", "provider_recovery.get"]);

    f.requestBackend.mockClear();
    const applied = await collectRunsCommand({ ...f, opts: { rest: ["switch-account", f.sessionId], account: "work", confirmRestart: true } });
    expect(applied).toMatchObject({ ok: true, accountSwitch: { state: "completed", execution: "completed" } });
    expect(f.requestBackend.mock.calls.at(-1)[1]).toEqual({ requestId: applied.accountSwitch.continuation.requestId,
      operation: "agent_runtime.transition", requiredCapabilities: ["agent_runtime.transition"],
      body: { schemaVersion: 1, agentId: f.agentId, targetInteractionProfile: "native_cli", expectedSourceRevision: 7,
        targetExecutionProfile: { kind: "credential_reference", reference_id: "work", credential_generation: "generation-2" } } });
  });

  it("resolves an exact Agent ID through the backend when the client projection is unavailable", async () => {
    const f = appAgentFixture({ registryState: "absent" });
    const report = await collectRunsCommand({ ...f, opts: { rest: ["show", f.agentId] } });
    expect(report).toMatchObject({ ok: true, agent: { agentId: f.agentId, name: null, providerId: "claude" } });
    const missing = await collectRunsCommand({ ...f, opts: { rest: ["show", "worker-resumed"] } });
    expect(missing).toMatchObject({ ok: false, error: { code: "run_not_found" } });
    expect(missing.error.message).toContain("name projection is unavailable");
  });

  it("does not treat an Agent ID the backend does not manage as a target", async () => {
    const f = appAgentFixture();
    const report = await collectRunsCommand({ ...f, opts: { rest: ["switch-account", "agent-elsewhere"], account: "work" } });
    expect(report).toMatchObject({ ok: false, error: { code: "run_not_found" } });
    expect(report.error.message).toContain("no managed runtime on backend local");
    expect(operations(f)).toEqual(["agent_spawn.list", "agent_runtime.projection.inspect"]);
  });

  it("lists every same-named app Agent with its state and an exact retry command, without mutation", async () => {
    const f = appAgentFixture();
    f.registry.agents.push({ id: "agent-app-other", name: "worker-resumed", displayName: "worker-resumed",
      project: "dure", provider: "claude", sessionId: "session-other" });
    const report = await collectRunsCommand({ ...f, opts: { rest: ["switch-account", "worker-resumed"], account: "work", confirmRestart: true } });
    expect(report).toMatchObject({ ok: false, error: { code: "run_selector_ambiguous", candidates: [
      { agentId: f.agentId, name: "worker-resumed", project: "project-a", state: "stable",
        retry: ["runs", "switch-account", f.agentId, "--account", "work", "--backend", "local"] },
      { agentId: "agent-app-other", name: "worker-resumed", project: "dure", state: "unmanaged",
        retry: ["runs", "switch-account", "agent-app-other", "--account", "work", "--backend", "local"] },
    ] } });
    expect(operations(f)).not.toContain("agent_runtime.transition");
    const text = formatRunsCommand(report);
    expect(text).toContain(f.agentId);
    expect(text).toContain("agent-app-other");
    expect(text).toContain(`dure 'runs' 'switch-account' '${f.agentId}' '--account' 'work' '--backend' 'local'`);
  });

  const openTarget = async () => ({ state: "requested", spaceId: "space-1", windowLabel: "main" });
  const appWith = (...capabilities) => ({ capabilities });

  it.each([[undefined], [appWith("agent.run_background_v1")]])(
    "keeps refusing to open an Agent without a Run record when the app lacks the contract (%j)", async (descriptor) => {
      const f = appAgentFixture();
      const presentRuntime = vi.fn();
      const report = await collectRunsCommand({ ...f, opts: { rest: ["open", f.agentId], space: "space-1" },
        resolveTarget: openTarget, descriptor, presentRuntime });
      expect(report).toMatchObject({ ok: false, agent: { agentId: f.agentId }, error: { code: "run_record_required" } });
      expect(report.error.message).toContain("Update the app");
      expect(presentRuntime).not.toHaveBeenCalled();
      expect(operations(f)).toEqual(["agent_spawn.list", "agent_runtime.projection.inspect"]);
    });

  it("opens an app-launched Agent's live runtime through an app with the contract, without a launch", async () => {
    const f = appAgentFixture();
    const presentRuntime = vi.fn(async () => ({ state: "opened", pane: { spaceId: "space-1", panelId: "panel-9" } }));
    const descriptor = appWith(AGENT_RUNTIME_PRESENTATION_CAPABILITY);
    const report = await collectRunsCommand({ ...f, opts: { rest: ["open", "worker-resumed"], space: "space-1" },
      resolveTarget: openTarget, descriptor: () => descriptor, presentRuntime });
    expect(report).toMatchObject({ ok: true, agent: { agentId: f.agentId, name: "worker-resumed" },
      presentation: { state: "opened" } });
    expect(presentRuntime).toHaveBeenCalledWith({ agent: report.agent, currentRuntime: f.runtime,
      target: await openTarget(), profile: f.backend.profile, descriptor });
    // No spawn receipt read, no runtime transition, no provider launch.
    expect(operations(f)).toEqual(["agent_spawn.list", "agent_runtime.projection.inspect"]);
    expect(formatRunsCommand(report)).toBe("worker-resumed: opened space-1/panel-9");
  });

  it("builds the receipt-free request from the backend runtime alone and verifies the pane receipt", async () => {
    const f = appAgentFixture({ registryState: "absent" });
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, pane: { spaceId: "space-1", panelId: "panel-9",
        agentId: body.agentId, sessionId: body.sessionId, workspaceId: body.workspaceId,
        runtime: "hmux_managed_v1", outcome: "created" } }), { status: 200 });
    });
    const descriptor = { schemaVersion: 1, apiVersion: 1, port: 6767, token: "token",
      packageVersion: "0.2.62", buildId: "0.2.62+test", channel: "stable", generation: "generation-1",
      processId: 42, startedAtUnixMs: 1, capabilities: [AGENT_RUNTIME_PRESENTATION_CAPABILITY] };
    const report = await collectRunsCommand({ ...f, opts: { rest: ["open", f.agentId], space: "space-1" },
      resolveTarget: openTarget, descriptor,
      presentRuntime: (options) => presentAgentRuntime({ ...options, fetchImpl }) });
    expect(report).toMatchObject({ ok: true, presentation: { state: "opened",
      pane: { panelId: "panel-9", sessionId: f.sessionId, outcome: "created" } } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/hmux/attach");
    const source = f.runtime.receipt.authority.authority;
    expect(JSON.parse(init.body)).toEqual({
      schemaVersion: 1, runtime: "hmux_managed_v1", identity: "agent_runtime", source: "local", hostId: "local",
      backendProfileId: "local", agentId: f.agentId, agentName: f.agentId, projectId: f.projectId,
      projectPath: "/repo", providerId: "claude", executionProfile: f.runtime.receipt.executionProfile,
      providerConversationRef: "conversation-7", sessionId: f.sessionId, workspaceId: source.runtimeWorkspaceId,
      workspaceRootPath: "/repo", generation: { runnerPrincipal: source.runnerPrincipal,
        runnerInstance: source.runnerInstance, channelEpoch: source.channelEpoch,
        hostInstanceId: source.hostInstanceId, terminalEpoch: source.terminalEpoch },
      permissionMode: f.runtime.receipt.permissionMode, spaceId: "space-1", windowLabel: "main",
    });
  });

  it("refuses a Chat Agent without a Run record before contacting the app", async () => {
    const f = appAgentFixture();
    f.runtime.receipt.authority = { interactionProfile: "structured_protocol",
      binding: { agentId: f.agentId, providerId: "claude", interactionSessionId: "interaction-1" } };
    const fetchImpl = vi.fn();
    const report = await collectRunsCommand({ ...f, opts: { rest: ["open", f.agentId], space: "space-1" },
      resolveTarget: openTarget, descriptor: appWith(AGENT_RUNTIME_PRESENTATION_CAPABILITY),
      presentRuntime: (options) => presentAgentRuntime({ ...options, fetchImpl }) });
    expect(report).toMatchObject({ ok: false, error: { code: "agent_runtime_presentation_unsupported" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a runtime that is not stable or whose binding names another Agent", () => {
    const f = appAgentFixture();
    const options = { agent: { agentId: f.agentId, name: null }, target: { state: "requested", spaceId: "s", windowLabel: "main" },
      profile: f.backend.profile };
    expect(() => agentRuntimePresentationRequest({ ...options,
      currentRuntime: { ...f.runtime, state: "transitioning" } })).toThrow(expect.objectContaining({ code: "client_run_runtime_unavailable" }));
    f.runtime.receipt.authority.authority.binding.agentId = "agent-other";
    expect(() => agentRuntimePresentationRequest({ ...options, currentRuntime: f.runtime }))
      .toThrow(expect.objectContaining({ code: "client_run_runtime_invalid" }));
  });
});

describe("Run selector ambiguity", () => {
  it("lists every matching Run with its project, launch state and exact retry command", async () => {
    const f = fixture();
    const other = { ...f.entry, agentId: "agent-other", projectId: "project-other", launchState: "failed",
      operationId: `${f.entry.operationId}z` };
    f.page.runs.push(other);
    const report = await collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.name], confirmRestart: true }, run: vi.fn() });
    expect(report).toMatchObject({ ok: false, error: { code: "run_selector_ambiguous", candidates: [
      { agentId: f.entry.agentId, name: f.entry.name, projectId: f.entry.projectId, launchState: "succeeded",
        retry: ["runs", "resume", f.entry.agentId, "--backend", "local"] },
      { agentId: "agent-other", projectId: "project-other", launchState: "failed",
        retry: ["runs", "resume", "agent-other", "--backend", "local"] },
    ] } });
    expect(f.requestBackend).toHaveBeenCalledOnce();
    expect(formatRunsCommand(report)).toContain("dure 'runs' 'resume' 'agent-other' '--backend' 'local'");
  });
});

describe("Closed Agents", () => {
  function closedFixture(stage = "stopped") {
    const f = fixture();
    f.entry.providerId = "claude";
    f.runtime.receipt.providerId = "claude";
    f.runtime.projectionContext.agent.providerId = "claude";
    f.runtime.receipt.providerConversationRef = "conversation-closed";
    const closed = { schemaVersion: 1, state: "closed", agentId: f.entry.agentId, operationId: "close-operation",
      stage, projectionContext: f.runtime.projectionContext,
      source: { selectionRevision: 4, interactionProfile: "native_cli",
        launchSelection: { model: null, effort: null, permissionMode: "skip_permissions" } } };
    const profile = { schemaVersion: 1, providerId: "claude", referenceId: "work", credentialGeneration: "generation-2" };
    f.requestBackend.mockImplementation(async (_backend, request) => {
      if (request.operation === "agent_spawn.list") return { result: f.page };
      if (request.operation === "agent_runtime.projection.inspect") return { result: closed };
      if (request.operation === "provider_recovery.get") return { result: { schemaVersion: 1, profiles: [profile], policy: null } };
      if (request.operation === "agent_runtime.transition") return { result: { schemaVersion: 1, receipt: {
        ...f.runtime.receipt, selectionRevision: 5,
        executionProfile: request.body.targetExecutionProfile ?? { kind: "provider_default" } } } };
      throw new Error(`Unexpected operation ${request.operation}`);
    });
    return { ...f, closed, run: vi.fn() };
  }

  it("previews a stopped Agent's restart through the app's backend transition, then applies it once", async () => {
    const f = closedFixture();
    const preview = await collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.name] } });
    expect(preview).toMatchObject({ ok: true, recovery: { state: "preview", backendExecution: "not_requested" } });
    const c = preview.recovery.continuation;
    expect(c).toMatchObject({ kind: "runtime_restart", targetInteractionProfile: "native_cli", expectedSourceRevision: 4 });
    expect(c.start).toEqual(["runtime", "switch", f.entry.agentId, "terminal", "--expected-revision", "4",
      "--idempotency-key", c.requestId, "--backend", "local", "--json"]);
    expect(c.retry).toEqual(c.start);
    expect(formatRunsCommand(preview)).toContain("Restart: dure 'runtime' 'switch'");
    expect(f.requestBackend.mock.calls.map((call) => call[1].operation)).toEqual(["agent_spawn.list", "agent_runtime.projection.inspect"]);

    f.requestBackend.mockClear();
    const applied = await collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.agentId], confirmRestart: true } });
    expect(applied).toMatchObject({ ok: true, recovery: { state: "completed", backendExecution: "completed",
      conversationId: "conversation-closed" } });
    expect(f.requestBackend.mock.calls.at(-1)[1]).toEqual({ requestId: applied.recovery.continuation.requestId,
      operation: "agent_runtime.transition", requiredCapabilities: ["agent_runtime.transition"],
      body: { schemaVersion: 1, agentId: f.entry.agentId, targetInteractionProfile: "native_cli", expectedSourceRevision: 4 } });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("restarts a stopped Agent with another account through the same transition", async () => {
    const f = closedFixture();
    const preview = await collectRunsCommand({ ...f, opts: { rest: ["switch-account", f.entry.name], account: "work" } });
    expect(preview).toMatchObject({ ok: true, accountSwitch: { state: "preview", conversationId: null } });
    expect(preview.accountSwitch.continuation.start).toEqual(["runtime", "switch", f.entry.agentId, "terminal",
      "--account", "work", "--credential-generation", "generation-2", "--expected-revision", "4",
      "--idempotency-key", preview.accountSwitch.continuation.requestId, "--backend", "local", "--json"]);
    const applied = await collectRunsCommand({ ...f, opts: { rest: ["switch-account", f.entry.name], account: "work", confirmRestart: true } });
    expect(applied).toMatchObject({ ok: true, accountSwitch: { state: "completed", conversationId: "conversation-closed" } });
    expect(f.requestBackend.mock.calls.at(-1)[1].body).toMatchObject({ expectedSourceRevision: 4, targetInteractionProfile: "native_cli" });
  });

  it("explains a close that has not stopped instead of a generic source error", async () => {
    const f = closedFixture("admitted");
    const resume = await collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.name], confirmRestart: true } });
    expect(resume).toMatchObject({ ok: false, error: { code: "rehost_native_source_unavailable" } });
    expect(resume.error.message).toContain("close is still in progress");
    const accountSwitch = await collectRunsCommand({ ...f, opts: { rest: ["switch-account", f.entry.name], account: "work", confirmRestart: true } });
    expect(accountSwitch).toMatchObject({ ok: false, error: { code: "account_switch_source_unavailable" } });
    expect(accountSwitch.error.message).toContain("close is still in progress");
    expect(f.requestBackend.mock.calls.map((call) => call[1].operation)).not.toContain("agent_runtime.transition");
  });
});

describe("Resume from a provider conversation ID", () => {
  const CONVERSATION = "019a4c2e-7d3b-7f00-9c11-conversation";
  const CONFLICT = "hmux_managed_conversation_writer_conflict";

  /** Receipts the backend returns for the exact resume request the CLI sends. */
  function conversationFixture({ apply = "succeeded", previewState = "applying", transport = "local", plannedConversation = CONVERSATION } = {}) {
    const planned = canonicalNativeReceipt(spawnRequest({ idempotencyKey: "resume-key-1", agentName: "claude-resume",
      providerId: "claude", worktree: { kind: "project_root" }, interactionPreference: "native_cli",
      providerConversationRef: plannedConversation, promptDigest: null }));
    const plan = planned.plan;
    const launchInputs = { stage: "runtime_launch", agent_id: plan.agentId, workspace_id: plan.workspaceId,
      session_id: plan.launch.sessionId, runtime_kind_id: plan.launch.runtime.runtimeKindId,
      provider_id: "claude", provider_conversation_ref: plannedConversation, permission_mode: plan.request.permissionMode };
    const worktree = { stage: "worktree", attempt: 1, inputs: { stage: "worktree", workspace_id: plan.workspaceId,
      project_root_id: plan.authority.rootId, repository_id: plan.authority.repositoryId, policy: plan.request.worktree },
    evidence: { stage: "worktree", workspace_id: plan.workspaceId, disposition: "adopted_existing" } };
    const succeeded = { ...structuredClone(planned), state: "succeeded", lastSequence: 5, recovery: { kind: "none" },
      completed: [worktree, { stage: "runtime_launch", attempt: 1, inputs: launchInputs, evidence: {
        stage: "runtime_launch", launch_idempotency_key: `spawn-runtime:${plan.operationId}`, session: {
          sessionId: plan.launch.sessionId, workspaceId: plan.workspaceId, providerId: "claude",
          runnerPrincipal: "runner-principal-1", runnerInstance: "runner-instance-1", channelEpoch: "1",
          hostInstanceId: "host-instance-1", terminalEpoch: "terminal-epoch-1" } } }] };
    const refused = { ...structuredClone(planned), state: "retry_required", lastSequence: 4, completed: [worktree],
      recovery: { kind: "retry_required", stage: "runtime_launch", failed_attempt: 1, error_code: CONFLICT, inputs: launchInputs } };
    const receipts = { applying: planned, succeeded, refused };
    const requestBackend = vi.fn(async (_profile, request) => ({ result: { schemaVersion: 1,
      receipt: request.operation === "agent_spawn.preview" ? receipts[previewState] : receipts[apply] } }));
    const backend = { profile: { id: "local", transport: { kind: transport } } };
    const opts = { rest: ["resume"], conversation: CONVERSATION, provider: "claude", project: "dure",
      name: "claude-resume", idempotencyKey: "resume-key-1" };
    return { planned, requestBackend, backend, resolveBackend: async () => backend, opts, currentDirectory: () => "/work/dure" };
  }

  it("previews a new terminal Agent on the exact conversation without launching it", async () => {
    const f = conversationFixture();
    const report = await collectRunsCommand(f);
    expect(report).toMatchObject({ ok: true, conversationResume: { state: "preview", agentId: f.planned.plan.agentId,
      conversationId: CONVERSATION, providerId: "claude", projectId: "dure", account: "default" } });
    expect(f.requestBackend.mock.calls.map((call) => call[1].operation)).toEqual(["agent_spawn.preview"]);
    expect(f.requestBackend.mock.calls[0][1].body).toEqual({ schemaVersion: 1, idempotencyKey: "resume-key-1",
      projectId: "dure", providerId: "claude", executionProfile: { kind: "provider_default" },
      interactionPreference: "native_cli", providerConversationRef: CONVERSATION, agentName: "claude-resume",
      worktree: { kind: "project_root" }, promptDigest: null });
    expect(report.conversationResume.continuation.apply).toEqual(["runs", "resume", "--conversation", CONVERSATION,
      "--provider", "claude", "--project", "dure", "--name", "claude-resume", "--account", "default",
      "--idempotency-key", "resume-key-1", "--confirm-restart", "--backend", "local", "--json"]);
    const text = formatRunsCommand(report);
    expect(text).toContain("Apply: dure 'runs' 'resume' '--conversation'");
    expect(text).toContain("never stops that session");
    expect(runsCommandExitCode(report)).toBe(0);
  });

  it("confirmed resume applies that plan once and prints the new Agent and Session", async () => {
    const f = conversationFixture();
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report).toMatchObject({ ok: true, conversationResume: { state: "completed", execution: "completed",
      agentId: f.planned.plan.agentId, sessionId: f.planned.plan.launch.sessionId } });
    expect(f.requestBackend.mock.calls.map((call) => call[1].operation)).toEqual(["agent_spawn.preview", "agent_spawn.apply"]);
    expect(f.requestBackend.mock.calls[1][1].body).toEqual({ schemaVersion: 1, operationId: f.planned.operationId,
      planToken: f.planned.plan.planToken, expectedLastSequence: f.planned.lastSequence, prompt: null });
    const text = formatRunsCommand(report);
    expect(text).toContain(`Agent: ${f.planned.plan.agentId}`);
    expect(text).toContain(`Open: dure runs open ${f.planned.plan.agentId} --space <space-id>`);
    expect(runsCommandExitCode(report)).toBe(0);
  });

  it("reports a replayed successful plan without launching again", async () => {
    const f = conversationFixture({ previewState: "succeeded" });
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report.conversationResume.state).toBe("completed");
    expect(f.requestBackend).toHaveBeenCalledOnce();
  });

  it("refuses a conversation another session holds and keeps the same Apply as the retry", async () => {
    const f = conversationFixture({ apply: "refused" });
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report).toMatchObject({ ok: false, error: { code: CONFLICT },
      conversationResume: { state: "refused", execution: "refused" } });
    expect(report.conversationResume.error.message).toContain("left running");
    const text = formatRunsCommand(report);
    expect(text).toContain("Retry: dure 'runs' 'resume' '--conversation'");
    expect(text).toContain("'--idempotency-key' 'resume-key-1'");
    expect(runsCommandExitCode(report)).toBe(2);
  });

  it("never applies a plan the backend did not bind to the requested conversation", async () => {
    const f = conversationFixture({ plannedConversation: "another-conversation" });
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, confirmRestart: true } });
    expect(report.ok).toBe(false);
    expect(f.requestBackend.mock.calls.map((call) => call[1].operation)).toEqual(["agent_spawn.preview"]);
  });

  it("selects the project from the current directory on a local backend only", async () => {
    const local = conversationFixture();
    const { project: _project, ...withoutProject } = local.opts;
    await collectRunsCommand({ ...local, opts: withoutProject });
    expect(local.requestBackend.mock.calls[0][1].body).toMatchObject({ projectPath: "/work/dure" });
    expect(local.requestBackend.mock.calls[0][1].body.projectId).toBeUndefined();
    const remote = conversationFixture({ transport: "ssh" });
    const refused = await collectRunsCommand({ ...remote, opts: withoutProject });
    expect(refused).toMatchObject({ ok: false, error: { code: "runs_request_invalid" } });
    expect(remote.requestBackend).not.toHaveBeenCalled();
  });

  it.each([
    { provider: undefined }, { rest: ["resume", "worker"] }, { rest: ["show"] }, { cwd: "/work" },
    { path: "/work", project: "dure" }, { space: "desk" }, { conversation: "bad conversation" },
  ])("refuses an incomplete or mixed request before contacting the backend: %j", async (change) => {
    const f = conversationFixture();
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, ...change } });
    expect(report.ok).toBe(false);
    expect(report.error.code).toBe("runs_request_invalid");
    expect(f.requestBackend).not.toHaveBeenCalled();
  });

  it("keeps resume of an existing Agent in its own workspace", () => {
    expect(parseRunsOptions(["resume", "--conversation", CONVERSATION, "--provider", "claude", "--project", "dure"]))
      .toMatchObject({ conversation: CONVERSATION, provider: "claude", project: "dure", rest: ["resume"] });
    expect(() => parseRunsOptions(["resume", "worker", "--project", "dure"]))
      .toThrow(expect.objectContaining({ code: "conversation_project_move_unsupported" }));
  });

  it("refuses conversation options on other Run actions", async () => {
    const f = fixture();
    const report = await collectRunsCommand({ ...f, opts: { ...f.opts, provider: "claude" } });
    expect(report).toMatchObject({ ok: false, error: { code: "runs_request_invalid" } });
    expect(f.requestBackend).not.toHaveBeenCalled();
  });
});
