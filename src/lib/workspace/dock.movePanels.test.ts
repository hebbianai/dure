import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview-react";
import { movePanelsToDesktop } from "@/lib/workspace/dock";
import { registerDockview, unregisterDockview } from "@/lib/workspace/dock/dockRegistry";
import {
  movePanelToDesktopDrop,
  movePanelWithinDesktopDrop,
} from "@/lib/workspace/pane/paneDropCoordinator";
import { dropPosition } from "@/lib/workspace/pane/panePlacement";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";

function layout(panelId: string, sessionId: string) {
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
        params: { sessionId },
      },
    },
    activeGroup: `group:${panelId}`,
  };
}

function panelIds(layoutValue: unknown): string[] {
  return panelsFromLayout(layoutValue)
    .map((panel) => panel.id)
    .sort();
}

describe("dropPosition", () => {
  it("keeps an empty-workspace center drop unpositioned while preserving root edges", () => {
    expect(dropPosition(undefined, "center")).toEqual({});
    expect(dropPosition(undefined, "left")).toEqual({ direction: "left" });
    expect(dropPosition(undefined, "top")).toEqual({ direction: "above" });
  });
});

const registered: { desktopId: string; api: DockviewApi }[] = [];

function terminalPanel(id: string, sessionId: string) {
  return { id, params: { sessionId }, api: { component: "terminal", getParameters: () => ({ sessionId }) } };
}

function mountedDockview(desktopId: string, initialLayout: unknown) {
  let currentLayout = structuredClone(initialLayout);
  const fromJSON = vi.fn((nextLayout: unknown) => {
    currentLayout = structuredClone(nextLayout);
  });
  const api = {
    toJSON: () => structuredClone(currentLayout),
    fromJSON,
    getPanel: () => undefined,
  } as unknown as DockviewApi;
  registerDockview(desktopId, api);
  registered.push({ desktopId, api });
  return { api, fromJSON };
}

afterEach(() => {
  for (const entry of registered.splice(0)) {
    unregisterDockview(entry.desktopId, entry.api);
  }
  vi.useRealTimers();
  useStore.setState({ layouts: {} });
});

describe("movePanelsToDesktop", () => {
  it("persists a move when both source and target spaces are unmounted", async () => {
    vi.useFakeTimers();
    useStore.setState({
      layouts: {
        source: layout("term:moved", "moved"),
        target: layout("term:kept", "kept"),
      },
    });

    const moving = movePanelsToDesktop(
      [{ panelId: "term:moved", fromDesktopId: "source" }],
      "target",
    );
    await vi.runAllTimersAsync();
    await moving;

    const layouts = useStore.getState().layouts;
    expect(panelIds(layouts.source)).toEqual([]);
    expect(panelIds(layouts.target)).toEqual(["term:kept", "term:moved"]);
  });

  it("projects the committed transaction into mounted source and target Dockviews", async () => {
    vi.useFakeTimers();
    const source = mountedDockview(
      "source",
      layout("term:moved", "moved"),
    );
    const target = mountedDockview(
      "target",
      layout("term:kept", "kept"),
    );
    useStore.setState({
      layouts: {
        source: layout("term:stale-source", "stale-source"),
        target: layout("term:stale-target", "stale-target"),
      },
    });

    const receipt = await movePanelsToDesktop(
      [{ panelId: "term:moved", fromDesktopId: "source" }],
      "target",
    );
    await vi.runAllTimersAsync();

    expect(receipt.projectionFailedDesktopIds).toEqual([]);
    expect(receipt.projectedDesktopIds).toEqual(["source", "target"]);
    expect(source.fromJSON).toHaveBeenCalledOnce();
    expect(target.fromJSON).toHaveBeenCalledOnce();
    const layouts = useStore.getState().layouts;
    expect(panelIds(layouts.source)).toEqual([]);
    expect(panelIds(layouts.target)).toEqual(["term:kept", "term:moved"]);
  });

  it("fails closed when an affected mounted layout cannot be snapshotted", async () => {
    const sourceLayout = layout("term:moved", "moved");
    const targetLayout = layout("term:kept", "kept");
    const api = {
      getPanel: (id: string) => id === "term:moved" ? terminalPanel(id, "moved") : undefined,
      toJSON: () => {
        throw new Error("snapshot failed");
      },
    } as unknown as DockviewApi;
    registerDockview("source", api);
    registered.push({ desktopId: "source", api });
    useStore.setState({
      layouts: { source: sourceLayout, target: targetLayout },
    });

    const receipt = await movePanelsToDesktop(
      [{ panelId: "term:moved", fromDesktopId: "source" }],
      "target",
    );

    expect(receipt.error).toEqual({
      code: "layout_snapshot_failed",
      desktopId: "source",
    });
    const layouts = useStore.getState().layouts;
    expect(layouts.source).toBe(sourceLayout);
    expect(layouts.target).toBe(targetLayout);
  });
});

describe("movePanelToDesktopDrop", () => {
  it("keeps the source layout when the target window is unavailable", async () => {
    const sourceLayout = layout("term:moved", "moved-session");
    useStore.setState({
      layouts: { source: sourceLayout },
    });

    const receipt = await movePanelToDesktopDrop(
      { panelId: "term:moved", fromDesktopId: "source" },
      "closed-target",
      { direction: "right" },
    );

    expect(receipt.error).toEqual({
      code: "target_projection_failed",
      desktopId: "closed-target",
    });
    expect(useStore.getState().layouts.source).toBe(sourceLayout);
    expect(useStore.getState().layouts["closed-target"]).toBeUndefined();
  });

  it("projects the target position before committing source removal", async () => {
    const events: string[] = [];
    let currentLayout = layout("term:kept", "kept");
    const position = {
      referenceGroup: { id: "target-group" },
      direction: "right",
    };
    const addPanel = vi.fn((options: {
      id: string;
      component: string;
      title?: string;
      params?: Record<string, unknown>;
      position?: unknown;
    }) => {
      events.push("target-projected");
      const next = structuredClone(currentLayout) as ReturnType<typeof layout>;
      next.panels[options.id] = {
        id: options.id,
        contentComponent: options.component,
        title: options.title ?? options.id,
        params: { sessionId: String(options.params?.sessionId ?? "") },
      };
      next.grid.root.data.push({
        type: "leaf",
        data: {
          id: `group:${options.id}`,
          views: [options.id],
          activeView: options.id,
          locked: true,
        },
        size: 800,
      });
      currentLayout = next;
      return {};
    });
    const api = {
      toJSON: () => structuredClone(currentLayout),
      fromJSON: vi.fn((next: unknown) => {
        currentLayout = structuredClone(next) as ReturnType<typeof layout>;
      }),
      getPanel: () => undefined,
      addPanel,
    } as unknown as DockviewApi;
    registerDockview("target", api);
    registered.push({ desktopId: "target", api });
    useStore.setState({
      layouts: {
        source: layout("term:moved", "moved-session"),
        target: currentLayout,
      },
    });
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.layouts !== previous.layouts) events.push("committed");
    });

    const receipt = await movePanelToDesktopDrop(
      { panelId: "term:moved", fromDesktopId: "source" },
      "target",
      position,
    );
    unsubscribe();

    expect(receipt.error).toBeUndefined();
    expect(events.slice(0, 2)).toEqual(["target-projected", "committed"]);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "term:moved",
        component: "terminal",
        title: "term:moved",
        params: { sessionId: "moved-session" },
        position,
      }),
    );
    const layouts = useStore.getState().layouts;
    expect(panelIds(layouts.source)).toEqual([]);
    expect(panelIds(layouts.target)).toEqual(["term:kept", "term:moved"]);
  });

  it("snapshots a mounted source before an exact Spaces transfer", async () => {
    const staleSource = layout("term:stale", "stale-session");
    const liveSource = layout("term:moved", "moved-session");
    let currentTarget = layout("term:kept", "kept-session");
    const sourceApi = {
      getPanel: (id: string) => id === "term:moved" ? terminalPanel(id, "moved-session") : undefined,
      toJSON: vi.fn(() => structuredClone(liveSource)),
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    const targetApi = {
      toJSON: () => structuredClone(currentTarget),
      fromJSON: vi.fn((next: unknown) => {
        currentTarget = structuredClone(next) as ReturnType<typeof layout>;
      }),
      getPanel: () => undefined,
      addPanel: (options: { id: string; component: string; params?: Record<string, unknown> }) => {
        const next = structuredClone(currentTarget);
        next.panels[options.id] = {
          id: options.id,
          contentComponent: options.component,
          title: options.id,
          params: { sessionId: String(options.params?.sessionId ?? "") },
        };
        next.grid.root.data.push({
          type: "leaf",
          data: {
            id: `group:${options.id}`,
            views: [options.id],
            activeView: options.id,
            locked: true,
          },
          size: 800,
        });
        currentTarget = next;
      },
    } as unknown as DockviewApi;
    registerDockview("source", sourceApi);
    registerDockview("target", targetApi);
    registered.push(
      { desktopId: "source", api: sourceApi },
      { desktopId: "target", api: targetApi },
    );
    useStore.setState({
      layouts: { source: staleSource, target: currentTarget },
    });

    const receipt = await movePanelToDesktopDrop(
      { panelId: "term:moved", fromDesktopId: "source" },
      "target",
      { direction: "right" },
    );

    expect(receipt.error).toBeUndefined();
    expect(sourceApi.toJSON).toHaveBeenCalledOnce();
    expect(panelIds(useStore.getState().layouts.source)).toEqual([]);
    expect(panelIds(useStore.getState().layouts.target)).toEqual([
      "term:kept",
      "term:moved",
    ]);
  });

  it("keeps the source layout untouched when target projection is rejected", async () => {
    const sourceLayout = layout("term:moved", "moved-session");
    const targetLayout = layout("term:kept", "kept");
    const api = {
      toJSON: () => structuredClone(targetLayout),
      fromJSON: vi.fn(),
      getPanel: () => undefined,
      addPanel: () => {
        throw new Error("target rejected panel");
      },
    } as unknown as DockviewApi;
    registerDockview("target", api);
    registered.push({ desktopId: "target", api });
    useStore.setState({
      layouts: { source: sourceLayout, target: targetLayout },
    });

    const receipt = await movePanelToDesktopDrop(
      { panelId: "term:moved", fromDesktopId: "source" },
      "target",
      { direction: "right" },
    );

    expect(receipt.error).toEqual({
      code: "target_projection_failed",
      desktopId: "target",
    });
    expect(useStore.getState().layouts.source).toBe(sourceLayout);
    expect(useStore.getState().layouts.target).toBe(targetLayout);
  });

  it("rolls back a provisional target when its accepted layout cannot be snapshotted", async () => {
    const sourceLayout = layout("term:moved", "moved-session");
    const targetLayout = layout("term:kept", "kept");
    let snapshots = 0;
    const fromJSON = vi.fn();
    const api = {
      toJSON: () => {
        snapshots += 1;
        if (snapshots > 1) throw new Error("snapshot failed after add");
        return structuredClone(targetLayout);
      },
      fromJSON,
      getPanel: () => undefined,
      addPanel: vi.fn(),
    } as unknown as DockviewApi;
    registerDockview("target", api);
    registered.push({ desktopId: "target", api });
    useStore.setState({
      layouts: { source: sourceLayout, target: targetLayout },
    });

    const receipt = await movePanelToDesktopDrop(
      { panelId: "term:moved", fromDesktopId: "source" },
      "target",
      { direction: "below" },
    );

    expect(receipt.error).toEqual({
      code: "target_snapshot_failed",
      desktopId: "target",
    });
    expect(fromJSON).toHaveBeenCalledWith(targetLayout, {
      reuseExistingPanels: true,
    });
    expect(useStore.getState().layouts.source).toBe(sourceLayout);
    expect(useStore.getState().layouts.target).toBe(targetLayout);
  });
});

describe("movePanelWithinDesktopDrop", () => {
  it("moves a Spaces pane beside the exact target group", () => {
    const moveTo = vi.fn();
    const sourceGroup = {
      id: "source-group",
      api: { moveTo: vi.fn() },
    };
    const targetGroup = { id: "target-group" };
    const panel = {
      id: "term:moved",
      group: sourceGroup,
      api: { moveTo },
    };
    const api = {
      toJSON: () => layout("term:moved", "moved-session"),
      getPanel: (id: string) => (id === panel.id ? panel : undefined),
      getGroup: (id: string) => (id === targetGroup.id ? targetGroup : undefined),
    } as unknown as DockviewApi;
    registerDockview("desktop", api);
    registered.push({ desktopId: "desktop", api });

    expect(
      movePanelWithinDesktopDrop(
        { panelId: panel.id, fromDesktopId: "desktop" },
        "desktop",
        { referenceGroup: targetGroup.id, direction: "above" },
      ),
    ).toBe(true);
    expect(moveTo).toHaveBeenCalledWith({
      group: targetGroup,
      position: "top",
    });
  });

  it("turns an imprecise workspace drop into the same floating pane size", () => {
    const panel = {
      id: "term:moved",
      group: { id: "source-group", api: { moveTo: vi.fn() } },
      api: { moveTo: vi.fn() },
    };
    const addFloatingGroup = vi.fn();
    const api = {
      toJSON: () => layout("term:moved", "moved-session"),
      getPanel: (id: string) => (id === panel.id ? panel : undefined),
      addFloatingGroup,
    } as unknown as DockviewApi;
    registerDockview("desktop", api);
    registered.push({ desktopId: "desktop", api });

    expect(
      movePanelWithinDesktopDrop(
        { panelId: panel.id, fromDesktopId: "desktop" },
        "desktop",
        { floating: { x: 120, y: 80 } },
      ),
    ).toBe(true);
    expect(addFloatingGroup).toHaveBeenCalledWith(panel, {
      x: 120,
      y: 80,
      width: 560,
      height: 420,
    });
  });

  it("suppresses a drop beside the pane's own group", () => {
    const moveTo = vi.fn();
    const sourceGroup = { id: "source-group", api: { moveTo } };
    const panel = {
      id: "term:moved",
      group: sourceGroup,
      api: { moveTo },
    };
    const api = {
      toJSON: () => layout("term:moved", "moved-session"),
      getPanel: () => panel,
      getGroup: () => sourceGroup,
    } as unknown as DockviewApi;
    registerDockview("desktop", api);
    registered.push({ desktopId: "desktop", api });

    expect(
      movePanelWithinDesktopDrop(
        { panelId: panel.id, fromDesktopId: "desktop" },
        "desktop",
        { referenceGroup: sourceGroup.id, direction: "right" },
      ),
    ).toBe(false);
    expect(moveTo).not.toHaveBeenCalled();
  });
});
