import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePaneById: vi.fn(),
}));

vi.mock("@/lib/workspace/dock", () => ({
  resolvePaneById: mocks.resolvePaneById,
}));

import {
  projectHmuxManagedAgentPaneLayout,
  resolveHmuxManagedAgentPromotion,
} from "@/lib/hmux/conversion/hmuxAgentPanePromotion";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import {
  hmuxSessionConversionId,
  inspectHmuxSessionConversion,
} from "@/lib/hmux/conversion/hmuxSessionConversion";
import {
  hmuxManagedBinding,
  hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const sourcePanelId = "term:standalone-source";
const source = hmuxStandaloneBinding("standalone-source", "workspace-1");
const target = {
  ...hmuxManagedBinding("managed-target", "workspace-1"),
  createIdempotencyKey: "convert-replacement",
};
const cwd = "/repo/.worktrees/hmux-codex";
const project = {
  id: "project-1",
  name: "HebbianIDE",
  path: "/repo",
  kind: "local" as const,
  isRepo: true,
};

function terminalLayout(
  binding:
    | ReturnType<typeof hmuxManagedBinding>
    | ReturnType<typeof hmuxStandaloneBinding> = target,
) {
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
          sessionId: binding.sessionId,
          binding,
        },
      },
    },
    activeGroup: "group-1",
  };
}

function panel(
  id: string,
  params: Record<string, unknown>,
  component = "terminal",
) {
  return {
    id,
    params,
    api: {
      component,
      getParameters: () => params,
    },
  };
}

describe("Hmux conversion response-loss inspection", () => {
  beforeEach(() => {
    mocks.resolvePaneById.mockReset();
    useStore.setState({
      projects: [project],
      agents: [],
      accounts: [],
      activeAccounts: {},
      skipPermissions: { codex: true },
      detected: {},
      layouts: { "desktop-1": terminalLayout() },
      sessionCwd: { [target.sessionId]: cwd },
      sessionAgent: { [target.sessionId]: "codex" },
      sessionAgentPin: {},
    });
  });

  it("uses the detected Claude adapter instead of assuming Codex", async () => {
    const layout = terminalLayout(source);
    const livePanel = panel(sourcePanelId, layout.panels[sourcePanelId].params);
    useStore.setState({
      layouts: { "desktop-1": layout },
      sessionCwd: { [source.sessionId]: cwd },
      sessionAgent: { [source.sessionId]: "claude" },
    });
    mocks.resolvePaneById.mockResolvedValue({
      desktopId: "desktop-1",
      panelId: sourcePanelId,
      api: { getPanel: () => livePanel },
      cwd,
    });

    await expect(
      inspectHmuxSessionConversion(
        source.sessionId,
        sourcePanelId,
        "managed",
        source.workspaceId,
      ),
    ).resolves.toMatchObject({
      providerId: "claude",
      sourceBinding: source,
      promotion: { sourcePanelId },
    });

    useStore.setState({ sessionAgent: {} });
    await expect(
      inspectHmuxSessionConversion(
        source.sessionId,
        sourcePanelId,
        "managed",
        source.workspaceId,
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "pane has no detected provider for exact-resume conversion",
    });
  });

  it.each(["term:managed-shell", "slot", "launcher:previous", "agent:previous"])("inspects a fenced managed shell at %s by its actual terminal content", async (managedPanelId) => {
    const managedShell = {
      ...hmuxManagedBinding(
        "managed-shell",
        "dure-local-shells-v1",
        undefined,
        undefined,
        {
          runnerPrincipal: "runner-source",
          runnerInstance: "instance-source",
          channelEpoch: "1",
          hostInstanceId: "host-source",
          terminalEpoch: "terminal-source",
        },
      ),
      createIdempotencyKey: "shell_managed-shell",
    };
    const params = {
      cwd,
      sessionId: managedShell.sessionId,
      binding: managedShell,
    };
    const livePanel = panel(managedPanelId, params);
    useStore.setState({
      layouts: {
        "desktop-1": {
          panels: {
            [managedPanelId]: {
              id: managedPanelId,
              contentComponent: "terminal",
              params,
            },
          },
        },
      },
      sessionCwd: { [managedShell.sessionId]: cwd },
      sessionAgent: {},
      sessionAgentPin: { [managedShell.sessionId]: "codex" },
    });
    mocks.resolvePaneById.mockResolvedValue({
      desktopId: "desktop-1",
      panelId: managedPanelId,
      api: { getPanel: () => livePanel },
      cwd,
    });

    await expect(
      inspectHmuxSessionConversion(
        managedShell.sessionId,
        managedPanelId,
        "managed",
        managedShell.workspaceId,
      ),
    ).resolves.toMatchObject({
      providerId: "codex",
      sourceBinding: managedShell,
      promotion: { sourcePanelId: managedPanelId, targetPanelId: managedPanelId },
    });
  });

  it("reconstructs the exact standalone source after only the runtime binding converted", async () => {
    const livePanel = panel(
      sourcePanelId,
      terminalLayout().panels[sourcePanelId].params,
    );
    mocks.resolvePaneById.mockResolvedValue({
      desktopId: "desktop-1",
      panelId: sourcePanelId,
      api: {
        getPanel: () => livePanel,
      },
      cwd,
    });

    await expect(
      inspectHmuxSessionConversion(
        source.sessionId,
        sourcePanelId,
        "managed",
        source.workspaceId,
        undefined,
        "hmux-codex-managed",
      ),
    ).resolves.toMatchObject({
      panelId: sourcePanelId,
      resolvedPanelId: sourcePanelId,
      sourceBinding: source,
      conversionId: hmuxSessionConversionId(
        sourcePanelId,
        source,
        "managed",
      ),
      promotion: {
        agentName: "hmux-codex-managed",
        sourcePanelId,
      },
    });
  });

  it("finds the promoted AgentPanel by durable provenance when the source panel is gone", async () => {
    const conversionId = hmuxSessionConversionId(
      sourcePanelId,
      source,
      "managed",
    );
    const planned = resolveHmuxManagedAgentPromotion({
      sourcePanelId,
      conversionId,
      providerId: "codex",
      cwd,
      sourceBinding: source,
      currentBinding: target,
      preferredName: "hmux-codex-managed",
      terminalEnvironment: {},
      projects: [project],
      detected: {},
      agents: [],
    });
    const promotion = { ...planned, targetPanelId: `agent:${planned.agentId}` };
    const promoted = projectHmuxManagedAgentPaneLayout(
      terminalLayout(),
      promotion,
      source,
      target,
    ).layout as {
      panels: Record<string, { params: Record<string, unknown> }>;
    };
    const agent: Agent = {
      id: promotion.agentId,
      name: promotion.agentName,
      provider: "codex",
      projectId: project.id,
      worktreePath: cwd,
      branch: promotion.branch,
      sessionId: target.sessionId,
      sessionKind: "pty",
      runtimeBinding: target,
      started: true,
      conversationId: "019fa9b6-9907-70f2-877b-5f07907bd2ba",
    };
    useStore.setState({
      agents: [agent],
      layouts: { "desktop-1": promoted },
    });
    const livePanel = panel(
      promotion.targetPanelId,
      promoted.panels[promotion.targetPanelId].params,
      "agent",
    );
    mocks.resolvePaneById.mockImplementation(async (panelId: string) => {
      if (panelId === sourcePanelId) {
        throw new PaneCommandError(
          "pane_not_found",
          "source pane is gone",
        );
      }
      return {
        desktopId: "desktop-1",
        panelId: promotion.targetPanelId,
        api: {
          getPanel: () => livePanel,
        },
        cwd,
      };
    });

    const inspection = await inspectHmuxSessionConversion(
      source.sessionId,
      sourcePanelId,
      "managed",
      source.workspaceId,
      undefined,
      promotion.agentName,
    );
    expect(inspection).toMatchObject({
      panelId: sourcePanelId,
      resolvedPanelId: promotion.targetPanelId,
      agentId: promotion.agentId,
      sourceBinding: source,
      promotion,
      expectedConversationId: agent.conversationId,
    });
    expect(mocks.resolvePaneById).toHaveBeenNthCalledWith(1, sourcePanelId);
    expect(mocks.resolvePaneById).toHaveBeenNthCalledWith(
      2,
      promotion.targetPanelId,
    );
  });
});
