import { describe, expect, test } from "vitest";
import { RowTermination } from "@/contracts/terminalStateProtocol";
import {
	structuredTerminalLogicalProjectionText,
	structuredTerminalQaMarkerCounts,
} from "./structuredTerminalLogicalProjection";

function row(input: {
	line: bigint;
	offset: number;
	span: number;
	continues: boolean;
	termination: RowTermination;
}) {
	return {
		logicalLineId: input.line,
		logicalCellOffset: input.offset,
		logicalCellSpan: input.span,
		continuesFromPrevious: input.continues,
		termination: input.termination,
	};
}

describe("structuredTerminalLogicalProjectionText", () => {
	test("observes one marker across engine-proven soft-wrap rows", () => {
		const rows = [
			row({
				line: 7n,
				offset: 0,
				span: 5,
				continues: false,
				termination: RowTermination.SOFT_WRAP,
			}),
			row({
				line: 7n,
				offset: 5,
				span: 5,
				continues: true,
				termination: RowTermination.NONE,
			}),
		];

		expect(
			structuredTerminalLogicalProjectionText(rows, ["QABC1", "23XYZ"]),
		).toContain("QABC123XYZ");
	});

	test("does not join hard breaks or non-adjacent logical offsets", () => {
		const rows = [
			row({
				line: 8n,
				offset: 0,
				span: 3,
				continues: false,
				termination: RowTermination.HARD_BREAK,
			}),
			row({
				line: 9n,
				offset: 0,
				span: 3,
				continues: false,
				termination: RowTermination.NONE,
			}),
		];

		expect(structuredTerminalLogicalProjectionText(rows, ["ABC", "123"])).toBe(
			"ABC\n123",
		);
	});

	test("counts one QA marker split across a proven soft wrap", () => {
		const marker = "HMUX_WINDOW_QA_0123456789AB_B_0003";
		const rows = [
			row({
				line: 10n,
				offset: 0,
				span: 20,
				continues: false,
				termination: RowTermination.SOFT_WRAP,
			}),
			row({
				line: 10n,
				offset: 20,
				span: marker.length - 20,
				continues: true,
				termination: RowTermination.NONE,
			}),
		];

		expect(
			structuredTerminalQaMarkerCounts(rows, [
				marker.slice(0, 20),
				marker.slice(20),
			]),
		).toEqual({ [marker]: 1 });
	});
});
