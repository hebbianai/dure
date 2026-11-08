// Attention-routing vocabulary for the Spaces navigator — the ONE authority
// for "which display states need a human". The group-header rollups and the
// rail badge read this set; a second inline set would let the surfaces
// disagree about what counts as attention.
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";

/** Display states that require human input (error · blocked · input). */
export const ATTENTION_DISPLAY_STATES: ReadonlySet<string> = new Set([
	"error",
	"blocked",
	"input",
]);

/** Rail-badge count: how many entries currently need a human. */
export function countAttentionDisplayStates(
	states: Record<string, AgentDisplayState | undefined>,
): number {
	let count = 0;
	for (const state of Object.values(states)) {
		if (state !== undefined && ATTENTION_DISPLAY_STATES.has(state)) count += 1;
	}
	return count;
}

interface ProgramStatusRollupRow {
	readonly displayState?: string;
	readonly programStatusKind?: string;
}

/** A program's own report that it is waiting, where Host attention has not
 *  already spoken for the row. The two stay separate counts: a report written
 *  by terminal output never adds to Host-owned attention, and one pane never
 *  counts twice on a heading. */
export function countsTowardProgramStatusRollup(
	row: ProgramStatusRollupRow,
): boolean {
	return (
		row.programStatusKind !== undefined &&
		!(
			row.displayState !== undefined &&
			ATTENTION_DISPLAY_STATES.has(row.displayState)
		)
	);
}

export function countProgramStatusRows(
	rows: readonly ProgramStatusRollupRow[],
): number {
	return rows.filter(countsTowardProgramStatusRollup).length;
}
