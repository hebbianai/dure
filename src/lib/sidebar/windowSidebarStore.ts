import { create } from "zustand";
import type { PluginSidebarSelection } from "@/lib/plugins/pluginSidebarSelection";
import type { SidebarTab } from "@/lib/sidebar/sidebarTabs";
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
	selectPluginView: (selection: PluginSidebarSelection | null) => void;
	openPluginView: (selection: PluginSidebarSelection) => void;
	toggle: () => void;
	setTab: (tab: SidebarTab) => void;
	setWidth: (width: number) => void;
}

type SaveWindowSidebarState = (snapshot: WindowSidebarSnapshot) => void;

export function createWindowSidebarStore(
	initial: WindowSidebarSnapshot,
	save?: SaveWindowSidebarState,
	saveInitial = false,
) {
	const store = create<WindowSidebarStore>()((set) => ({
		...initial,
		selectPluginView: (pluginSelection) =>
			set((current) => ({
				pluginSelection,
				tab:
					pluginSelection === null && current.tab === "plugin"
						? "spaces"
						: current.tab,
			})),
		openPluginView: (pluginSelection) =>
			set({ pluginSelection, tab: "plugin", open: true }),
		toggle: () => set((current) => ({ open: !current.open })),
		setTab: (tab) => set({ tab }),
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

function browserLocalStorage(): Storage | undefined {
	if (typeof localStorage === "undefined") return undefined;
	try {
		// Access itself can throw when Web Storage is unavailable.
		void localStorage.length;
		return localStorage;
	} catch {
		return undefined;
	}
}

function readStorage(storage: Storage | undefined, key: string): string | null {
	try {
		return storage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

const scope = windowSidebarScope(
	typeof location === "undefined" ? "" : location.search,
);
const storage = browserLocalStorage();
const dedicatedMainState = readStorage(
	storage,
	MAIN_WINDOW_SIDEBAR_STORAGE_KEY,
);
const initial = initialWindowSidebarState(
	scope,
	dedicatedMainState,
	readStorage(storage, LEGACY_SHARED_STORE_KEY),
);

export const useWindowSidebarStore = createWindowSidebarStore(
	initial,
	scope === "main" && storage
		? (snapshot) => {
				try {
					storage.setItem(
						MAIN_WINDOW_SIDEBAR_STORAGE_KEY,
						serializeWindowSidebarState(snapshot),
					);
				} catch {
					// Sidebar state is presentation-only. Keep the current window usable
					// when Web Storage is unavailable rather than surfacing a fatal error.
				}
			}
		: undefined,
	scope === "main" && storage !== undefined && dedicatedMainState === null,
);
