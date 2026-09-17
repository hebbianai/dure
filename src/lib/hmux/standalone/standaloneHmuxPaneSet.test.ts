import type { DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HmuxSessionSummary } from "@/lib/ipc";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  listSessions: vi.fn(),
  querySessionHmux: vi.fn(),
  createManagedShell: vi.fn(),
  stopManaged: vi.fn(),
  upgradeStandalone: vi.fn(),
  layoutPush: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
}));

vi.mock("@/lib/ipc", () => ({
  hmux: {
    createManagedShell: mocks.createManagedShell,
    listSessions: mocks.listSessions,
    stopManaged: mocks.stopManaged,
    upgradeStandalone: mocks.upgradeStandalone,
  },
  homeDir: vi.fn(),
  querySessionHmux: mocks.querySessionHmux,
}));
vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
  inspectHmuxSessionExact: async (target: {
    sessionId: string;
    workspaceId: string;
  }) =>
    (await mocks.listSessions()).find(
      (session: { sessionId: string; workspaceId: string }) =>
        session.sessionId === target.sessionId &&
        session.workspaceId === target.workspaceId,
    ),
}));

vi.mock("@/lib/workspace/layout/layoutPushChannel", () => ({
  publishLayoutPush: mocks.layoutPush,
}));

import { registerDockview, unregisterDockview } from "@/lib/workspace/dock/dockRegistry";
import {
  HMUX_STANDALONE_RETARGETED_EVENT,
  applyStandaloneHmuxRetargetSync,
  inspectHmuxStandaloneTerminalPanel,
  inspectStandaloneHmuxPaneSet,
  prepareStandaloneHmuxPaneSet,
  projectStandaloneHmuxRetargetLayouts,
  retargetHmuxStandaloneTerminalPanel,
  retargetStandaloneHmuxPaneSet,
} from "@/lib/hmux/standalone/standaloneHmuxPaneSet";
import { handleStandaloneHmuxUpgrade } from "@/lib/hmux/standalone/standaloneHmuxUpgradeCli";
import { emitCallsFor } from "@/test/emitCalls";
import {
  hmuxLocalBinding,
  hmuxStandaloneBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import { hmuxSessionSummaryFixture } from "@/test/agentFixtures";

const legacyLocalBinding = (sessionId: string) =>
  ({
    schemaVersion: 1,
    runtime: "legacy_session_v1",
    source: "local",
    hostId: "local",
    sessionId,
  }) as unknown as TerminalPaneBindingV1;

const desktopId = "desktop-1";
const sourceSessionId = "standalone_c55e3056a3c6";
const siblingOuterSessionId = "standalone_6446e98d6dc3";
const sourcePanelId = `term:${sourceSessionId}`;
const siblingPanelId = `term:${siblingOuterSessionId}`;
const unrelatedOuterSessionId = "legacy-unrelated";
const unrelatedPanelId = `term:${unrelatedOuterSessionId}`;
const workspaceId = "workspace-1";
let registered: DockviewApi | undefined;
let siblingUpdateAttempts = 0;
let failSiblingUpdateOnce = false;
let hideSiblingPanel = false;

interface RestoredLegacyPanelDefinition {
  id: string;
  contentComponent: string;
  params: {
    sessionId: string;
    cwd: string;
    binding: TerminalPaneBindingV1;
  };
}

beforeEach(() => {
  mocks.emit.mockResolvedValue(undefined);
});

function summary(): HmuxSessionSummary {
  return hmuxSessionSummaryFixture({
    sessionId: sourceSessionId,
    sessionName: "daily-driver",
    workspaceId,
    sessionClass: "standalone",
    inputAllowed: true,
    detachOnly: false,
    terminalEpoch: "epoch-1",
    outputSeq: "7",
  });
}

function replacementSummary(): HmuxSessionSummary {
  return {
    ...summary(),
    sessionId: "standalone_replacement",
    hostBuildVersion: "build-current",
    terminalEpoch: "epoch-2",
    outputSeq: "0",
  };
}

function restoredLegacyLayout(panelId = sourcePanelId) {
  const panels: Record<string, RestoredLegacyPanelDefinition> = {
    [panelId]: {
      id: panelId,
      contentComponent: "terminal",
      params: {
        sessionId: sourceSessionId,
        cwd: "/repo",
        binding: legacyLocalBinding(sourceSessionId),
      },
    },
    [siblingPanelId]: {
      id: siblingPanelId,
      contentComponent: "terminal",
      params: {
        sessionId: siblingOuterSessionId,
        cwd: "/repo",
        binding: legacyLocalBinding(siblingOuterSessionId),
      },
    },
  };
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: {
              id: "group-1",
              views: [panelId, siblingPanelId],
              activeView: panelId,
            },
          },
        ],
      },
    },
    panels,
  };
}

function mount(layout: ReturnType<typeof restoredLegacyLayout>) {
  const group = {
    element: { isConnected: true },
  };
  const panels = Object.values(layout.panels).map((definition) => {
    const panel = {
      ...definition,
      group,
      api: {
        get component() { return definition.contentComponent; },
        getParameters: () => panel.params,
        updateParameters: vi.fn((params: Record<string, unknown>) => {
          if (panel.id === siblingPanelId) {
            siblingUpdateAttempts += 1;
            if (failSiblingUpdateOnce && siblingUpdateAttempts === 1) {
              throw new Error("fault injection: sibling WebView update failed");
            }
          }
          panel.params = params as typeof panel.params;
          definition.params = params as typeof definition.params;
        }),
        setActive: vi.fn(),
      },
    };
    return panel;
  });
  const api = {
    panels,
    groups: [group],
    getPanel: (panelId: string) =>
      hideSiblingPanel && panelId === siblingPanelId
        ? undefined
        : panels.find((panel) => panel.id === panelId),
    toJSON: () => structuredClone(layout),
  } as unknown as DockviewApi;
  registerDockview(desktopId, api);
  registered = api;
  return api;
}

afterEach(() => {
  if (registered) unregisterDockview(desktopId, registered);
  registered = undefined;
  mocks.emit.mockReset();
  mocks.listSessions.mockReset();
  mocks.querySessionHmux.mockReset();
  mocks.createManagedShell.mockReset();
  mocks.stopManaged.mockReset();
  mocks.upgradeStandalone.mockReset();
  mocks.layoutPush.mockReset();
  siblingUpdateAttempts = 0;
  failSiblingUpdateOnce = false;
  hideSiblingPanel = false;
  useStore.setState({ layouts: {} });
});

describe("restored standalone pane-set recovery", () => {
  it.each(["slot", "launcher:previous", "agent:previous", sourcePanelId])("inspects, attaches and replays the exact terminal at %s", async (panelId) => {
    const layout = restoredLegacyLayout(panelId);
    const source = hmuxStandaloneBinding(sourceSessionId, workspaceId);
    layout.panels[panelId].params.binding = source;
    layout.panels[siblingPanelId].contentComponent = "launcher";
    layout.panels[siblingPanelId].params = { ...layout.panels[panelId].params };
    const api = mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    mocks.listSessions.mockResolvedValue([summary()]);

    const inspected = await inspectStandaloneHmuxPaneSet(panelId);
    expect(inspected.source).toMatchObject({ panelId, sessionId: sourceSessionId, workspaceId });
    expect(inspected.consumers.map((consumer) => consumer.panelId)).toEqual([panelId]);
    const prepared = await prepareStandaloneHmuxPaneSet(inspected);
    const result = await retargetStandaloneHmuxPaneSet(prepared, { kind: "recovery", operationId: `recover-${panelId}`, replacement: replacementSummary() });
    expect(result.primary.panelId).toBe(panelId);
    expect(result.primary.sessionId).toBe(replacementSummary().sessionId);
    expect(await applyStandaloneHmuxRetargetSync(result.sync)).toBe(true);
    expect(api.getPanel(panelId)?.params?.sessionId).toBe(replacementSummary().sessionId);
    expect(api.getPanel(siblingPanelId)?.params?.sessionId).toBe(sourceSessionId);
    expect(mocks.querySessionHmux).not.toHaveBeenCalled();

    const attached = await retargetHmuxStandaloneTerminalPanel({ panelId, sessionId: replacementSummary().sessionId, workspaceId, cwd: "/current" });
    expect(attached.panelId).toBe(panelId);
    expect(api.getPanel(panelId)?.params?.cwd).toBe("/current");
  });

  it.each(["agent", "launcher", "other"])("never treats %s content at an old terminal ID as a terminal", async (contentComponent) => {
    const layout = restoredLegacyLayout();
    layout.panels[sourcePanelId].contentComponent = contentComponent;
    layout.panels[sourcePanelId].params.binding = hmuxStandaloneBinding(sourceSessionId, workspaceId);
    const api = mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    const before = structuredClone(layout);
    mocks.listSessions.mockResolvedValue([summary()]);
    mocks.querySessionHmux.mockResolvedValue(null);
    await expect(inspectStandaloneHmuxPaneSet(sourcePanelId)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(retargetHmuxStandaloneTerminalPanel({ panelId: sourcePanelId, sessionId: "different", workspaceId })).rejects.toMatchObject({ code: "invalid_request" });
    expect(api.toJSON()).toEqual(before);
    expect(mocks.querySessionHmux).not.toHaveBeenCalled();
  });

  it("does not project a late handoff over changed content carrying old binding fields", () => {
    const layout = restoredLegacyLayout();
    const source = hmuxStandaloneBinding(sourceSessionId, workspaceId);
    layout.panels[sourcePanelId].params.binding = source;
    layout.panels[sourcePanelId].contentComponent = "launcher";
    const result = projectStandaloneHmuxRetargetLayouts({ [desktopId]: layout }, {
      schemaVersion: 1, operation: "recovery", operationId: "late-operation", source,
      target: hmuxStandaloneBinding("replacement", workspaceId),
      consumers: [{ desktopId, panelId: sourcePanelId, sourceTransportSessionId: sourceSessionId, state: "source" }],
    });
    expect(result.conflicts).toEqual([`${desktopId}:${sourcePanelId}`]);
    expect(result.layouts[desktopId]).toEqual(layout);
  });

  it("persists and pushes an authoritative cwd for an already attached pane", async () => {
    const layout = restoredLegacyLayout();
    layout.panels[sourcePanelId].params.binding = hmuxStandaloneBinding(
      sourceSessionId,
      workspaceId,
    );
    layout.panels[sourcePanelId].params.cwd = "/old";
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });

    await retargetHmuxStandaloneTerminalPanel({
      panelId: sourcePanelId,
      sessionId: sourceSessionId,
      workspaceId,
      cwd: "/repo/HebbianIDE/.worktrees/task",
    });

    expect(
      panelParams(useStore.getState().layouts[desktopId], sourcePanelId).cwd,
    ).toBe("/repo/HebbianIDE/.worktrees/task");
    expect(mocks.layoutPush).toHaveBeenCalledWith([desktopId]);
  });

  it("promotes a legacy pane from its exact attached standalone identity", async () => {
    const layout = restoredLegacyLayout();
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    mocks.querySessionHmux.mockResolvedValue(summary());

    await expect(
      inspectHmuxStandaloneTerminalPanel(sourcePanelId),
    ).resolves.toMatchObject({
      desktopId,
      panelId: sourcePanelId,
      sessionId: sourceSessionId,
      workspaceId,
      cwd: "/repo",
    });

    await expect(
      inspectStandaloneHmuxPaneSet(sourcePanelId),
    ).resolves.toMatchObject({
      consumers: [
        {
          panelId: siblingPanelId,
          sourceTransportSessionId: siblingOuterSessionId,
          state: "legacy_attached",
        },
        {
          panelId: sourcePanelId,
          sourceTransportSessionId: sourceSessionId,
          state: "legacy_attached",
        },
      ],
    });
  });

  it("isolates an unrelated legacy liveness probe failure", async () => {
    const layout = restoredLegacyLayout();
    layout.panels[unrelatedPanelId] = {
      id: unrelatedPanelId,
      contentComponent: "terminal",
      params: {
        sessionId: unrelatedOuterSessionId,
        cwd: "/other",
        binding: legacyLocalBinding(unrelatedOuterSessionId),
      },
    };
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    mocks.querySessionHmux.mockImplementation((sessionId: string) =>
      sessionId === unrelatedOuterSessionId
        ? Promise.reject(new Error("fault injection: unrelated daemon died"))
        : Promise.resolve(summary()),
    );

    await expect(
      inspectStandaloneHmuxPaneSet(sourcePanelId),
    ).resolves.toMatchObject({
      consumers: [{ panelId: siblingPanelId }, { panelId: sourcePanelId }],
    });
  });

  it("atomically promotes both restored panes and converges a one-shot live failure", async () => {
    const layout = restoredLegacyLayout();
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    mocks.querySessionHmux.mockResolvedValue(summary());

    const inspected = await inspectStandaloneHmuxPaneSet(sourcePanelId);
    const prepared = await prepareStandaloneHmuxPaneSet(inspected);
    const promoted = useStore.getState().layouts[desktopId];
    expect(panelParams(promoted, sourcePanelId).binding).toEqual(
      hmuxStandaloneBinding(sourceSessionId, workspaceId),
    );
    expect(panelParams(promoted, siblingPanelId).binding).toEqual(
      hmuxStandaloneBinding(sourceSessionId, workspaceId),
    );

    siblingUpdateAttempts = 0;
    failSiblingUpdateOnce = true;
    const receipt = await retargetStandaloneHmuxPaneSet(prepared, {
      kind: "upgrade",
      operationId: `upgrade_${sourceSessionId}`,
      replacement: replacementSummary(),
    });

    expect(receipt.pendingPanelIds).toEqual([]);
    expect(receipt.panes.map((pane) => pane.panelId).sort()).toEqual([
      siblingPanelId,
      sourcePanelId,
    ]);
    expect(receipt.panes.every((pane) => pane.cwd === undefined)).toBe(true);
    expect(siblingUpdateAttempts).toBe(2);
    const retargeted = useStore.getState().layouts[desktopId];
    for (const panelId of [sourcePanelId, siblingPanelId]) {
      expect(panelParams(retargeted, panelId)).not.toHaveProperty("cwd");
      expect(panelParams(retargeted, panelId)).toMatchObject({
        sessionId: replacementSummary().sessionId,
        binding: hmuxStandaloneBinding(
          replacementSummary().sessionId,
          workspaceId,
        ),
        hmuxStandaloneHandoff: {
          operationId: `upgrade_${sourceSessionId}`,
          sourceSessionId,
          sourceTransportSessionId:
            panelId === siblingPanelId
              ? siblingOuterSessionId
              : sourceSessionId,
          targetSessionId: replacementSummary().sessionId,
        },
      });
    }
  });

  it("does not report completion while a mounted pane is pending live projection", async () => {
    const layout = restoredLegacyLayout();
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    mocks.querySessionHmux.mockResolvedValue(summary());
    const prepared = await prepareStandaloneHmuxPaneSet(
      await inspectStandaloneHmuxPaneSet(sourcePanelId),
    );

    hideSiblingPanel = true;
    await expect(
      retargetStandaloneHmuxPaneSet(prepared, {
        kind: "upgrade",
        operationId: `upgrade_${sourceSessionId}`,
        replacement: replacementSummary(),
      }),
    ).rejects.toMatchObject({ code: "pane_changed" });
    expect(
      panelParams(useStore.getState().layouts[desktopId], siblingPanelId)
        .binding,
    ).toEqual(
      hmuxStandaloneBinding(replacementSummary().sessionId, workspaceId),
    );
  });

  it("converges when a mounted sibling remounts during bounded retry", async () => {
    const layout = restoredLegacyLayout();
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    mocks.querySessionHmux.mockResolvedValue(summary());
    const prepared = await prepareStandaloneHmuxPaneSet(
      await inspectStandaloneHmuxPaneSet(sourcePanelId),
    );

    hideSiblingPanel = true;
    setTimeout(() => {
      hideSiblingPanel = false;
    }, 30);
    await expect(
      retargetStandaloneHmuxPaneSet(prepared, {
        kind: "upgrade",
        operationId: `upgrade_remount_${sourceSessionId}`,
        replacement: replacementSummary(),
      }),
    ).resolves.toMatchObject({ pendingPanelIds: [] });

    const sibling = registered?.getPanel(siblingPanelId) as
      | { params: Record<string, unknown> }
      | undefined;
    expect(sibling?.params.binding).toEqual(
      hmuxStandaloneBinding(replacementSummary().sessionId, workspaceId),
    );
  });

  it("replays the durable handoff when a pane remounts after bounded retry expires", async () => {
    vi.useFakeTimers();
    try {
      const layout = restoredLegacyLayout();
      mount(layout);
      useStore.setState({ layouts: { [desktopId]: layout } });
      mocks.querySessionHmux.mockResolvedValue(summary());
      const prepared = await prepareStandaloneHmuxPaneSet(
        await inspectStandaloneHmuxPaneSet(sourcePanelId),
      );

      hideSiblingPanel = true;
      const retarget = expect(
        retargetStandaloneHmuxPaneSet(prepared, {
          kind: "upgrade",
          operationId: `upgrade_late_remount_${sourceSessionId}`,
          replacement: replacementSummary(),
        }),
      ).rejects.toMatchObject({ code: "pane_changed" });
      await vi.advanceTimersByTimeAsync(1_000);
      await retarget;
      expect(
        emitCallsFor(mocks.emit, HMUX_STANDALONE_RETARGETED_EVENT),
      ).toHaveLength(1);

      if (registered) unregisterDockview(desktopId, registered);
      registered = undefined;
      hideSiblingPanel = false;
      const remounted = mount(restoredLegacyLayout());
      await vi.runAllTimersAsync();

      const sibling = remounted.getPanel(siblingPanelId) as
        | { params: Record<string, unknown> }
        | undefined;
      expect(sibling?.params.binding).toEqual(
        hmuxStandaloneBinding(replacementSummary().sessionId, workspaceId),
      );
      expect(
        emitCallsFor(mocks.emit, HMUX_STANDALONE_RETARGETED_EVENT),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when a pre-enumerated sibling changes before promotion", async () => {
    const layout = restoredLegacyLayout();
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    mocks.querySessionHmux.mockResolvedValue(summary());
    const inspected = await inspectStandaloneHmuxPaneSet(sourcePanelId);
    const sibling = registered?.getPanel(siblingPanelId);
    sibling?.api.updateParameters({
      ...sibling.params,
      sessionId: "unrelated-session",
      binding: hmuxStandaloneBinding(
        "unrelated-session",
        "unrelated-workspace",
      ),
    });

    await expect(prepareStandaloneHmuxPaneSet(inspected)).rejects.toThrow(
      /consumers changed before handoff/,
    );
    const persisted = useStore.getState().layouts[desktopId];
    expect(panelParams(persisted, sourcePanelId).binding).toEqual(
      legacyLocalBinding(sourceSessionId),
    );
  });

  it("replays the original durable upgrade identity after the CLI response is lost", async () => {
    const layout = restoredLegacyLayout();
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    mocks.querySessionHmux.mockResolvedValue(summary());
    mocks.upgradeStandalone
      .mockResolvedValueOnce({
        sourceSessionId,
        sourceWorkspaceId: workspaceId,
        targetBuildId: "build-current",
        action: "upgrade_standalone_with_current_build",
        outcome: "rehosted",
        replayed: false,
        requiresConfirmation: false,
        replacementSession: replacementSummary(),
      })
      .mockResolvedValueOnce({
        sourceSessionId,
        sourceWorkspaceId: workspaceId,
        targetBuildId: "build-current",
        action: "upgrade_standalone_with_current_build",
        outcome: "rehosted",
        replayed: true,
        requiresConfirmation: false,
        replacementSession: replacementSummary(),
      });

    const params = {
      name: "daily-driver",
      targetPanelId: sourcePanelId,
      confirmRestart: true,
    };
    await expect(
      handleStandaloneHmuxUpgrade(params, async () => true),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      handleStandaloneHmuxUpgrade(params, async () => true),
    ).resolves.toMatchObject({
      ok: true,
      upgrade: { replayed: true },
    });

    expect(mocks.upgradeStandalone).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.upgradeStandalone.mock.calls) {
      expect(request).toMatchObject({
        upgradeId: `upgrade_${sourceSessionId}`,
        sessionId: sourceSessionId,
        workspaceId,
      });
    }
    const retargets = emitCallsFor(
      mocks.emit,
      HMUX_STANDALONE_RETARGETED_EVENT,
    );
    expect(retargets[retargets.length - 1]?.[1]).toEqual(
      expect.objectContaining({
        consumers: expect.arrayContaining([
          expect.objectContaining({
            panelId: siblingPanelId,
            sourceTransportSessionId: siblingOuterSessionId,
          }),
        ]),
      }),
    );
    const replayPayload = retargets[retargets.length - 1]?.[1];
    const staleWebview = projectStandaloneHmuxRetargetLayouts(
      { [desktopId]: restoredLegacyLayout() },
      replayPayload,
    );
    expect(staleWebview.conflicts).toEqual([]);
    expect(
      panelParams(staleWebview.layouts[desktopId], siblingPanelId).binding,
    ).toEqual(
      hmuxStandaloneBinding(replacementSummary().sessionId, workspaceId),
    );
  });

  it("keeps an already-current source as a successful no-op", async () => {
    const layout = restoredLegacyLayout();
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    mocks.querySessionHmux.mockResolvedValue(summary());
    mocks.upgradeStandalone.mockResolvedValue({
      sourceSessionId,
      sourceWorkspaceId: workspaceId,
      targetBuildId: "build-current",
      action: "upgrade_standalone_with_current_build",
      outcome: "already_current",
      replayed: false,
      requiresConfirmation: false,
      replacementSession: summary(),
    });

    const standaloneResult = await handleStandaloneHmuxUpgrade(
      {
        name: "daily-driver",
        targetPanelId: sourcePanelId,
      },
      async () => true,
    );
    expect(standaloneResult).toMatchObject({
      ok: true,
      upgrade: { outcome: "already_current" },
      panes: [{ sessionId: sourceSessionId }, { sessionId: sourceSessionId }],
    });
    expect(
      emitCallsFor(mocks.emit, HMUX_STANDALONE_RETARGETED_EVENT),
    ).toHaveLength(0);
  });

  it("replaces a confirmed legacy managed local shell in the same pane before stopping its exact source", async () => {
    const layout = restoredLegacyLayout();
    layout.panels[sourcePanelId].params.binding = hmuxLocalBinding(
      sourceSessionId,
      "dure-local-shells-v1",
    ) as never;
    mount(layout);
    useStore.setState({ layouts: { [desktopId]: layout } });
    const sourceStopFence = {
      runnerPrincipal: "local-user",
      runnerInstance: "runner-source",
      channelEpoch: "1",
      hostInstanceId: "host-source",
      terminalEpoch: "terminal-source",
    };
    mocks.listSessions.mockResolvedValue([
      {
        sessionId: sourceSessionId,
        workspaceId: "dure-local-shells-v1",
        sessionClass: "managed",
        lifecycle: "ready",
        manifestLifecycle: "ready",
        health: "compatible_old_healthy",
        inputAllowed: true,
        detachOnly: false,
        terminalEpoch: "terminal-source",
        stopFence: sourceStopFence,
        outputSeq: "25",
        capabilities: [],
      },
    ]);
    mocks.createManagedShell.mockImplementation(async (request) => ({
      idempotencyKey: request.idempotencyKey,
      outcome: "created",
      session: {
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        sessionClass: "managed",
        lifecycle: "ready",
        manifestLifecycle: "ready",
        health: "current_healthy",
        inputAllowed: true,
        detachOnly: false,
        terminalEpoch: "terminal-target",
        outputSeq: "0",
        capabilities: ["terminal_state_binary_v1"],
        stopFence: {
          runnerPrincipal: "local-user",
          runnerInstance: "runner-target",
          channelEpoch: "1",
          hostInstanceId: "host-target",
          terminalEpoch: "terminal-target",
        },
      },
    }));
    mocks.stopManaged.mockResolvedValue({ outcome: "stopped" });

    const managedResult = await handleStandaloneHmuxUpgrade(
      {
        name: sourceSessionId,
        targetPanelId: sourcePanelId,
        confirmRestart: true,
      },
      async () => true,
    );
    expect(managedResult).toMatchObject({
      ok: true,
      upgrade: { outcome: "rehosted" },
      pane: { panelId: sourcePanelId, runtime: "hmux_managed_v1" },
    });

    expect(mocks.createManagedShell).toHaveBeenCalledTimes(1);
    expect(mocks.createManagedShell.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stopManaged.mock.invocationCallOrder[0],
    );
    const createdSessionId = mocks.createManagedShell.mock.calls[0][0].sessionId;
    expect(panelParams(useStore.getState().layouts[desktopId], sourcePanelId)).toMatchObject({
      sessionId: createdSessionId,
      binding: {
        runtime: "hmux_managed_v1",
        sessionId: createdSessionId,
        workspaceId: "dure-local-shells-v1",
      },
    });
    expect(mocks.stopManaged).toHaveBeenCalledWith(
      expect.any(String),
      sourceSessionId,
      "dure-local-shells-v1",
      sourceStopFence,
    );
  });
});

function panelParams(layout: unknown, panelId: string) {
  return (
    layout as {
      panels: Record<string, { params: Record<string, unknown> }>;
    }
  ).panels[panelId].params;
}
