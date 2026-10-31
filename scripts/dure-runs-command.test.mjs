import { describe, expect, it, vi } from "vitest";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
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

  it("refuses to open an Agent without a Run record and names the gap", async () => {
    const f = appAgentFixture();
    const report = await collectRunsCommand({ ...f, opts: { rest: ["open", f.agentId], space: "space-1" },
      resolveTarget: async () => ({ state: "requested", spaceId: "space-1", windowLabel: "main" }) });
    expect(report).toMatchObject({ ok: false, agent: { agentId: f.agentId }, error: { code: "run_record_required" } });
    expect(operations(f)).toEqual(["agent_spawn.list", "agent_runtime.projection.inspect"]);
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
