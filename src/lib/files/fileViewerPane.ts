// Document identity chooses content to reuse; pane identity preserves its view.
import {
	fileDraftKey,
	fileTargetFromPane,
	type FileTarget,
} from "@/lib/files/fileTarget";
import type { DockviewApi } from "dockview-react";
import {
	dockviewRegistry as registry,
	registeredDesktopIdFor,
} from "@/lib/workspace/dock/dockRegistry";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { autoSplitPosition } from "@/lib/workspace/dock/gridPanePlacement";
import {
	clearFilePaneHidden,
	type HiddenFilePaneRecord,
	useHiddenFilePanes,
} from "@/lib/workspace/pane/hiddenFilePanesStore";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import {
	placementOptions,
	type PanelPosition,
} from "@/lib/workspace/pane/panePlacement";
import { restorePanePreservingLayout } from "@/lib/workspace/pane/paneVisibility";
import { recordRecentFileOpen } from "@/lib/files/recentFileOpensStore";
import { isMockupPath, mockupPaneTitle } from "@/lib/design/mockupSrcdoc";

export type OpenFileOpts = FileTarget;

function recordFileOpen(target: FileTarget): void {
	const { sessionId: _sessionId, ...file } = target;
	recordRecentFileOpen(file);
}

function addFilePane(
	api: DockviewApi,
	id: string,
	target: FileTarget,
	component: "fileviewer" | "mockup",
	position?: PanelPosition,
) {
	return addPanePreservingSizes(api, {
		id,
		component,
		title:
			(component === "mockup" ? mockupPaneTitle(target.path) : null) ??
			target.path.split("/").pop() ??
			target.path,
		params: component === "mockup" ? { path: target.path } : target,
		...placementOptions(position ?? autoSplitPosition(api)),
	});
}

function restorePosition(
	record: HiddenFilePaneRecord,
	api: DockviewApi,
): PanelPosition | undefined {
	const anchor = record.anchor;
	if (!anchor) return undefined;
	if ("floating" in anchor) return { floating: anchor.floating };
	return api.getPanel(anchor.referencePanelId)
		? { referencePanel: anchor.referencePanelId, direction: anchor.direction }
		: undefined;
}

/** The selected record is an exact intent handle across deferred Space mounting. */
export function restoreHiddenFilePaneOn(
	api: DockviewApi,
	panelId: string,
	record: HiddenFilePaneRecord,
) {
	if (
		useHiddenFilePanes.getState().hidden[panelId] !== record ||
		record.desktopId !== registeredDesktopIdFor(api)
	)
		return undefined;
	const existing = api.getPanel(panelId);
	if (existing) {
		const target = fileTargetFromPane(dockPanelReference(existing));
		if (!target || fileDraftKey(target) !== fileDraftKey(record.file)) {
			clearFilePaneHidden(panelId);
			return undefined;
		}
	}
	const pane =
		existing ??
		addFilePane(
			api,
			panelId,
			record.file,
			"fileviewer",
			restorePosition(record, api),
		);
	restorePanePreservingLayout(api, pane.id);
	recordFileOpen(record.file);
	return pane;
}

export function openFileViewerOn(
	api: DockviewApi,
	opts: OpenFileOpts,
	position?: PanelPosition,
) {
	const key = fileDraftKey(opts);
	const existing = api.panels.find((pane) => {
		const ref = dockPanelReference(pane);
		if (ref.component === "mockup") {
			return opts.source === "local" && ref.params?.path === opts.path;
		}
		const target = fileTargetFromPane(ref);
		return target && fileDraftKey(target) === key;
	});
	if (!existing) {
		const desktopId = registeredDesktopIdFor(api);
		const hidden = Object.entries(useHiddenFilePanes.getState().hidden).find(
			([, record]) =>
				record.desktopId === desktopId && fileDraftKey(record.file) === key,
		);
		if (hidden) {
			const restored = restoreHiddenFilePaneOn(api, hidden[0], hidden[1]);
			if (restored) return restored;
		}
	}
	const pane =
		existing ??
		addFilePane(
			api,
			createPaneId(),
			opts,
			opts.source === "local" && isMockupPath(opts.path)
				? "mockup"
				: "fileviewer",
			position,
		);
	if (existing) restorePanePreservingLayout(api, pane.id);
	recordFileOpen(opts);
	return pane;
}

export function openFileViewer(
	desktopId: string,
	opts: OpenFileOpts,
	position?: PanelPosition,
) {
	const api = registry.get(desktopId);
	if (api) openFileViewerOn(api, opts, position);
}
