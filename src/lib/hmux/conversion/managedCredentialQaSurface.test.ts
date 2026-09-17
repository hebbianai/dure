import { describe, expect, it } from "vitest";
import type { StructuredTerminalQaInputObservation } from "@/lib/terminal/qa/structuredTerminalQaProbe";
import type { TerminalQaBufferState } from "@/lib/terminal/terminalViewContracts";
import {
	managedCredentialTargetSurfaceStayedContinuous,
	sameTerminalGrid,
	structuredTerminalGrid,
} from "./managedCredentialQaSurface";

function presentation(
	overrides: Partial<TerminalQaBufferState> = {},
): TerminalQaBufferState {
	return {
		columns: 80,
		rows: 24,
		fitColumns: 80,
		fitRows: 24,
		fitDimensionsMatch: true,
		viewportFill: {
			containerHeight: 384,
			gridHeight: 384,
			effectiveGridHeight: 384,
			rowHeight: 16,
			unfilledHeight: 0,
			overflowHeight: 0,
			fillsContainer: true,
		},
		bufferLength: 24,
		scrollbackRows: 0,
		viewportY: 0,
		atBottom: true,
		concealed: false,
		resizeRenderSeedVisible: false,
		...overrides,
	};
}

function inputObservation(
	attachmentIdentity: string,
	markerCount: number,
): StructuredTerminalQaInputObservation {
	return {
		receipt: {
			requestId: "1",
			attachmentIdentity,
			state: "written_to_pty",
			inputStartedAtMs: 1,
			hostReceiptAtMs: 2,
		},
		projection: presentation(),
		markerCounts: { painted: markerCount, projection: markerCount },
	};
}

describe("managed credential QA presentation evidence", () => {
	it("rejects a canonical grid whose rendered fit or viewport fill regressed", () => {
		const settled = structuredTerminalGrid(presentation());
		const staleFit = structuredTerminalGrid(
			presentation({ fitColumns: 79, fitDimensionsMatch: false }),
		);
		const unfilled = structuredTerminalGrid(
			presentation({
				viewportFill: {
					...presentation().viewportFill,
					unfilledHeight: 16,
					fillsContainer: false,
				},
			}),
		);

		expect(sameTerminalGrid(settled, staleFit)).toBe(false);
		expect(sameTerminalGrid(settled, unfilled)).toBe(false);
	});

	it("rejects a target rehost without a fresh writable attachment", () => {
		const before = {
			connections: 1,
			disconnections: 0,
			hydrations: 1,
			synchronizations: 1,
			gridTransitions: [structuredTerminalGrid(presentation())],
			errors: [],
		};

		expect(
			managedCredentialTargetSurfaceStayedContinuous({
				before,
				after: { ...before, hydrations: 2, synchronizations: 2 },
				inputBefore: inputObservation("attachment-a", 1),
				inputAfter: inputObservation("attachment-a", 0),
			}),
		).toBe(false);
	});

	it("accepts a synchronized replacement without a hydration counter delta", () => {
		const grid = structuredTerminalGrid(presentation());
		const before = {
			connections: 1,
			disconnections: 0,
			hydrations: 1,
			synchronizations: 1,
			gridTransitions: [grid],
			errors: [],
		};

		expect(
			managedCredentialTargetSurfaceStayedContinuous({
				before,
				after: {
					...before,
					synchronizations: 2,
					gridTransitions: [...before.gridTransitions, grid],
				},
				inputBefore: inputObservation("attachment-a", 1),
				inputAfter: inputObservation("attachment-b", 1),
			}),
		).toBe(true);
	});
});
