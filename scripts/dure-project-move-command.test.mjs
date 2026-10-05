import { describe, it, expect, vi } from "vitest";
import { collectAgentProjectMove, formatAgentProjectMove } from "../cli/lib/agent-project-move-command.mjs";
import { collectRunsCommand, parseRunsOptions } from "../cli/lib/runs-command.mjs";

function fixture() {
  const plan = { schemaVersion: 1, operationId: "move-1", idempotencyKey: "request-1",
    source: { agentId: "agent-1", providerId: "codex", revision: 7 }, targetInteractionProfile: "native_cli",
    providerConversationRef: "conversation-1", workspaceMove: {
      sourceAgent: { agentId: "agent-1" }, sourceWorkspace: { projectId: "old", rootPath: "/old" },
      targetProject: { projectId: "new" }, targetWorkspace: { projectId: "new", workspaceId: "new-workspace", rootPath: "/new" } } };
  const backend = { profile: { id: "remote-owner", transport: { kind: "ssh" } } };
  const requestBackend = vi.fn(async (_, request) => ({ result: request.operation.endsWith("preview.v1")
    ? { schemaVersion: 1, plan, requiresRestartConfirmation: true }
    : { schemaVersion: 1, receipt: { agentId: "agent-1", providerConversationRef: "conversation-1",
      authority: { authority: { runtimeWorkspaceId: "new-workspace" } } } } }));
  return { agentId: "agent-1", projectId: "new", backend, requestBackend, plan };
}

describe("conversation project move command", () => {
  it("previews without effects and carries the exact source revision and owning backend into apply", async () => {
    const f = fixture();
    const preview = await collectAgentProjectMove(f);
    expect(preview).toMatchObject({ ok: true, state: "preview", execution: "not_requested" });
    expect(f.requestBackend).toHaveBeenCalledOnce();
    expect(f.requestBackend.mock.calls[0][1].requiredCapabilities).toEqual([
      "agent_runtime.project_move.preview.v1", "agent_runtime.project_move.apply.v1"]);
    const opts = parseRunsOptions(preview.continuation.apply.slice(1));
    const apply = await collectRunsCommand({ opts, resolveBackend: async () => f.backend, requestBackend: f.requestBackend });
    expect(apply).toMatchObject({ ok: true, projectMove: { state: "completed" } });
    expect(f.requestBackend.mock.calls[1][1]).toMatchObject({ operation: "agent_runtime.project_move.apply.v1",
      requestId: "request-1", body: { plan: f.plan, confirmRestart: true } });
    expect(formatAgentProjectMove(preview)).toContain("From: old — /old");
  });
  it("requires a reviewed plan before restart", async () => {
    const f = fixture();
    const result = await collectRunsCommand({ opts: parseRunsOptions(["move", "agent-1", "--project", "new", "--confirm-restart"]),
      resolveBackend: vi.fn(), requestBackend: f.requestBackend });
    expect(result.ok).toBe(false);
    expect(f.requestBackend).not.toHaveBeenCalled();
  });
  it("retains the same plan after response loss without repeating preview or launching again", async () => {
    const f = fixture(); const preview = await collectAgentProjectMove(f);
    f.requestBackend.mockRejectedValue(new Error("response lost"));
    const opts = parseRunsOptions(preview.continuation.apply.slice(1));
    const result = await collectAgentProjectMove({ ...f, movePlan: opts.movePlan, confirmRestart: opts.confirmRestart });
    expect(result).toMatchObject({ ok: false, execution: "unconfirmed" });
    expect(result.continuation.retry).toEqual(preview.continuation.retry);
    expect(f.requestBackend).toHaveBeenCalledTimes(2);
  });
  it("rejects switching the backend of an existing preview before effects", async () => {
    const f = fixture(); const preview = await collectAgentProjectMove(f);
    const opts = parseRunsOptions(preview.continuation.apply.slice(1));
    const result = await collectAgentProjectMove({ ...f, movePlan: opts.movePlan, confirmRestart: opts.confirmRestart, backend: { profile: { id: "other-host" } } });
    expect(result.ok).toBe(false); expect(f.requestBackend).toHaveBeenCalledOnce();
  });
  it("rejects a target response that did not preserve conversation identity", async () => {
    const f = fixture(); const preview = await collectAgentProjectMove(f);
    f.requestBackend.mockResolvedValue({ result: { schemaVersion: 1, receipt: { agentId: "agent-1", providerConversationRef: "fresh" } } });
    const opts = parseRunsOptions(preview.continuation.apply.slice(1));
    const result = await collectAgentProjectMove({ ...f, movePlan: opts.movePlan, confirmRestart: opts.confirmRestart });
    expect(result).toMatchObject({ ok: false, execution: "unconfirmed" });
  });
  it("keeps unsupported destination flags rejected on ordinary resume", () => {
    expect(() => parseRunsOptions(["resume", "agent-1", "--project", "new"])).toThrow();
  });
});
