import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CellStyleSchema,
	GraphemeSchema,
	RowTermination,
	TerminalCellSchema,
	TerminalRowSchema,
	TerminalTablesSchema,
} from "@/contracts/terminalStateProtocol";
import {
	hitTerminalSelectionPoint,
	mergeTerminalSelectionDocumentRows,
	terminalSelectionDocumentRows,
	terminalSelectionDocumentText,
	terminalSelectionText,
} from "./terminalSelection";

const tables = create(TerminalTablesSchema, {
	graphemes: [
		create(GraphemeSchema, { text: "a", displayWidth: 1 }),
		create(GraphemeSchema, { text: "b", displayWidth: 1 }),
		create(GraphemeSchema, { text: "界", displayWidth: 2 }),
		create(GraphemeSchema, { text: "c", displayWidth: 1 }),
		create(GraphemeSchema, { text: "d", displayWidth: 1 }),
		create(GraphemeSchema, { text: "z", displayWidth: 1 }),
	],
	styles: [create(CellStyleSchema)],
});

const cell = (graphemeIndex: number) =>
	create(TerminalCellSchema, { graphemeIndex, styleIndex: 0 });

const rows = [
	create(TerminalRowSchema, {
		rowId: 1n,
		logicalLineId: 10n,
		logicalCellOffset: 0,
		logicalCellSpan: 4,
		cells: [cell(0), cell(1), cell(2)],
		termination: RowTermination.SOFT_WRAP,
	}),
	create(TerminalRowSchema, {
		rowId: 2n,
		logicalLineId: 10n,
		logicalCellOffset: 4,
		logicalCellSpan: 2,
		continuesFromPrevious: true,
		cells: [cell(3), cell(4)],
		termination: RowTermination.HARD_BREAK,
	}),
	create(TerminalRowSchema, {
		rowId: 3n,
		logicalLineId: 11n,
		logicalCellOffset: 0,
		logicalCellSpan: 1,
		cells: [cell(5)],
		termination: RowTermination.HARD_BREAK,
	}),
];

describe("structured terminal selection", () => {
	it("copies one logical line across physical soft-wrap rows", () => {
		const anchor = hitTerminalSelectionPoint(rows, tables, 0, 1, "start");
		const focus = hitTerminalSelectionPoint(rows, tables, 1, 1, "end");
		expect(anchor).not.toBeNull();
		expect(focus).not.toBeNull();
		expect(
			terminalSelectionText(rows, tables, {
				anchor: anchor!,
				focus: focus!,
			}),
		).toBe("b界cd");
	});

	it("keeps logical anchors stable after authoritative reflow", () => {
		const selection = {
			anchor: { logicalLineId: 10n, logicalCellOffset: 1 },
			focus: { logicalLineId: 10n, logicalCellOffset: 6 },
		};
		const reflowed = [
			create(TerminalRowSchema, {
				rowId: 4n,
				logicalLineId: 10n,
				logicalCellOffset: 0,
				logicalCellSpan: 6,
				cells: [cell(0), cell(1), cell(2), cell(3), cell(4)],
				termination: RowTermination.HARD_BREAK,
			}),
			rows[2]!,
		];
		expect(terminalSelectionText(reflowed, tables, selection)).toBe("b界cd");
	});

	it("preserves hard line breaks across logical lines", () => {
		expect(
			terminalSelectionText(rows, tables, {
				anchor: { logicalLineId: 10n, logicalCellOffset: 4 },
				focus: { logicalLineId: 11n, logicalCellOffset: 1 },
			}),
		).toBe("cd\nz");
	});

	it("retains rows that leave overlapping Host viewport windows", () => {
		const initial = terminalSelectionDocumentRows(rows.slice(0, 2), tables);
		const next = terminalSelectionDocumentRows(rows.slice(1), tables);
		const merged = mergeTerminalSelectionDocumentRows(initial, next, "newer");

		expect(
			merged.map((row) => [row.logicalLineId, row.logicalCellOffset]),
		).toEqual([
			[10n, 0],
			[10n, 4],
			[11n, 0],
		]);
		expect(
			terminalSelectionDocumentText(merged, {
				anchor: { logicalLineId: 10n, logicalCellOffset: 1 },
				focus: { logicalLineId: 11n, logicalCellOffset: 1 },
			}),
		).toBe("b界cd\nz");
	});

	it("prepends older rows when an upward one-row viewport has no overlap", () => {
		const newest = terminalSelectionDocumentRows([rows[2]!], tables);
		const older = terminalSelectionDocumentRows([rows[0]!], tables);
		const merged = mergeTerminalSelectionDocumentRows(newest, older, "older");

		expect(merged.map((row) => row.logicalLineId)).toEqual([10n, 11n]);
	});
});
