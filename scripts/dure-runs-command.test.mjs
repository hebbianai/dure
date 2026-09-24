import { describe, expect, it, vi } from "vitest";
import { collectRunsCommand, formatRunsCommand } from "../cli/lib/runs-command.mjs";
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

describe("durable Run commands", () => {
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
