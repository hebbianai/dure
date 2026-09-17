import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  resolvePaneById: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
}));

vi.mock("@/lib/workspace/dock", () => ({
  resolvePaneById: mocks.resolvePaneById,
}));

import { resolveHmuxManagedAgentPromotion } from "@/lib/hmux/conversion/hmuxAgentPanePromotion";
import type {
  HmuxSessionConversionInspection,
} from "@/lib/hmux/conversion/hmuxSessionConversion";
import {
  HMUX_SESSION_CONVERTED_EVENT,
  hmuxSessionConversionId,
  retargetConvertedHmuxPane,
} from "@/lib/hmux/conversion/hmuxSessionConversion";
import type { HmuxSessionConversionReceipt } from "@/lib/ipc";
import {
  hmuxManagedBinding,
  hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import { stopFenceFixture } from "@/test/agentFixtures";

const sourcePanelId = "term:standalone-source";
const source = hmuxStandaloneBinding("standalone-source", "workspace-1");
const target = {
  ...hmuxManagedBinding("managed-target", "workspace-1"),
  createIdempotencyKey: "convert-replacement",
};
const cwd = "/repo/.worktrees/hmux-codex";
const conversationId = "019fa9b6-9907-70f2-877b-5f07907bd2ba";
const targetStopFence = stopFenceFixture({
  hostInstanceId: "host-1",
  terminalEpoch: "1",
});

function sourceLayout() {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: {
              id: "group-1",
              views: [sourcePanelId],
              activeView: sourcePanelId,
            },
          },
        ],
      },
    },
    panels: {
      [sourcePanelId]: {
        id: sourcePanelId,
        contentComponent: "terminal",
        title: "hmux-codex",
        params: {
          cwd,
          sessionId: source.sessionId,
          binding: source,
        },
      },
    },
    activeGroup: "group-1",
  };
}

function receipt(): HmuxSessionConversionReceipt {
  return {
    sourceSessionId: source.sessionId,
    sourceWorkspaceId: source.workspaceId,
    targetClass: "managed",
    replacementIdempotencyKey: target.createIdempotencyKey,
    action: "convert_standalone_to_managed_with_exact_conversation",
    outcome: "converted",
    replayed: false,
    requiresConfirmation: false,
    providerId: "codex",
    conversationId,
    replacementSession: {
      sessionId: target.sessionId,
      workspaceId: target.workspaceId,
      sessionClass: "managed",
      lifecycle: "ready",
      terminalEpoch: "1",
      stopFence: targetStopFence,
      outputSeq: "1",
      capabilities: [],
    },
  };
}

describe("retargetConvertedHmuxPane promotion recovery", () => {
  let inspection: HmuxSessionConversionInspection;

  beforeEach(() => {
    mocks.emit.mockReset();
    mocks.resolvePaneById.mockReset();
    const project = {
      id: "project-1",
      name: "HebbianIDE",
      path: "/repo",
      kind: "local" as const,
      isRepo: true,
    };
    const conversionId = hmuxSessionConversionId(
      sourcePanelId,
      source,
      "managed",
    );
    const promotion = resolveHmuxManagedAgentPromotion({
      sourcePanelId,
      conversionId,
      providerId: "codex",
      cwd,
      sourceBinding: source,
      currentBinding: source,
      preferredName: "hmux-codex",
      terminalEnvironment: {},
      projects: [project],
      detected: {},
      agents: [],
    });
    inspection = {
      desktopId: "desktop-1",
      panelId: sourcePanelId,
      resolvedPanelId: sourcePanelId,
      promotion,
      sourceBinding: source,
      target: "managed",
      providerId: "codex",
      cwd,
      conversionId,
      permissionMode: "bypass_approvals",
      terminalEnvironment: {},
    };

    let currentLayout: unknown = sourceLayout();
    let projectionAttempts = 0;
    let targetPanel:
      | {
          id: string;
          params: Record<string, unknown>;
          api: {
            component: string;
            getParameters: () => Record<string, unknown>;
            setActive: ReturnType<typeof vi.fn>;
          };
        }
      | undefined;
    const sourcePanel = {
      id: sourcePanelId,
      params: sourceLayout().panels[sourcePanelId].params,
      api: {
        component: "terminal",
        getParameters: () => sourcePanel.params,
        updateParameters: vi.fn(),
        setActive: vi.fn(),
      },
    };
    const api = {
      getPanel: vi.fn((panelId: string) => {
        if (panelId === sourcePanelId && !targetPanel) return sourcePanel;
        if (panelId === promotion.targetPanelId) return targetPanel;
        return undefined;
      }),
      toJSON: vi.fn(() => structuredClone(currentLayout)),
      fromJSON: vi.fn((next: unknown) => {
        projectionAttempts += 1;
        if (projectionAttempts === 1) {
          throw new Error("fault injection: Dockview projection failed");
        }
        currentLayout = structuredClone(next);
        const definition = (
          next as {
            panels: Record<
              string,
              { params: Record<string, unknown> }
            >;
          }
        ).panels[promotion.targetPanelId];
        targetPanel = {
          id: promotion.targetPanelId,
          params: definition.params,
          api: {
            component: "agent",
            getParameters: () => definition.params,
            setActive: vi.fn(),
          },
        };
      }),
    };
    mocks.resolvePaneById.mockImplementation(async () => ({
      desktopId: "desktop-1",
      panelId: targetPanel ? promotion.targetPanelId : sourcePanelId,
      api,
      cwd,
    }));
    useStore.setState({
      projects: [project],
      agents: [],
      agentActivity: {},
      accounts: [],
      activeAccounts: {},
      skipPermissions: { codex: true },
      layouts: { "desktop-1": sourceLayout() },
      sessionCwd: { [source.sessionId]: cwd },
    });
  });

  it("recovers idempotently after the Agent/store commit but before Dockview projection", async () => {
    await expect(
      retargetConvertedHmuxPane(inspection, receipt()),
    ).rejects.toThrow(/fault injection/);
    expect(useStore.getState().agents).toHaveLength(1);
    expect(useStore.getState().agents[0]).toMatchObject({
      id: inspection.promotion?.agentId,
      sessionId: target.sessionId,
      runtimeBinding: { ...target, stopFence: targetStopFence },
      conversationId,
    });

    await expect(
      retargetConvertedHmuxPane(inspection, {
        ...receipt(),
        replayed: true,
      }),
    ).resolves.toMatchObject({
      panelId: inspection.promotion?.targetPanelId,
      sessionId: target.sessionId,
      conversationId,
    });
    expect(useStore.getState().agents).toHaveLength(1);
    expect(
      mocks.emit.mock.calls.filter(
        ([eventName]) => eventName === HMUX_SESSION_CONVERTED_EVENT,
      ),
    ).toHaveLength(1);
  });
});
