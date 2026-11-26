// The Work view's own presentation state: which row is selected, how deep
// the list goes, whether it groups by project, whether today's results are
// unfolded, and which agents are pinned as columns beside the selection. It
// belongs to one window; the main window keeps it across restarts. Nothing
// here records an answer or an acknowledgement. The module imports no store,
// i18n or React.
import { asRecord } from "@/lib/payloadGuards";
import type { WorkDepth, WorkGrouping } from "@/lib/work/workViewList";

export interface WorkViewState {
	/** The selected entry's key (an Agent id, or a shell pane's key). Drilling
	 * into an agent from any column selects it. */
	readonly selected: string | null;
	readonly depth: WorkDepth;
	readonly grouping: WorkGrouping;
	/** Whether the Has a result today section is unfolded. */
	readonly resultsOpen: boolean;
	/** Agent ids the person pinned as detail columns, left to right. A pin
	 * stays until the person removes it, even after its agent is gone. */
	readonly pinned: readonly string[];
}

export const WORK_VIEW_DEFAULT: WorkViewState = {
	selected: null,
	depth: "top",
	grouping: "project",
	resultsOpen: false,
	pinned: [],
};

const VERSION = 1;

function normalizePinned(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return WORK_VIEW_DEFAULT.pinned;
	const pinned = new Set<string>();
	for (const key of value) {
		if (typeof key === "string" && key.length > 0) pinned.add(key);
	}
	return [...pinned];
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
		resultsOpen: state.resultsOpen === true,
		// Absent in what builds before pins saved; older builds ignore it.
		pinned: normalizePinned(state.pinned),
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

/** `pinned` with `agentId` added at the right end; unchanged when it is
 * already pinned. */
export function withPin(
	pinned: readonly string[],
	agentId: string,
): readonly string[] {
	return pinned.includes(agentId) ? pinned : [...pinned, agentId];
}

export function withoutPin(
	pinned: readonly string[],
	agentId: string,
): readonly string[] {
	return pinned.includes(agentId)
		? pinned.filter((key) => key !== agentId)
		: pinned;
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
