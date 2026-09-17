import type { DockviewApi, SerializedDockview } from "dockview-react";
import {
	applyPaneRowSizes,
	capturePaneGrid,
} from "@/lib/workspace/pane/panePreservedSizes";

type GridNode = SerializedDockview["grid"]["root"];

/** Count visible tracks along one axis. A perpendicular stack occupies the
 * widest child's span; a parallel split adds spans. This makes four columns
 * nested beside a fifth receive four shares, rather than half the width. */
function paneSpan(node: GridNode, parallel: boolean): number {
	if (node.visible === false) return 0;
	if (node.type === "leaf") return 1;
	const spans = (node.data as GridNode[]).map((child) =>
		paneSpan(child, !parallel),
	);
	return parallel
		? spans.reduce((sum, span) => sum + span, 0)
		: Math.max(0, ...spans);
}

/** Resize in place, preserving topology, tabs, mounted content and focus.
 * Dockview enforces size constraints; the caller commits the resulting layout. */
export function balancePaneSizes(api: DockviewApi): void {
	if (api.hasMaximizedGroup()) return;
	const root = api.toJSON().grid.root;
	const walk = (node: GridNode, location: readonly number[]): void => {
		if (node.type !== "branch" || node.visible === false) return;
		const children = node.data as GridNode[];
		const spans = children.map((child) => paneSpan(child, false));
		const totalSpan = spans.reduce((sum, span) => sum + span, 0);
		// Ancestor resizing changes descendants' available space. Measure each
		// row when reached, after its parent has received its final allocation.
		const row = capturePaneGrid(api).rows.find(
			(candidate) =>
				candidate.location.length === location.length &&
				candidate.location.every((index, depth) => index === location[depth]),
		);
		if (!row || row.order.length !== children.length) return;
		const visible = row.order.flatMap((id, index) =>
			spans[index] > 0 ? [{ id, span: spans[index] }] : [],
		);
		const totalSize = visible.reduce(
			(sum, { id }) => sum + (row.sizes.get(id) ?? Number.NaN),
			0,
		);
		if (visible.length > 1 && Number.isFinite(totalSize) && totalSize > 0) {
			applyPaneRowSizes(
				api,
				row,
				visible.slice(0, -1).map(({ id, span }) => ({
					id,
					size: Math.floor((totalSize * span) / totalSpan),
				})),
			);
		}
		for (const [index, child] of children.entries()) {
			walk(child, [...location, index]);
		}
	};
	// Floating and popout groups are outside this grid and keep their bounds.
	walk(root, []);
}
