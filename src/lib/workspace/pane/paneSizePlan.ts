/**
 * What the pane sizes should be after a split or a close.
 *
 * dockview redistributes on every structural change: `doAddGroup` falls back to
 * `Sizing.Distribute` when no size is given, and `doRemoveGroup` passes
 * `Sizing.Distribute` unconditionally (dockview-core 7.0.4
 * baseComponentGridview.js:228 and :236). Distribute *equalises* rather than
 * scaling, so a 700/400/100 row becomes 300/300/300/300 when a pane is added —
 * the large panes shrink and the small one grows (user report 2026-09-02).
 *
 * `initialWidth` does not fix it: `Sizing.Split(index)` only sets the new view's
 * size to half the reference (splitview.js:447-448) and says nothing about
 * which siblings pay for it. There is no dockview API for "take the space from
 * this pane only", so the sizes are restored after the mutation instead.
 *
 * This module owns the arithmetic and nothing else — no dockview types, no DOM.
 * The caller reads sizes off the api, applies the returned targets in order,
 * and lets the final pane absorb the rounding remainder.
 */

/** A size to apply to one pane, along the axis the mutation happened on. */
export interface PaneSizeTarget {
	readonly id: string;
	readonly size: number;
}

interface SplitPlanInput {
	/** Pane ids along the mutated axis, in layout order, after the mutation. */
	readonly order: readonly string[];
	/** Size each pane had along that axis before the mutation. */
	readonly before: ReadonlyMap<string, number>;
	/** The pane that was split. */
	readonly referenceId: string;
	/** The pane the split produced. */
	readonly addedId: string;
}

interface RemovePlanInput {
	readonly order: readonly string[];
	readonly before: ReadonlyMap<string, number>;
	/** The pane that was closed. */
	readonly removedId: string;
	/** The pane that takes the closed pane's space. */
	readonly inheritorId: string;
}

/**
 * Applying a size to the last pane is pointless — a splitview gives it whatever
 * the earlier panes did not take — and actively harmful, because rounding would
 * then have nowhere to go and the total would drift from the container width.
 */
const dropTrailing = (targets: readonly PaneSizeTarget[]) =>
	targets.slice(0, -1);

/** A general addition gets its requested share, or one average share by
 * default; every existing sibling scales by the same factor. Explicit splits
 * use planSizesAfterSplit instead. */
export function planSizesAfterAdd(
	input: Pick<SplitPlanInput, "order" | "before" | "addedId"> & {
		readonly preferredAddedSize?: number;
	},
): readonly PaneSizeTarget[] {
	const existing = input.order.filter((id) => id !== input.addedId);
	if (existing.length === 0 || existing.length + 1 !== input.order.length)
		return [];
	const sizes = existing.map((id) => input.before.get(id));
	if (
		sizes.some(
			(size) => size === undefined || !Number.isFinite(size) || size < 0,
		)
	)
		return [];
	const total = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
	if (
		input.preferredAddedSize !== undefined &&
		(!Number.isFinite(input.preferredAddedSize) || input.preferredAddedSize < 0)
	)
		return [];
	const addedSize = Math.min(
		total,
		Math.max(0, input.preferredAddedSize ?? total / input.order.length),
	);
	const scale = total > 0 ? (total - addedSize) / total : 0;
	return dropTrailing(
		input.order.map((id) => ({
			id,
			size: Math.round(
				id === input.addedId
					? addedSize
					: (input.before.get(id) as number) * scale,
			),
		})),
	);
}

/**
 * The split pane and its new sibling share the split pane's former size; every
 * other pane keeps exactly what it had.
 *
 * Returns an empty plan when the reference size is unknown (the reference was
 * not in the snapshot, so there is nothing to preserve and dockview's own
 * result stands).
 */
export function planSizesAfterSplit(
	input: SplitPlanInput,
): readonly PaneSizeTarget[] {
	const referenceSize = input.before.get(input.referenceId);
	if (referenceSize === undefined) return [];
	// Floor, so the remainder lands on the new pane rather than being taken back
	// off the reference by the trailing-pane rule.
	const half = Math.floor(referenceSize / 2);
	const targets: PaneSizeTarget[] = [];
	for (const id of input.order) {
		if (id === input.referenceId) {
			targets.push({ id, size: half });
			continue;
		}
		if (id === input.addedId) {
			targets.push({ id, size: referenceSize - half });
			continue;
		}
		const size = input.before.get(id);
		if (size === undefined) return [];
		targets.push({ id, size });
	}
	return dropTrailing(targets);
}

/**
 * The closed pane's space goes to one neighbour; every other pane keeps exactly
 * what it had. Giving it to a single neighbour is what makes closing feel like
 * the inverse of splitting — spreading it would move panes the user never
 * touched, which is the behaviour being fixed.
 */
export function planSizesAfterRemove(
	input: RemovePlanInput,
): readonly PaneSizeTarget[] {
	const removedSize = input.before.get(input.removedId);
	const inheritorSize = input.before.get(input.inheritorId);
	if (removedSize === undefined || inheritorSize === undefined) return [];
	const targets: PaneSizeTarget[] = [];
	for (const id of input.order) {
		if (id === input.removedId) return [];
		const size =
			id === input.inheritorId
				? inheritorSize + removedSize
				: input.before.get(id);
		if (size === undefined) return [];
		targets.push({ id, size });
	}
	return dropTrailing(targets);
}

/**
 * Which pane inherits a closed pane's space: the one before it, or the one
 * after when it was first. Preferring the earlier neighbour matches the split
 * direction — a pane opened to the right of another gives its space back to
 * that same pane when it closes.
 */
export function inheritorForRemoval(
	order: readonly string[],
	removedId: string,
): string | undefined {
	const index = order.indexOf(removedId);
	if (index === -1 || order.length < 2) return undefined;
	return index > 0 ? order[index - 1] : order[1];
}
