import { describe, expect, it } from "vitest";
import {
  planDesktopPaneMove,
  type DesktopPaneMoveItem,
} from "@/lib/workspace/desktop/desktopPaneMove";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";

function layout(...panelIds: string[]) {
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
          size: 800,
        })),
        size: 600,
      },
      width: 800,
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
          params: { sessionId: panelId.slice(panelId.indexOf(":") + 1) },
        },
      ]),
    ),
    activeGroup:
      panelIds.length > 0
        ? `group:${panelIds[panelIds.length - 1]}`
        : undefined,
  };
}

function ids(value: unknown): string[] {
  return panelsFromLayout(value)
    .map((panel) => panel.id)
    .sort();
}

function move(
  layouts: Record<string, unknown>,
  items: readonly DesktopPaneMoveItem[],
  targetDesktopId = "target",
) {
  return planDesktopPaneMove(layouts, items, targetDesktopId);
}

describe("planDesktopPaneMove", () => {
  it("moves a panel between persisted layouts without mutating either input", () => {
    const source = layout("term:moved", "term:kept-source");
    const target = layout("term:kept-target");
    const original = structuredClone({ source, target });

    const plan = move(
      { source, target },
      [{ panelId: "term:moved", fromDesktopId: "source" }],
    );

    expect(plan.error).toBeUndefined();
    expect(plan.movedPanelIds).toEqual(["term:moved"]);
    expect(ids(plan.updates.source)).toEqual(["term:kept-source"]);
    expect(ids(plan.updates.target)).toEqual([
      "term:kept-target",
      "term:moved",
    ]);
    expect({ source, target }).toEqual(original);
  });

  it("creates a valid target layout when the desktop has never mounted", () => {
    const plan = move(
      { source: layout("term:moved") },
      [{ panelId: "term:moved", fromDesktopId: "source" }],
    );

    expect(plan.error).toBeUndefined();
    expect(ids(plan.updates.source)).toEqual([]);
    expect(ids(plan.updates.target)).toEqual(["term:moved"]);
    expect(
      (plan.updates.target as { grid: { root: { type: string } } }).grid.root
        .type,
    ).toBe("branch");
  });

  it("moves several source spaces in one target transaction", () => {
    const plan = move(
      {
        first: layout("term:first", "term:stay"),
        second: layout("agent:second"),
        target: layout("term:target"),
      },
      [
        { panelId: "term:first", fromDesktopId: "first" },
        { panelId: "agent:second", fromDesktopId: "second" },
      ],
    );

    expect(plan.movedPanelIds).toEqual(["term:first", "agent:second"]);
    expect(ids(plan.updates.first)).toEqual(["term:stay"]);
    expect(ids(plan.updates.second)).toEqual([]);
    expect(ids(plan.updates.target)).toEqual([
      "agent:second",
      "term:first",
      "term:target",
    ]);
  });

  it("heals duplicate source copies when the target already owns the panel", () => {
    const plan = move(
      {
        source: layout("term:duplicate"),
        stale: layout("term:duplicate", "term:stay"),
        target: layout("term:duplicate", "term:target"),
      },
      [{ panelId: "term:duplicate", fromDesktopId: "source" }],
    );

    expect(plan.movedPanelIds).toEqual(["term:duplicate"]);
    expect(ids(plan.updates.source)).toEqual([]);
    expect(ids(plan.updates.stale)).toEqual(["term:stay"]);
    expect(plan.updates.target).toBeUndefined();
    expect(ids(layout("term:duplicate", "term:target"))).toEqual([
      "term:duplicate",
      "term:target",
    ]);
  });

  it("is idempotent after the panel already reached the target", () => {
    const plan = move(
      { source: layout("term:stay"), target: layout("term:moved") },
      [{ panelId: "term:moved", fromDesktopId: "source" }],
    );

    expect(plan.updates).toEqual({});
    expect(plan.movedPanelIds).toEqual([]);
    expect(plan.alreadyAtTargetPanelIds).toEqual(["term:moved"]);
  });

  it("skips a stale item when neither declared source nor target owns it", () => {
    const plan = move(
      { source: layout("term:stay"), target: layout("term:target") },
      [{ panelId: "term:missing", fromDesktopId: "source" }],
    );

    expect(plan.updates).toEqual({});
    expect(plan.missingPanelIds).toEqual(["term:missing"]);
  });

  it("fails closed instead of overwriting a malformed target layout", () => {
    const plan = move(
      { source: layout("term:moved"), target: { panels: {} } },
      [{ panelId: "term:moved", fromDesktopId: "source" }],
    );

    expect(plan.updates).toEqual({});
    expect(plan.error).toEqual({
      code: "invalid_target_layout",
      desktopId: "target",
    });
  });
});
