import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { autoSplitPosition } from "@/lib/workspace/dock/gridPanePlacement";
import {
	placementOptions,
	type PanelPosition,
} from "@/lib/workspace/pane/panePlacement";

export interface OpenOrFocusPanelOptions {
	readonly api: DockviewApi;
	readonly panelId: string;
	readonly component: string;
	readonly title: string;
	readonly params: Record<string, unknown>;
	readonly position?: PanelPosition;
	/** Adjust an already-open panel (params, title, events) before focus. */
	readonly onExisting?: (existing: IDockviewPanel) => void;
}

/**
 * Focus the panel when it is already open, otherwise add it at the requested
 * (or auto-split) position. Returns true when an existing panel was focused.
 *
 * This is the plain visible-panel idiom shared by git/diff/browser/terminal
 * opens. Agent panes intentionally do not use it — they restore hidden panes
 * through `restorePanePreservingLayout` under an explicit dockview commit.
 */
export function openOrFocusPanel(options: OpenOrFocusPanelOptions): boolean {
	const existing = options.api.getPanel(options.panelId);
	if (existing) {
		options.onExisting?.(existing);
		existing.api.setActive();
		return true;
	}
	const position = options.position ?? autoSplitPosition(options.api);
	addPanePreservingSizes(options.api, {
		id: options.panelId,
		component: options.component,
		title: options.title,
		params: options.params,
		...placementOptions(position),
	});
	return false;
}
