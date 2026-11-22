/**
 * A tap on a phone alert opens the agent it is about.
 *
 * The alert names the agent by the key the home list already finds rows by
 * (`agentSeatKey` on the computer), so opening it is a tap on that row: the
 * same row, through the same open path, as the list or a Needs you card.
 */

import { type UnifiedRow, sourceOpenable } from "./allSessions";

/** Rust `PushActivation`: the agent a tapped alert names. */
export interface PushActivation {
	readonly sessionId: string;
}

/**
 * The row a tap opens, or none while no paired computer lists that agent
 * where the phone can reach it.
 */
export function activatedRow(
	rows: readonly UnifiedRow[],
	activation: PushActivation,
): UnifiedRow | undefined {
	return rows.find(
		(row) =>
			row.sessionId === activation.sessionId && sourceOpenable(row.source),
	);
}
