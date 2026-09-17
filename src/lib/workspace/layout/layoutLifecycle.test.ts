import { describe, expect, it } from "vitest";
import {
  appendPanelToLayout,
  extractPanelIdsFromLayout,
  graftPanelIdsFromLayout,
  panelIsPlacedInLayout,
  panelsFromLayout,
  pruneEmptyDockviewGroups,
  removePanelIdsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";

function layoutFixture() {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: {
              id: "keep-group",
              views: ["keep", "remove"],
              activeView: "remove",
            },
          },
        ],
      },
    },
    panels: {
      keep: { params: { sessionId: "keep-session" } },
      remove: { params: { sessionId: "remove-session" } },
    },
    activeGroup: "keep-group",
  };
}

function horizontalLayout(width: number, sizes: readonly number[]) {
  const panelIds = sizes.map((_, index) => `pane-${index + 1}`);
  return {
    grid: {
      root: {
        type: "branch",
        data: panelIds.map((panelId, index) => ({
          type: "leaf",
          data: {
            id: `group-${index + 1}`,
            views: [panelId],
            activeView: panelId,
          },
          size: sizes[index],
        })),
        size: 969,
      },
      width,
      height: 969,
      orientation: "HORIZONTAL",
    },
    panels: Object.fromEntries(
      panelIds.map((panelId) => [panelId, { params: {} }]),
    ),
    activeGroup: "group-1",
  };
}

function rootSizeSum(layout: ReturnType<typeof horizontalLayout>): number {
  return layout.grid.root.data.reduce((sum, node) => sum + node.size, 0);
}

describe("layout lifecycle", () => {
  it("retains explicit content at the serialized boundary without inferring it from ID spelling", () => {
    expect(panelsFromLayout({
      panels: {
        "launcher:first": {
          contentComponent: "terminal", params: { sessionId: "current" },
        },
        "pane:opaque": { component: "ssh", params: { sessionId: "remote" } },
        "term:unknown": { contentComponent: "extension-view", params: {} },
        "agent:unobserved": { params: {} },
      },
    })).toEqual([
      { id: "launcher:first", component: "terminal", params: { sessionId: "current" } },
      { id: "pane:opaque", component: "ssh", params: { sessionId: "remote" } },
      { id: "term:unknown", component: "extension-view", params: {} },
      { id: "agent:unobserved", component: undefined, params: {} },
    ]);
  });

  it("appends a panel beside its durable reference panel", () => {
    const original = horizontalLayout(800, [400, 400]);
    const next = appendPanelToLayout(
      original,
      "pane-new",
      { id: "pane-new", component: "terminal", params: {} },
      { referencePanel: "pane-1", direction: "below" },
    ) as ReturnType<typeof horizontalLayout>;

    expect(next.grid.root.data[0]).toMatchObject({
      type: "branch",
      data: [
        { type: "leaf", data: { views: ["pane-1"] } },
        { type: "leaf", data: { views: ["pane-new"] } },
      ],
    });
    expect(next.grid.root.data[1]).toEqual(original.grid.root.data[1]);
    expect(panelIsPlacedInLayout(next, "pane-new")).toBe(true);
    expect(panelIsPlacedInLayout(original, "pane-new")).toBe(false);
  });

  it("keeps the referenced group active when adding a tab within it", () => {
    const next = appendPanelToLayout(
      horizontalLayout(800, [400, 400]),
      "pane-new",
      { id: "pane-new", component: "terminal", params: {} },
      { referencePanel: "pane-1", direction: "within" },
    ) as ReturnType<typeof horizontalLayout>;

    expect(next.grid.root.data[0].data).toMatchObject({
      id: "group-1",
      views: ["pane-1", "pane-new"],
      activeView: "pane-new",
    });
    expect(next.activeGroup).toBe("group-1");
  });

  it("serializes requested floating placement without mounting a second writer", () => {
    const next = appendPanelToLayout(
      horizontalLayout(800, [800]),
      "pane-floating",
      { id: "pane-floating", component: "terminal", params: {} },
      { floating: { x: 24, y: 32, width: 640, height: 480 } },
    ) as {
      floatingGroups: Array<Record<string, unknown>>;
    };

    expect(next.floatingGroups).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ views: ["pane-floating"] }),
        position: { left: 24, top: 32, width: 640, height: 480 },
      }),
    ]);
  });

  it("extracts serialized panel identities and params", () => {
    expect(panelsFromLayout(layoutFixture())).toEqual([
      { id: "keep", params: { sessionId: "keep-session" } },
      { id: "remove", params: { sessionId: "remove-session" } },
    ]);
  });

	it("recognizes panels placed outside the root grid", () => {
		const layout = {
			...layoutFixture(),
			floatingGroups: [
				{ data: { id: "floating", views: ["floating-pane"] } },
			],
			panels: {
				...layoutFixture().panels,
				"floating-pane": { params: {} },
			},
		};

		expect(panelIsPlacedInLayout(layout, "floating-pane")).toBe(true);
		expect(panelIsPlacedInLayout(layout, "missing")).toBe(false);
	});

  it("removes a panel without mutating the saved layout", () => {
    const original = layoutFixture();
    const cleaned = removePanelIdsFromLayout(original, new Set(["remove"]));

    expect(panelsFromLayout(cleaned).map((panel) => panel.id)).toEqual(["keep"]);
    expect(panelsFromLayout(original).map((panel) => panel.id)).toEqual(["keep", "remove"]);
    expect(
      (cleaned as ReturnType<typeof layoutFixture>).grid.root.data[0].data.activeView,
    ).toBe("keep");
  });

  it("extracts only the requested panels without mutating the source", () => {
    const original = layoutFixture();
    const extracted = extractPanelIdsFromLayout(original, new Set(["remove"]));

    expect(panelsFromLayout(extracted).map((panel) => panel.id)).toEqual(["remove"]);
    expect(panelsFromLayout(original).map((panel) => panel.id)).toEqual(["keep", "remove"]);
  });

  it("returns null when no requested panel exists in the layout", () => {
    expect(extractPanelIdsFromLayout(layoutFixture(), new Set(["ghost"]))).toBeNull();
  });

  it("prunes an empty nested group captured during panel close", () => {
    const corrupted = layoutFixture();
    corrupted.grid.root.data.unshift({
      type: "branch" as const,
      data: [],
    } as never);

    const repaired = pruneEmptyDockviewGroups(corrupted) as ReturnType<
      typeof layoutFixture
    >;

    expect(repaired.grid.root.data).toHaveLength(1);
    expect(repaired.grid.root.data[0]).toMatchObject({ type: "leaf" });
    expect(repaired.activeGroup).toBe("keep-group");
    expect(corrupted.grid.root.data).toHaveLength(2);
  });

  it("repairs a persisted top-level geometry hole after its empty group marker is gone", () => {
    const corrupted = horizontalLayout(1_394, [263.4, 278.4, 278, 276.8]);

    const repaired = pruneEmptyDockviewGroups(corrupted) as typeof corrupted;

    expect(rootSizeSum(corrupted)).toBeCloseTo(1_096.6, 5);
    expect(rootSizeSum(repaired)).toBeCloseTo(1_394, 5);
    expect(repaired).not.toBe(corrupted);
  });

  it("redistributes a removed pane's serialized width to the surviving source panes", () => {
    const original = horizontalLayout(1_400, [280, 280, 280, 280, 280]);

    const cleaned = removePanelIdsFromLayout(
      original,
      new Set(["pane-5"]),
    ) as typeof original;

    expect(cleaned.grid.root.data).toHaveLength(4);
    expect(rootSizeSum(cleaned)).toBeCloseTo(1_400, 5);
    expect(rootSizeSum(original)).toBe(1_400);
  });

  it("leaves a healthy configured splitter gap unchanged", () => {
    const healthy = horizontalLayout(1_394, [330.5, 385.5, 317.5, 354.5]);

    expect(pruneEmptyDockviewGroups(healthy)).toBe(healthy);
    expect(rootSizeSum(healthy)).toBe(1_388);
  });

  it("repairs the alternating axis inside a nested split", () => {
    const corrupted = {
      grid: {
        root: {
          type: "branch",
          data: [
            {
              type: "branch",
              data: [
                {
                  type: "leaf",
                  data: {
                    id: "group-1",
                    views: ["pane-1"],
                    activeView: "pane-1",
                  },
                  size: 200,
                },
                {
                  type: "leaf",
                  data: {
                    id: "group-2",
                    views: ["pane-2"],
                    activeView: "pane-2",
                  },
                  size: 200,
                },
              ],
              size: 800,
            },
          ],
          size: 969,
        },
        width: 800,
        height: 969,
        orientation: "HORIZONTAL",
      },
      panels: { "pane-1": { params: {} }, "pane-2": { params: {} } },
    };

    const repaired = pruneEmptyDockviewGroups(corrupted) as typeof corrupted;
    const children = repaired.grid.root.data[0].data;

    expect(children.reduce((sum, child) => sum + child.size, 0)).toBeCloseTo(969, 5);
  });

  it("does not reinterpret cached sizes while a split has hidden children", () => {
    const layout = horizontalLayout(800, [300, 200]);
    (layout.grid.root.data[1] as { visible?: boolean }).visible = false;

    expect(pruneEmptyDockviewGroups(layout)).toBe(layout);
    expect(rootSizeSum(layout)).toBe(500);
  });

  it("extracting every panel returns an independent copy", () => {
    const original = layoutFixture();
    const extracted = extractPanelIdsFromLayout(original, new Set(["keep", "remove"]));

    expect(extracted).toEqual(original);
    expect(extracted).not.toBe(original);
    expect(panelsFromLayout(extracted).map((panel) => panel.id)).toEqual(["keep", "remove"]);
  });

  it("renames a colliding graft group without rewriting its pane id", () => {
    const destination = horizontalLayout(800, [800]);
    destination.grid.root.data[0].data.id = "pane-move";
    const source = horizontalLayout(800, [800]);
    source.grid.root.data[0].data = {
      id: "pane-move",
      views: ["pane-move"],
      activeView: "pane-move",
    };
    source.panels = {
      "pane-move": { params: { generation: "successor" } },
    };
    source.activeGroup = "pane-move";

    const grafted = graftPanelIdsFromLayout(
      destination,
      source,
      new Set(["pane-move"]),
    );

    expect(panelIsPlacedInLayout(grafted, "pane-move")).toBe(true);
    expect(panelsFromLayout(grafted)).toContainEqual({
      id: "pane-move",
      params: { generation: "successor" },
    });
    expect(JSON.stringify(grafted)).not.toContain('"views":["pane-move:graft"]');
  });

  it("preserves a grafted root split whose axis differs from the destination", () => {
    const destination = horizontalLayout(800, [800]);
    const source = horizontalLayout(800, [300, 300]);
    source.grid.orientation = "VERTICAL";
    source.grid.height = 600;
    source.grid.root.data[0].data = {
      id: "group-moved-a",
      views: ["moved-a"],
      activeView: "moved-a",
    };
    source.grid.root.data[1].data = {
      id: "group-moved-b",
      views: ["moved-b"],
      activeView: "moved-b",
    };
    source.panels = {
      "moved-a": { params: {} },
      "moved-b": { params: {} },
    };

    const grafted = graftPanelIdsFromLayout(
      destination,
      source,
      new Set(["moved-a", "moved-b"]),
    ) as ReturnType<typeof horizontalLayout>;

    expect(grafted.grid.orientation).toBe("HORIZONTAL");
    expect(grafted.grid.root.data).toHaveLength(2);
    expect(grafted.grid.root.data[1]).toMatchObject({
      type: "branch",
      data: [
        { type: "leaf", data: { views: ["moved-a"] } },
        { type: "leaf", data: { views: ["moved-b"] } },
      ],
    });
    expect(rootSizeSum(grafted)).toBeCloseTo(800, 5);
  });
});
