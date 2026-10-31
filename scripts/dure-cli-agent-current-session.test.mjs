import { describe, expect, it, vi } from "vitest";
import {
  agentScreenReader,
  currentAgentSessionSuccessor,
} from "../cli/lib/agent-current-session.mjs";
import { SessionCaptureError } from "../cli/lib/local-session-read.mjs";
import { succeededNativeReceipt } from "./fixtures/agent-spawn-receipts.mjs";

/** A registry Agent whose backend binding moved to a successor Session, as a
 * `dure runs switch-account` or restart leaves it while the app is closed. */
function movedAgent({ movedTo = "runtime-native-successor" } = {}) {
  const receipt = succeededNativeReceipt();
  const plan = receipt.plan;
  const session = receipt.completed.find((stage) => stage.stage === "runtime_launch").evidence.session;
  const agent = {
    id: plan.agentId, name: "lead", displayName: "lead", sessionId: session.sessionId, kind: "pty",
    runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local",
      backendProfileId: "local", sessionId: session.sessionId, workspaceId: plan.workspaceId },
  };
  const runtime = { schemaVersion: 1, state: "stable", receipt: { schemaVersion: 1,
    agentId: plan.agentId, selectionRevision: 2, providerId: plan.request.providerId,
    executionProfile: plan.request.executionProfile, permissionMode: plan.request.permissionMode,
    authority: { interactionProfile: "native_cli", authority: {
      ...session, sessionId: movedTo, runtimeWorkspaceId: plan.workspaceId,
      binding: { agentId: plan.agentId, sessionId: movedTo, runtimeKindId: "runtime.hmux" },
    } } }, projectionContext: { schemaVersion: 1, identity: { kind: "registered" },
      agent: { agentId: plan.agentId, providerId: plan.request.providerId, workspaceId: plan.workspaceId },
      workspace: { workspaceId: plan.workspaceId, projectId: plan.authority.projectId, rootPath: "/repo" },
      project: { projectId: plan.authority.projectId, rootPath: "/repo" } } };
  const requestBackend = vi.fn(async (_profile, request) => {
    expect(request.operation).toBe("agent_runtime.projection.inspect");
    expect(request.body).toEqual({ schemaVersion: 1, agentId: plan.agentId });
    return { result: runtime };
  });
  const resolveBackend = async () => ({ profile: { id: "local", transport: { kind: "local" } } });
  return { agent, runtime, requestBackend, resolveBackend, workspaceId: plan.workspaceId };
}

describe("an Agent's current Session after a restart or account switch", () => {
  it("names the backend's current Session when the registry still lists the predecessor", async () => {
    const f = movedAgent();
    await expect(currentAgentSessionSuccessor(f)).resolves.toEqual({
      sessionId: "runtime-native-successor", workspaceId: f.workspaceId,
    });
    expect(f.requestBackend).toHaveBeenCalledTimes(1);
  });

  it("reports no successor when the registry already lists the current Session", async () => {
    const f = movedAgent();
    await expect(currentAgentSessionSuccessor({ ...f, agent: { ...f.agent,
      runtimeBinding: { ...f.agent.runtimeBinding, sessionId: "runtime-native-successor" } } })).resolves.toBeNull();
  });

  it.each([
    ["an unregistered name", (agent) => ({ ...agent, id: undefined })],
    ["a remote binding", (agent) => ({ ...agent, runtimeBinding: { ...agent.runtimeBinding, source: "ssh" } })],
  ])("never asks the backend for %s", async (_label, change) => {
    const f = movedAgent();
    await expect(currentAgentSessionSuccessor({ ...f, agent: change(f.agent) })).resolves.toBeNull();
    expect(f.requestBackend).not.toHaveBeenCalled();
  });

  it("reads the successor once the registered Session has exited, and stays there", async () => {
    const f = movedAgent();
    const exited = new SessionCaptureError("nonzero",
      "hmux: error: The exited Hmux session can no longer provide a terminal attachment");
    const capture = vi.fn(async (session) => {
      if (session === f.agent) throw exited;
      return `screen of ${session.sessionId}`;
    });
    const onSuccessor = vi.fn();
    const read = agentScreenReader({ agent: f.agent, capture, onSuccessor,
      findSuccessor: (agent) => currentAgentSessionSuccessor({ ...f, agent }) });

    await expect(read()).resolves.toBe("screen of runtime-native-successor");
    await expect(read()).resolves.toBe("screen of runtime-native-successor");
    expect(capture.mock.calls.map(([session]) => session === f.agent ? "registry" : session.sessionId))
      .toEqual(["registry", "runtime-native-successor", "runtime-native-successor"]);
    expect(onSuccessor).toHaveBeenCalledTimes(1);
    expect(onSuccessor).toHaveBeenCalledWith({ sessionId: "runtime-native-successor", workspaceId: f.workspaceId });
    expect(f.requestBackend).toHaveBeenCalledTimes(1);
  });

  it("keeps the registered Session's own failure when no successor exists", async () => {
    const f = movedAgent();
    const exited = new SessionCaptureError("nonzero", "session exited");
    const read = agentScreenReader({ agent: f.agent, capture: async () => { throw exited; },
      findSuccessor: async () => null });
    await expect(read()).rejects.toBe(exited);
  });

  it.each(["timeout", "aborted"])("does not look for a successor after a %s", async (kind) => {
    const f = movedAgent();
    const failure = new SessionCaptureError(kind, kind);
    const findSuccessor = vi.fn();
    const read = agentScreenReader({ agent: f.agent, capture: async () => { throw failure; }, findSuccessor });
    await expect(read()).rejects.toBe(failure);
    expect(findSuccessor).not.toHaveBeenCalled();
  });
});
