// @vitest-environment jsdom

import { createDockview, themeAbyss } from "dockview-react";
import { describe, expect, it } from "vitest";
import { planDesktopPaneMove } from "@/lib/workspace/desktop/desktopPaneMove";

function layout(panelId: string) {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: {
              id: `group:${panelId}`,
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
        title: panelId,
        params: { sessionId: panelId },
      },
    },
    activeGroup: `group:${panelId}`,
  };
}

function splitLayout(panelIds: readonly string[], width: number) {
  const size = width / panelIds.length;
  return {
    grid: {
      root: {
        type: "branch",
        data: panelIds.map((panelId) => ({
          type: "leaf",
          data: {
            id: `group:${panelId}`,
            views: [panelId],
            activeView: panelId,
            locked: true,
          },
          size,
        })),
        size: 600,
      },
      width,
      height: 600,
      orientation: "HORIZONTAL",
    },
    panels: Object.fromEntries(
      panelIds.map((panelId) => [
        panelId,
        {
          id: panelId,
          contentComponent: "terminal",
          title: panelId,
          params: { sessionId: panelId },
        },
      ]),
    ),
    activeGroup: `group:${panelIds[0]}`,
  };
}

function rootAssignedSize(layoutValue: unknown): number {
  const layoutRecord = layoutValue as {
    grid: { root: { data: Array<{ size: number }> } };
  };
  return layoutRecord.grid.root.data.reduce((sum, child) => sum + child.size, 0);
}

describe("desktop pane move Dockview compatibility", () => {
  it("loads and round-trips the merged serialized layout", () => {
    const plan = planDesktopPaneMove(
      {
        source: layout("term:moved"),
        target: layout("term:kept"),
      },
      [{ panelId: "term:moved", fromDesktopId: "source" }],
      "target",
    );
    expect(plan.error).toBeUndefined();

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

    expect(() => api.fromJSON(plan.updates.target as never)).not.toThrow();
    expect(api.panels.map((panel) => panel.id).sort()).toEqual([
      "term:kept",
      "term:moved",
    ]);
    expect(
      Object.keys(api.toJSON().panels).sort(),
    ).toEqual(["term:kept", "term:moved"]);

    api.dispose();
    container.remove();
  });

  it("round-trips a pane move source without preserving the removed pane's gap", () => {
    const source = splitLayout(
      ["term:one", "term:two", "term:three", "term:four", "term:moved"],
      1_400,
    );
    const plan = planDesktopPaneMove(
      { source, target: layout("term:target") },
      [{ panelId: "term:moved", fromDesktopId: "source" }],
      "target",
    );

    expect(plan.error).toBeUndefined();
    expect(rootAssignedSize(plan.updates.source)).toBeCloseTo(1_400, 5);

    const container = document.createElement("div");
    document.body.append(container);
    const api = createDockview(container, {
      theme: { ...themeAbyss, gap: 2 },
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
    api.layout(1_400, 600);

    expect(() => api.fromJSON(plan.updates.source as never)).not.toThrow();
    expect(api.panels).toHaveLength(4);
    expect(rootAssignedSize(api.toJSON())).toBeCloseTo(1_394, 5);

    api.dispose();
    container.remove();
  });
});
