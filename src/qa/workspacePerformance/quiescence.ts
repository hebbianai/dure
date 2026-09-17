import { readPendingTerminalPresentations } from "@/lib/terminal/presentation/terminalPresentationQueue";
import type { WorkspacePerformanceSnapshot } from "@/lib/workspace/performance/workspacePerformance";

export interface WorkspacePerformanceQuiescence {
	ready: boolean;
	terminalSurfaces: number;
	inFlightAttaches: number;
	pendingPresentations: number;
}

/**
 * Product-idle boundary used between load and interaction measurements.
 * Historical samples are intentionally ignored: only live attach work,
 * queued presentation work, and the active Workspace's visible presentation
 * count keep the workload out of steady state. This does not measure bytes
 * still in the Host or transport. Retained inactive shells own no presentation.
 */
export function workspacePerformanceQuiescence(
	snapshot: WorkspacePerformanceSnapshot,
	expectedTerminalSurfaces: number,
): WorkspacePerformanceQuiescence {
	const terminalSurfaces = snapshot.totals.terminalSurfaces;
	const inFlightAttaches = snapshot.terminalAttaches.filter(
		(sample) => sample.outcome === "in_flight",
	).length;
	const pendingPresentations = readPendingTerminalPresentations();
	return {
		ready:
			terminalSurfaces === expectedTerminalSurfaces &&
			inFlightAttaches === 0 &&
			pendingPresentations === 0,
		terminalSurfaces,
		inFlightAttaches,
		pendingPresentations,
	};
}
