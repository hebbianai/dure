import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HmuxRecoveryExecutionReceipt,
  HmuxRecoveryPlanReceipt,
  HmuxSessionSummary,
} from "@/lib/ipc";

const mocks = vi.hoisted(() => ({
  executeRecovery: vi.fn(),
  inspectPaneSet: vi.fn(),
  planRecovery: vi.fn(),
  preparePaneSet: vi.fn(),
  retargetPaneSet: vi.fn(),
  terminateStandalone: vi.fn(),
}));

vi.mock("@/lib/hmux/standalone/standaloneHmuxPaneSet", () => ({
  inspectStandaloneHmuxPaneSet: mocks.inspectPaneSet,
  prepareStandaloneHmuxPaneSet: mocks.preparePaneSet,
  retargetStandaloneHmuxPaneSet: mocks.retargetPaneSet,
}));

vi.mock("@/lib/ipc", () => ({
  hmux: {
    executeRecovery: mocks.executeRecovery,
    planRecovery: mocks.planRecovery,
    terminateStandalone: mocks.terminateStandalone,
  },
}));

import {
  executeStandaloneHmuxRecovery,
  inspectStandaloneHmuxRecovery,
} from "@/lib/hmux/standalone/standaloneHmuxRecovery";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { useStore } from "@/store";
import { hmuxSessionSummaryFixture } from "@/test/agentFixtures";

const source = {
  desktopId: "desktop-1",
  panelId: "term:source-session",
  sessionId: "source-session",
  workspaceId: "workspace-1",
  cwd: "/repo",
};

function paneSet() {
  return {
    source,
    sourceSummary: summary(),
    consumers: [
      {
        desktopId: source.desktopId,
        panelId: source.panelId,
        sourceTransportSessionId: source.sessionId,
        state: "source" as const,
        cwd: source.cwd,
      },
    ],
  };
}

function summary(
  patch: Partial<HmuxSessionSummary> = {},
): HmuxSessionSummary {
  return hmuxSessionSummaryFixture({
    sessionId: source.sessionId,
    sessionName: "shell-one",
    workspaceId: source.workspaceId,
    sessionClass: "standalone",
    lifecycle: "unavailable",
    manifestLifecycle: "ready",
    health: "stale_transport",
    hostBuildVersion: "build-old",
    clientSelection: "direct_rust",
    inputAllowed: false,
    detachOnly: true,
    terminalEpoch: "epoch-old",
    outputSeq: "7",
    ...patch,
  });
}

function plan(): HmuxRecoveryPlanReceipt {
  return {
    sessionId: source.sessionId,
    sourceBuildId: "build-old",
    targetBuildId: "build-current",
    action: "restore_plain_shell_with_current_build",
    allowed: true,
    requiresConfirmation: false,
  };
}

function execution(): HmuxRecoveryExecutionReceipt {
  return {
    sourceSessionId: source.sessionId,
    targetBuildId: "build-current",
    action: "restore_plain_shell_with_current_build",
    outcome: "restored",
    replayed: false,
    replacementSession: summary({
      sessionId: "replacement-session",
      lifecycle: "ready",
      manifestLifecycle: "ready",
      health: "current_healthy",
      hostBuildVersion: "build-current",
      inputAllowed: true,
      detachOnly: false,
      terminalEpoch: "epoch-new",
      outputSeq: "0",
    }),
  };
}

describe("standalone Hmux stale-session recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectPaneSet.mockResolvedValue(paneSet());
    mocks.preparePaneSet.mockResolvedValue(paneSet());
    mocks.planRecovery.mockResolvedValue(plan());
    mocks.executeRecovery.mockResolvedValue(execution());
    mocks.retargetPaneSet.mockResolvedValue({
      primary: {
        ...source,
        sessionId: "replacement-session",
        binding: {
          schemaVersion: 1,
          runtime: "hmux_standalone_v1",
          source: "local",
          hostId: "local",
          sessionId: "replacement-session",
          workspaceId: source.workspaceId,
        },
      },
      panes: [],
      pendingPanelIds: [],
    });
    useStore.setState({
      hmuxSessionMetadata: {
        [hmuxSessionMetadataKey(source.workspaceId, source.sessionId)]: summary(),
      },
    });
  });

  it("offers the recipe-backed action regardless of cached Host health", async () => {
    const inspection = await inspectStandaloneHmuxRecovery(source.panelId);

    expect(inspection).toMatchObject({
      source,
      plan: {
        action: "restore_plain_shell_with_current_build",
        allowed: true,
      },
    });
    expect(mocks.planRecovery).toHaveBeenCalledWith({
      sessionId: source.sessionId,
      workspaceId: source.workspaceId,
      adapterSupportsExplicitResume: false,
      confirmed: false,
    });

    useStore.setState({
      hmuxSessionMetadata: {
        [hmuxSessionMetadataKey(source.workspaceId, source.sessionId)]: summary({
          lifecycle: "ready",
          health: "current_healthy",
          inputAllowed: true,
          detachOnly: false,
        }),
      },
    });
    mocks.inspectPaneSet.mockResolvedValueOnce({
      ...paneSet(),
      sourceSummary: summary({
        lifecycle: "ready",
        health: "current_healthy",
        inputAllowed: true,
        detachOnly: false,
      }),
    });
    await expect(inspectStandaloneHmuxRecovery(source.panelId)).resolves.toMatchObject({
      source,
      plan: { action: "restore_plain_shell_with_current_build" },
    });

    useStore.setState({
      hmuxSessionMetadata: {
        [hmuxSessionMetadataKey(source.workspaceId, source.sessionId)]: summary(),
      },
    });
    mocks.planRecovery.mockResolvedValueOnce({
      ...plan(),
      sessionId: "other-session",
    });
    await expect(
      inspectStandaloneHmuxRecovery(source.panelId),
    ).resolves.toBeNull();
  });

  it("does not dial a reboot-stale Host before backend recovery proves it absent", async () => {
    const inspection = await inspectStandaloneHmuxRecovery(source.panelId);
    if (!inspection) throw new Error("fixture lost recovery inspection");

    const result = await executeStandaloneHmuxRecovery(inspection);

    expect(mocks.executeRecovery).toHaveBeenCalledWith({
      recoveryId: "standalone_rehost_source-session",
      kind: "plain_shell",
      sessionId: source.sessionId,
      workspaceId: source.workspaceId,
      adapterSupportsExplicitResume: false,
      confirmed: true,
    });
    expect(mocks.retargetPaneSet).toHaveBeenCalledWith(paneSet(), {
      kind: "recovery",
      operationId: "standalone_rehost_source-session",
      replacement: execution().replacementSession,
    });
    expect(result.pane.sessionId).toBe("replacement-session");
    expect(mocks.terminateStandalone).not.toHaveBeenCalled();
    expect(
      useStore.getState().hmuxSessionMetadata[
        hmuxSessionMetadataKey(source.workspaceId, "replacement-session")
      ],
    ).toMatchObject({ lifecycle: "ready", health: "current_healthy" });
  });

  it("stops a healthy exact source before replacing it", async () => {
    const healthy = summary({
      lifecycle: "ready",
      health: "current_healthy",
      inputAllowed: true,
      detachOnly: false,
    });
    mocks.inspectPaneSet.mockResolvedValueOnce({
      ...paneSet(),
      sourceSummary: healthy,
    });
    const inspection = await inspectStandaloneHmuxRecovery(source.panelId);
    if (!inspection)
      throw new Error("fixture lost healthy recovery inspection");
    mocks.preparePaneSet.mockResolvedValueOnce({
      ...paneSet(),
      sourceSummary: healthy,
    });

    await executeStandaloneHmuxRecovery(inspection);

    expect(mocks.terminateStandalone).toHaveBeenCalledWith(
      source.sessionId,
      source.workspaceId,
    );
    expect(mocks.terminateStandalone.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.executeRecovery.mock.invocationCallOrder[0],
    );
  });

  it("recovers an exited Host generation through the same replacement path", async () => {
    const exited = summary({
      lifecycle: "exited",
      manifestLifecycle: "exited",
      health: "exited",
      hostProcessAlive: false,
      inputAllowed: false,
      detachOnly: true,
    });
    mocks.inspectPaneSet.mockResolvedValueOnce({
      ...paneSet(),
      sourceSummary: exited,
    });
    useStore.setState({
      hmuxSessionMetadata: {
        [hmuxSessionMetadataKey(source.workspaceId, source.sessionId)]: exited,
      },
    });

    const inspection = await inspectStandaloneHmuxRecovery(source.panelId);
    expect(inspection).not.toBeNull();
    if (!inspection) throw new Error("fixture lost exited recovery inspection");
    mocks.preparePaneSet.mockResolvedValueOnce({
      ...paneSet(),
      sourceSummary: exited,
    });

    const result = await executeStandaloneHmuxRecovery(inspection);

    expect(mocks.executeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "plain_shell",
        sessionId: source.sessionId,
        workspaceId: source.workspaceId,
      }),
    );
    expect(mocks.retargetPaneSet).toHaveBeenCalledOnce();
    expect(result.pane.sessionId).toBe("replacement-session");
  });

  it("refuses a pane identity race before backend recovery", async () => {
    const inspection = await inspectStandaloneHmuxRecovery(source.panelId);
    if (!inspection) throw new Error("fixture lost recovery inspection");
    mocks.preparePaneSet.mockResolvedValueOnce({
      ...paneSet(),
      source: {
        ...source,
        sessionId: "other-session",
      },
    });

    await expect(
      executeStandaloneHmuxRecovery(inspection),
    ).rejects.toThrow("changed before standalone Hmux recovery");
    expect(mocks.terminateStandalone).not.toHaveBeenCalled();
    expect(mocks.executeRecovery).not.toHaveBeenCalled();
  });

  it("never retargets the pane set to a non-writable replacement", async () => {
    const inspection = await inspectStandaloneHmuxRecovery(source.panelId);
    if (!inspection) throw new Error("fixture lost recovery inspection");
    const receipt = execution();
    mocks.executeRecovery.mockResolvedValueOnce({
      ...receipt,
      replacementSession: {
        ...receipt.replacementSession!,
        health: "stale_transport",
        lifecycle: "unavailable",
        inputAllowed: false,
        detachOnly: true,
      },
    });

    await expect(
      executeStandaloneHmuxRecovery(inspection),
    ).rejects.toThrow("standalone Hmux recovery returned an invalid receipt");
    expect(mocks.retargetPaneSet).not.toHaveBeenCalled();
  });
});
