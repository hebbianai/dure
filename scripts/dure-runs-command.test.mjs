import { describe, expect, it, vi } from "vitest";
import { collectRunsCommand, formatRunsCommand, parseRunsOptions } from "../cli/lib/runs-command.mjs";
import { currentRunPresentationPlan } from "../cli/lib/run-presentation.mjs";
import { succeededNativeReceipt } from "./fixtures/agent-spawn-receipts.mjs";

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
  it.each(["ambiguous", "partial", "missing"])("refuses %s selection before runtime or mutations", async (kind) => {
    const f = fixture();
    if (kind === "missing") f.page.runs = [];
    else if (kind === "ambiguous") f.page.runs.push({ ...f.entry, agentId: "other", operationId: `${f.entry.operationId}z` });
    else f.page.nextCursor = "untrusted";
    expect(await collectRunsCommand(f)).toMatchObject({ ok: false });
    expect(f.requestBackend).toHaveBeenCalledOnce();
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
    const run = vi.fn();
    const report = await collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.name] }, run });
    expect(report).toMatchObject({ ok: true, recovery: { state: "preview", agentId: f.entry.agentId } });
    expect(run).not.toHaveBeenCalled();
    expect(report.recovery.continuation.start).toContain(f.runtime.receipt.authority.authority.binding.sessionId);
  });
  it("retains exact recovery commands after uncertain execution without another launch", async () => {
    const f = fixture();
    const run = vi.fn(async () => ({ kind: "timeout" }));
    const report = await collectRunsCommand({ ...f, opts: { rest: ["resume", f.entry.name], confirmRestart: true }, command: "hmux", run });
    expect(report).toMatchObject({ ok: false, recovery: { state: "unknown", publication: "not_requested" } });
    expect(run).toHaveBeenCalledOnce();
    expect(report.recovery.continuation.retry).toContain(report.recovery.continuation.operationId);
    expect(f.requestBackend).toHaveBeenCalledTimes(2);
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
