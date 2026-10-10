import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { collectAgentProjectMove, formatAgentProjectMove } from "../cli/lib/agent-project-move-command.mjs";
import { collectRunsCommand, parseRunsOptions } from "../cli/lib/runs-command.mjs";
import { collectAgentRuntimeCommand, RUNTIME_HELP } from "../cli/lib/agent-runtime-command.mjs";
import { nativeRuntimeReceipt } from "../src/test/dureAgentRuntimeFixtures.ts";
import { installRemoteBackendFixture } from "./lib/dure-cli-ssh-fixture.mjs";
import { assertNoConversationProjectOptions } from "../cli/lib/conversation-project-options.mjs";

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
  it("executes the generated repair command through the CLI with its source revision and unchanged credentials", async () => {
    const f = fixture();
    f.backend.profile.id = "remote-build";
    const preview = await collectAgentProjectMove(f);
    const root = mkdtempSync(join(tmpdir(), "dure-project-move-repair."));
    try {
      const remote = installRemoteBackendFixture(root, [], {
        capabilities: ["agent_runtime.transition"],
        results: { "agent_runtime.transition": { schemaVersion: 1,
          receipt: { ...nativeRuntimeReceipt({ kind: "credential_reference", reference_id: "retained-account", credential_generation: "generation-1" }, 8, "repair-1"), providerId: "codex" } } },
      });
      const run = spawnSync(process.execPath, [fileURLToPath(new URL("../cli/dure.mjs", import.meta.url)),
        ...preview.continuation.rollback], {
        encoding: "utf8", timeout: 15_000,
        env: { ...process.env, HOME: root, DURE_HOME: root,
          HMUX_DISCOVERY_ROOT: join(root, "discovery"), DURE_APP_CHANNEL: "stable",
          DURE_SESSION_REQUEST_LOG: remote.requestLog,
          DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
          DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
          PATH: `${remote.bin}:${process.env.PATH}` },
      });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, result: { receipt: {
        executionProfile: { kind: "credential_reference", reference_id: "retained-account" },
      } } });
      const requests = readFileSync(remote.requestLog, "utf8").trim().split("\n").map(JSON.parse);
      const transition = requests.find((request) => request.operation === "agent_runtime.transition");
      expect(transition).toMatchObject({ requestId: "rollback-request-1", body: {
        schemaVersion: 1, agentId: "agent-1", targetInteractionProfile: "native_cli", expectedSourceRevision: 7,
      } });
      expect(transition.body).not.toHaveProperty("targetExecutionProfile");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an invalid repair revision %s before backend access", async (expectedRevision) => {
      const resolveBackend = vi.fn();
      const report = await collectAgentRuntimeCommand({ args: ["switch", "agent-1", "terminal"], expectedRevision, resolveBackend });
      expect(report).toMatchObject({ ok: false, error: { code: "runtime_command_invalid" } });
      expect(resolveBackend).not.toHaveBeenCalled();
    },
  );
  it("documents the supported move separately from source-folder recovery", () => {
    expect(RUNTIME_HELP).toContain("dure runs move");
    expect(RUNTIME_HELP).toContain("--expected-revision");
    expect(RUNTIME_HELP).not.toContain("Moving an\nexisting conversation to another project is not supported");
    expect(() => assertNoConversationProjectOptions({ projectSpecified: true })).toThrow("dure runs move AGENT --project PROJECT --json");
  });
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
