import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CellStyleSchema,
	GraphemeSchema,
	RowTermination,
	TerminalCellSchema,
	TerminalRowSchema,
	TerminalTablesSchema,
	UnderlineKind,
	ViewportFrameSchema,
} from "@/contracts/terminalStateProtocol";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import {
	EMPTY_MATERIALIZED_TABLES,
	materializeTerminalViewportRows,
	materializeTerminalViewportTables,
} from "./terminalViewportMaterialization";

function installedFrame(
	rows: readonly string[],
	graphemeOrder: readonly string[],
): InstalledTerminalViewportFrame {
	const graphemeIndices = new Map(
		graphemeOrder.map((grapheme, index) => [grapheme, index]),
	);
	return {
		schemaMinor: 4,
		frame: create(ViewportFrameSchema, {
			projectionRevision: 1n,
			canonicalColumns: 4,
			viewportRows: rows.length,
			rows: rows.map((text, index) =>
				create(TerminalRowSchema, {
					rowId: BigInt(index + 1),
					logicalLineId: BigInt(index + 1),
					logicalCellSpan: text.length,
					termination: RowTermination.HARD_BREAK,
					cells: [...text].map((grapheme) => ({
						graphemeIndex: graphemeIndices.get(grapheme) ?? 0,
						styleIndex: 0,
					})),
				}),
			),
			tables: create(TerminalTablesSchema, {
				graphemes: graphemeOrder.map((text) =>
					create(GraphemeSchema, { text, displayWidth: 1 }),
				),
				styles: [create(CellStyleSchema, { underline: UnderlineKind.NONE })],
			}),
		}),
	};
}

describe("terminal viewport materialization", () => {
	it("does not reread byte-identical rows when one row changes", () => {
		const rowCount = 50;
		const columnCount = 160;
		const first = installedFrame(
			Array.from({ length: rowCount }, () => "A".repeat(columnCount)),
			["A", "B"],
		);
		let untouchedCellReads = 0;
		for (const row of first.frame.rows.slice(0, -1)) {
			row.cells = row.cells.map(
				(cell) =>
					new Proxy(cell, {
						get(target, property, receiver) {
							if (property === "graphemeIndex" || property === "styleIndex") {
								untouchedCellReads += 1;
							}
							return Reflect.get(target, property, receiver);
						},
					}),
			);
		}
		const firstTables = materializeTerminalViewportTables(first);
		const firstRows = materializeTerminalViewportRows(
			first.frame.rows,
			firstTables,
			"fixed_cell_advance",
			[],
			EMPTY_MATERIALIZED_TABLES,
		);
		const changedRow = create(TerminalRowSchema, {
			...first.frame.rows[rowCount - 1],
			cells: Array.from({ length: columnCount }, (_, index) =>
				create(TerminalCellSchema, {
					graphemeIndex: index === columnCount - 1 ? 1 : 0,
					styleIndex: 0,
				}),
			),
		});
		const nextSourceRows = [
			...first.frame.rows.slice(0, -1),
			changedRow,
		];
		const nextTables = materializeTerminalViewportTables(
			installedFrame([], ["A", "B"]),
		);
		untouchedCellReads = 0;

		const nextRows = materializeTerminalViewportRows(
			nextSourceRows,
			nextTables,
			"fixed_cell_advance",
			firstRows,
			firstTables,
		);

		expect(untouchedCellReads).toBe(0);
		expect(
			nextRows
				.slice(0, -1)
				.every((row, index) => row === firstRows[index]),
		).toBe(true);
		expect(nextRows[rowCount - 1]?.text).toBe(
			`${"A".repeat(columnCount - 1)}B`,
		);
	});

	it("rematerializes an exact row when its indexed grapheme changes", () => {
		const first = installedFrame(["A"], ["A"]);
		const firstTables = materializeTerminalViewportTables(first);
		const firstRows = materializeTerminalViewportRows(
			first.frame.rows,
			firstTables,
			"fixed_cell_advance",
			[],
			EMPTY_MATERIALIZED_TABLES,
		);
		const nextTables = materializeTerminalViewportTables(
			installedFrame([], ["B"]),
		);

		const nextRows = materializeTerminalViewportRows(
			first.frame.rows,
			nextTables,
			"fixed_cell_advance",
			firstRows,
			firstTables,
		);

		expect(nextRows[0]).not.toBe(firstRows[0]);
		expect(nextRows[0]?.text).toBe("B");
	});

	it("rematerializes an exact row when its indexed style changes", () => {
		const first = installedFrame(["A"], ["A"]);
		const firstTables = materializeTerminalViewportTables(first);
		const firstRows = materializeTerminalViewportRows(
			first.frame.rows,
			firstTables,
			"fixed_cell_advance",
			[],
			EMPTY_MATERIALIZED_TABLES,
		);
		const next = installedFrame([], ["A"]);
		if (!next.frame.tables) throw new Error("expected terminal tables");
		next.frame.tables.styles[0] = create(CellStyleSchema, {
			underline: UnderlineKind.SINGLE,
		});
		const nextTables = materializeTerminalViewportTables(next);

		const nextRows = materializeTerminalViewportRows(
			first.frame.rows,
			nextTables,
			"fixed_cell_advance",
			firstRows,
			firstTables,
		);

		expect(nextRows[0]).not.toBe(firstRows[0]);
		expect(nextRows[0]?.runs[0]?.style.underline).toBe(UnderlineKind.SINGLE);
	});

	it("reuses exact presentation across table reindexing and adopts current rows", () => {
		const first = installedFrame(["AB", "CD"], ["A", "B", "C", "D"]);
		const firstTables = materializeTerminalViewportTables(first);
		const firstRows = materializeTerminalViewportRows(
			first.frame.rows,
			firstTables,
			"fixed_cell_advance",
			[],
			EMPTY_MATERIALIZED_TABLES,
		);
		const next = installedFrame(["AB", "CE"], ["E", "D", "C", "B", "A"]);
		const nextTables = materializeTerminalViewportTables(next);

		const nextRows = materializeTerminalViewportRows(
			next.frame.rows,
			nextTables,
			"fixed_cell_advance",
			firstRows,
			firstTables,
		);

		expect(nextRows[0]?.runs).toBe(firstRows[0]?.runs);
		expect(nextRows[0]?.source).toBe(next.frame.rows[0]);
		expect(nextRows[0]?.text).toBe("AB");
		expect(nextRows[1]?.runs).not.toBe(firstRows[1]?.runs);
		expect(nextRows[1]?.text).toBe("CE");
	});
});
