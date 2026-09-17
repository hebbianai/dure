import type {
	TerminalRow,
	TerminalTables,
} from "@/contracts/terminalStateProtocol";

export interface TerminalSelectionPoint {
	readonly logicalLineId: bigint;
	readonly logicalCellOffset: number;
}

export interface TerminalSelection {
	readonly anchor: TerminalSelectionPoint;
	readonly focus: TerminalSelectionPoint;
}

interface TerminalSelectionDocumentCell {
	readonly text: string;
	readonly width: number;
}

export interface TerminalSelectionDocumentRow {
	readonly logicalLineId: bigint;
	readonly logicalCellOffset: number;
	readonly logicalCellSpan: number;
	readonly cells: readonly TerminalSelectionDocumentCell[];
}

export type TerminalSelectionDocumentDirection = "older" | "newer";

interface TerminalSelectionRowRange {
	readonly startColumn: number;
	readonly endColumn: number;
}

interface NormalizedTerminalSelection {
	readonly start: TerminalSelectionPoint;
	readonly end: TerminalSelectionPoint;
	readonly startLine: number;
	readonly endLine: number;
	readonly lineOrder: ReadonlyMap<bigint, number>;
}

export function hitTerminalSelectionPoint(
	rows: readonly TerminalRow[],
	tables: TerminalTables,
	rowIndex: number,
	column: number,
	edge: "start" | "end",
): TerminalSelectionPoint | null {
	const row = rows[rowIndex];
	if (!row || row.logicalCellSpan === 0) return null;
	const target = Math.min(Math.max(0, column), row.logicalCellSpan - 1);
	let current = 0;
	for (const cell of row.cells) {
		const grapheme = tables.graphemes[cell.graphemeIndex];
		if (!grapheme || grapheme.displayWidth === 0) continue;
		const end = current + grapheme.displayWidth;
		if (target < end) {
			return {
				logicalLineId: row.logicalLineId,
				logicalCellOffset:
					row.logicalCellOffset + (edge === "end" ? end : current),
			};
		}
		current = end;
	}
	return {
		logicalLineId: row.logicalLineId,
		logicalCellOffset:
			row.logicalCellOffset + target + (edge === "end" ? 1 : 0),
	};
}

export function terminalSelectionText(
	rows: readonly TerminalRow[],
	tables: TerminalTables,
	selection: TerminalSelection | null,
): string {
	const normalized = normalizeSelection(rows, selection);
	if (!normalized) return "";
	let currentLine: bigint | null = null;
	let text = "";
	for (const row of rows) {
		const range = terminalSelectionRangeForRow(row, normalized);
		if (!range) continue;
		if (currentLine !== null && currentLine !== row.logicalLineId) text += "\n";
		currentLine = row.logicalLineId;
		text += rowTextInRange(row, tables, range);
	}
	return text;
}

/** Materializes one complete Host viewport without retaining its frame-local
 * grapheme table. The resulting rows can safely survive later complete frames
 * while a local drag crosses the viewport boundary. */
export function terminalSelectionDocumentRows(
	rows: readonly TerminalRow[],
	tables: TerminalTables,
): readonly TerminalSelectionDocumentRow[] {
	return rows.map((row) => ({
		logicalLineId: row.logicalLineId,
		logicalCellOffset: row.logicalCellOffset,
		logicalCellSpan: row.logicalCellSpan,
		cells: row.cells.flatMap((cell) => {
			const grapheme = tables.graphemes[cell.graphemeIndex];
			return grapheme && grapheme.displayWidth > 0
				? [{ text: grapheme.text, width: grapheme.displayWidth }]
				: [];
		}),
	}));
}

/** Merges overlapping complete viewport windows in presentation order. A
 * one-row Host scroll therefore retains the row that left the DOM and adds
 * exactly the row that entered it. */
export function mergeTerminalSelectionDocumentRows(
	current: readonly TerminalSelectionDocumentRow[],
	incoming: readonly TerminalSelectionDocumentRow[],
	direction: TerminalSelectionDocumentDirection,
): readonly TerminalSelectionDocumentRow[] {
	if (current.length === 0) return incoming;
	if (incoming.length === 0) return current;
	const currentIndex = new Map(
		current.map((row, index) => [terminalSelectionDocumentRowKey(row), index]),
	);
	let alignment: number | undefined;
	for (const [index, row] of incoming.entries()) {
		const existing = currentIndex.get(terminalSelectionDocumentRowKey(row));
		if (existing !== undefined) {
			alignment = existing - index;
			break;
		}
	}
	if (alignment === undefined) {
		return uniqueTerminalSelectionDocumentRows(
			direction === "older"
				? [...incoming, ...current]
				: [...current, ...incoming],
		);
	}
	const start = Math.min(0, alignment);
	const end = Math.max(current.length, alignment + incoming.length);
	const merged: TerminalSelectionDocumentRow[] = [];
	for (let position = start; position < end; position += 1) {
		const replacement = incoming[position - alignment];
		const retained = current[position];
		const row = replacement ?? retained;
		if (row) merged.push(row);
	}
	return uniqueTerminalSelectionDocumentRows(merged);
}

/** Copies the accumulated logical selection, joining physical soft-wrap rows
 * by their stable logical line identity and trimming terminal padding once per
 * logical line. */
export function terminalSelectionDocumentText(
	rows: readonly TerminalSelectionDocumentRow[],
	selection: TerminalSelection | null,
): string {
	const normalized = normalizeSelection(rows, selection);
	if (!normalized) return "";
	const lines: string[] = [];
	let currentLine: bigint | null = null;
	let currentText = "";
	for (const row of rows) {
		const range = terminalSelectionRangeForRow(row, normalized);
		if (!range) continue;
		if (currentLine !== null && currentLine !== row.logicalLineId) {
			lines.push(currentText.trimEnd());
			currentText = "";
		}
		currentLine = row.logicalLineId;
		currentText += documentRowTextInRange(row, range);
	}
	if (currentLine !== null) lines.push(currentText.trimEnd());
	return lines.join("\n");
}

function terminalSelectionDocumentRowKey(
	row: TerminalSelectionDocumentRow,
): string {
	return `${row.logicalLineId}:${row.logicalCellOffset}:${row.logicalCellSpan}`;
}

function uniqueTerminalSelectionDocumentRows(
	rows: readonly TerminalSelectionDocumentRow[],
): readonly TerminalSelectionDocumentRow[] {
	const seen = new Set<string>();
	return rows.filter((row) => {
		const key = terminalSelectionDocumentRowKey(row);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function documentRowTextInRange(
	row: TerminalSelectionDocumentRow,
	range: TerminalSelectionRowRange,
): string {
	let column = 0;
	let text = "";
	for (const cell of row.cells) {
		const end = column + cell.width;
		if (end > range.startColumn && column < range.endColumn) {
			text += cell.text || " ".repeat(cell.width);
		}
		column = end;
		if (column >= range.endColumn) break;
	}
	if (column < range.endColumn) {
		text += " ".repeat(range.endColumn - Math.max(column, range.startColumn));
	}
	return text;
}

function terminalSelectionRangeForRow(
	row: Pick<
		TerminalRow,
		"logicalLineId" | "logicalCellOffset" | "logicalCellSpan"
	>,
	normalized: NormalizedTerminalSelection,
): TerminalSelectionRowRange | null {
	const lineIndex = normalized.lineOrder.get(row.logicalLineId);
	if (
		lineIndex === undefined ||
		lineIndex < normalized.startLine ||
		lineIndex > normalized.endLine
	) {
		return null;
	}
	const rowStart = row.logicalCellOffset;
	const rowEnd = rowStart + row.logicalCellSpan;
	const selectionStart =
		lineIndex === normalized.startLine ? normalized.start.logicalCellOffset : 0;
	const selectionEnd =
		lineIndex === normalized.endLine
			? normalized.end.logicalCellOffset
			: Number.MAX_SAFE_INTEGER;
	const startColumn = Math.max(rowStart, selectionStart) - rowStart;
	const endColumn = Math.min(rowEnd, selectionEnd) - rowStart;
	return endColumn > startColumn ? { startColumn, endColumn } : null;
}

function normalizeSelection(
	rows: readonly Pick<TerminalRow, "logicalLineId">[],
	selection: TerminalSelection | null,
): NormalizedTerminalSelection | null {
	if (!selection) return null;
	const lineOrder = new Map<bigint, number>();
	for (const row of rows) {
		if (!lineOrder.has(row.logicalLineId)) {
			lineOrder.set(row.logicalLineId, lineOrder.size);
		}
	}
	const anchorLine = lineOrder.get(selection.anchor.logicalLineId);
	const focusLine = lineOrder.get(selection.focus.logicalLineId);
	if (anchorLine === undefined || focusLine === undefined) return null;
	const anchorFirst =
		anchorLine < focusLine ||
		(anchorLine === focusLine &&
			selection.anchor.logicalCellOffset <= selection.focus.logicalCellOffset);
	return {
		start: anchorFirst ? selection.anchor : selection.focus,
		end: anchorFirst ? selection.focus : selection.anchor,
		startLine: anchorFirst ? anchorLine : focusLine,
		endLine: anchorFirst ? focusLine : anchorLine,
		lineOrder,
	};
}

function rowTextInRange(
	row: TerminalRow,
	tables: TerminalTables,
	range: TerminalSelectionRowRange,
): string {
	let column = 0;
	let text = "";
	for (const cell of row.cells) {
		const grapheme = tables.graphemes[cell.graphemeIndex];
		if (!grapheme || grapheme.displayWidth === 0) continue;
		const end = column + grapheme.displayWidth;
		if (end > range.startColumn && column < range.endColumn) {
			text += grapheme.text || " ".repeat(grapheme.displayWidth);
		}
		column = end;
		if (column >= range.endColumn) break;
	}
	if (column < range.endColumn) {
		text += " ".repeat(range.endColumn - Math.max(column, range.startColumn));
	}
	return text;
}
