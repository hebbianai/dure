// Attention-routing vocabulary for the Spaces navigator. Which agents need a
// person is the needs-person authority's (src/lib/agents/needsPerson.ts):
// each Spaces row carries the reason it found, and the group-header rollups
// and the status-group counts only read that field, so they count the same
// agents as the rail badge and Next up.
import type { NeedsPersonReason } from "@/lib/agents/needsPerson";

interface NeedsPersonRollupRow {
	readonly needsPerson?: NeedsPersonReason;
}

/** Whether a row counts toward a heading's "needs attention" rollup. */
export function countsTowardNeedsPersonRollup(row: NeedsPersonRollupRow): boolean {
	return row.needsPerson !== undefined;
}

interface ProgramStatusRollupRow extends NeedsPersonRollupRow {
	readonly programStatusKind?: string;
}

/** A program's own report that it is waiting, where the needs-person
 * authority has not already spoken for the row. The two stay separate
 * counts: a report written by terminal output never adds to Host-owned
 * attention, and one pane never counts twice on a heading. */
export function countsTowardProgramStatusRollup(
	row: ProgramStatusRollupRow,
): boolean {
	return (
		row.programStatusKind !== undefined && !countsTowardNeedsPersonRollup(row)
	);
}

export function countProgramStatusRows(
	rows: readonly ProgramStatusRollupRow[],
): number {
	return rows.filter(countsTowardProgramStatusRollup).length;
}
