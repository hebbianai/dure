// The window-local store for the Work view's presentation state. The main
// window keeps it across restarts in its own Web Storage entry; other windows
// start from the defaults and keep nothing.
import { create } from "zustand";
import {
	browserLocalStorage,
	readPresentationItem,
	writePresentationItem,
} from "@/lib/persistence/windowPresentationStorage";
import { windowSidebarScope } from "@/lib/sidebar/windowSidebarState";
import type { WorkDepth, WorkGrouping } from "@/lib/work/workViewList";
import {
	parseWorkViewState,
	serializeWorkViewState,
	type WorkViewState,
	withFoldOpen,
	withKey,
	withoutKey,
	withPinMoved,
} from "@/lib/work/workViewState";

const WORK_VIEW_STORAGE_KEY = "dure-main-window-work-view";

export interface WorkViewStore extends WorkViewState {
	/** Selecting only changes what the Work view shows: it opens no pane,
	 * mounts no terminal and acknowledges nothing. */
	select: (key: string | null) => void;
	setDepth: (depth: WorkDepth) => void;
	setGrouping: (grouping: WorkGrouping) => void;
	/** Open or close the fold with this key (WorkListFold.key); `listFolds`
	 * are the folds the list has now. */
	setFoldOpen: (
		foldKey: string,
		open: boolean,
		listFolds: readonly string[],
	) => void;
	setManagedOpen: (open: boolean) => void;
	pin: (agentId: string) => void;
	unpin: (agentId: string) => void;
	movePin: (agentId: string, offset: -1 | 1) => void;
}

export function createWorkViewStore(
	initial: WorkViewState,
	save?: (state: WorkViewState) => void,
) {
	const store = create<WorkViewStore>()((set) => ({
		...initial,
		select: (selected) => set({ selected }),
		setDepth: (depth) => set({ depth }),
		setGrouping: (grouping) => set({ grouping }),
		setFoldOpen: (foldKey, open, listFolds) =>
			set((current) => ({
				openFolds: withFoldOpen(current.openFolds, foldKey, open, listFolds),
			})),
		setManagedOpen: (managedOpen) => set({ managedOpen }),
		pin: (agentId) =>
			set((current) => ({ pinned: withKey(current.pinned, agentId) })),
		unpin: (agentId) =>
			set((current) => ({ pinned: withoutKey(current.pinned, agentId) })),
		movePin: (agentId, offset) =>
			set((current) => ({
				pinned: withPinMoved(current.pinned, agentId, offset),
			})),
	}));
	if (save) {
		store.subscribe((current, previous) => {
			if (
				current.selected === previous.selected &&
				current.depth === previous.depth &&
				current.grouping === previous.grouping &&
				current.openFolds === previous.openFolds &&
				current.managedOpen === previous.managedOpen &&
				current.pinned === previous.pinned
			) {
				return;
			}
			save({
				selected: current.selected,
				depth: current.depth,
				grouping: current.grouping,
				openFolds: current.openFolds,
				managedOpen: current.managedOpen,
				pinned: current.pinned,
			});
		});
	}
	return store;
}

const mainWindow =
	windowSidebarScope(typeof location === "undefined" ? "" : location.search) ===
	"main";
const storage = mainWindow ? browserLocalStorage() : undefined;

export const useWorkViewStore = createWorkViewStore(
	parseWorkViewState(readPresentationItem(storage, WORK_VIEW_STORAGE_KEY)),
	storage
		? (state) =>
				writePresentationItem(
					storage,
					WORK_VIEW_STORAGE_KEY,
					serializeWorkViewState(state),
				)
		: undefined,
);
