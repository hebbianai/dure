/**
 * Preserve existing proportions on general additions, and keep explicit
 * splits or closes from resizing panes they did not touch.
 *
 * dockview equalises on every structural change (see paneSizePlan.ts for the
 * two lines and why `initialWidth` cannot express this), so the sizes are
 * captured before the mutation and re-applied after it.
 *
 * The restore is deliberately conservative: it only acts when the mutation
 * stayed inside one splitview, which it checks by comparing the row before and
 * after. A split that creates a new nested branch — opening below a pane that
 * sits in a row — already leaves its siblings alone, and this stands down there
 * rather than guessing at sizes recorded on the other axis.
 */
import type { DockviewApi } from "dockview-react";
import {
	type PaneGridSnapshot,
	type PaneRow,
	readPaneGrid,
	rowContaining,
} from "@/lib/workspace/pane/paneGridSnapshot";
import {
	inheritorForRemoval,
	planSizesAfterAdd,
	planSizesAfterRemove,
	planSizesAfterSplit,
} from "@/lib/workspace/pane/paneSizePlan";

export function capturePaneGrid(api: DockviewApi): PaneGridSnapshot {
	const layout = api.toJSON() as unknown as {
		grid?: { orientation?: string };
	};
	return readPaneGrid(layout?.grid, layout?.grid?.orientation === "VERTICAL");
}

/** Same ids in the same order — compared element-wise, since a joined string
 *  would need a separator no group id can contain. */
const sameOrder = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((id, index) => id === b[index]);

/** The rows match when the mutation only added `added` to `before`'s row. */
const sameRowPlusOne = (before: PaneRow, after: PaneRow, added: string) =>
	after.order.length === before.order.length + 1 &&
	sameOrder(
		after.order.filter((id) => id !== added),
		before.order,
	);

/** The rows match when the mutation only removed `removed` from `before`'s row. */
const sameRowMinusOne = (before: PaneRow, after: PaneRow, removed: string) =>
	after.order.length === before.order.length - 1 &&
	sameOrder(
		before.order.filter((id) => id !== removed),
		after.order,
	);

export function applyPaneRowSizes(
	api: DockviewApi,
	row: PaneRow,
	targets: readonly { id: string; size: number }[],
): void {
	// Like grid insertion, branch sizing needs Dockview's TS-private surface.
	// GroupApi.setSize only reaches the nearest matching axis, which can be a
	// different nested row. The installed-Dockview regressions cover this
	// receiver-sensitive contract; an unsupported projection API stands down.
	const grid = (
		api as unknown as {
			component?: {
				gridview?: {
					getNode(location: number[]): [
						unknown,
						{
							readonly children: readonly unknown[];
							resizeChild(index: number, size: number): void;
						},
					];
				};
			};
		}
	).component?.gridview;
	if (typeof grid?.getNode !== "function") return;
	const branch = grid.getNode([...row.location])[1];
	if (
		typeof branch?.resizeChild !== "function" ||
		branch.children?.length !== row.order.length
	)
		return;
	for (const target of targets) {
		const index = row.order.indexOf(target.id);
		if (index !== -1) branch.resizeChild(index, target.size);
	}
}

/** Scale the existing sibling row and give the new peer its requested or average share.
 * Match by topology rather than the root index: Dockview may wrap a column
 * in a one-child root, and a row child may itself contain a nested column. */
export function preserveSizesAfterAdd(
	api: DockviewApi,
	before: PaneGridSnapshot,
	addedGroupId: string,
	preferredAddedSize?: number,
): void {
	const after = capturePaneGrid(api);
	const afterRow = rowContaining(after, addedGroupId);
	const addedChild = after.childOfGroup.get(addedGroupId);
	if (!afterRow || addedChild === undefined) return;
	let beforeRow = before.rows.find(
		(row) =>
			row.vertical === afterRow.vertical &&
			sameRowPlusOne(row, afterRow, addedChild),
	);
	// Adding on the perpendicular root axis wraps the prior grid as one child.
	// A requested rail size applies to that new root without flattening or
	// rewriting the preserved layout inside its remaining child.
	if (
		!beforeRow &&
		preferredAddedSize !== undefined &&
		afterRow.location.length === 0 &&
		afterRow.order.length === 2
	) {
		const existingChild = afterRow.order.find((id) => id !== addedChild);
		const total = afterRow.order.reduce(
			(sum, id) => sum + (afterRow.sizes.get(id) ?? Number.NaN),
			0,
		);
		if (existingChild !== undefined && Number.isFinite(total) && total > 0) {
			beforeRow = {
				location: [],
				order: [existingChild],
				sizes: new Map([[existingChild, total]]),
				vertical: afterRow.vertical,
			};
		}
	}
	if (!beforeRow) return;
	applyPaneRowSizes(
		api,
		afterRow,
		planSizesAfterAdd({
			order: afterRow.order,
			before: beforeRow.sizes,
			addedId: addedChild,
			preferredAddedSize,
		}),
	);
}

/**
 * Give the new pane its space out of the pane that was split, and put every
 * other pane in that row back where it was.
 */
export function preserveSizesAfterSplit(
	api: DockviewApi,
	before: PaneGridSnapshot,
	referenceGroupId: string,
	addedGroupId: string,
): void {
	const beforeRow = rowContaining(before, referenceGroupId);
	if (!beforeRow) return;
	const after = capturePaneGrid(api);
	const afterRow = rowContaining(after, addedGroupId);
	const addedChild = after.childOfGroup.get(addedGroupId);
	const referenceChild = before.childOfGroup.get(referenceGroupId);
	if (!afterRow || addedChild === undefined || referenceChild === undefined)
		return;
	if (!sameRowPlusOne(beforeRow, afterRow, addedChild)) return;
	applyPaneRowSizes(
		api,
		afterRow,
		planSizesAfterSplit({
			order: afterRow.order,
			before: beforeRow.sizes,
			referenceId: referenceChild,
			addedId: addedChild,
		}),
	);
}

/**
 * Hand the closed pane's space to one neighbour and put every other pane in
 * that row back where it was.
 */
export function preserveSizesAfterRemove(
	api: DockviewApi,
	before: PaneGridSnapshot,
	removedGroupId: string,
): void {
	const beforeRow = rowContaining(before, removedGroupId);
	const removedChild = before.childOfGroup.get(removedGroupId);
	if (!beforeRow || removedChild === undefined) return;
	const inheritor = inheritorForRemoval(beforeRow.order, removedChild);
	if (inheritor === undefined) return;
	const after = capturePaneGrid(api);
	const afterRow = after.rows.find(
		(row) =>
			row.vertical === beforeRow.vertical &&
			sameRowMinusOne(beforeRow, row, removedChild),
	);
	if (!afterRow) return;
	applyPaneRowSizes(
		api,
		afterRow,
		planSizesAfterRemove({
			order: afterRow.order,
			before: beforeRow.sizes,
			removedId: removedChild,
			inheritorId: inheritor,
		}),
	);
}
