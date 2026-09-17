import { describe, expect, it, vi } from "vitest";
import {
  agentRuntimeConvergenceExitCode,
  collectAgentRuntimeConvergence,
} from "../cli/lib/agent-runtime-convergence.mjs";
import { parseAgentRuntimeDiagnosticArgs } from "./diagnose-agent-runtime.mjs";

const generation = {
  runnerPrincipal: "local-user",
  runnerInstance: "runner-1",
  channelEpoch: "1",
  hostInstanceId: "host-1",
  terminalEpoch: "terminal-1",
};

const profile = {
  id: "local",
  transport: { kind: "local" },
};

function backendResponse(overrides = {}) {
  return {
    result: {
      schemaVersion: 1,
      state: "stable",
      receipt: {
        schemaVersion: 1,
        agentId: "agent-1",
        providerId: "codex",
        selectionRevision: 8,
        providerConversationRef: "conversation-1",
        executionProfile: {
          kind: "credential_reference",
          reference_id: "account-b",
          credential_generation: "credential-b-9",
        },
        authority: {
          interactionProfile: "native_cli",
          authority: {
            schemaVersion: 1,
            ...generation,
            runtimeWorkspaceId: "workspace-1",
            binding: {
              agentId: "agent-1",
              bindingGeneration: 16,
              sessionId: "session-2",
              runtimeKindId: "runtime.hmux",
              credentialReferenceId: "account-b",
              providerConversationId: "conversation-1",
            },
          },
        },
        ...overrides,
      },
    },
  };
}

function sessionReport(overrides = {}) {
  return {
    kind: "dure.sessions.show",
    session: {
      sessionId: "session-2",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      provider: { id: "codex" },
      runtime: { sessionClass: "managed", generation: { ...generation } },
      liveness: {
        state: "alive",
        health: "healthy",
        exactGeneration: true,
      },
      clientProjection: {
        state: "current",
        agents: [{ id: "agent-1" }],
      },
      ...overrides,
    },
  };
}

function registry(overrides = {}) {
  return {
    state: "available",
    agents: [
      {
        id: "agent-1",
        credentialId: "account-b",
        conversationId: "conversation-1",
        runtimeBinding: {
          source: "local",
          hostId: "local",
          backendProfileId: "local",
          sessionId: "session-2",
          workspaceId: "workspace-1",
          credentialId: "account-b",
          stopFence: { ...generation },
          conversationIdentity: { conversationId: "conversation-1" },
        },
      },
    ],
    clientPresentation: {
      schemaVersion: 2,
      complete: true,
      spaces: [
        {
          id: "space-1",
          name: "Space 1",
          kind: "desktop",
          windowLabel: "main",
          panes: [
            {
              id: "agent:agent-1",
              type: "agent",
              component: "agent",
              agentId: "agent-1",
              binding: {
                schemaVersion: 1,
                runtime: "hmux_managed_v1",
                source: "local",
                hostId: "local",
                workspaceId: "workspace-1",
                sessionId: "session-2",
              },
            },
          ],
        },
      ],
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
    },
    ...overrides,
  };
}

async function collect({ response, session, clientRegistry } = {}) {
  const requestBackend = vi
    .fn()
    .mockResolvedValue(response ?? backendResponse());
  const collectSessions = vi
    .fn()
    .mockResolvedValue(session ?? sessionReport());
  const report = await collectAgentRuntimeConvergence({
    agentId: "agent-1",
    sourceSessionId: "session-1",
    expectedCredentialId: "account-b",
    expectedConversationId: "conversation-1",
    profile,
    registry: clientRegistry ?? registry(),
    requestBackend,
    collectSessions,
    now: () => 42,
  });
  return { report, requestBackend, collectSessions };
}

describe("agent runtime convergence diagnostic", () => {
  it.each(["slot", "pane-neutral", "launcher:previous", "term:previous", "agent:previous"])(
    "compares the current Agent projection in %s without guessing another pane",
    async (paneId) => {
      const clientRegistry = registry();
      clientRegistry.clientPresentation.spaces[0].panes[0].id = paneId;
      const { report } = await collect({ clientRegistry });
      expect(report).toMatchObject({ ok: true, projection: { paneId }, failures: [] });
      expect(agentRuntimeConvergenceExitCode(report)).toBe(0);
    },
  );

  it.each(["terminal", "launcher"])(
    "does not mistake changed %s content carrying the old Agent fields for its view",
    async (component) => {
      const clientRegistry = registry();
      const pane = clientRegistry.clientPresentation.spaces[0].panes[0];
      pane.component = component;
      pane.type = component === "terminal" ? "terminal" : "other";
      const { report } = await collect({ clientRegistry });
      expect(report).toMatchObject({ ok: false, projection: { paneId: null } });
      expect(report.failures).toEqual([{ code: "client_pane_projection_mismatch" }]);
    },
  );

  it("proves backend, Hmux, Agent, and pane projections select one successor", async () => {
    const { report, requestBackend, collectSessions } = await collect();

    expect(report).toMatchObject({
      kind: "dure.agent_runtime.convergence",
      complete: true,
      ok: true,
      observedAtMs: 42,
      authority: {
        credentialId: "account-b",
        credentialGeneration: "credential-b-9",
        conversationId: "conversation-1",
        sessionId: "session-2",
        generation,
      },
      projection: {
        runtimeState: "current",
        agentId: "agent-1",
        paneId: "agent:agent-1",
      },
      failures: [],
    });
    expect(agentRuntimeConvergenceExitCode(report)).toBe(0);
    expect(requestBackend).toHaveBeenCalledWith(
      profile,
      {
        operation: "agent_runtime.inspect",
        body: { schemaVersion: 1, agentId: "agent-1" },
        requiredCapabilities: ["agent_runtime.inspect"],
      },
      {},
    );
    expect(collectSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "show",
        sessionId: "session-2",
        workspaceId: "workspace-1",
      }),
    );
    expect(JSON.stringify(report)).not.toContain("endpoint");
  });

  it("reports every diverged projection without writing a fallback authority", async () => {
    const clientRegistry = registry();
    clientRegistry.agents[0].credentialId = "account-stale";
    clientRegistry.clientPresentation.spaces[0].panes[0].binding.sessionId =
      "session-stale";
    const { report } = await collect({
      session: sessionReport({
        conversationId: "conversation-stale",
        runtime: {
          sessionClass: "managed",
          generation: { ...generation, terminalEpoch: "terminal-stale" },
        },
        liveness: {
          state: "unknown",
          health: "generation_changed",
          exactGeneration: false,
        },
        clientProjection: { state: "stale", agents: [{ id: "agent-1" }] },
      }),
      clientRegistry,
    });

    expect(report.ok).toBe(false);
    expect(report.failures.map(({ code }) => code)).toEqual([
      "hmux_conversation_mismatch",
      "hmux_generation_mismatch",
      "hmux_runtime_unhealthy",
      "client_runtime_projection_not_current",
      "client_agent_projection_mismatch",
      "client_pane_projection_mismatch",
    ]);
    expect(agentRuntimeConvergenceExitCode(report)).toBe(1);
  });

  it("requires the credential switch to select a different Hmux writer", async () => {
    const report = await collectAgentRuntimeConvergence({
      agentId: "agent-1",
      sourceSessionId: "session-2",
      expectedCredentialId: "account-b",
      expectedConversationId: "conversation-1",
      profile,
      registry: registry(),
      requestBackend: vi.fn().mockResolvedValue(backendResponse()),
      collectSessions: vi.fn().mockResolvedValue(sessionReport()),
      now: () => 42,
    });

    expect(report.failures).toContainEqual({
      code: "backend_successor_not_replaced",
    });
    expect(agentRuntimeConvergenceExitCode(report)).toBe(1);
  });

  it("distinguishes incomplete observation from a proven mismatch", async () => {
    const requestBackend = vi.fn().mockRejectedValue(
      Object.assign(new Error("rejected"), {
        code: "backend_transport_remote_rejected",
        details: { code: "agent_runtime_inspect_denied" },
      }),
    );
    const report = await collectAgentRuntimeConvergence({
      agentId: "agent-1",
      sourceSessionId: "session-1",
      expectedCredentialId: "account-b",
      expectedConversationId: "conversation-1",
      profile,
      registry: registry(),
      requestBackend,
      now: () => 42,
    });

    expect(report).toMatchObject({
      kind: "dure.agent_runtime.convergence_error",
      complete: false,
      ok: false,
      error: {
        code: "agent_runtime_convergence_backend_failed",
        upstreamCode: "agent_runtime_inspect_denied",
      },
    });
    expect(agentRuntimeConvergenceExitCode(report)).toBe(2);
  });

  it("does not inspect Hmux while the backend selection is transitioning", async () => {
    const collectSessions = vi.fn();
    const response = backendResponse();
    response.result = { schemaVersion: 1, state: "transitioning" };
    const report = await collectAgentRuntimeConvergence({
      agentId: "agent-1",
      sourceSessionId: "session-1",
      expectedCredentialId: "account-b",
      expectedConversationId: "conversation-1",
      profile,
      registry: registry(),
      requestBackend: vi.fn().mockResolvedValue(response),
      collectSessions,
      now: () => 42,
    });

    expect(report.failures).toEqual([
      {
        code: "backend_runtime_not_stable",
        expected: "stable",
        observed: "transitioning",
      },
    ]);
    expect(collectSessions).not.toHaveBeenCalled();
  });

  it("accepts the canonical pane id directly from an incident report", () => {
    expect(
      parseAgentRuntimeDiagnosticArgs([
        "--",
        "--agent",
        "agent:agent-1",
        "--source-session",
        "session-1",
        "--credential",
        "account-b",
        "--conversation",
        "conversation-1",
        "--backend",
        "local",
        "--channel",
        "dev-fix-live-1234",
        "--json",
      ]),
    ).toEqual({
      agentId: "agent-1",
      sourceSessionId: "session-1",
      expectedCredentialId: "account-b",
      expectedConversationId: "conversation-1",
      backendId: "local",
      channel: "dev-fix-live-1234",
      json: true,
    });
  });
});
