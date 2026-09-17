/**
 * Geometry of a serialized Dockview grid: which shapes Dockview can lay out
 * faithfully, and how to repair a snapshot that lost that shape while a panel
 * was removed on the serialized tree instead of the live grid.
 */
import { MAX_SPLITTER_SIZE } from "@/lib/settings/paneLayout";
import { recordOf } from "@/lib/workspace/layout/serializedLayoutJson";

const GRID_ROUNDING_TOLERANCE = 1;

export function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

interface UnderfilledBranch {
	childRecords: Record<string, unknown>[];
	sizes: number[];
	scale: number;
}

function underfilledBranch(
	children: readonly unknown[],
	axisSize: number,
): UnderfilledBranch | null {
	if (children.length === 0) return null;
	const childRecords: Record<string, unknown>[] = [];
	const sizes: number[] = [];
	for (const childValue of children) {
		const child = recordOf(childValue);
		if (!child || child.visible === false || !finiteNonNegative(child.size))
			return null;
		childRecords.push(child);
		sizes.push(child.size);
	}
	const assignedSize = sizes.reduce((sum, size) => sum + size, 0);
	// Dockview excludes splitter gaps from serialized child sizes. A deficit is
	// corruption only when it exceeds every splitter size the UI can configure.
	const allowedGap =
		MAX_SPLITTER_SIZE * Math.max(0, children.length - 1) +
		GRID_ROUNDING_TOLERANCE;
	if (assignedSize <= 0 || axisSize - assignedSize <= allowedGap) return null;
	return { childRecords, sizes, scale: axisSize / assignedSize };
}

function branchHasGeometryHole(
	nodeValue: unknown,
	axisSize: number,
	crossAxisSize: number,
): boolean {
	const node = recordOf(nodeValue);
	if (node?.type !== "branch" || !Array.isArray(node.data)) return false;

	const children = node.data as unknown[];
	const visibleChildren = children.filter(
		(child) => recordOf(child)?.visible !== false,
	);
	if (underfilledBranch(children, axisSize)) return true;

	return visibleChildren.some((childValue) => {
		const child = recordOf(childValue);
		if (child?.type !== "branch" || !finiteNonNegative(child.size))
			return false;
		return branchHasGeometryHole(child, crossAxisSize, child.size);
	});
}

function repairBranchGeometry(
	nodeValue: unknown,
	axisSize: number,
	crossAxisSize: number,
): void {
	const node = recordOf(nodeValue);
	if (node?.type !== "branch" || !Array.isArray(node.data)) return;

	const children = node.data as unknown[];
	const visibleChildren = children.filter(
		(child) => recordOf(child)?.visible !== false,
	);
	const underfilled = underfilledBranch(children, axisSize);
	if (underfilled) {
		let redistributedSize = 0;
		underfilled.childRecords.forEach((child, index) => {
			if (index === underfilled.childRecords.length - 1) {
				child.size = axisSize - redistributedSize;
			} else {
				const nextSize = underfilled.sizes[index] * underfilled.scale;
				child.size = nextSize;
				redistributedSize += nextSize;
			}
		});
	}

	for (const childValue of visibleChildren) {
		const child = recordOf(childValue);
		if (child?.type !== "branch" || !finiteNonNegative(child.size)) continue;
		repairBranchGeometry(child, crossAxisSize, child.size);
	}
}

export function nestedGridHasGeometryHole(gridValue: unknown): boolean {
	const grid = recordOf(gridValue);
	const root = recordOf(grid?.root);
	if (
		!root ||
		!finiteNonNegative(grid?.width) ||
		!finiteNonNegative(grid?.height)
	) {
		return false;
	}
	const horizontal = grid?.orientation === "HORIZONTAL";
	const vertical = grid?.orientation === "VERTICAL";
	if (!horizontal && !vertical) return false;
	return branchHasGeometryHole(
		root,
		horizontal ? grid.width : grid.height,
		horizontal ? grid.height : grid.width,
	);
}

/**
 * Dockview never serializes a branch below the root with a single child:
 * `removeView` promotes the last survivor into the grandparent the moment a
 * branch is down to one, and relies on that invariant when that survivor is
 * itself removed — a branch reaching zero children returns early and stays in
 * the grid with its full size (dockview-core 7.0.4 gridview.js:682). Leaf
 * removal and grafting here work on the serialized tree instead, so they must
 * restore the invariant themselves; otherwise `fromJSON` reintroduces the
 * wrapper and the next close leaves its space blank (user report 2026-09-10).
 */
function collapseSingleChildBranches(children: unknown[]): unknown[] {
	return children.flatMap((childValue) => {
		const child = recordOf(childValue);
		if (child?.type !== "branch" || !Array.isArray(child.data))
			return [childValue];
		const collapsed = collapseSingleChildBranches(child.data as unknown[]);
		child.data = collapsed;
		if (collapsed.length !== 1) return [childValue];
		const only = recordOf(collapsed[0]);
		if (!only) return [childValue];
		if (only.type !== "branch" || !Array.isArray(only.data)) {
			// A leaf takes the wrapper's place, and therefore its size on this axis.
			if (finiteNonNegative(child.size)) only.size = child.size;
			else delete only.size;
			return [only];
		}
		// A branch two levels down shares this axis: its children take the
		// wrapper's place, scaled onto the wrapper's extent when both are known.
		const grandchildren = only.data as unknown[];
		const sizes = grandchildren.map((value) => recordOf(value)?.size);
		const total = sizes.reduce<number>(
			(sum, size) => sum + (finiteNonNegative(size) ? size : 0),
			0,
		);
		if (
			finiteNonNegative(child.size) &&
			total > 0 &&
			sizes.every(finiteNonNegative)
		) {
			const scale = child.size / total;
			for (const value of grandchildren) {
				const grandchild = recordOf(value);
				if (grandchild) grandchild.size = (grandchild.size as number) * scale;
			}
		}
		return grandchildren;
	});
}

export function repairNestedGridGeometry(gridValue: unknown): void {
	const grid = recordOf(gridValue);
	const root = recordOf(grid?.root);
	if (!root) return;
	if (root.type === "branch" && Array.isArray(root.data)) {
		root.data = collapseSingleChildBranches(root.data as unknown[]);
	}
	if (!finiteNonNegative(grid?.width) || !finiteNonNegative(grid?.height))
		return;
	const horizontal = grid?.orientation === "HORIZONTAL";
	const vertical = grid?.orientation === "VERTICAL";
	if (!horizontal && !vertical) return;
	repairBranchGeometry(
		root,
		horizontal ? grid.width : grid.height,
		horizontal ? grid.height : grid.width,
	);
}
