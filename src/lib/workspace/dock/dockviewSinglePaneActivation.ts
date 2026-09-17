import type { DockviewApi } from "dockview-react";

interface ActivePanel {
	id: string;
}

interface SinglePaneTab {
	panel: ActivePanel;
	setActive(active: boolean): void;
}

interface TabGroupManagerSurface {
	groupUnderlines: { size: number };
	positionUnderlines(): void;
}

interface TabsSurface {
	tabs: readonly SinglePaneTab[];
	_tabGroupManager: TabGroupManagerSurface;
}

interface HeaderSurface {
	size: number;
	tabs?: TabsSurface;
	setActivePanel(panel: ActivePanel): void;
}

interface GroupSurface {
	model: { header: HeaderSurface };
}

interface Subscription {
	dispose(): void;
}

interface DockviewSurface {
	groups: readonly GroupSurface[];
	onDidAddGroup(listener: (group: GroupSurface) => void): Subscription;
	onDidRemoveGroup(listener: (group: GroupSurface) => void): Subscription;
}

interface HeaderPatch {
	refCount: number;
	original: HeaderSurface["setActivePanel"];
	replacement: HeaderSurface["setActivePanel"];
}

const headerPatches = new WeakMap<HeaderSurface, HeaderPatch>();

function acquireSinglePaneFastPath(header: HeaderSurface): () => void {
	const existing = headerPatches.get(header);
	if (existing) {
		existing.refCount += 1;
		return () => releaseSinglePaneFastPath(header, existing);
	}

	const original = header.setActivePanel;
	const replacement = (panel: ActivePanel) => {
		const tabs = header.tabs;
		const tab = tabs?.tabs[0];
		const manager = tabs?._tabGroupManager;
		if (
			header.size !== 1 ||
			tabs?.tabs.length !== 1 ||
			!tab ||
			typeof tab.setActive !== "function" ||
			!manager ||
			typeof manager.positionUnderlines !== "function"
		) {
			original.call(header, panel);
			return;
		}

		// Dure keeps one pane per Dockview group. A lone tab cannot overflow
		// its strip, so reading every tab/strip clientWidth here only forces a
		// full workspace style/layout pass. Preserve the active-tab semantics
		// and the optional grouped-tab underline without touching geometry.
		tab.setActive(panel.id === tab.panel.id);
		if (manager.groupUnderlines.size > 0) manager.positionUnderlines();
	};
	const patch: HeaderPatch = { refCount: 1, original, replacement };
	headerPatches.set(header, patch);
	header.setActivePanel = replacement;
	return () => releaseSinglePaneFastPath(header, patch);
}

function releaseSinglePaneFastPath(
	header: HeaderSurface,
	patch: HeaderPatch,
): void {
	if (headerPatches.get(header) !== patch) return;
	patch.refCount -= 1;
	if (patch.refCount > 0) return;
	if (header.setActivePanel === patch.replacement) {
		header.setActivePanel = patch.original;
	}
	headerPatches.delete(header);
}

/**
 * Install the app-owned single-pane activation fast path on current and future
 * Dockview groups. The narrow private-shape check is fail-safe: an incompatible
 * Dockview upgrade falls back to its original behavior, while this module's
 * real-Dockview contract test makes the performance regression visible.
 */
export function installDockviewSinglePaneActivation(
	api: DockviewApi,
): () => void {
	const surface = api as unknown as Partial<DockviewSurface>;
	if (
		!Array.isArray(surface.groups) ||
		typeof surface.onDidAddGroup !== "function" ||
		typeof surface.onDidRemoveGroup !== "function"
	) {
		return () => {};
	}

	const releases = new Map<GroupSurface, () => void>();
	const attach = (group: GroupSurface) => {
		if (releases.has(group)) return;
		const header = group?.model?.header;
		if (!header || typeof header.setActivePanel !== "function") return;
		releases.set(group, acquireSinglePaneFastPath(header));
	};
	const detach = (group: GroupSurface) => {
		releases.get(group)?.();
		releases.delete(group);
	};
	const added = surface.onDidAddGroup(attach);
	const removed = surface.onDidRemoveGroup(detach);
	for (const group of surface.groups) attach(group);

	return () => {
		added.dispose();
		removed.dispose();
		for (const release of releases.values()) release();
		releases.clear();
	};
}
