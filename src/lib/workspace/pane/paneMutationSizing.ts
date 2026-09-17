/**
 * The one place a pane is added to or removed from the grid.
 *
 * Both operations have to bracket the dockview call with a size capture and a
 * restore (see panePreservedSizes.ts), and doing that at each call site would
 * put the invariant in eight places. These two functions are the authority;
 * nothing else calls `api.addPanel` or `api.removePanel` for grid panes.
 */
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { t } from "@/lib/i18n";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import {
	capturePaneGrid,
	preserveSizesAfterAdd,
	preserveSizesAfterRemove,
	preserveSizesAfterSplit,
} from "@/lib/workspace/pane/panePreservedSizes";

/**
 * Whether this api can be measured and resized. Size preservation is a
 * refinement of dockview's own behaviour, never a precondition for it: a
 * projection api that only records the mutation (cross-window moves, tests)
 * must still add and remove panes, so a missing surface means stand down, not
 * fail.
 */
const canResize = (api: DockviewApi): boolean =>
	typeof (api as { toJSON?: unknown }).toJSON === "function" &&
	Array.isArray((api as { groups?: unknown }).groups);

/** Only an explicit reference denotes a split of one existing pane. */
function referenceGroupId(
	api: DockviewApi,
	position: Record<string, unknown>,
): string | undefined {
	const group = position.referenceGroup;
	if (typeof group === "string") return group;
	if (group && typeof (group as { id?: unknown }).id === "string") {
		return (group as { id: string }).id;
	}
	const panel = position.referencePanel;
	const panelId =
		typeof panel === "string"
			? panel
			: (panel as { id?: string } | undefined)?.id;
	if (panelId !== undefined) return api.getPanel(panelId)?.group.id;
	return undefined;
}

/**
 * Explicit splits share the referenced pane's space. General edge additions
 * share the row proportionally, preserving the existing siblings' ratios.
 */
export function addPanePreservingSizes<Options>(
	api: DockviewApi,
	options: Options,
): ReturnType<DockviewApi["addPanel"]> {
	const paneOptions = options as {
		replacement?: IDockviewPanel["api"];
		position?: Record<string, unknown>;
		initialWidth?: unknown;
	};
	if (paneOptions.replacement) {
		const panel = api.replacePanel(paneOptions.replacement, options as never);
		if (panel) return panel;
		throw new PaneCommandError(
			"pane_changed",
			t("workspace.launcher.unavailable"),
		);
	}
	const before = canResize(api) ? capturePaneGrid(api) : undefined;
	const position = paneOptions?.position;
	const directional =
		position &&
		["left", "right", "above", "below"].includes(String(position.direction));
	const reference = directional ? referenceGroupId(api, position) : undefined;
	const requestedSize =
		position?.direction === "left" || position?.direction === "right"
			? paneOptions.initialWidth
			: undefined;
	const preferredAddedSize =
		typeof requestedSize === "number" &&
		Number.isFinite(requestedSize) &&
		requestedSize >= 0
			? requestedSize
			: undefined;
	const panel = api.addPanel(options as never);
	const addedGroupId = (panel as { group?: { id?: unknown } } | undefined)
		?.group?.id;
	if (before && directional && typeof addedGroupId === "string") {
		if (reference !== undefined) {
			preserveSizesAfterSplit(api, before, reference, addedGroupId);
		} else if (
			position.referenceGroup === undefined &&
			position.referencePanel === undefined
		) {
			preserveSizesAfterAdd(api, before, addedGroupId, preferredAddedSize);
		}
	}
	return panel;
}

/**
 * Remove a pane, handing its space to one neighbour rather than letting
 * dockview equalise the whole row.
 */
export function removePanePreservingSizes(
	api: DockviewApi,
	panel: Parameters<DockviewApi["removePanel"]>[0],
): void {
	const group = (panel as { group?: { id?: string } } | undefined)?.group;
	// Only the last pane of a group takes its space with it; closing a tab out
	// of a stacked group leaves the group, and the grid, exactly as it was.
	const removedGroupId =
		canResize(api) &&
		group &&
		typeof group.id === "string" &&
		api.getGroup?.(group.id)?.panels.length === 1
			? group.id
			: undefined;
	const before =
		removedGroupId === undefined ? undefined : capturePaneGrid(api);
	api.removePanel(panel);
	if (before && removedGroupId !== undefined) {
		preserveSizesAfterRemove(api, before, removedGroupId);
	}
}
