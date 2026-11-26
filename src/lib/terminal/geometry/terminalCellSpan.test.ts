import { describe, expect, it } from "vitest";
import { terminalCellSpanBox } from "./terminalCellSpan";

describe("terminalCellSpanBox", () => {
	it("places a span on the painted cell grid", () => {
		expect(
			terminalCellSpanBox(
				{ row: 3, startColumn: 2, endColumn: 7 },
				{ cellWidth: 8.5, rowHeight: 18 },
			),
		).toEqual({ key: "3:2", left: 17, top: 54, width: 42.5, height: 18 });
	});
});
