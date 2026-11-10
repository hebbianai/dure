import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import {
  DELEGATE_ONCE_CONTRIBUTION_ID,
  WorkflowDelegationFailure,
  delegateWorkflowTask,
  formatWorkflowDelegation,
  formatWorkflowDelegationError,
  normalizeDelegatedTask,
  workflowDelegationErrorReport,
} from "../cli/lib/workflow-delegation.mjs";

const digest = "c".repeat(64);
const environment = Object.freeze({
  HMUX_SESSION_ID: "session.lead-1",
  HMUX_WORKSPACE_ID: "workspace.project-1",
  HMUX_RUNNER_PRINCIPAL: "principal.lead-1",
  HMUX_RUNNER_INSTANCE: "instance.lead-1",
  HMUX_CHANNEL_EPOCH: "channel.21",
  HMUX_HOST_INSTANCE_ID: "host.22",
  HMUX_TERMINAL_EPOCH: "terminal.23",
});
const stopFence = Object.freeze({
  runnerPrincipal: environment.HMUX_RUNNER_PRINCIPAL,
  runnerInstance: environment.HMUX_RUNNER_INSTANCE,
  channelEpoch: environment.HMUX_CHANNEL_EPOCH,
  hostInstanceId: environment.HMUX_HOST_INSTANCE_ID,
  terminalEpoch: environment.HMUX_TERMINAL_EPOCH,
});
const profile = Object.freeze({ id: "local", transport: { kind: "local" } });
const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const workerSession = Object.freeze({
  sessionId: `workflow-${digest.slice(0, 32)}`,
  workspaceId: environment.HMUX_WORKSPACE_ID,
  providerId: "claude",
  runnerPrincipal: "principal.worker-1",
  runnerInstance: "instance.worker-1",
  channelEpoch: "channel.31",
  hostInstanceId: "host.22",
  terminalEpoch: "terminal.33",
});

function registryAgent(overrides = {}) {
  return {
    id: "agent-lead",
    name: "lead",
    displayName: "Lead",
    project: "dure",
    sessionId: environment.HMUX_SESSION_ID,
    kind: "pty",
    provider: "claude",
    worktree: "/work/dure",
    branch: "main",
    runtimeBinding: {
      schemaVersion: 1,
      runtime: "hmux_managed_v1",
      source: "local",
      hostId: "local",
      sessionId: environment.HMUX_SESSION_ID,
      workspaceId: environment.HMUX_WORKSPACE_ID,
      stopFence,
    },
    ...overrides,
  };
}

function registry(agents = [registryAgent()]) {
  return { state: "available", clientId: null, updatedAtMs: 1, agents };
}

function sessionReport(providerId = "claude") {
  return {
    kind: "dure.sessions.show",
    complete: true,
    session: {
      sessionId: environment.HMUX_SESSION_ID,
      workspaceId: environment.HMUX_WORKSPACE_ID,
      provider: { id: providerId },
      runtime: {
        source: "hmux_host",
        sessionClass: "managed",
        generation: stopFence,
      },
      liveness: {
        state: "alive",
        health: "healthy",
        exactGeneration: true,
        manifestLifecycle: "ready",
        effectiveLifecycle: "ready",
      },
    },
  };
}

function delegateReceipt(body, overrides = {}) {
  return {
    schemaVersion: 1,
    idempotencyKey: body.idempotencyKey,
    runId: `run.${digest}`,
    taskId: `task.${digest}`,
    dispatchId: `dispatch.${digest}`,
    generation: 1,
    status: "active",
    launchIdempotencyKey: `workflow:${digest}`,
    session: { ...workerSession, providerId: body.providerId },
    promptDelivery: {
      idempotencyKey: `prompt-${digest.slice(0, 16)}`,
      state: "written_to_pty",
      evidence: {},
    },
    createdAtMs: body.createdAtMs,
    updatedAtMs: body.createdAtMs + 5,
    ...overrides,
  };
}

function fixture({
  report = sessionReport(),
  receipt = {},
  delegateError,
  agents,
} = {}) {
  const requestBackend = vi.fn(async (_profile, request) => {
    if (request.operation === "agent_checkpoint.binding.ensure") {
      return {
        result: {
          schemaVersion: 1,
          identity: {
            agentId: request.body.agentId,
            sessionId: request.body.sessionId,
            bindingGeneration: 4,
          },
        },
      };
    }
    if (delegateError) throw delegateError;
    return {
      result: { schemaVersion: 1, receipt: delegateReceipt(request.body, receipt) },
    };
  });
  return {
    environment,
    backend: { managedLocal: true, profile },
    registry: registry(agents),
    collectSession: vi.fn(async () => report),
    requestBackend,
    now: () => 1_794_000_000_000,
    random: () => "0123456789abcdef",
  };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the delegation to fail");
}

describe("dure workflow delegate", () => {
  it("documents delegation next to done and show", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "workflow"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "dure workflow delegate --summary <text> (--file PATH | --stdin | --instructions <text>)",
    );
    expect(result.stdout).toContain("--idempotency-key");
  });

  it.each([
    [["--instructions", "Do it"]],
    [["--summary", "Fix", "--instructions", "Do it", "--stdin"]],
    [["--summary", "Fix", "--instructions", "Do it", "--backend", "local"]],
    [["--summary", "Fix", "--instructions", "Do it", "--task", `task.${digest}`]],
    [["--summary", "Fix", "--instructions", "Do it", "extra"]],
  ])("refuses an incomplete or mixed request before any backend: %j", (args) => {
    const result = spawnSync(
      process.execPath,
      [cliPath, "workflow", "delegate", ...args],
      { encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dure workflow — delegated workflow control");
  });

  it("keeps delegate-only flags off done", () => {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "workflow",
        "done",
        "--task",
        `task.${digest}`,
        "--dispatch",
        `dispatch.${digest}`,
        "--generation",
        "1",
        "--summary",
        "Fix",
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dure workflow — delegated workflow control");
  });

  it("refuses a caller outside an Hmux Session before bootstrapping the backend", () => {
    const root = mkdtempSync(join(tmpdir(), "dure-workflow-delegate-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "workflow",
          "delegate",
          "--summary",
          "Fix",
          "--instructions",
          "Do it",
          "--json",
        ],
        { encoding: "utf8", env: { DURE_HOME: root, PATH: process.env.PATH } },
      );
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr).error.code).toBe(
        "workflow_delegate_environment_invalid",
      );
      expect(existsSync(join(root, "backend"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds the calling Agent and starts one worker with the app's request", async () => {
    const options = fixture();
    const report = await delegateWorkflowTask({
      ...options,
      summary: "  Fix the flaky test  ",
      instructions: "Line one\r\nLine two\r\n",
    });

    expect(options.collectSession).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "show",
        sessionId: environment.HMUX_SESSION_ID,
        workspaceId: environment.HMUX_WORKSPACE_ID,
      }),
    );
    const [[, binding, bindingOptions], [, delegate, delegateOptions]] =
      options.requestBackend.mock.calls;
    expect(binding).toEqual({
      body: {
        schemaVersion: 1,
        agentId: "agent-lead",
        sessionId: environment.HMUX_SESSION_ID,
        workspaceId: environment.HMUX_WORKSPACE_ID,
        displayName: "Lead",
        worktreePath: "/work/dure",
        stopFence,
      },
      operation: "agent_checkpoint.binding.ensure",
      requiredCapabilities: ["agent_checkpoint.binding.ensure"],
    });
    expect(bindingOptions.deadlineMs).toBe(20_000);
    expect(delegate).toEqual({
      body: {
        schemaVersion: 1,
        contributionId: DELEGATE_ONCE_CONTRIBUTION_ID,
        coordinator: {
          agentId: "agent-lead",
          sessionId: environment.HMUX_SESSION_ID,
          bindingGeneration: 4,
        },
        task: { summary: "Fix the flaky test", instructions: "Line one\nLine two" },
        providerId: "claude",
        runtimeKindId: "runtime.hmux",
        targetReference: "backend-profile:local",
        idempotencyKey: "delegate-once-1794000000000-0123456789abcdef",
        createdAtMs: 1_794_000_000_000,
      },
      operation: "workflow.delegate_once",
      requiredCapabilities: ["workflow.delegate_once"],
    });
    expect(delegateOptions.deadlineMs).toBe(185_000);

    expect(report).toMatchObject({
      kind: "dure.workflow.delegate",
      apiVersion: "dure.workflow/v1",
      idempotencyKey: "delegate-once-1794000000000-0123456789abcdef",
      coordinator: { agentId: "agent-lead", bindingGeneration: 4 },
      providerId: "claude",
      taskId: `task.${digest}`,
      dispatchId: `dispatch.${digest}`,
      generation: 1,
      status: "active",
      worker: workerSession,
    });
    const text = formatWorkflowDelegation(report);
    expect(text).toContain(
      `dure wait --task task.${digest} --dispatch dispatch.${digest} --generation 1`,
    );
    expect(text).toContain(
      `dure read ${workerSession.sessionId} --workspace ${workerSession.workspaceId}`,
    );
  });

  it("replays the exact request from an idempotency key", async () => {
    const options = fixture({ receipt: { status: "completed", result: "Done." } });
    const report = await delegateWorkflowTask({
      ...options,
      summary: "Fix",
      instructions: "Do it",
      providerId: "codex",
      idempotencyKey: "delegate-once-1793000000123-fedcba9876543210",
    });
    const delegate = options.requestBackend.mock.calls[1][1].body;
    expect(delegate.idempotencyKey).toBe("delegate-once-1793000000123-fedcba9876543210");
    expect(delegate.createdAtMs).toBe(1_793_000_000_123);
    expect(delegate.providerId).toBe("codex");
    expect(report.status).toBe("completed");
    expect(report.receipt.result).toBe("Done.");
  });

  it.each([
    ["delegate-once-abc-0123456789abcdef"],
    ["delegate-once-1793000000123-XYZ"],
    ["another-key"],
  ])("refuses a key it did not issue: %s", async (idempotencyKey) => {
    const options = fixture();
    const error = await failure(
      delegateWorkflowTask({ ...options, summary: "Fix", instructions: "Do", idempotencyKey }),
    );
    expect(error.code).toBe("workflow_delegate_request_invalid");
    expect(options.collectSession).not.toHaveBeenCalled();
  });

  it.each([
    ["no Agent", [], "workflow_delegate_coordinator_unregistered"],
    [
      "two Agents",
      [registryAgent(), registryAgent({ id: "agent-other" })],
      "workflow_delegate_coordinator_ambiguous",
    ],
    [
      "a delegated worker",
      [registryAgent({ id: `agent-workflow-${digest}` })],
      "workflow_delegate_nested_unsupported",
    ],
    [
      "a relative worktree",
      [registryAgent({ worktree: "dure" })],
      "workflow_delegate_coordinator_invalid",
    ],
    [
      "another workspace",
      [
        registryAgent({
          runtimeBinding: {
            ...registryAgent().runtimeBinding,
            workspaceId: "workspace.other",
          },
        }),
      ],
      "workflow_delegate_coordinator_unregistered",
    ],
  ])("refuses %s as coordinator before any backend effect", async (_label, agents, code) => {
    const options = fixture({ agents });
    const error = await failure(
      delegateWorkflowTask({ ...options, summary: "Fix", instructions: "Do it" }),
    );
    expect(error.code).toBe(code);
    expect(options.requestBackend).not.toHaveBeenCalled();
  });

  it("refuses a provider that cannot run delegated work", async () => {
    const options = fixture({ report: sessionReport("kimi") });
    const error = await failure(
      delegateWorkflowTask({ ...options, summary: "Fix", instructions: "Do it" }),
    );
    expect(error.code).toBe("workflow_delegate_provider_unsupported");
    expect(error.details.supported).toEqual(expect.arrayContaining(["claude", "codex"]));
    expect(options.requestBackend).not.toHaveBeenCalled();
  });

  it("refuses a remote backend and a stale Session generation", async () => {
    const remote = fixture();
    const remoteError = await failure(
      delegateWorkflowTask({
        ...remote,
        backend: { managedLocal: false, profile: { id: "remote", transport: { kind: "ssh" } } },
        summary: "Fix",
        instructions: "Do it",
      }),
    );
    expect(remoteError.code).toBe("workflow_delegate_backend_local_required");

    const stale = sessionReport();
    stale.session.runtime.generation = { ...stopFence, terminalEpoch: "terminal.99" };
    const staleOptions = fixture({ report: stale });
    const staleError = await failure(
      delegateWorkflowTask({ ...staleOptions, summary: "Fix", instructions: "Do it" }),
    );
    expect(staleError.code).toBe("workflow_delegate_session_mismatch");
    expect(staleOptions.requestBackend).not.toHaveBeenCalled();
  });

  it("reports a worker that could not start as terminal, without a retry hint", async () => {
    const options = fixture({
      receipt: {
        status: "start_failed",
        session: undefined,
        promptDelivery: undefined,
        startErrorCode: "workflow_provider_unavailable",
      },
    });
    const error = await failure(
      delegateWorkflowTask({ ...options, summary: "Fix", instructions: "Do it" }),
    );
    expect(error).toBeInstanceOf(WorkflowDelegationFailure);
    const report = workflowDelegationErrorReport(error, profile);
    expect(report.error).toMatchObject({
      code: "workflow_delegate_start_failed",
      startErrorCode: "workflow_provider_unavailable",
      disposition: "terminal",
      idempotencyKey: "delegate-once-1794000000000-0123456789abcdef",
    });
    expect(formatWorkflowDelegationError(report)).not.toContain("--idempotency-key");
  });

  it("keeps the key for a retry when the worker is still starting", async () => {
    const options = fixture({
      receipt: { status: "starting", session: undefined, promptDelivery: undefined },
    });
    const report = workflowDelegationErrorReport(
      await failure(delegateWorkflowTask({ ...options, summary: "Fix", instructions: "Do it" })),
      profile,
    );
    expect(report.error.code).toBe("workflow_delegate_start_uncertain");
    expect(formatWorkflowDelegationError(report)).toContain(
      "--idempotency-key delegate-once-1794000000000-0123456789abcdef",
    );
  });

  it("keeps the key and the backend's reason when the backend refuses", async () => {
    const options = fixture({
      delegateError: new BackendTransportError("backend_transport_remote_error", {
        details: { code: "workflow_coordinator_binding_mismatch", disposition: "retry_same" },
      }),
    });
    const report = workflowDelegationErrorReport(
      await failure(delegateWorkflowTask({ ...options, summary: "Fix", instructions: "Do it" })),
      profile,
    );
    expect(report.error).toMatchObject({
      code: "backend_transport_remote_error",
      remoteCode: "workflow_coordinator_binding_mismatch",
      disposition: "retry_same",
      idempotencyKey: "delegate-once-1794000000000-0123456789abcdef",
    });
    expect(formatWorkflowDelegationError(report)).toContain(
      "(workflow_coordinator_binding_mismatch)",
    );
  });

  it("refuses a receipt for another provider or workspace", async () => {
    const options = fixture({
      receipt: { session: { ...workerSession, providerId: "codex" } },
    });
    const error = await failure(
      delegateWorkflowTask({ ...options, summary: "Fix", instructions: "Do it" }),
    );
    expect(error.cause.code).toBe("workflow_delegate_receipt_invalid");
  });

  it.each([
    [{ summary: "", instructions: "Do it" }, "workflow_delegate_summary_invalid"],
    [{ summary: "Two\nlines", instructions: "Do it" }, "workflow_delegate_summary_invalid"],
    [{ summary: "x".repeat(513), instructions: "Do it" }, "workflow_delegate_summary_invalid"],
    [{ summary: "Fix", instructions: "  \n " }, "workflow_delegate_instructions_invalid"],
    [{ summary: "Fix", instructions: "bell\u0007" }, "workflow_delegate_instructions_invalid"],
    [
      { summary: "Fix", instructions: "x".repeat(16 * 1024 + 1) },
      "workflow_delegate_instructions_invalid",
    ],
  ])("refuses task text the backend would reject: %#", (task, code) => {
    expect(() => normalizeDelegatedTask(task)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("keeps tabs and newlines in instructions", () => {
    expect(
      normalizeDelegatedTask({ summary: "Fix", instructions: "a\tb\r\nc\rd" }),
    ).toEqual({ summary: "Fix", instructions: "a\tb\nc\nd" });
  });
});
