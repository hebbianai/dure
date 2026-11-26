import { create } from "zustand";
import {
	browserLocalStorage,
	readPresentationItem,
	writePresentationItem,
} from "@/lib/persistence/windowPresentationStorage";
import type { PluginSidebarSelection } from "@/lib/plugins/pluginSidebarSelection";
import {
	type MainView,
	mainViewOf,
	type SidebarTab,
} from "@/lib/sidebar/sidebarTabs";
import {
	initialWindowSidebarState,
	normalizeWindowSidebarWidth,
	serializeWindowSidebarState,
	type WindowSidebarSnapshot,
	windowSidebarScope,
} from "@/lib/sidebar/windowSidebarState";

const MAIN_WINDOW_SIDEBAR_STORAGE_KEY = "agent-ide-main-window-sidebar";
const LEGACY_SHARED_STORE_KEY = "agent-ide";

export interface WindowSidebarStore extends WindowSidebarSnapshot {
	/** The tab the Spaces view was last shown with, which revealing Spaces
	 * from Work returns to. Presentation of this window only; not saved. */
	spacesTab: Exclude<SidebarTab, "work">;
	selectPluginView: (selection: PluginSidebarSelection | null) => void;
	openPluginView: (selection: PluginSidebarSelection) => void;
	toggle: () => void;
	setTab: (tab: SidebarTab) => void;
	/** Bring the Spaces deck forward: from Work, back to the tab Spaces was
	 * last shown with; any other tab already shows it. */
	showSpaces: () => void;
	setWidth: (width: number) => void;
}

function spacesTabOf(
	tab: SidebarTab,
	previous: Exclude<SidebarTab, "work">,
): Exclude<SidebarTab, "work"> {
	return tab === "work" ? previous : tab;
}

type SaveWindowSidebarState = (snapshot: WindowSidebarSnapshot) => void;

export function createWindowSidebarStore(
	initial: WindowSidebarSnapshot,
	save?: SaveWindowSidebarState,
	saveInitial = false,
) {
	const store = create<WindowSidebarStore>()((set) => ({
		...initial,
		spacesTab: spacesTabOf(initial.tab, "spaces"),
		selectPluginView: (pluginSelection) =>
			set((current) => {
				// A retired plugin view falls back to Spaces wherever it was the
				// tab, including the one revealing Spaces would return to.
				const retired = pluginSelection === null;
				return {
					pluginSelection,
					tab: retired && current.tab === "plugin" ? "spaces" : current.tab,
					spacesTab:
						retired && current.spacesTab === "plugin"
							? "spaces"
							: current.spacesTab,
				};
			}),
		openPluginView: (pluginSelection) =>
			set({ pluginSelection, tab: "plugin", spacesTab: "plugin", open: true }),
		toggle: () => set((current) => ({ open: !current.open })),
		setTab: (tab) =>
			set((current) => ({
				tab,
				spacesTab: spacesTabOf(tab, current.spacesTab),
			})),
		showSpaces: () =>
			set((current) =>
				current.tab === "work" ? { tab: current.spacesTab } : current,
			),
		setWidth: (width) => set({ width: normalizeWindowSidebarWidth(width) }),
	}));

	if (save) {
		if (saveInitial) save(initial);
		store.subscribe((current, previous) => {
			if (
				current.open === previous.open &&
				current.width === previous.width &&
				current.tab === previous.tab &&
				current.pluginSelection?.containerKey ===
					previous.pluginSelection?.containerKey &&
				current.pluginSelection?.viewId === previous.pluginSelection?.viewId
			) {
				return;
			}
			save({
				open: current.open,
				width: current.width,
				tab: current.tab,
				pluginSelection: current.pluginSelection,
			});
		});
	}
	return store;
}

const scope = windowSidebarScope(
	typeof location === "undefined" ? "" : location.search,
);
const storage = browserLocalStorage();
const dedicatedMainState = readPresentationItem(
	storage,
	MAIN_WINDOW_SIDEBAR_STORAGE_KEY,
);
const initial = initialWindowSidebarState(
	scope,
	dedicatedMainState,
	readPresentationItem(storage, LEGACY_SHARED_STORE_KEY),
);

export const useWindowSidebarStore = createWindowSidebarStore(
	initial,
	scope === "main" && storage
		? (snapshot) =>
				writePresentationItem(
					storage,
					MAIN_WINDOW_SIDEBAR_STORAGE_KEY,
					serializeWindowSidebarState(snapshot),
				)
		: undefined,
	scope === "main" && storage !== undefined && dedicatedMainState === null,
);

/** What this window's main area shows now, for readers outside React. */
export function windowMainView(): MainView {
	return mainViewOf(useWindowSidebarStore.getState().tab);
}

/** What this window's main area shows. */
export function useWindowMainView(): MainView {
	return useWindowSidebarStore((state) => mainViewOf(state.tab));
}
