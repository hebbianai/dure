/**
 * Reading the dockview grid as sibling rows: which panes share a splitview, in
 * layout order, and how big each one is along that splitview's axis.
 *
 * `api.groups` is insertion order, not layout order, so it cannot answer "which
 * pane is next to which" — after opening a pane to the left of another, the two
 * orders disagree. `api.toJSON().grid` is the tree dockview actually lays out,
 * with each node's size along its parent's axis, so this module reads that.
 *
 * A branch child may itself be a branch (a column inside a row). Its first
 * descendant leaf is a stable identity, but not a resize proxy: deeper rows
 * can repeat the same axis. The row location identifies the actual splitview.
 */

/** The dockview serialised grid, narrowed to what this module reads. */
interface SerializedLeaf {
	readonly type: "leaf";
	readonly data: { readonly id: string };
	readonly size?: number;
}
interface SerializedBranch {
	readonly type: "branch";
	readonly data: readonly SerializedNode[];
	readonly size?: number;
}
type SerializedNode = SerializedLeaf | SerializedBranch;

/** One splitview: the panes sharing it, in layout order, with their sizes. */
export interface PaneRow {
	/** The exact branch location in this snapshot, not a descendant leaf. */
	readonly location: readonly number[];
	/** Identity of each child, in layout order — its first descendant group. */
	readonly order: readonly string[];
	/** Child identity → its size along this row's axis. */
	readonly sizes: ReadonlyMap<string, number>;
	/** True when this row's children are stacked vertically. */
	readonly vertical: boolean;
}

export interface PaneGridSnapshot {
	readonly rows: readonly PaneRow[];
	/** Every group id → the row its enclosing child belongs to. */
	readonly rowOfGroup: ReadonlyMap<string, number>;
	/** Every group id → the identity of the child that encloses it. */
	readonly childOfGroup: ReadonlyMap<string, string>;
}

const isBranch = (node: SerializedNode): node is SerializedBranch =>
	node.type === "branch";

/** The first leaf in layout order — a child's stable identity. */
function firstLeafId(node: SerializedNode): string | undefined {
	if (!isBranch(node)) return node.data?.id;
	for (const child of node.data) {
		const id = firstLeafId(child);
		if (id !== undefined) return id;
	}
	return undefined;
}

function collectLeafIds(node: SerializedNode, into: string[]): void {
	if (!isBranch(node)) {
		if (node.data?.id !== undefined) into.push(node.data.id);
		return;
	}
	for (const child of node.data) collectLeafIds(child, into);
}

/**
 * Read the grid as rows. `rootVertical` is whether the root splitview stacks
 * its children vertically; orientation alternates with depth, which is how
 * dockview itself decides the axis.
 */
export function readPaneGrid(
	grid: unknown,
	rootVertical: boolean,
): PaneGridSnapshot {
	const root = (grid as { root?: SerializedNode } | undefined)?.root;
	const rows: PaneRow[] = [];
	const rowOfGroup = new Map<string, number>();
	const childOfGroup = new Map<string, string>();
	if (!root || !isBranch(root)) return { rows, rowOfGroup, childOfGroup };

	const walk = (
		branch: SerializedBranch,
		vertical: boolean,
		location: readonly number[],
	): void => {
		const order: string[] = [];
		const sizes = new Map<string, number>();
		const rowIndex = rows.length;
		rows.push({ order, sizes, vertical, location });
		for (const child of branch.data) {
			const identity = firstLeafId(child);
			if (identity === undefined) continue;
			order.push(identity);
			if (typeof child.size === "number") sizes.set(identity, child.size);
			const leaves: string[] = [];
			collectLeafIds(child, leaves);
			for (const leaf of leaves) {
				rowOfGroup.set(leaf, rowIndex);
				childOfGroup.set(leaf, identity);
			}
		}
		// Descend after the row is recorded, so a parent always precedes its
		// children and `rowOfGroup` ends up pointing at the innermost row a
		// group belongs to.
		for (const [index, child] of branch.data.entries()) {
			if (isBranch(child)) walk(child, !vertical, [...location, index]);
		}
	};
	walk(root, rootVertical, []);
	return { rows, rowOfGroup, childOfGroup };
}

/** The row a group sits in, or undefined when the group is not in the grid. */
export function rowContaining(
	snapshot: PaneGridSnapshot,
	groupId: string,
): PaneRow | undefined {
	const index = snapshot.rowOfGroup.get(groupId);
	return index === undefined ? undefined : snapshot.rows[index];
}
