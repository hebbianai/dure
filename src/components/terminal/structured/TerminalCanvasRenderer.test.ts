// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalCanvasRenderer } from "./TerminalCanvasRenderer";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TerminalCanvasRenderer metrics", () => {
	it("measures once per font epoch and invalidates explicitly", () => {
		const renderer = createTerminalCanvasRenderer();
		const measureText = vi.fn(() => ({ width: 10 }) as TextMetrics);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			measureText,
		} as unknown as CanvasRenderingContext2D);

		expect(renderer.measure(800, 400, "monospace", 10, 1)).toMatchObject({
			columns: 80,
			rows: 40,
			asciiRunCapability: "fixed_cell_advance",
		});
		const firstMeasurementCalls = measureText.mock.calls.length;
		expect(firstMeasurementCalls).toBeGreaterThan(1);
		renderer.measure(1_000, 500, "monospace", 10, 1);
		expect(measureText).toHaveBeenCalledTimes(firstMeasurementCalls);

		renderer.invalidateMetrics();
		renderer.measure(1_000, 500, "monospace", 10, 1);
		expect(measureText).toHaveBeenCalledTimes(firstMeasurementCalls * 2);
	});

	it("requires representative printable advances to match the Host cell", () => {
		const renderer = createTerminalCanvasRenderer();
		const measureText = vi.fn((text: string) => ({
			width: text === "i" ? 3 : 10,
		})) as unknown as CanvasRenderingContext2D["measureText"];
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			measureText,
		} as unknown as CanvasRenderingContext2D);

		expect(renderer.measure(800, 400, "Arial", 10, 1)).toMatchObject({
			cellWidth: 10,
			asciiRunCapability: "positioned_cells",
		});
	});

	it("fails closed when browser font metrics are unavailable", () => {
		const renderer = createTerminalCanvasRenderer();
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

		expect(renderer.measure(800, 400, "monospace", 10, 1)).toMatchObject({
			cellWidth: 6,
			asciiRunCapability: "positioned_cells",
		});
	});
});
