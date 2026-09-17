// @vitest-environment jsdom

import { createDockview } from "dockview-react";
import { describe, expect, it } from "vitest";
import {
  projectHmuxManagedAgentPaneLayout,
  type HmuxManagedAgentPromotion,
} from "@/lib/hmux/conversion/hmuxAgentPanePromotion";
import {
  hmuxManagedBinding,
  hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";

const sourcePanelId = "term:standalone-source";
const source = hmuxStandaloneBinding("standalone-source", "workspace-1");
const target = {
  ...hmuxManagedBinding("managed-target", "workspace-1"),
  createIdempotencyKey: "convert-1",
};
const promotion: HmuxManagedAgentPromotion = {
  agentId: "agent-hmux-deadbeef",
  agentName: "hmux-codex",
  projectId: "project-1",
  branch: "agent/hmux-codex",
  sourcePanelId,
  targetPanelId: "agent:agent-hmux-deadbeef",
  conversionId: "convert-deadbeef",
  terminalEnvironment: {},
};

function layout(panelId = sourcePanelId) {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: {
              id: "group-1",
              views: [panelId],
              activeView: panelId,
              locked: true,
            },
            size: 800,
          },
        ],
        size: 600,
      },
      width: 800,
      height: 600,
      orientation: "HORIZONTAL",
    },
    panels: {
      [panelId]: {
        id: panelId,
        contentComponent: "terminal",
        title: "hmux-codex",
        params: {
          cwd: "/repo/.worktrees/hmux-codex",
          sessionId: source.sessionId,
          binding: source,
        },
      },
    },
    activeGroup: "group-1",
  };
}

describe("Hmux Agent pane promotion Dockview compatibility", () => {
  it.each(["term:standalone-source", "slot", "launcher:previous", "agent:previous"])("replaces terminal content at %s without changing the mounted slot", (panelId) => {
    const before = layout(panelId);
    const sameSlotPromotion = { ...promotion, sourcePanelId: panelId, targetPanelId: panelId };
    const projected = projectHmuxManagedAgentPaneLayout(
      before,
      sameSlotPromotion,
      source,
      target,
    );
    expect(projected.state).toBe("source");

    const container = document.createElement("div");
    document.body.append(container);
    const api = createDockview(container, {
      createComponent: () => {
        const element = document.createElement("div");
        return {
          element,
          init() {},
          dispose() {
            element.remove();
          },
        };
      },
    });
    api.layout(800, 600);
    api.fromJSON(before as never);
    const previous = api.getPanel(panelId)!;
    const previousGroup = previous.group;

    expect(() =>
      api.fromJSON(projected.layout as never, {
        reuseExistingPanels: true,
      }),
    ).not.toThrow();
    expect(api.panels.map((panel) => panel.id)).toEqual([
      panelId,
    ]);
    expect(api.activePanel?.id).toBe(panelId);
    expect(api.getPanel(panelId)?.group.id).toBe(previousGroup.id);
    expect(api.getPanel(panelId)?.api).not.toBe(previous.api);
    const promoted = api.toJSON().panels[panelId];
    expect(promoted).toMatchObject({
      id: panelId,
      contentComponent: "agent",
      title: promotion.agentName,
    });
    expect(promoted?.params).toEqual({ agentRef: { agentId: promotion.agentId } });
    const replay = projectHmuxManagedAgentPaneLayout(api.toJSON(), sameSlotPromotion, source, target);
    expect(replay.state).toBe("target");
    const current = api.getPanel(panelId)!;
    api.fromJSON(replay.layout as never, { reuseExistingPanels: true });
    expect(api.getPanel(panelId)).toBe(current);

    api.dispose();
    container.remove();
  });
});
