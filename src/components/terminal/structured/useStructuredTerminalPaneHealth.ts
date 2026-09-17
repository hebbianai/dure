import { useCallback } from "react";
import { publishHmuxPaneHealthObservation } from "@/lib/terminal/hmuxPaneHealthStore";
import type { HmuxPaneHealthObservation } from "@/lib/terminal/terminalHealth";

export type StructuredTerminalPaneHealthPublisher = (
	observation: HmuxPaneHealthObservation,
) => void;

/** Project exact attachment observations into one pane-owned health record. */
export function useStructuredTerminalPaneHealth(
	paneHealthId: string | undefined,
): StructuredTerminalPaneHealthPublisher {
	return useCallback(
		(observation: HmuxPaneHealthObservation) => {
			if (!paneHealthId) return;
			publishHmuxPaneHealthObservation(paneHealthId, observation);
		},
		[paneHealthId],
	);
}
