// The Work view's own presentation state: which row is selected, how deep
// the list goes, whether it groups by project, which folds are open, whether
// the details' managed agents are unfolded, and which agents are pinned as
// columns beside the selection. It belongs to one window; the main window
// keeps it across restarts. Nothing here records an answer or an
// acknowledgement. The module imports no store, i18n or React.
import { asRecord } from "@/lib/payloadGuards";
import {
	RESULTS_TODAY_FOLD_KEY,
	type WorkDepth,
	type WorkGrouping,
} from "@/lib/work/workViewList";

export interface WorkViewState {
	/** The selected entry's key (an Agent id, or a shell pane's key). Drilling
	 * into an agent from any column selects it. */
	readonly selected: string | null;
	readonly depth: WorkDepth;
	readonly grouping: WorkGrouping;
	/** Keys of the folds the person opened (WorkListFold.key): today's
	 * results, each group's ended agents. Every fold starts closed. */
	readonly openFolds: readonly string[];
	/** Whether a detail's agents it manages are unfolded: one setting for the
	 * selection's column and every pinned one. */
	readonly managedOpen: boolean;
	/** Agent ids the person pinned as detail columns, left to right. A pin
	 * stays until the person removes it, even after its agent is gone. */
	readonly pinned: readonly string[];
}

export const WORK_VIEW_DEFAULT: WorkViewState = {
	selected: null,
	depth: "top",
	grouping: "project",
	openFolds: [],
	managedOpen: true,
	pinned: [],
};

const VERSION = 1;

/** An ordered set of keys, each once, in the order first saved. */
function normalizeKeys(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	const keys = new Set<string>();
	for (const key of value) {
		if (typeof key === "string" && key.length > 0) keys.add(key);
	}
	return [...keys];
}

/** Builds before folds were keyed saved one flag for today's results. */
function normalizeOpenFolds(state: Record<string, unknown>): readonly string[] {
	if (state.openFolds !== undefined) return normalizeKeys(state.openFolds);
	return state.resultsOpen === true ? [RESULTS_TODAY_FOLD_KEY] : [];
}

function normalizeWorkViewState(value: unknown): WorkViewState {
	const state = asRecord(value);
	if (!state) return WORK_VIEW_DEFAULT;
	return {
		selected:
			typeof state.selected === "string" && state.selected.length > 0
				? state.selected
				: null,
		depth: state.depth === "all" ? "all" : "top",
		grouping: state.grouping === "none" ? "none" : "project",
		openFolds: normalizeOpenFolds(state),
		// Absent in what builds before pins and the managed fold saved; older
		// builds ignore both.
		managedOpen: state.managedOpen !== false,
		pinned: normalizeKeys(state.pinned),
	};
}

/** A saved state, or the defaults when it is absent, corrupt or from a
 * version this build does not know. */
export function parseWorkViewState(raw: string | null): WorkViewState {
	if (!raw) return WORK_VIEW_DEFAULT;
	try {
		const envelope = asRecord(JSON.parse(raw));
		return envelope?.version === VERSION
			? normalizeWorkViewState(envelope.state)
			: WORK_VIEW_DEFAULT;
	} catch {
		return WORK_VIEW_DEFAULT;
	}
}

export function serializeWorkViewState(state: WorkViewState): string {
	return JSON.stringify({ state: normalizeWorkViewState(state), version: VERSION });
}

/** `keys` with `key` added at the end (a pin's right end); unchanged when
 * it is there already. */
export function withKey(
	keys: readonly string[],
	key: string,
): readonly string[] {
	return keys.includes(key) ? keys : [...keys, key];
}

/** `keys` without `key`; unchanged when it is not there. */
export function withoutKey(
	keys: readonly string[],
	key: string,
): readonly string[] {
	return keys.includes(key) ? keys.filter((other) => other !== key) : keys;
}

/** `openFolds` with `foldKey` opened or closed, keeping only the folds the
 * list has now (`listFolds`): a fold gone with its project is forgotten. */
export function withFoldOpen(
	openFolds: readonly string[],
	foldKey: string,
	open: boolean,
	listFolds: readonly string[],
): readonly string[] {
	const next = (open ? withKey : withoutKey)(openFolds, foldKey);
	const kept = next.filter((key) => listFolds.includes(key));
	return kept.length === next.length ? next : kept;
}

/** `pinned` with `agentId` moved one column left (-1) or right (1);
 * unchanged at either end or when it is not pinned. */
export function withPinMoved(
	pinned: readonly string[],
	agentId: string,
	offset: -1 | 1,
): readonly string[] {
	const from = pinned.indexOf(agentId);
	const to = from + offset;
	if (from === -1 || to < 0 || to >= pinned.length) return pinned;
	const moved = [...pinned];
	moved[from] = moved[to];
	moved[to] = agentId;
	return moved;
}

export interface WorkDetailColumn {
	readonly key: string;
	readonly pinned: boolean;
	readonly selected: boolean;
}

/** The detail columns side by side: the pinned agents in the person's order,
 * then the selection unless it is pinned already. Pinning the selection
 * keeps its column where it is, and selecting a pinned agent marks its
 * column instead of adding a second one. */
export function workDetailColumns(
	state: Pick<WorkViewState, "selected" | "pinned">,
): readonly WorkDetailColumn[] {
	const columns: WorkDetailColumn[] = state.pinned.map((key) => ({
		key,
		pinned: true,
		selected: key === state.selected,
	}));
	if (state.selected !== null && !state.pinned.includes(state.selected)) {
		columns.push({ key: state.selected, pinned: false, selected: true });
	}
	return columns;
}
