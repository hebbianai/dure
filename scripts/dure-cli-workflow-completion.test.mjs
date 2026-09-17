import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  WorkflowCompletionError,
  completeDelegatedWorkflow,
  currentHmuxSessionGeneration,
  readDelegatedWorkflow,
} from "../cli/lib/workflow-completion.mjs";
import {
  identityFileAuth,
  sshBackendProfile,
} from "./lib/dure-cli-ssh-fixture.mjs";

const taskId = `task.${"a".repeat(64)}`;
const dispatchId = `dispatch.${"b".repeat(64)}`;
const environment = Object.freeze({
  HMUX_SESSION_ID: "session.worker-1",
  HMUX_WORKSPACE_ID: "workspace.project-1",
  HMUX_RUNNER_PRINCIPAL: "principal.worker-1",
  HMUX_RUNNER_INSTANCE: "instance.worker-1",
  HMUX_CHANNEL_EPOCH: "channel.11",
  HMUX_HOST_INSTANCE_ID: "host.12",
  HMUX_TERMINAL_EPOCH: "terminal.13",
});
const session = Object.freeze({
  sessionId: environment.HMUX_SESSION_ID,
  workspaceId: environment.HMUX_WORKSPACE_ID,
  providerId: "codex",
  runnerPrincipal: environment.HMUX_RUNNER_PRINCIPAL,
  runnerInstance: environment.HMUX_RUNNER_INSTANCE,
  channelEpoch: environment.HMUX_CHANNEL_EPOCH,
  hostInstanceId: environment.HMUX_HOST_INSTANCE_ID,
  terminalEpoch: environment.HMUX_TERMINAL_EPOCH,
});
const profile = Object.freeze({
  id: "local",
  transport: { kind: "local" },
});
const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));

function sessionReport(overrides = {}) {
  return {
    kind: "dure.sessions.show",
    complete: true,
    session: {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      provider: { id: session.providerId },
      runtime: {
        source: "hmux_host",
        sessionClass: "managed",
        generation: {
          runnerPrincipal: session.runnerPrincipal,
          runnerInstance: session.runnerInstance,
          channelEpoch: session.channelEpoch,
          hostInstanceId: session.hostInstanceId,
          terminalEpoch: session.terminalEpoch,
        },
      },
      liveness: {
        state: "alive",
        health: "healthy",
        exactGeneration: true,
        manifestLifecycle: "ready",
        effectiveLifecycle: "ready",
      },
      ...overrides,
    },
  };
}

function completionResult(overrides = {}) {
  return {
    result: {
      schemaVersion: 1,
      receipt: {
        schemaVersion: 1,
        taskId,
        dispatchId,
        generation: 1,
        status: "completed",
        session,
        ...overrides,
      },
    },
  };
}

function fixture({ report = sessionReport(), response = completionResult() } = {}) {
  return {
    backend: { managedLocal: true, profile },
    collectSession: vi.fn(async () => report),
    requestBackend: vi.fn(async () => response),
  };
}

describe("delegated workflow completion", () => {
  it("documents the bounded worker command without starting a backend", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "workflow"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "dure workflow done --task <id> --dispatch <id> --generation <n> [--result <text>]",
    );
    expect(result.stdout).toContain(
      "dure workflow show --task <id> --dispatch <id> --generation <n>",
    );
  });

  it("rejects identity hints before starting a backend", () => {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "workflow",
        "done",
        "--task",
        taskId,
        "--dispatch",
        dispatchId,
        "--generation",
        "1",
        "--provider",
        "codex",
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dure workflow — delegated workflow control");
  });

  it("rejects a non-Hmux caller before bootstrapping the local backend", () => {
    const root = mkdtempSync(join(tmpdir(), "dure-workflow-done-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "workflow",
          "done",
          "--task",
          taskId,
          "--dispatch",
          dispatchId,
          "--generation",
          "1",
          "--json",
        ],
        {
          encoding: "utf8",
          env: { DURE_HOME: root, PATH: process.env.PATH },
        },
      );
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr).error.code).toBe(
        "workflow_done_environment_invalid",
      );
      expect(existsSync(join(root, "backend"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an environment-selected remote profile before Session lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "dure-workflow-remote-"));
    try {
      writeFileSync(
        join(root, "backend-profiles.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "dure.backend_profiles",
          profiles: [
            sshBackendProfile({
              id: "remote",
              defaultProfile: true,
              host: "worker.example.test",
              user: "runner",
              endpointPort: 4317,
              auth: identityFileAuth("remote"),
              capabilities: [
                "sessions.show",
                "workflow.delegate_once.complete",
              ],
            }),
          ],
        }),
        { mode: 0o600 },
      );
      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "workflow",
          "done",
          "--task",
          taskId,
          "--dispatch",
          dispatchId,
          "--generation",
          "1",
          "--json",
        ],
        {
          encoding: "utf8",
          env: {
            ...environment,
            DURE_BACKEND_PROFILE: "remote",
            DURE_HOME: root,
            PATH: process.env.PATH,
          },
        },
      );
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr).error.code).toBe(
        "workflow_done_backend_local_required",
      );
      expect(existsSync(join(root, "backend"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the full fence from the current live Hmux Session", async () => {
    const workflowResult = "Implemented the requested change.";
    const dependencies = fixture({
      response: completionResult({ result: workflowResult }),
    });
    const report = await completeDelegatedWorkflow({
      taskId,
      dispatchId,
      generation: "1",
      result: workflowResult,
      environment,
      ...dependencies,
    });

    expect(dependencies.collectSession).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "show",
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
      }),
    );
    expect(dependencies.requestBackend).toHaveBeenCalledWith(
      profile,
      {
        body: {
          schemaVersion: 1,
          taskId,
          dispatchId,
          generation: 1,
          session,
          result: workflowResult,
        },
        operation: "workflow.delegate_once.complete",
        requiredCapabilities: ["workflow.delegate_once.complete"],
      },
      expect.objectContaining({ deadlineMs: 2_500 }),
    );
    expect(report).toMatchObject({
      kind: "dure.workflow.done",
      taskId,
      dispatchId,
      generation: 1,
      session,
      receipt: { result: workflowResult },
    });
  });

  it("reads an exact active receipt without requiring a Hmux environment", async () => {
    const requestBackend = vi.fn(async () =>
      completionResult({ status: "active" }),
    );
    const report = await readDelegatedWorkflow({
      taskId,
      dispatchId,
      generation: "1",
      backend: { managedLocal: false, profile },
      requestBackend,
    });

    expect(requestBackend).toHaveBeenCalledWith(
      profile,
      {
        body: { schemaVersion: 1, taskId, dispatchId, generation: 1 },
        operation: "workflow.delegate_once.show",
        requiredCapabilities: ["workflow.delegate_once.show"],
      },
      expect.objectContaining({ deadlineMs: 2_500 }),
    );
    expect(report).toMatchObject({
      kind: "dure.workflow.show",
      taskId,
      dispatchId,
      generation: 1,
      receipt: { status: "active" },
    });
  });

  it("reads the same bounded result from a completed receipt", async () => {
    const workflowResult = "Implemented the requested change.";
    const report = await readDelegatedWorkflow({
      taskId,
      dispatchId,
      generation: "1",
      backend: { profile },
      requestBackend: vi.fn(async () =>
        completionResult({ result: workflowResult }),
      ),
    });

    expect(report.receipt).toMatchObject({
      status: "completed",
      result: workflowResult,
    });
  });

  it("fails closed when workflow show returns a different dispatch fence", async () => {
    await expect(
      readDelegatedWorkflow({
        taskId,
        dispatchId,
        generation: 1,
        backend: { profile },
        requestBackend: vi.fn(async () =>
          completionResult({ dispatchId: "dispatch.replacement" }),
        ),
      }),
    ).rejects.toMatchObject({ code: "workflow_show_receipt_invalid" });
  });

  it("fails closed before observation when one environment fence is missing", async () => {
    const dependencies = fixture();
    const incomplete = { ...environment };
    delete incomplete.HMUX_TERMINAL_EPOCH;

    await expect(
      completeDelegatedWorkflow({
        taskId,
        dispatchId,
        generation: 1,
        environment: incomplete,
        ...dependencies,
      }),
    ).rejects.toMatchObject({
      code: "workflow_done_environment_invalid",
      details: { variable: "HMUX_TERMINAL_EPOCH" },
    });
    expect(dependencies.collectSession).not.toHaveBeenCalled();
    expect(dependencies.requestBackend).not.toHaveBeenCalled();
  });

  it.each([
    ["standalone Session", { runtime: { ...sessionReport().session.runtime, sessionClass: "standalone" } }],
    ["stale Session", { liveness: { ...sessionReport().session.liveness, health: "stale_transport", state: "unknown", exactGeneration: false } }],
    ["replacement generation", { runtime: { ...sessionReport().session.runtime, generation: { ...sessionReport().session.runtime.generation, terminalEpoch: "terminal.replacement" } } }],
  ])("rejects a %s before completion", async (_label, overrides) => {
    const dependencies = fixture({ report: sessionReport(overrides) });
    await expect(
      completeDelegatedWorkflow({
        taskId,
        dispatchId,
        generation: 1,
        environment,
        ...dependencies,
      }),
    ).rejects.toMatchObject({ code: "workflow_done_session_mismatch" });
    expect(dependencies.requestBackend).not.toHaveBeenCalled();
  });

  it("rejects a remote backend before reading the Session", async () => {
    const dependencies = fixture();
    await expect(
      completeDelegatedWorkflow({
        taskId,
        dispatchId,
        generation: 1,
        environment,
        ...dependencies,
        backend: { managedLocal: false, profile },
      }),
    ).rejects.toMatchObject({
      code: "workflow_done_backend_local_required",
    });
    expect(dependencies.collectSession).not.toHaveBeenCalled();
  });

  it("rejects invalid workflow IDs and generations", async () => {
    const dependencies = fixture();
    await expect(
      completeDelegatedWorkflow({
        taskId: "other.task",
        dispatchId,
        generation: 0,
        environment,
        ...dependencies,
      }),
    ).rejects.toBeInstanceOf(WorkflowCompletionError);
    expect(dependencies.collectSession).not.toHaveBeenCalled();
  });

  it("rejects an empty or oversized result before reading the Session", async () => {
    for (const result of ["", "x".repeat(16 * 1024 + 1)]) {
      const dependencies = fixture();
      await expect(
        completeDelegatedWorkflow({
          taskId,
          dispatchId,
          generation: 1,
          result,
          environment,
          ...dependencies,
        }),
      ).rejects.toMatchObject({ code: "workflow_done_request_invalid" });
      expect(dependencies.collectSession).not.toHaveBeenCalled();
      expect(dependencies.requestBackend).not.toHaveBeenCalled();
    }
  });

  it("does not accept a malformed or mismatched completion receipt", async () => {
    const dependencies = fixture({
      response: completionResult({ generation: 2 }),
    });
    await expect(
      completeDelegatedWorkflow({
        taskId,
        dispatchId,
        generation: 1,
        environment,
        ...dependencies,
      }),
    ).rejects.toMatchObject({ code: "workflow_done_receipt_invalid" });
  });

  it("does not accept a replay receipt with a different result", async () => {
    const dependencies = fixture({
      response: completionResult({ result: "different result" }),
    });
    await expect(
      completeDelegatedWorkflow({
        taskId,
        dispatchId,
        generation: 1,
        result: "expected result",
        environment,
        ...dependencies,
      }),
    ).rejects.toMatchObject({ code: "workflow_done_receipt_invalid" });
  });

  it("projects the exact environment fields without accepting a provider hint", () => {
    expect(currentHmuxSessionGeneration(environment)).toEqual({
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      runnerPrincipal: session.runnerPrincipal,
      runnerInstance: session.runnerInstance,
      channelEpoch: session.channelEpoch,
      hostInstanceId: session.hostInstanceId,
      terminalEpoch: session.terminalEpoch,
    });
  });
});
