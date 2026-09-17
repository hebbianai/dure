import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptExistingCheckout,
  canonicalNativeReceipt,
  dedicatedWorkspaceEvidence,
  promptDigest,
  receipt,
  request,
  succeededNativeReceipt,
  succeededStructuredReceipt,
  worktree,
} from "./fixtures/agent-spawn-receipts.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import {
  agentSpawnLaunchProjection,
  agentSpawnWorkspaceProjection,
  agentSpawnQueryExitCode,
  collectAgentSpawnQuery,
  DEFAULT_AGENT_SPAWN_APPLY_DEADLINE_MS,
  formatAgentSpawnQuery,
  MAX_AGENT_SPAWN_APPLY_DEADLINE_MS,
} from "../cli/lib/agent-spawn-query.mjs";
import {
  presentAgentRunRuntime,
  resolveRunPresentationTarget,
} from "../cli/lib/run-presentation.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const temporaryRoots = [];
const prompt = "never serialize this prompt";
const FUNCTIONAL_DEADLINE_MS = 10_000;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-agent-spawn-"));
  temporaryRoots.push(root);
  return root;
}

function managedPresentationPane({
  id = "agent:source",
  sessionId = "source-session",
  workspaceId = "source-workspace",
} = {}) {
  return {
    id,
    type: "agent",
    component: "agent",
    agentId: "source",
    binding: {
      schemaVersion: 1,
      runtime: "hmux_managed_v1",
      source: "local",
      hostId: "local",
      workspaceId,
      sessionId,
    },
  };
}

function clientPresentation(spaces) {
  return {
    schemaVersion: 2,
    complete: true,
    spaces: spaces.map((space) => ({
      ...space,
      windowLabel:
        space.windowLabel ??
        (space.kind === "popout" ? `win-popout-${space.id}` : "main"),
    })),
    limits: {
      maxSpaces: 64,
      maxPanesPerSpace: 128,
      maxTotalPanes: 512,
    },
    truncation: {
      spaces: false,
      panes: false,
      omittedSpaceCount: 0,
      omittedPaneCount: 0,
    },
  };
}

function profile(id = "remote-a") {
  return {
    id,
    transport: {
      kind: "ssh",
      host: "dev.example.test",
      port: 2222,
      user: "dev",
    },
    expected: { capabilities: ["agent_spawn.preview.v2", "agent_spawn.status"] },
    deadlineMs: 2_500,
  };
}


function backendResult(result) {
  return {
    backend: {
      id: "remote-a-backend",
      generation: "remote-a-generation-1",
      protocol: { major: 1, minor: 0 },
      capabilities: ["agent_spawn.preview.v2", "agent_spawn.status"],
      observedAtMs: Date.now(),
    },
    result,
  };
}

describe("agent spawn query contract", () => {
  it("accepts a selected-checkout preview and reads its durable receipt", async () => {
    const value = adoptExistingCheckout(succeededNativeReceipt());
    const policy = value.plan.request.worktree;
    const reference = {
      canonicalPath: policy.instance.canonicalPath, gitCommonDir: policy.instance.gitCommonDir,
      gitDir: policy.instance.gitDir, branch: policy.branch, head: policy.base_commit_sha,
    };
    const report = await collectAgentSpawnQuery({
      action: "preview",
      ...request({ worktree: { kind: "existing_checkout", reference } }),
      prompt,
      backend: { profile: profile() },
      requestBackend: async () => backendResult({ schemaVersion: 1, receipt: value }),
    });
    expect(report).toMatchObject({ receipt: value });
    expect(agentSpawnWorkspaceProjection(value.plan, value.completed[0].evidence)).toEqual({
      kind: "existing_checkout", branch: reference.branch, rootPath: reference.canonicalPath,
    });
  });

  it("reads backend-owned checkout evidence without changing the spawn request", async () => {
    const value = succeededStructuredReceipt();
    value.checkoutRegistration = {
      repositoryPath: "/repo",
      instance: {
        schemaVersion: 1,
        canonicalPath: "/repo/.worktrees/codex-1",
        gitCommonDir: "/repo/.git",
        gitDir: "/repo/.git/worktrees/codex-1",
        instanceToken: `dwt1_${"a".repeat(32)}`,
      },
    };
    const calls = [];
    const report = await collectAgentSpawnQuery({
      action: "status",
      operationId: value.operationId,
      backend: { profile: profile() },
      requestBackend: async (_profile, request) => {
        calls.push(request);
        return backendResult({ schemaVersion: 1, receipt: value });
      },
    });
    expect(report).toMatchObject({ found: true, receipt: value });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ schemaVersion: 1, operationId: value.operationId });
  });

  it("normalizes both durable legacy and canonical native launch plans", () => {
    const legacy = receipt().plan;
    const canonical = canonicalNativeReceipt().plan;
    const legacyProjection = agentSpawnLaunchProjection(
      legacy,
      dedicatedWorkspaceEvidence(legacy),
    );
    const canonicalProjection = agentSpawnLaunchProjection(
      canonical,
      dedicatedWorkspaceEvidence(canonical),
    );

    expect(legacyProjection?.launch).toEqual({
      interactionProfile: "native_cli",
      sessionId: legacy.sessionId,
      runtime: legacy.runtime,
    });
    expect(canonicalProjection?.launch).toEqual(canonical.launch);
  });

  it("binds a dedicated lease directory to the immutable branch", () => {
    const plan = receipt().plan;
    const evidence = {
      stage: "worktree",
      workspace_id: plan.workspaceId,
      disposition: "created_dure_owned",
      lease: {
        lease_id: `workspace-lease:${plan.workspaceId}`,
        directory_name: "codex-1",
        retirement_id: `workspace-retire:${plan.workspaceId}`,
      },
    };

    expect(agentSpawnWorkspaceProjection(plan, evidence)).toEqual({
      kind: "dedicated",
      branch: "agent/codex-1",
      directoryName: "codex-1",
    });
    expect(
      agentSpawnWorkspaceProjection(plan, {
        ...evidence,
        lease: { ...evidence.lease, directory_name: "another-directory" },
      }),
    ).toBeNull();
  });

  it("accepts a complete structured receipt without projecting an Hmux runtime", async () => {
    const value = succeededStructuredReceipt(
      request({ providerConversationRef: "threads/2026-08-30:turn_1" }),
    );
    const report = await collectAgentSpawnQuery({
      action: "status",
      operationId: value.operationId,
      backend: { profile: profile(), transportOptions: {} },
      requestBackend: async () => backendResult({ schemaVersion: 1, receipt: value }),
    });

    expect(report).toMatchObject({
      kind: "dure.agent_spawn.status",
      found: true,
      receipt: { state: "succeeded" },
    });
    expect(
      agentSpawnLaunchProjection(value.plan, value.completed[0].evidence)?.launch,
    ).toEqual({ interactionProfile: "structured_protocol" });
    expect(formatAgentSpawnQuery(report)).toContain(
      "interaction\tstructured_protocol",
    );
    expect(formatAgentSpawnQuery(report)).not.toContain("undefined");
  });

  it("presents a completed structured Run through the provider-neutral client route", async () => {
    const requests = [];
    const value = succeededStructuredReceipt();
    const presentation = await presentAgentRunRuntime({
      report: {
        kind: "dure.agent_spawn.apply",
        receipt: value,
      },
      target: {
        state: "requested",
        reason: "explicit_space",
        spaceId: "space-a",
        windowLabel: "main",
      },
      profile: profile(),
      projectPath: "/remote/dure",
      descriptor: {
        port: 42,
        token: "client-control-token",
        channel: "stable",
        generation: "client-generation-1",
        buildId: "0.1.4+fixture",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return new Response(
          JSON.stringify({
            ok: true,
            pane: {
              spaceId: "space-a",
              desktopId: "space-a",
              panelId: `agent:${value.plan.agentId}`,
              agentId: value.plan.agentId,
              interactionSessionId: "interaction-session-1",
              interactionProfile: "structured_protocol",
              outcome: "created",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    expect(presentation).toMatchObject({
      state: "opened",
      pane: {
        spaceId: "space-a",
        panelId: `agent:${value.plan.agentId}`,
        interactionSessionId: "interaction-session-1",
        interactionProfile: "structured_protocol",
      },
    });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:42/agent/present",
        body: expect.objectContaining({
          schemaVersion: 1,
          interactionProfile: "structured_protocol",
          backendProfileId: "remote-a",
          source: "ssh",
          hostId: "remote-a",
          remote: {
            host: "dev.example.test",
            port: 2222,
            user: "dev",
          },
          agentId: value.plan.agentId,
          interactionSessionId: "interaction-session-1",
          projectPath: "/remote/dure",
          spaceId: "space-a",
          windowLabel: "main",
        }),
      },
    ]);
  });

  it("accepts the managed launch prompt receipt without exposing plaintext", async () => {
    const value = succeededNativeReceipt({ initialPromptAccepted: true });
    const report = await collectAgentSpawnQuery({
      action: "status",
      operationId: value.operationId,
      backend: { profile: profile(), transportOptions: {} },
      requestBackend: async () =>
        backendResult({ schemaVersion: 1, receipt: value }),
    });

    expect(report).toMatchObject({
      kind: "dure.agent_spawn.status",
      receipt: {
        state: "succeeded",
        completed: [
          expect.anything(),
          {
            evidence: {
              stage: "runtime_launch",
              initial_prompt_accepted: true,
            },
          },
          expect.anything(),
        ],
      },
    });
    expect(JSON.stringify(report)).not.toContain(prompt);
  });

  it("projects one advanced native Session with the matching effective create key", async () => {
    const value = succeededNativeReceipt({
      sessionId: "session-successor",
      launchIdempotencyKey: "spawn-runtime:successor",
    });
    const report = await collectAgentSpawnQuery({
      action: "status",
      operationId: value.operationId,
      backend: { profile: profile(), transportOptions: {} },
      requestBackend: async () =>
        backendResult({ schemaVersion: 1, receipt: value }),
    });
    expect(report).toMatchObject({
      kind: "dure.agent_spawn.status",
      receipt: { state: "succeeded" },
    });

    const requests = [];
    await presentAgentRunRuntime({
      report: { kind: "dure.agent_spawn.apply", receipt: value },
      target: {
        state: "requested",
        reason: "explicit_space",
        spaceId: "space-a",
        windowLabel: "main",
      },
      profile: profile(),
      projectPath: "/remote/dure",
      descriptor: {
        port: 42,
        token: "client-control-token",
        channel: "stable",
        generation: "client-generation-1",
        buildId: "0.1.4+fixture",
      },
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
          ok: true,
          pane: {
            spaceId: "space-a",
            desktopId: "space-a",
            panelId: `agent:${value.plan.agentId}`,
            agentId: value.plan.agentId,
            sessionId: "session-successor",
            workspaceId: value.plan.workspaceId,
            runtime: "hmux_managed_v1",
            outcome: "created",
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    expect(requests[0]).toMatchObject({
      sessionId: "session-successor",
      preparedSessionId: value.plan.launch.sessionId,
      launchIdempotencyKey: "spawn-runtime:successor",
    });
  });

  it.each([undefined, "native_cli"])("presents native preference %s to v1 apps", async (interactionPreference) => {
    const value = succeededNativeReceipt();
    if (interactionPreference) {
      value.plan.request.interactionPreference = interactionPreference;
    }
    const requests = [];
    await presentAgentRunRuntime({
      report: { kind: "dure.agent_spawn.apply", receipt: value },
      target: {
        state: "requested",
        reason: "explicit_space",
        spaceId: "space-a",
        windowLabel: "main",
      },
      profile: profile(),
      descriptor: {
        port: 42,
        token: "client-control-token",
        channel: "stable",
        generation: "client-generation-1",
        buildId: "0.1.4+fixture",
      },
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
          ok: true,
          pane: {
            spaceId: "space-a",
            desktopId: "space-a",
            panelId: `agent:${value.plan.agentId}`,
            agentId: value.plan.agentId,
            sessionId: value.plan.launch.sessionId,
            workspaceId: value.plan.workspaceId,
            runtime: "hmux_managed_v1",
            outcome: "created",
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    expect(requests[0]).toMatchObject({
      sessionId: value.plan.launch.sessionId,
    });
    expect(requests[0]).not.toHaveProperty("preparedSessionId");
    expect(requests[0]).not.toHaveProperty("launchIdempotencyKey");
  });

  it("rejects mixed or missing successor create identity", async () => {
    for (const value of [
      succeededNativeReceipt({
        sessionId: "session-successor",
        launchIdempotencyKey: "spawn-runtime:spawn-0123456789abcdef0123456789abcdef",
      }),
      succeededNativeReceipt({
        sessionId: "session-successor",
        omitLaunchIdempotencyKey: true,
      }),
      succeededNativeReceipt({
        launchIdempotencyKey: "spawn-runtime:successor",
      }),
    ]) {
      const report = await collectAgentSpawnQuery({
        action: "status",
        operationId: value.operationId,
        backend: { profile: profile(), transportOptions: {} },
        requestBackend: async () =>
          backendResult({ schemaVersion: 1, receipt: value }),
      });
      expect(report).toMatchObject({
        kind: "dure.agent_spawn.error",
        error: { code: "backend_agent_spawn_payload_invalid" },
      });
    }
  });

  it("hashes prompt plaintext locally and returns one strict durable preview", async () => {
    const calls = [];
    const report = await collectAgentSpawnQuery({
      action: "preview",
      projectId: "dure",
      providerId: "codex",
      agentName: "codex-1",
      worktree: worktree(),
      idempotencyKey: "spawn-request-1",
      prompt,
      backend: { profile: profile(), transportOptions: { marker: true } },
      requestBackend: async (_profile, backendRequest, options) => {
        calls.push({ backendRequest, options });
        return backendResult({ schemaVersion: 1, receipt: receipt(backendRequest.body) });
      },
    });

    expect(report).toMatchObject({
      kind: "dure.agent_spawn.preview",
      complete: true,
      found: true,
      source: {
        appDaemonRequired: false,
        profileId: "remote-a",
        transport: "ssh",
      },
      receipt: { operationId: "spawn-0123456789abcdef0123456789abcdef" },
    });
    expect(calls[0]).toMatchObject({
      backendRequest: {
        operation: "agent_spawn.preview",
        requiredCapabilities: ["agent_spawn.preview.v2"],
        body: request(),
      },
      options: { deadlineMs: 2_500, maxResponseBytes: 262_144, marker: true },
    });
    expect(JSON.stringify(calls)).not.toContain(prompt);
    expect(JSON.stringify(report)).not.toContain(prompt);
    expect(agentSpawnQueryExitCode(report)).toBe(0);
    expect(formatAgentSpawnQuery(report)).toContain("state\tapplying");
  });

  it.each(["codex", "claude"])(
    "%s inherits the backend provider permission default when the one-run override is omitted",
    async (providerId) => {

      const calls = [];
      const agentName = `${providerId}-1`;
      const inheritedReceipt = receipt(
        request({ providerId, agentName }),
        "skip_permissions",
      );
      inheritedReceipt.plan.providerLaunchDefaults.revision = 7;

      const report = await collectAgentSpawnQuery({
        action: "preview",
        projectId: "dure",
        providerId,
        agentName,
        worktree: worktree(),
        idempotencyKey: "spawn-request-1",
        prompt,
        backend: { profile: profile() },
        requestBackend: async (_profile, backendRequest) => {
          calls.push(backendRequest);
          return backendResult({ schemaVersion: 1, receipt: inheritedReceipt });
        },
      });

      expect(report).toMatchObject({
        complete: true,
        receipt: {
          plan: {
            request: { permissionMode: "skip_permissions" },
            providerLaunchDefaults: {
              revision: 7,
              permissionOverride: null,
            },
          },
        },
      });
      expect(calls[0].body).not.toHaveProperty("permissionMode");
      expect(calls[0].body).not.toHaveProperty("permissionOverride");
    },
  );

  it("reads by exact identity and reports an absent receipt without mutation", async () => {
    const calls = [];
    const found = await collectAgentSpawnQuery({
      action: "status",
      operationId: "spawn-0123456789abcdef0123456789abcdef",
      backend: { profile: profile() },
      requestBackend: async (_profile, backendRequest) => {
        calls.push(backendRequest);
        return backendResult({
          schemaVersion: 1,
          receipt: receipt(request({ permissionOverride: "auto_edit" })),
        });
      },
    });
    const missing = await collectAgentSpawnQuery({
      action: "status",
      idempotencyKey: "missing-key",
      backend: { profile: profile() },
      requestBackend: async (_profile, backendRequest) => {
        calls.push(backendRequest);
        return backendResult({ schemaVersion: 1, receipt: null });
      },
    });

    expect(calls).toEqual([
      {
        operation: "agent_spawn.status",
        requiredCapabilities: ["agent_spawn.status"],
        body: {
          schemaVersion: 1,
          operationId: "spawn-0123456789abcdef0123456789abcdef",
        },
      },
      {
        operation: "agent_spawn.status",
        requiredCapabilities: ["agent_spawn.status"],
        body: { schemaVersion: 1, idempotencyKey: "missing-key" },
      },
    ]);
    expect(found).toMatchObject({
      found: true,
      receipt: {
        plan: {
          request: { permissionMode: "auto_edit" },
          providerLaunchDefaults: { permissionOverride: "auto_edit" },
        },
      },
    });
    expect(missing.found).toBe(false);
    expect(agentSpawnQueryExitCode(missing)).toBe(1);
  });

  it.each([
    { operationId: "different-operation" },
    { idempotencyKey: "different-request-key" },
  ])("rejects a status receipt for another exact request: %j", async (identity) => {
    const report = await collectAgentSpawnQuery({
      action: "status", ...identity, backend: { profile: profile() },
      requestBackend: async () => backendResult({ schemaVersion: 1, receipt: receipt() }),
    });
    expect(report).toMatchObject({
      kind: "dure.agent_spawn.error",
      error: { code: "backend_agent_spawn_identity_mismatch" },
    });
  });

  it("keeps status compatible with later journal recovery states", async () => {
    const retry = {
      ...receipt(),
      state: "retry_required",
      lastSequence: 3,
      recovery: {
        kind: "retry_required",
        stage: "worktree",
        failed_attempt: 1,
        error_code: "worktree_create_failed",
        inputs: {
          stage: "worktree",
          workspace_id: "workspace-0123456789abcdef0123456789abcdef",
          project_root_id: "root_0123456789abcdef0123456789abcdef",
          repository_id: "repo_fedcba9876543210fedcba9876543210",
          policy: worktree(),
        },
      },
      updatedAtMs: 1_700_000_000_002,
    };
    const report = await collectAgentSpawnQuery({
      action: "status",
      idempotencyKey: "spawn-request-1",
      backend: { profile: profile() },
      requestBackend: async () =>
        backendResult({ schemaVersion: 1, receipt: retry }),
    });

    expect(report).toMatchObject({
      kind: "dure.agent_spawn.status",
      complete: true,
      receipt: {
        state: "retry_required",
        recovery: { kind: "retry_required", stage: "worktree" },
      },
    });
  });

  /** A failed stage may carry one line of evidence beside its code. The CLI
   *  must read those receipts — they are exactly the ones an operator opens
   *  when a spawn failed — while still refusing evidence that is not one
   *  bounded line. */
  it("reads the evidence a failed stage carries, and refuses an unbounded one", async () => {
    const withDetail = (detail) => ({
      ...receipt(),
      state: "retry_required",
      lastSequence: 3,
      recovery: {
        kind: "retry_required",
        stage: "worktree",
        failed_attempt: 1,
        error_code: "worktree_create_failed",
        error_detail: detail,
        inputs: {
          stage: "worktree",
          workspace_id: "workspace-0123456789abcdef0123456789abcdef",
          project_root_id: "root_0123456789abcdef0123456789abcdef",
          repository_id: "repo_fedcba9876543210fedcba9876543210",
          policy: worktree(),
        },
      },
      updatedAtMs: 1_700_000_000_002,
    });
    const status = (value) =>
      collectAgentSpawnQuery({
        action: "status",
        idempotencyKey: "spawn-request-1",
        backend: { profile: profile() },
        requestBackend: async () =>
          backendResult({ schemaVersion: 1, receipt: withDetail(value) }),
      });

    expect(await status("host_exited_before_ready: capability boundary")).toMatchObject({
      receipt: {
        recovery: {
          kind: "retry_required",
          error_detail: "host_exited_before_ready: capability boundary",
        },
      },
    });

    // A newline would let a log dump ride into the journal record: the reader
    // refuses the receipt rather than passing it on (2 = contract violation,
    // the same answer as any other malformed receipt).
    const unbounded = await status("first line\nsecond line");
    expect(agentSpawnQueryExitCode(unbounded)).toBe(2);
  });

  it("rejects divergent ownership, extra fields, and typed remote failures", async () => {
    const divergent = await collectAgentSpawnQuery({
      action: "preview",
      projectId: "dure",
      providerId: "codex",
      agentName: "codex-1",
      worktree: worktree(),
      idempotencyKey: "spawn-request-1",
      prompt,
      backend: { profile: profile() },
      requestBackend: async () =>
        backendResult({
          schemaVersion: 1,
          receipt: receipt(request({ agentName: "other-agent" })),
        }),
    });
    const injected = await collectAgentSpawnQuery({
      action: "status",
      idempotencyKey: "spawn-request-1",
      backend: { profile: profile() },
      requestBackend: async () =>
        backendResult({
          schemaVersion: 1,
          receipt: { ...receipt(), prompt: "leak" },
        }),
    });
    const forgedProgress = await collectAgentSpawnQuery({
      action: "status",
      idempotencyKey: "spawn-request-1",
      backend: { profile: profile() },
      requestBackend: async () =>
        backendResult({
          schemaVersion: 1,
          receipt: {
            ...receipt(),
            recovery: {
              kind: "continue",
              stage: "runtime_launch",
              next_attempt: 1,
            },
          },
        }),
    });
    const remoteFailure = await collectAgentSpawnQuery({
      action: "status",
      idempotencyKey: "spawn-request-1",
      backend: { profile: profile() },
      requestBackend: async () => {
        throw new BackendTransportError("backend_transport_remote_error", {
          details: {
            code: "agent_spawn_idempotency_conflict",
            message: "/private/path secret",
          },
        });
      },
    });

    expect(divergent.error.code).toBe("backend_agent_spawn_identity_mismatch");
    expect(injected.error.code).toBe("backend_agent_spawn_payload_invalid");
    expect(forgedProgress.error.code).toBe("backend_agent_spawn_payload_invalid");
    expect(remoteFailure.error).toEqual({
      code: "backend_transport_remote_error",
      message: "the backend rejected the request",
      profileId: "remote-a",
      remoteCode: "agent_spawn_idempotency_conflict",
    });
    expect(JSON.stringify(remoteFailure)).not.toContain("/private/path secret");
  });

  it("rejects an ambiguous selector or unapplyable prompt before transport", async () => {
    let calls = 0;
    const common = {
      action: "preview",
      projectId: "dure",
      providerId: "codex",
      agentName: "codex-1",
      worktree: worktree(),
      idempotencyKey: "spawn-request-1",
      backend: { profile: profile() },
      requestBackend: async () => {
        calls += 1;
        return backendResult({ schemaVersion: 1, receipt: receipt() });
      },
    };
    for (const overrides of [
      { projectPath: "/remote/dure", prompt },
      { projectId: null, prompt },
      { prompt: "invalid\u0000prompt" },
    ]) {
      const report = await collectAgentSpawnQuery({ ...common, ...overrides });
      expect(report.error.code).toBe("agent_spawn_request_invalid");
    }
    expect(calls).toBe(0);
  });
});

function remoteProfile() {
  return {
    id: "remote-a",
    default: true,
    transport: {
      kind: "ssh",
      host: "remote-a.example.test",
      port: 22,
      user: "dure",
      endpoint: { kind: "tcp", host: "127.0.0.1", port: 6767 },
      batchMode: true,
      strictHostKeyChecking: "yes",
      connectTimeoutMs: 1_000,
    },
    auth: { kind: "identity_file", reference: "credential-profile:remote-a" },
    trust: { kind: "known_hosts", reference: "known-hosts-profile:remote-a" },
    expected: {
      backendId: "remote-a-backend",
      generation: "remote-a-generation-1",
      protocol: {
        minimum: { major: 1, minor: 0 },
        maximum: { major: 1, minor: 0 },
      },
      capabilities: ["agent_spawn.preview.v2", "agent_spawn.status"],
    },
    deadlineMs: FUNCTIONAL_DEADLINE_MS,
  };
}

function installRemoteFixture(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "backend-profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_profiles",
      profiles: [remoteProfile()],
    }),
    { mode: 0o600 },
  );
  const identity = join(root, "remote-a-identity");
  const knownHosts = join(root, "remote-a-known-hosts");
  writeFileSync(identity, "private material", { mode: 0o600 });
  writeFileSync(knownHosts, "remote-a.example.test fixture", { mode: 0o600 });
  writeFileSync(
    join(root, "backend-ssh-references.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_ssh_references",
      references: [
        {
          reference: "credential-profile:remote-a",
          kind: "identity_file",
          path: identity,
        },
        {
          reference: "known-hosts-profile:remote-a",
          kind: "known_hosts_file",
          path: knownHosts,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const bin = join(root, "bin");
  const log = join(root, "ssh-observation.json");
  mkdirSync(bin);
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const request = JSON.parse(readFileSync(0, "utf8"));
const argv = process.argv.slice(2);
const materials = Object.fromEntries([
  ["identity", "IdentityFile="],
  ["knownHosts", "UserKnownHostsFile="],
].map(([name, prefix]) => {
  const path = argv.find(value => value.startsWith(prefix)).slice(prefix.length);
  return [name, { path, contents: readFileSync(path, "utf8") }];
}));
writeFileSync(process.env.DURE_AGENT_SPAWN_LOG, JSON.stringify({ argv, request, materials }));
const operationId = "spawn-0123456789abcdef0123456789abcdef";
const permissionOverride = request.body.permissionOverride ?? null;
const spawnRequest = {
  ...request.body,
  providerConversationRef: request.body.providerConversationRef ?? null,
  permissionMode: permissionOverride === "auto_edit"
    ? "auto_edit"
    : permissionOverride === "bypass_approvals"
      ? "skip_permissions"
      : "default"
};
delete spawnRequest.permissionOverride;
const receipt = {
  schemaVersion: 1,
  operationId,
  plan: {
    schemaVersion: 1,
    operationId,
    authority: {
      backendId: request.expected.backendId,
      backendGeneration: request.expected.generation,
      projectId: "dure",
      rootId: "root_0123456789abcdef0123456789abcdef",
      repositoryId: "repo_fedcba9876543210fedcba9876543210"
    },
    request: spawnRequest,
    agentId: "agent-0123456789abcdef0123456789abcdef",
    workspaceId: "workspace-0123456789abcdef0123456789abcdef",
    sessionId: "session-0123456789abcdef0123456789abcdef",
    runtime: { runtimeKindId: "runtime.hmux", requiredCapabilities: ["provider-launch", "session-create"] },
    providerLaunchDefaults: {
      schemaVersion: 1,
      revision: 0,
      fingerprint: "sha256:${"c".repeat(64)}",
      permissionOverride
    },
    planToken: "sha256:${"b".repeat(64)}"
  },
  state: "applying",
  lastSequence: 1,
  completed: [],
  recovery: { kind: "continue", stage: "worktree", next_attempt: 1 },
  terminalCode: null,
  createdAtMs: 1700000000000,
  updatedAtMs: 1700000000000
};
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  apiVersion: "dure.backend-transport/v1",
  kind: "dure.backend.response",
  requestId: request.requestId,
  backend: {
    id: request.expected.backendId,
    generation: request.expected.generation,
    protocol: { major: 1, minor: 0 },
    capabilities: ["agent_spawn.preview.v2", "agent_spawn.status"],
    observedAtMs: Date.now()
  },
  result: { schemaVersion: 1, receipt }
}));
`,
  );
  chmodSync(ssh, 0o755);
  return { bin, log, identity, knownHosts };
}

function installRunRemoteFixture(root) {
  const remote = installRemoteFixture(root);
  const profilesPath = join(root, "backend-profiles.json");
  const profiles = JSON.parse(readFileSync(profilesPath, "utf8"));
  profiles.profiles[0].expected.capabilities.push(
    "agent_spawn.apply",
    "agent_spawn.presentation_project.v1",
  );
  writeFileSync(profilesPath, JSON.stringify(profiles), { mode: 0o600 });
  const ssh = join(remote.bin, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const request = JSON.parse(readFileSync(0, "utf8"));
const log = process.env.DURE_AGENT_SPAWN_LOG;
const observations = existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) : [];
observations.push({ argv: process.argv.slice(2), request });
writeFileSync(log, JSON.stringify(observations));
const operationId = "spawn-0123456789abcdef0123456789abcdef";
const planToken = "sha256:${"b".repeat(64)}";
const selectorRequest = observations[0].request.body;
const spawnRequest = { ...selectorRequest };
const permissionOverride = selectorRequest.permissionOverride ?? null;
delete spawnRequest.permissionOverride;
delete spawnRequest.includePresentationProject;
spawnRequest.providerConversationRef = selectorRequest.providerConversationRef ?? null;
spawnRequest.permissionMode = permissionOverride === "auto_edit"
  ? "auto_edit"
  : permissionOverride === "bypass_approvals"
    ? "skip_permissions"
    : "default";
if (spawnRequest.projectPath !== undefined) {
  delete spawnRequest.projectPath;
  spawnRequest.projectId = "dure";
}
if (spawnRequest.worktree?.kind === "dedicated" && spawnRequest.worktree.base_commit_sha === undefined) {
  spawnRequest.worktree = { ...spawnRequest.worktree, base_commit_sha: "${"a".repeat(40)}" };
}
const plan = {
  schemaVersion: 1,
  operationId,
  authority: {
    backendId: request.expected.backendId,
    backendGeneration: request.expected.generation,
    projectId: "dure",
    rootId: "root_0123456789abcdef0123456789abcdef",
    repositoryId: "repo_fedcba9876543210fedcba9876543210"
  },
  request: spawnRequest,
  agentId: "agent-0123456789abcdef0123456789abcdef",
  workspaceId: "workspace-0123456789abcdef0123456789abcdef",
  sessionId: "session-0123456789abcdef0123456789abcdef",
  runtime: { runtimeKindId: "runtime.hmux", requiredCapabilities: ["provider-launch", "session-create"] },
  providerLaunchDefaults: {
    schemaVersion: 1,
    revision: 0,
    fingerprint: "sha256:${"c".repeat(64)}",
    permissionOverride
  },
  planToken
};
const createdAtMs = 1700000000000;
const session = {
  sessionId: plan.sessionId,
  workspaceId: plan.workspaceId,
  providerId: "codex",
  runnerPrincipal: "runner-principal-1",
  runnerInstance: "runner-instance-1",
  channelEpoch: "1",
  hostInstanceId: "host-instance-1",
  terminalEpoch: "terminal-epoch-1"
};
const applyState = process.env.DURE_AGENT_SPAWN_FIXTURE_APPLY_STATE || "succeeded";
const applied = request.operation === "agent_spawn.apply";
const succeeded = applied && applyState === "succeeded";
const promptUncertain = applied && applyState === "prompt_delivery_uncertain";
const dedicated = plan.request.worktree.kind === "dedicated";
const directoryName = dedicated
  ? plan.request.worktree.branch.split("/").filter(Boolean).at(-1).replace(/[^A-Za-z0-9_-]/g, "-")
  : null;
const completed = applied ? [
  {
    stage: "worktree",
    attempt: 1,
    inputs: {
      stage: "worktree",
      workspace_id: plan.workspaceId,
      project_root_id: plan.authority.rootId,
      repository_id: plan.authority.repositoryId,
      policy: plan.request.worktree
    },
    evidence: dedicated
      ? {
          stage: "worktree",
          workspace_id: plan.workspaceId,
          disposition: "created_dure_owned",
          lease: {
            lease_id: "workspace-lease:" + plan.workspaceId,
            directory_name: directoryName,
            retirement_id: "workspace-retire:" + plan.workspaceId
          }
        }
      : { stage: "worktree", workspace_id: plan.workspaceId, disposition: "adopted_existing" }
  },
  {
    stage: "runtime_launch",
    attempt: 1,
    inputs: {
      stage: "runtime_launch",
      agent_id: plan.agentId,
      workspace_id: plan.workspaceId,
      session_id: plan.sessionId,
      runtime_kind_id: "runtime.hmux",
      provider_id: "codex",
      provider_conversation_ref: plan.request.providerConversationRef,
      permission_mode: plan.request.permissionMode,
      ...(plan.request.setupCommand === undefined
        ? {}
        : { setup_command: plan.request.setupCommand })
    },
    evidence: { stage: "runtime_launch", session }
  },
  ...(plan.request.promptDigest === null || promptUncertain ? [] : [{
    stage: "prompt_delivery",
    attempt: 1,
    inputs: { stage: "prompt_delivery", session_id: plan.sessionId, prompt_digest: plan.request.promptDigest },
    evidence: { stage: "prompt_delivery", session_id: plan.sessionId, delivery_id: "input-request-1" }
  }])
] : [];
const receipt = {
  schemaVersion: 1,
  operationId,
  plan,
  state: succeeded ? "succeeded" : promptUncertain ? "prompt_delivery_uncertain" : "applying",
  lastSequence: succeeded ? (plan.request.promptDigest === null ? 6 : 8) : promptUncertain ? 7 : 1,
  completed,
  recovery: succeeded
    ? { kind: "none" }
    : promptUncertain
      ? {
          kind: "do_not_replay_prompt",
          attempt: 1,
          inputs: {
            stage: "prompt_delivery",
            session_id: plan.sessionId,
            prompt_digest: plan.request.promptDigest
          },
          error_code: "workflow_prompt_provider_exited"
        }
      : { kind: "continue", stage: "worktree", next_attempt: 1 },
  terminalCode: null,
  createdAtMs,
  updatedAtMs: succeeded ? createdAtMs + 7 : createdAtMs
};
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  apiVersion: "dure.backend-transport/v1",
  kind: "dure.backend.response",
  requestId: request.requestId,
  backend: {
    id: request.expected.backendId,
    generation: request.expected.generation,
    protocol: { major: 1, minor: 0 },
    capabilities: [
      "agent_spawn.apply",
      "agent_spawn.presentation_project.v1",
      "agent_spawn.preview.v2",
      "agent_spawn.status"
    ],
    observedAtMs: Date.now()
  },
  result: {
    schemaVersion: 1,
    receipt,
    ...(request.operation === "agent_spawn.preview" && request.body.includePresentationProject
      ? {
          presentationProject: {
            projectId: plan.authority.projectId,
            rootId: plan.authority.rootId,
            repositoryId: plan.authority.repositoryId,
            root: "/remote/dure"
          }
        }
      : {})
  }
}));
`,
  );
  chmodSync(ssh, 0o755);
  return remote;
}

function functionalArguments(args) {
  return args.includes("--deadline-ms")
    ? args
    : [...args, "--deadline-ms", String(FUNCTIONAL_DEADLINE_MS)];
}

function runCli(root, args, environment = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cliPath, ...functionalArguments(args)], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DURE_APP_CHANNEL: "stable",
      DURE_HOME: root,
      ...environment,
    },
  });
}

function runCliAsync(root, args, environment = {}, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...functionalArguments(args)], {
      cwd,
      env: {
        ...process.env,
        DURE_APP_CHANNEL: "stable",
        DURE_HOME: root,
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function installClientControlFixture(
  root,
  { error: clientError = null, result: clientResult = null } = {},
) {
  const requests = [];
  const server = createServer((request, response) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      source += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(source),
      });
      response.writeHead(clientError ? 409 : 200, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify(
          clientError
            ? { ok: false, error: clientError }
            : (clientResult ?? {
                ok: true,
                pane: {
                  spaceId: "space-source",
                  desktopId: "space-source",
                  panelId: "agent:agent-0123456789abcdef0123456789abcdef",
                  agentId: "agent-0123456789abcdef0123456789abcdef",
                  sessionId: "session-0123456789abcdef0123456789abcdef",
                  workspaceId: "workspace-0123456789abcdef0123456789abcdef",
                  runtime: "hmux_managed_v1",
                  outcome: "created",
                },
              }),
        ),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture client did not bind a TCP port");
  }
  writeFileSync(
    join(root, "server.json"),
    JSON.stringify({
      schemaVersion: 1,
      apiVersion: 1,
      packageVersion: "0.1.4",
      buildId: "0.1.4+fixture",
      port: address.port,
      token: "client-control-token",
      channel: "stable",
      generation: "client-generation-1",
      processId: 42,
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "agents.json"),
    JSON.stringify({
      version: 3,
      updatedAt: Date.now(),
      agents: [],
      projects: [],
      clientPresentation: clientPresentation([
        {
          id: "space-source",
          name: "Source",
          kind: "desktop",
          panes: [managedPresentationPane()],
        },
      ]),
    }),
    { mode: 0o600 },
  );
  return {
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("dure run and spawn CLI", () => {
  it("resolves explicit and invoking-pane Space targets without backend state", () => {
    const projection = {
      state: "available",
      clientPresentation: clientPresentation([
        {
          id: "space-a",
          name: "Build",
          kind: "desktop",
          panes: [managedPresentationPane()],
        },
      ]),
    };
    const environment = {
      HMUX_SESSION_ID: "source-session",
      HMUX_WORKSPACE_ID: "source-workspace",
    };

    expect(
      resolveRunPresentationTarget({ registry: projection, environment }),
    ).toEqual({
      state: "requested",
      reason: "invoking_pane",
      spaceId: "space-a",
      windowLabel: "main",
      referencePanelId: "agent:source",
    });
    expect(
      resolveRunPresentationTarget({
        registry: { ...projection, state: "truncated" },
        environment,
      }),
    ).toMatchObject({ state: "requested", spaceId: "space-a" });
    expect(
      resolveRunPresentationTarget({
        registry: projection,
        environment: {},
        spaceSelector: "Build",
      }),
    ).toEqual({
      state: "requested",
      reason: "explicit_space",
      spaceId: "space-a",
      windowLabel: "main",
    });
    expect(
      resolveRunPresentationTarget({ registry: projection, environment: {} }),
    ).toEqual({ state: "headless", reason: "source_pane_unavailable" });

    expect(() =>
      resolveRunPresentationTarget({
        registry: {
          ...projection,
          clientPresentation: {
            ...projection.clientPresentation,
            schemaVersion: 1,
          },
        },
        environment,
      }),
    ).toThrow(expect.objectContaining({ code: "client_source_projection_invalid" }));

    expect(
      resolveRunPresentationTarget({
        registry: {
          state: "available",
          clientPresentation: clientPresentation([
            {
              id: "space-popout",
              name: "Popout",
              kind: "popout",
              panes: [],
            },
          ]),
        },
        environment: {},
        spaceSelector: "space-popout",
      }),
    ).toMatchObject({
      state: "requested",
      spaceId: "space-popout",
      windowLabel: "win-popout-space-popout",
    });
  });

  it("requires an explicit Space when the invoking runtime has two panes", () => {
    const registry = {
      state: "available",
      clientPresentation: clientPresentation([
        {
          id: "space-a",
          name: "A",
          kind: "desktop",
          panes: [managedPresentationPane({ id: "agent:source-a" })],
        },
        {
          id: "space-b",
          name: "B",
          kind: "desktop",
          panes: [managedPresentationPane({ id: "agent:source-b" })],
        },
      ]),
    };

    expect(() =>
      resolveRunPresentationTarget({
        registry,
        environment: {
          HMUX_SESSION_ID: "source-session",
          HMUX_WORKSPACE_ID: "source-workspace",
        },
      }),
    ).toThrow("--space");
    expect(
      resolveRunPresentationTarget({
        registry,
        environment: {
          HMUX_SESSION_ID: "source-session",
          HMUX_WORKSPACE_ID: "source-workspace",
        },
        spaceSelector: "A",
      }),
    ).toEqual({
      state: "requested",
      reason: "explicit_space",
      spaceId: "space-a",
      windowLabel: "main",
      referencePanelId: "agent:source-a",
    });
  });

  it("uses only the selected SSH backend and does not bootstrap app state", () => {
    const root = temporaryRoot();
    const remote = installRemoteFixture(root);
    const result = runCli(
      root,
      [
        "spawn",
        "preview",
        "--project",
        "dure",
        "--provider",
        "codex",
        "--name",
        "codex-1",
        "--idempotency-key",
        "spawn-request-1",
        "--no-worktree",
        "--prompt",
        prompt,
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: remote.log,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout);
    const observation = JSON.parse(readFileSync(remote.log, "utf8"));
    expect(report).toMatchObject({
      kind: "dure.agent_spawn.preview",
      source: { appDaemonRequired: false, transport: "ssh" },
      receipt: { plan: { request: { worktree: { kind: "project_root" } } } },
    });
    expect(observation.request.operation).toBe("agent_spawn.preview");
    expect(observation.request.body.promptDigest).toBe(promptDigest);
    expect(JSON.stringify(observation)).not.toContain(prompt);
    expect(observation.argv).toContain("remote-a.example.test");
    for (const [name, contents] of Object.entries({
      identity: "private material",
      knownHosts: "remote-a.example.test fixture",
    })) {
      const material = observation.materials[name];
      expect(material.contents).toBe(contents);
      expect(material.path).not.toBe(remote[name]);
      expect(existsSync(material.path)).toBe(false);
      expect(readFileSync(remote[name], "utf8")).toBe(contents);
      expect(result.stdout).not.toContain(material.path);
      expect(result.stdout).not.toContain(contents);
    }
    expect(result.stdout).not.toContain(remote.identity);
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(existsSync(join(root, "agents.json"))).toBe(false);
  });

  it("runs one prompt through preview and apply without app-owned state", () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const result = runCli(
      root,
      [
        "run",
        prompt,
        "--project",
        "dure",
        "--provider",
        "codex",
        "--idempotency-key",
        "run-request-1",
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: remote.log,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout);
    const observations = JSON.parse(readFileSync(remote.log, "utf8"));
    expect(report).toMatchObject({
      kind: "dure.agent_spawn.apply",
      complete: true,
      receipt: {
        state: "succeeded",
        plan: {
          request: {
            idempotencyKey: "run-request-1",
            agentName: expect.stringMatching(/^codex-[a-f0-9]{12}$/),
          },
        },
      },
    });
    expect(observations.map(({ request }) => request.operation)).toEqual([
      "agent_spawn.preview",
      "agent_spawn.apply",
    ]);
    expect(observations[0].request.body.promptDigest).toBe(promptDigest);
    expect(JSON.stringify(observations[0])).not.toContain(prompt);
    expect(observations[1].request.body).toMatchObject({
      schemaVersion: 1,
      operationId: "spawn-0123456789abcdef0123456789abcdef",
      planToken: `sha256:${"b".repeat(64)}`,
      expectedLastSequence: 1,
      prompt,
    });
    expect(result.stdout).not.toContain(prompt);
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(existsSync(join(root, "agents.json"))).toBe(false);

    const replay = runCli(
      root,
      [
        "run",
        prompt,
        "--project",
        "dure",
        "--provider",
        "codex",
        "--idempotency-key",
        "run-request-1",
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: remote.log,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );
    expect(replay.status, `${replay.stdout}\n${replay.stderr}`).toBe(0);
    const replayedObservations = JSON.parse(readFileSync(remote.log, "utf8"));
    expect(replayedObservations[2].request.body.agentName).toBe(
      replayedObservations[0].request.body.agentName,
    );
  });

  it("runs one dedicated worktree through the same durable spawn operation", () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const result = runCli(
      root,
      [
        "run",
        prompt,
        "--project",
        "dure",
        "--provider",
        "codex",
        "--worktree",
        "feature-x",
        "--setup-command",
        "pnpm install",
        "--idempotency-key",
        "run-worktree-1",
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: remote.log,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const observations = JSON.parse(readFileSync(remote.log, "utf8"));
    expect(observations[0].request.body.worktree).toEqual({
      kind: "dedicated",
      branch: "agent/feature-x",
    });
    expect(observations[0].request.body.setupCommand).toBe("pnpm install");
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      receipt: {
        state: "succeeded",
        plan: {
          request: {
            agentName: "feature-x",
            worktree: {
              kind: "dedicated",
              base_commit_sha: "a".repeat(40),
              branch: "agent/feature-x",
            },
          },
        },
      },
    });
    expect(report.receipt.completed[0].evidence).toMatchObject({
      disposition: "created_dure_owned",
      lease: {
        directory_name: "feature-x",
        retirement_id:
          "workspace-retire:workspace-0123456789abcdef0123456789abcdef",
      },
    });
    expect(report.receipt.completed[1].inputs.setup_command).toBe(
      "pnpm install",
    );

    const explicitRoot = temporaryRoot();
    const explicitRemote = installRunRemoteFixture(explicitRoot);
    const explicitBase = "c".repeat(40);
    const explicit = runCli(
      explicitRoot,
      [
        "run",
        prompt,
        "--project",
        "dure",
        "--provider",
        "codex",
        "--worktree",
        "feature-y",
        "--base-commit",
        explicitBase,
        "--branch",
        "agent/custom-feature-y",
        "--idempotency-key",
        "run-worktree-2",
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: explicitRemote.log,
        PATH: `${explicitRemote.bin}:${process.env.PATH}`,
      },
    );

    expect(explicit.status, `${explicit.stdout}\n${explicit.stderr}`).toBe(0);
    const explicitObservations = JSON.parse(
      readFileSync(explicitRemote.log, "utf8"),
    );
    expect(explicitObservations[0].request.body.worktree).toEqual({
      kind: "dedicated",
      base_commit_sha: explicitBase,
      branch: "agent/custom-feature-y",
    });
  });

  it.each([
    {
      label: "skip permissions",
      flags: ["--skip-permissions"],
      permissionOverride: "bypass_approvals",
      permissionMode: "skip_permissions",
    },
    {
      label: "auto edit",
      flags: ["--permission-override", "auto_edit"],
      permissionOverride: "auto_edit",
      permissionMode: "auto_edit",
    },
  ])("carries $label through the canonical run request", ({
    flags,
    permissionOverride,
    permissionMode,
  }) => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const result = runCli(
      root,
      [
        "run",
        prompt,
        "--project",
        "dure",
        "--provider",
        "codex",
        ...flags,
        "--idempotency-key",
        "run-skip-permissions-1",
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: remote.log,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const observations = JSON.parse(readFileSync(remote.log, "utf8"));
    expect(observations[0].request.body).not.toHaveProperty("permissionMode");
    expect(observations[0].request.body.permissionOverride).toBe(permissionOverride);
    expect(JSON.parse(result.stdout)).toMatchObject({
      receipt: {
        plan: { request: { permissionMode } },
      },
    });
  });

  it("rejects empty dedicated overrides before contacting the backend", () => {
    for (const override of [
      ["--base-commit", ""],
      ["--branch", ""],
    ]) {
      const root = temporaryRoot();
      const remote = installRunRemoteFixture(root);
      const result = runCli(
        root,
        [
          "run",
          prompt,
          "--project",
          "dure",
          "--provider",
          "codex",
          "--worktree",
          "feature-x",
          ...override,
          "--backend",
          "remote-a",
          "--json",
        ],
        {
          DURE_AGENT_SPAWN_LOG: remote.log,
          PATH: `${remote.bin}:${process.env.PATH}`,
        },
      );

      expect(result.status).toBe(1);
      expect(existsSync(remote.log)).toBe(false);
    }
  });

  it("uses an explicit path or cwd as the backend-owned project selector", () => {
    for (const explicitPath of [true, false]) {
      const root = temporaryRoot();
      const remote = installRunRemoteFixture(root);
      const selectorPath = join(root, "catalog-project");
      mkdirSync(selectorPath);
      const args = [
        "run",
        prompt,
        ...(explicitPath ? ["--path", selectorPath] : []),
        "--provider",
        "codex",
        "--idempotency-key",
        explicitPath ? "run-path-request-1" : "run-cwd-request-1",
        "--backend",
        "remote-a",
        "--json",
      ];
      const result = runCli(
        root,
        args,
        {
          DURE_AGENT_SPAWN_LOG: remote.log,
          PATH: `${remote.bin}:${process.env.PATH}`,
        },
        selectorPath,
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const report = JSON.parse(result.stdout);
      const observations = JSON.parse(readFileSync(remote.log, "utf8"));
      expect(observations[0].request.body).toMatchObject({
        projectPath: explicitPath ? selectorPath : realpathSync(selectorPath),
      });
      expect(observations[0].request.body).not.toHaveProperty("projectId");
      expect(report.receipt.plan).toMatchObject({
        authority: { projectId: "dure" },
        request: { projectId: "dure" },
      });
      expect(JSON.stringify(report)).not.toContain(selectorPath);
    }
  });

  it("rejects project and path together before backend transport", () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const result = runCli(
      root,
      [
        "run",
        prompt,
        "--project",
        "dure",
        "--path",
        "/remote/dure",
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: remote.log,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--project ID | --path PATH");
    expect(existsSync(remote.log)).toBe(false);
  });

  it("shows run help without selecting a backend or creating an operation", () => {
    const root = temporaryRoot();

    const result = runCli(root, ["run", "--help"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("dure run");
    expect(result.stdout).toContain("--space");
    expect(existsSync(join(root, "backend-profiles.json"))).toBe(false);
    expect(existsSync(join(root, "backend"))).toBe(false);
  });

  it("opens a --project run by the backend's canonical root beside the invoking pane", async () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const client = await installClientControlFixture(root);
    try {
      const result = await runCliAsync(
        root,
        [
          "run",
          prompt,
          "--project",
          "dure",
          "--provider",
          "codex",
          "--idempotency-key",
          "run-presented-1",
          "--backend",
          "remote-a",
          "--json",
        ],
        {
          DURE_AGENT_SPAWN_LOG: remote.log,
          HMUX_SESSION_ID: "source-session",
          HMUX_WORKSPACE_ID: "source-workspace",
          PATH: `${remote.bin}:${process.env.PATH}`,
        },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: "dure.agent_spawn.apply",
        receipt: { state: "succeeded" },
        presentation: {
          state: "opened",
          pane: {
            spaceId: "space-source",
            panelId: "agent:agent-0123456789abcdef0123456789abcdef",
          },
        },
      });
      expect(result.stdout).not.toContain("/remote/dure");
      expect(client.requests).toEqual([
        expect.objectContaining({
          method: "POST",
          url: "/hmux/attach",
          authorization: "Bearer client-control-token",
          body: expect.objectContaining({
            runtime: "hmux_managed_v1",
            backendProfileId: "remote-a",
            source: "ssh",
            hostId: "remote-a",
            projectId: "dure",
            projectPath: "/remote/dure",
            spaceId: "space-source",
            windowLabel: "main",
            referencePanelId: "agent:source",
            sessionId: "session-0123456789abcdef0123456789abcdef",
            workspaceId: "workspace-0123456789abcdef0123456789abcdef",
            generation: {
              runnerPrincipal: "runner-principal-1",
              runnerInstance: "runner-instance-1",
              channelEpoch: "1",
              hostInstanceId: "host-instance-1",
              terminalEpoch: "terminal-epoch-1",
            },
          }),
        }),
      ]);
      const backendRequests = JSON.parse(readFileSync(remote.log, "utf8"));
      expect(backendRequests[0].request).toMatchObject({
        operation: "agent_spawn.preview",
        body: { includePresentationProject: true },
        expected: {
          requiredCapabilities: expect.arrayContaining([
            "agent_spawn.presentation_project.v1",
            "agent_spawn.preview.v2",
          ]),
        },
      });
      expect(
        backendRequests.map(
          ({ request }) => request.operation,
        ),
      ).toEqual(["agent_spawn.preview", "agent_spawn.apply"]);
    } finally {
      await client.close();
    }
  });

  it("opens a committed runtime even when prompt delivery is uncertain", async () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const client = await installClientControlFixture(root);
    try {
      const result = await runCliAsync(
        root,
        [
          "run",
          prompt,
          "--project",
          "dure",
          "--provider",
          "codex",
          "--idempotency-key",
          "run-presented-uncertain-1",
          "--backend",
          "remote-a",
          "--json",
        ],
        {
          DURE_AGENT_SPAWN_FIXTURE_APPLY_STATE: "prompt_delivery_uncertain",
          DURE_AGENT_SPAWN_LOG: remote.log,
          HMUX_SESSION_ID: "source-session",
          HMUX_WORKSPACE_ID: "source-workspace",
          PATH: `${remote.bin}:${process.env.PATH}`,
        },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: "dure.agent_spawn.apply",
        receipt: { state: "prompt_delivery_uncertain" },
        presentation: {
          state: "opened",
          pane: {
            spaceId: "space-source",
            panelId: "agent:agent-0123456789abcdef0123456789abcdef",
          },
        },
      });
      expect(client.requests).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("reports a pane failure without replaying the succeeded Run", async () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const client = await installClientControlFixture(root, {
      error: {
        code: "client_space_changed",
        message: "Space changed before pane commit",
      },
    });
    try {
      const result = await runCliAsync(
        root,
        [
          "run",
          prompt,
          "--project",
          "dure",
          "--provider",
          "codex",
          "--idempotency-key",
          "run-presentation-failed-1",
          "--backend",
          "remote-a",
          "--json",
        ],
        {
          DURE_AGENT_SPAWN_LOG: remote.log,
          HMUX_SESSION_ID: "source-session",
          HMUX_WORKSPACE_ID: "source-workspace",
          PATH: `${remote.bin}:${process.env.PATH}`,
        },
      );

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        receipt: { state: "succeeded" },
        presentation: {
          state: "failed",
          error: { code: "client_space_changed" },
        },
      });
      expect(
        JSON.parse(readFileSync(remote.log, "utf8")).map(
          ({ request }) => request.operation,
        ),
      ).toEqual(["agent_spawn.preview", "agent_spawn.apply"]);
      expect(client.requests).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("rejects a client pane receipt for another runtime identity", async () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const client = await installClientControlFixture(root, {
      result: {
        ok: true,
        pane: {
          spaceId: "space-other",
          desktopId: "space-other",
          panelId: "agent:agent-other",
          agentId: "agent-other",
          sessionId: "session-other",
          workspaceId: "workspace-other",
          runtime: "hmux_managed_v1",
          outcome: "created",
        },
      },
    });
    try {
      const result = await runCliAsync(
        root,
        [
          "run",
          prompt,
          "--project",
          "dure",
          "--provider",
          "codex",
          "--idempotency-key",
          "run-wrong-pane-receipt-1",
          "--backend",
          "remote-a",
          "--json",
        ],
        {
          DURE_AGENT_SPAWN_LOG: remote.log,
          HMUX_SESSION_ID: "source-session",
          HMUX_WORKSPACE_ID: "source-workspace",
          PATH: `${remote.bin}:${process.env.PATH}`,
        },
      );

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        receipt: { state: "succeeded" },
        presentation: {
          state: "failed",
          error: { code: "client_response_invalid" },
        },
      });
      expect(client.requests).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("keeps bare spawn as a thin compatibility entry point to run", () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const result = runCli(
      root,
      [
        "spawn",
        "--project",
        "dure",
        "--agent",
        "codex",
        "--prompt",
        prompt,
        "--no-worktree",
        "--idempotency-key",
        "spawn-compat-1",
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: remote.log,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.agent_spawn.apply",
      receipt: {
        state: "succeeded",
        plan: {
          request: {
            providerId: "codex",
            promptDigest,
            worktree: { kind: "project_root" },
          },
        },
      },
    });
    const observations = JSON.parse(readFileSync(remote.log, "utf8"));
    expect(observations.map(({ request }) => request.operation)).toEqual([
      "agent_spawn.preview",
      "agent_spawn.apply",
    ]);
  });

  it("keeps promptless project-root spawn compatibility", () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const result = runCli(
      root,
      [
        "spawn",
        "--project",
        "dure",
        "--agent",
        "codex",
        "--no-worktree",
        "--idempotency-key",
        "spawn-without-prompt-1",
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: remote.log,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      receipt: {
        state: "succeeded",
        plan: { request: { promptDigest: null } },
      },
      presentation: { state: "headless" },
    });
  });

  it("does not reinterpret --reuse on the canonical run command", () => {
    const root = temporaryRoot();
    const result = runCli(root, ["run", "--reuse", prompt]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dure run");
    expect(existsSync(join(root, "backend"))).toBe(false);
  });

  it("preserves reuse as a client-only durable successor action", async () => {
    const root = temporaryRoot();
    const client = await installClientControlFixture(root, {
      result: {
        ok: true,
        agent: {
          id: "agent-cleaner",
          name: "cleaner",
          projectId: "project-1",
          provider: "codex",
          sessionId: "managed-successor",
          runtime: "hmux_managed_v1",
        },
      },
    });
    try {
      const result = await runCliAsync(root, [
        "spawn",
        "--reuse",
        "--project",
        "HebbianIDE",
        "--name",
        "cleaner",
        "--prompt",
        "continue",
        "--window-label",
        "main",
        "--idempotency-key",
        "reuse-cleaner-1",
        "--json",
      ]);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: "dure.agent.reuse",
        state: "reused",
        agent: {
          id: "agent-cleaner",
          sessionId: "managed-successor",
        },
      });
      expect(client.requests).toEqual([
        expect.objectContaining({
          method: "POST",
          url: "/agent/reuse",
          authorization: "Bearer client-control-token",
          body: {
            schemaVersion: 1,
            project: "HebbianIDE",
            name: "cleaner",
            prompt: "continue",
            idempotencyKey: "reuse-cleaner-1",
            windowLabel: "main",
          },
        }),
      ]);
      expect(existsSync(join(root, "backend-profiles.json"))).toBe(false);
      expect(existsSync(join(root, "backend"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("routes the legacy implicit worktree through the canonical Run writer", () => {
    const root = temporaryRoot();
    const remote = installRunRemoteFixture(root);
    const result = runCli(
      root,
      [
        "spawn",
        "--project",
        "dure",
        "--agent",
        "codex",
        "--prompt",
        prompt,
        "--idempotency-key",
        "spawn-implicit-worktree-1",
        "--backend",
        "remote-a",
        "--json",
      ],
      {
        DURE_AGENT_SPAWN_LOG: remote.log,
        PATH: `${remote.bin}:${process.env.PATH}`,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).receipt.plan.request.worktree).toMatchObject({
      kind: "dedicated",
      branch: expect.stringMatching(/^agent\/codex-[a-f0-9]{12}$/),
    });
  });

  it("documents the daemonless preview/status split without creating state", () => {
    const root = temporaryRoot();
    const help = runCli(root, ["help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain(
      "dure spawn preview (--project <id> | --path <path>)",
    );
    expect(help.stdout).toContain("dure spawn apply --operation-id <id>");
    expect(help.stdout).toContain("dure spawn status (--operation-id <id>");
    expect(help.stdout).toContain(
      "dure run [--project <id> | --path <path>]",
    );
    expect(existsSync(join(root, "backend-profiles.json"))).toBe(false);
  });
});

describe("agent spawn apply deadline", () => {
  it("an apply with the CLI's own default deadline is a valid request that reaches the backend", async () => {
    // Regression: e4174111b raised the apply default to 185s above the single
    // 60s cap, so every `dure run` refused its own apply as request_invalid.
    expect(DEFAULT_AGENT_SPAWN_APPLY_DEADLINE_MS).toBeLessThanOrEqual(
      MAX_AGENT_SPAWN_APPLY_DEADLINE_MS,
    );
    const seen = [];
    const value = succeededStructuredReceipt();
    const report = await collectAgentSpawnQuery({
      action: "apply",
      operationId: value.operationId,
      planToken: value.plan.planToken,
      expectedLastSequence: 1,
      backend: { profile: profile(), transportOptions: {} },
      requestBackend: async (_profile, backendRequest) => {
        seen.push(backendRequest);
        return backendResult({ schemaVersion: 1, receipt: value });
      },
    });
    expect(report).toMatchObject({ kind: "dure.agent_spawn.apply", complete: true });
    expect(seen).toHaveLength(1);
    expect(report.limits.deadlineMs).toBe(DEFAULT_AGENT_SPAWN_APPLY_DEADLINE_MS);
  });

  it("still refuses a deadline above the action's cap before transport", async () => {
    const report = await collectAgentSpawnQuery({
      action: "apply",
      operationId: "spawn-1",
      planToken: `sha256:${"a".repeat(64)}`,
      expectedLastSequence: 1,
      deadlineMs: MAX_AGENT_SPAWN_APPLY_DEADLINE_MS + 1,
      backend: { profile: profile(), transportOptions: {} },
      requestBackend: async () => {
        throw new Error("must not reach the backend");
      },
    });
    expect(report).toMatchObject({ error: { code: "agent_spawn_request_invalid" } });
  });
});
