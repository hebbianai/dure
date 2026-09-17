import { describe, expect, it } from "vitest";
import { admitTerminalPresentation } from "@/lib/terminal/presentation/terminalPresentationQueue";
import type { WorkspacePerformanceSnapshot } from "@/lib/workspace/performance/workspacePerformance";
import { emptyStructuredTerminalPresentationSnapshot } from "@/lib/workspace/performance/structuredTerminalPresentationPerformance";
import { workspacePerformanceQuiescence } from "./quiescence";

function snapshot(
	overrides: Partial<WorkspacePerformanceSnapshot> = {},
): WorkspacePerformanceSnapshot {
	return {
		transitions: [],
		terminalAttaches: [],
		terminalAttachIntegrity: {
			duplicatePhaseEvents: 0,
			missingPredecessorEvents: 0,
		},
		paneOpens: [],
		agentReady: [],
		workspaces: [],
		totals: {
			mountedWorkspaces: 5,
			terminalSurfaces: 15,
			webglContexts: 0,
			hmuxObservers: 15,
		},
		render: null,
		terminalPresentation: emptyStructuredTerminalPresentationSnapshot(),
		...overrides,
	};
}

describe("workspacePerformanceQuiescence", () => {
	it("waits for actual queued terminal presentation work to drain", () => {
		const cancel = admitTerminalPresentation("background", () => undefined, {
			initialBackground: false,
		});
		try {
			expect(workspacePerformanceQuiescence(snapshot(), 15).ready).toBe(false);
		} finally {
			cancel();
		}
		expect(workspacePerformanceQuiescence(snapshot(), 15).ready).toBe(true);
	});

	it("accepts constructed surfaces without pending attach or presentation work", () => {
		expect(workspacePerformanceQuiescence(snapshot(), 15)).toEqual({
			ready: true,
			terminalSurfaces: 15,
			inFlightAttaches: 0,
			pendingPresentations: 0,
		});
	});

	it("ignores retained inactive Workspace shells without terminal presentations", () => {
		const activePresentations = snapshot({
			totals: {
				...snapshot().totals,
				mountedWorkspaces: 10,
				terminalSurfaces: 3,
				hmuxObservers: 3,
				terminalModelBytes: 0,
			},
		});
		expect(workspacePerformanceQuiescence(activePresentations, 3)).toEqual({
			ready: true,
			terminalSurfaces: 3,
			inFlightAttaches: 0,
			pendingPresentations: 0,
		});
	});

	it.each([
		[
			"missing surface",
			snapshot({ totals: { ...snapshot().totals, terminalSurfaces: 14 } }),
		],
		[
			"active attach",
			snapshot({
				terminalAttaches: [
					{
						sequence: 1,
						transitionSequence: null,
						frontendPreparationMs: null,
						renderableWaitMs: null,
						prepareMs: null,
						preAttachResizeMs: null,
						frontendInvokeMs: null,
						backendCommandMs: null,
						frontendHydrationBarrierMs: null,
						receiptToBarrierMs: null,
						barrierToPaintMs: null,
						paintToStableMs: null,
						invokeToStableMs: null,
						outcome: "in_flight",
					},
				],
			}),
		],
	] as const)("rejects %s", (_label, value) => {
		expect(workspacePerformanceQuiescence(value, 15).ready).toBe(false);
	});

	it("treats a completed hidden synchronization as quiescent", () => {
		const synchronized = snapshot({
			terminalAttaches: [
				{
					sequence: 1,
					transitionSequence: null,
					frontendPreparationMs: 10,
					renderableWaitMs: 0,
					prepareMs: null,
					preAttachResizeMs: 0,
					frontendInvokeMs: 4,
					backendCommandMs: 2,
					frontendHydrationBarrierMs: 4,
					receiptToBarrierMs: 2,
					barrierToPaintMs: null,
					paintToStableMs: null,
					invokeToStableMs: null,
					outcome: "synchronized",
				},
			],
		});
		expect(workspacePerformanceQuiescence(synchronized, 15).ready).toBe(true);
	});
});
