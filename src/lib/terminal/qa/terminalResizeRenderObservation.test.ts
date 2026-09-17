import { describe, expect, it } from "vitest";
import { terminalResizeRenderObservation } from "@/lib/terminal/qa/terminalResizeRenderObservation";

describe("terminalResizeRenderObservation", () => {
	it("recognizes a complete Claude alternate-screen redraw", () => {
		expect(
			terminalResizeRenderObservation({
				lines: [
					"DURE_RESIZE_QA_CLAUDE_R55_C193_G4",
					"working",
					"DURE_RESIZE_QA_FOOTER_CLAUDE_G4",
				],
				buffer: "alternate",
				columns: 193,
				rows: 55,
			}),
		).toEqual({
			provider: "claude",
			buffer: "alternate",
			generation: 4,
			reportedColumns: 193,
			reportedRows: 55,
			terminalColumns: 193,
			terminalRows: 55,
			dimensionsMatch: true,
			footerVisible: true,
		});
	});

	it("keeps a stale provider redraw visibly failed", () => {
		const observation = terminalResizeRenderObservation({
			lines: [
				"DURE_RESIZE_QA_CODEX_R55_C193_G2",
				"DURE_RESIZE_QA_FOOTER_CODEX_G1",
			],
			buffer: "normal",
			columns: 42,
			rows: 14,
		});

		expect(observation).toMatchObject({
			provider: "codex",
			generation: 2,
			dimensionsMatch: false,
			footerVisible: false,
		});
	});

	it("uses the newest generation when a replay contains older markers", () => {
		expect(
			terminalResizeRenderObservation({
				lines: [
					"DURE_RESIZE_QA_CLAUDE_R14_C42_G1",
					"DURE_RESIZE_QA_CLAUDE_R55_C193_G3",
					"DURE_RESIZE_QA_FOOTER_CLAUDE_G3",
				],
				buffer: "alternate",
				columns: 193,
				rows: 55,
			})?.generation,
		).toBe(3);
	});

	it("accepts a bounded future provider without changing the parser", () => {
		expect(
			terminalResizeRenderObservation({
				lines: [
					"DURE_RESIZE_QA_FUTURE_PROVIDER_R24_C80_G1",
					"DURE_RESIZE_QA_FOOTER_FUTURE_PROVIDER_G1",
				],
				buffer: "normal",
				columns: 80,
				rows: 24,
			})?.provider,
		).toBe("future_provider");
	});

	it("ignores an ordinary terminal frame", () => {
		expect(
			terminalResizeRenderObservation({
				lines: ["normal shell output"],
				buffer: "normal",
				columns: 80,
				rows: 24,
			}),
		).toBeUndefined();
	});
});
