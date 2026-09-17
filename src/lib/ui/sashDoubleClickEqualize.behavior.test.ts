// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDockviewGridRow,
	type DockviewGridRow,
} from "@/test/dockviewGridRow";

// The behavior under test lives in patches/dockview-core@7.0.4.patch: a
// double-click on a grid sash gives the two groups touching it equal size
// without moving any other sibling.

function doubleClick(sash: HTMLElement): void {
	sash.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 }));
}

function panel(row: DockviewGridRow, index: number) {
	const found = row.panels[index];
	if (!found) throw new Error(`panel ${index} is missing`);
	return found;
}

describe("grid sash double-click", () => {
	const rows: DockviewGridRow[] = [];
	const row = (ids: readonly string[]) => {
		const created = createDockviewGridRow(ids);
		rows.push(created);
		return created;
	};
	afterEach(() => {
		for (const created of rows.splice(0)) created.dispose();
	});

	it("gives the two touching groups equal size and reports a layout change", async () => {
		const grid = row(["left", "right"]);
		panel(grid, 0).group.api.setSize({ width: 450 });
		expect(grid.widths()).toEqual([450, 150]);
		const layoutChanges = vi.fn();
		grid.api.onDidLayoutChange(layoutChanges);

		doubleClick(grid.sash());

		expect(grid.widths()).toEqual([300, 300]);
		await Promise.resolve();
		expect(layoutChanges).toHaveBeenCalledOnce();
	});

	it("leaves groups that do not touch the sash untouched", () => {
		const grid = row(["a", "b", "c"]);
		panel(grid, 0).group.api.setSize({ width: 100 });
		expect(grid.widths()).toEqual([100, 200, 300]);

		doubleClick(grid.sash());

		expect(grid.widths()).toEqual([150, 150, 300]);
	});

	it("stops at a touching group's minimum size instead of taking from the next sibling", () => {
		const grid = row(["a", "b", "c"]);
		panel(grid, 1).group.api.setConstraints({ minimumWidth: 300 });
		panel(grid, 0).group.api.setSize({ width: 100 });
		panel(grid, 2).group.api.setSize({ width: 150 });
		expect(grid.widths()).toEqual([100, 350, 150]);

		doubleClick(grid.sash());

		expect(grid.widths()).toEqual([150, 300, 150]);
	});

	it("does nothing when both touching groups are already pinned", () => {
		const grid = row(["left", "right"]);
		panel(grid, 1).group.api.setConstraints({ minimumWidth: 350 });
		panel(grid, 0).group.api.setSize({ width: 250 });
		expect(grid.widths()).toEqual([250, 350]);
		const layoutChanges = vi.fn();
		grid.api.onDidLayoutChange(layoutChanges);

		doubleClick(grid.sash());

		expect(grid.widths()).toEqual([250, 350]);
		expect(layoutChanges).not.toHaveBeenCalled();
	});

	it("equalises across a hidden group the way a drag through that sash does", () => {
		const grid = row(["a", "hidden", "c"]);
		panel(grid, 0).group.api.setSize({ width: 400 });
		panel(grid, 1).group.api.setVisible(false);
		expect(grid.widths()).toEqual([400, 0, 200]);

		doubleClick(grid.sash());

		expect(grid.widths()).toEqual([300, 0, 300]);
	});
});
