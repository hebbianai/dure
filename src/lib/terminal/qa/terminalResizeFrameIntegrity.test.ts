import { describe, expect, it } from "vitest";
import {
	TerminalResizeFrameIntegrity,
	type TerminalResizeFrameSample,
} from "./terminalResizeFrameIntegrity";

function frame(
	generation: number,
	overrides: Partial<TerminalResizeFrameSample> = {},
): TerminalResizeFrameSample {
	return {
		columns: 120,
		rows: 40,
		fitColumns: 120,
		fitRows: 40,
		fitDimensionsMatch: true,
		atBottom: true,
		concealed: false,
		resizeRender: {
			provider: "claude",
			buffer: "alternate",
			generation,
			reportedColumns: 120,
			reportedRows: 40,
			terminalColumns: 120,
			terminalRows: 40,
			dimensionsMatch: true,
			footerVisible: true,
		},
		...overrides,
	};
}

function monitor() {
	return new TerminalResizeFrameIntegrity({
		provider: "claude",
		buffer: "alternate",
	});
}

describe("TerminalResizeFrameIntegrity", () => {
	it("records complete monotonic provider frames", () => {
		const integrity = monitor();
		integrity.observe(frame(1));
		integrity.observe(frame(2));

		expect(integrity.snapshot()).toMatchObject({
			visibleFrames: 2,
			validFrames: 2,
			violationFrames: 0,
			lastGeneration: 2,
		});
	});

	it("allows an incomplete transition only while it is concealed", () => {
		const integrity = monitor();
		integrity.observe(frame(1));
		integrity.observe({
			columns: 180,
			rows: 55,
			fitColumns: 180,
			fitRows: 55,
			fitDimensionsMatch: false,
			atBottom: true,
			concealed: true,
		});
		integrity.observe(
			frame(2, {
				columns: 180,
				rows: 55,
				fitColumns: 180,
				fitRows: 55,
				fitDimensionsMatch: true,
				resizeRender: {
					...frame(2).resizeRender!,
					reportedColumns: 180,
					reportedRows: 55,
					terminalColumns: 180,
					terminalRows: 55,
				},
			}),
		);

		expect(integrity.snapshot()).toMatchObject({
			concealedFrames: 1,
			validFrames: 2,
			violationFrames: 0,
		});
	});

	it("fails a visible blank or stale geometry frame after activation", () => {
		const integrity = monitor();
		integrity.observe(frame(2));
		integrity.observe({
			columns: 180,
			rows: 55,
			fitColumns: 180,
			fitRows: 55,
			fitDimensionsMatch: false,
			atBottom: true,
			concealed: false,
		});
		integrity.observe(
			frame(1, {
				resizeRender: {
					...frame(1).resizeRender!,
					dimensionsMatch: false,
					footerVisible: false,
				},
			}),
		);

		expect(integrity.snapshot()).toMatchObject({
			violationFrames: 2,
			violations: {
				missingObservation: 1,
				dimensionsMismatch: 1,
				footerMissing: 1,
				generationRegression: 1,
			},
		});
	});

	it("fails a visible frame whose logical scroll left the bottom", () => {
		const integrity = monitor();
		integrity.observe(frame(1));
		integrity.observe(
			frame(2, {
				atBottom: false,
			}),
		);

		expect(integrity.snapshot()).toMatchObject({
			violationFrames: 1,
			violations: { scrollIntentMismatch: 1 },
		});
	});

	it("records replica container divergence without rejecting its canonical frame", () => {
		const integrity = monitor();
		integrity.observe(
			frame(1, {
				fitColumns: 180,
				fitRows: 55,
				fitDimensionsMatch: false,
			}),
		);

		expect(integrity.snapshot()).toMatchObject({
			validFrames: 1,
			violationFrames: 0,
			violations: { containerFitMismatch: 1 },
		});
	});

	it("deduplicates polling of the same displayed state", () => {
		const integrity = monitor();
		const valid = frame(1);
		integrity.observe(valid);
		integrity.observe(valid);

		expect(integrity.snapshot()).toMatchObject({
			samples: 1,
			validFrames: 1,
		});
	});

	it("starts an explicit measurement after preparation without retaining setup violations", () => {
		const integrity = monitor();
		integrity.observe(
			frame(1, {
				fitColumns: 180,
				fitRows: 55,
				fitDimensionsMatch: false,
			}),
		);

		integrity.reset();
		integrity.observe(frame(2));

		expect(integrity.snapshot()).toMatchObject({
			samples: 1,
			visibleFrames: 1,
			validFrames: 1,
			violationFrames: 0,
			lastGeneration: 2,
			violations: { containerFitMismatch: 0 },
		});
	});

	it("keeps generation monotonic after an invalid newer frame", () => {
		const integrity = monitor();
		integrity.observe(
			frame(3, {
				resizeRender: {
					...frame(3).resizeRender!,
					footerVisible: false,
				},
			}),
		);
		integrity.observe(frame(2));

		expect(integrity.snapshot()).toMatchObject({
			lastGeneration: 3,
			violationFrames: 2,
			violations: { footerMissing: 1, generationRegression: 1 },
		});
	});
});
