// The Work view's own presentation state: which row is selected, how deep
// the list goes, whether it groups by project and whether today's results
// are unfolded. It belongs to one window; the main window keeps it across
// restarts. Nothing here records an answer or an acknowledgement. The module
// imports no store, i18n or React.
import { asRecord } from "@/lib/payloadGuards";
import type { WorkDepth, WorkGrouping } from "@/lib/work/workViewList";

export interface WorkViewState {
	/** The selected entry's key (an Agent id, or a shell pane's key). */
	readonly selected: string | null;
	readonly depth: WorkDepth;
	readonly grouping: WorkGrouping;
	/** Whether the Has a result today section is unfolded. */
	readonly resultsOpen: boolean;
}

export const WORK_VIEW_DEFAULT: WorkViewState = {
	selected: null,
	depth: "top",
	grouping: "project",
	resultsOpen: false,
};

const VERSION = 1;

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
