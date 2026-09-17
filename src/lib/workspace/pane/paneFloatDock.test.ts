// The floating pane's explicit way back to the grid (2026-09-01): the only
// path was the undiscoverable shift+drag redock gesture.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspace/dock/explicitDockviewCommit", () => ({
	commitExplicitDockviewMutation: vi.fn(
		({ mutate }: { mutate: () => void }) => mutate(),
	),
}));
vi.mock("@/lib/workspace/pane/paneMoveUndo", () => ({
	recordPaneMoveSnapshot: vi.fn(),
}));

import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { dockFloatingPaneToGrid } from "@/lib/workspace/pane/paneDropCoordinator";

function fakeDockview(options: {
	panelLocation: "floating" | "grid";
	gridGroups: number;
}) {
	const moveTo = vi.fn();
	const gridGroups = Array.from({ length: options.gridGroups }, (_, index) => ({
		id: `grid-${index}`,
		api: { location: { type: "grid" } },
	}));
	const panelGroup = {
		id: "float-group",
		api: { location: { type: options.panelLocation }, moveTo: vi.fn() },
	};
	const panel = { id: "pane-1", group: panelGroup, api: { moveTo } };
	return {
		api: {
			groups: [...gridGroups, panelGroup],
			getPanel: (id: string) => (id === "pane-1" ? panel : undefined),
			toJSON: () => ({}),
		},
		panel,
		panelGroup,
		gridGroups,
		moveTo,
	};
}

afterEach(() => {
	dockviewRegistry.delete("desk-1");
	vi.clearAllMocks();
});

describe("dockFloatingPaneToGrid", () => {
	it("splits the floating pane off the last grid group", () => {
		const dock = fakeDockview({ panelLocation: "floating", gridGroups: 2 });
		dockviewRegistry.set("desk-1", dock.api as never);

		expect(dockFloatingPaneToGrid("desk-1", "pane-1")).toBe(true);
		expect(dock.moveTo).toHaveBeenCalledWith({
			group: dock.gridGroups[1],
			position: "right",
		});
	});

	it("moves the whole group into the grid when no grid group remains", () => {
		const dock = fakeDockview({ panelLocation: "floating", gridGroups: 0 });
		dockviewRegistry.set("desk-1", dock.api as never);

		expect(dockFloatingPaneToGrid("desk-1", "pane-1")).toBe(true);
		expect(dock.panelGroup.api.moveTo).toHaveBeenCalledWith({
			position: "right",
		});
	});

	it("does nothing for a pane already in the grid", () => {
		const dock = fakeDockview({ panelLocation: "grid", gridGroups: 1 });
		dockviewRegistry.set("desk-1", dock.api as never);

		expect(dockFloatingPaneToGrid("desk-1", "pane-1")).toBe(false);
		expect(dock.moveTo).not.toHaveBeenCalled();
	});
});

describe("float anchor round trip", () => {
	it("returns to the original neighbor, side, and width", async () => {
		const { rememberPaneFloatAnchor } = await import(
			"@/lib/workspace/pane/paneFloatAnchor"
		);
		const rect = (x: number, width: number) => ({
			x,
			y: 0,
			width,
			height: 400,
			left: x,
			top: 0,
			right: x + width,
			bottom: 400,
		});
		const moveTo = vi.fn();
		const setSize = vi.fn();
		const ownGroup = {
			id: "own",
			api: { location: { type: "grid" } },
			element: { getBoundingClientRect: () => rect(0, 300) },
		};
		const neighborPanel = { id: "pane-neighbor" };
		const neighborGroup = {
			id: "neighbor",
			api: { location: { type: "grid" }, setSize },
			element: { getBoundingClientRect: () => rect(300, 500) },
			activePanel: neighborPanel,
		};
		const panel = {
			id: "pane-1",
			group: ownGroup,
			api: { moveTo },
		} as unknown as {
			id: string;
			group: typeof ownGroup;
			api: { moveTo: typeof moveTo };
		};
		const api = {
			groups: [ownGroup, neighborGroup],
			getPanel: (id: string) =>
				id === "pane-1"
					? panel
					: id === "pane-neighbor"
						? { id, group: neighborGroup }
						: undefined,
			toJSON: () => ({}),
		};
		dockviewRegistry.set("desk-1", api as never);

		// Capture while still in the grid, then float the pane.
		rememberPaneFloatAnchor("desk-1", "pane-1");
		ownGroup.api.location.type = "floating";
		// After moveTo the panel lives in the split next to the neighbor.
		moveTo.mockImplementation(() => {
			panel.group = neighborGroup as never;
		});

		expect(dockFloatingPaneToGrid("desk-1", "pane-1")).toBe(true);
		expect(moveTo).toHaveBeenCalledWith({
			group: neighborGroup,
			position: "left",
		});
		expect(setSize).toHaveBeenCalledWith({ width: 300 });
	});
});
