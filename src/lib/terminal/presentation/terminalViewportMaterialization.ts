import type {
	CellStyle,
	Hyperlink,
	TerminalColor,
	TerminalRow,
} from "@/contracts/terminalStateProtocol";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";

export type TerminalAsciiRunCapability =
	| "fixed_cell_advance"
	| "positioned_cells";

export interface MaterializedRun {
	readonly text: string;
	readonly columns: number;
	readonly cellMap: string | null;
	readonly positionedCell: boolean;
	readonly style: CellStyle;
	readonly styleIndex: number;
	readonly hyperlink?: Hyperlink;
	readonly identity: string;
}

export interface MaterializedRow {
	readonly source: TerminalRow;
	readonly text: string;
	readonly runs: readonly MaterializedRun[];
	readonly anchorIdentity: string;
	readonly identity: string;
}

interface MaterializedRunSource {
	readonly text: string[];
	columns: number;
	cellCount: number;
	cellMap: string[] | null;
	readonly coalescible: boolean;
	readonly style: CellStyle;
	readonly styleIndex: number;
	readonly hyperlink?: Hyperlink;
	readonly identity: string;
}

interface MaterializedStyle {
	readonly style: CellStyle;
	readonly styleIndex: number;
	readonly hyperlink?: Hyperlink;
	readonly identity: string;
}

interface MaterializedGrapheme {
	readonly text: string;
	readonly displayWidth: number;
}

export interface MaterializedTables {
	readonly graphemes: readonly MaterializedGrapheme[];
	readonly styles: readonly (MaterializedStyle | undefined)[];
}

export const EMPTY_MATERIALIZED_TABLES: MaterializedTables = {
	graphemes: [],
	styles: [],
};

export function materializeTerminalViewportTables(
	installed: InstalledTerminalViewportFrame,
): MaterializedTables {
	const tables = installed.frame.tables;
	if (!tables) return EMPTY_MATERIALIZED_TABLES;
	return {
		graphemes: tables.graphemes.map((grapheme) => ({
			text: grapheme.text,
			displayWidth: grapheme.displayWidth,
		})),
		styles: materializeStyles(installed),
	};
}

export function materializeTerminalViewportRows(
	rows: readonly TerminalRow[],
	tables: MaterializedTables,
	asciiRunCapability: TerminalAsciiRunCapability,
	previous: readonly MaterializedRow[],
	previousTables: MaterializedTables,
): readonly MaterializedRow[] {
	const reusable = reusableRowsByAnchor(previous);
	let sameTablePresentation: boolean | undefined;
	return rows.map((row) => {
		const anchor = rowAnchorIdentity(row);
		const candidate = reusable.get(anchor);
		reusable.delete(anchor);
		// The carrier decoder preserves a row reference only after exact byte
		// equality. Equal normalized tables preserve those frame-local indices.
		if (candidate?.source === row) {
			sameTablePresentation ??= hasSameTablePresentation(
				previousTables,
				tables,
			);
			if (sameTablePresentation) return candidate;
		}
		if (
			candidate &&
			hasSameCellPresentation(candidate.source, row, previousTables, tables)
		) {
			return { ...candidate, source: row };
		}
		return materializeRow(row, tables, asciiRunCapability);
	});
}

function hasSameTablePresentation(
	previous: MaterializedTables,
	next: MaterializedTables,
): boolean {
	if (previous === next) return true;
	if (
		previous.graphemes.length !== next.graphemes.length ||
		previous.styles.length !== next.styles.length
	) {
		return false;
	}
	for (let index = 0; index < next.graphemes.length; index += 1) {
		const previousGrapheme = previous.graphemes[index];
		const nextGrapheme = next.graphemes[index];
		if (
			previousGrapheme?.text !== nextGrapheme?.text ||
			previousGrapheme?.displayWidth !== nextGrapheme?.displayWidth
		) {
			return false;
		}
	}
	for (let index = 0; index < next.styles.length; index += 1) {
		if (previous.styles[index]?.identity !== next.styles[index]?.identity) {
			return false;
		}
	}
	return true;
}

function reusableRowsByAnchor(
	rows: readonly MaterializedRow[],
): Map<string, MaterializedRow | null> {
	const candidates = new Map<string, MaterializedRow | null>();
	for (const row of rows) {
		const anchor = rowAnchorIdentity(row.source);
		candidates.set(anchor, candidates.has(anchor) ? null : row);
	}
	return candidates;
}

function hasSameCellPresentation(
	previous: TerminalRow,
	next: TerminalRow,
	previousTables: MaterializedTables,
	nextTables: MaterializedTables,
): boolean {
	if (previous.cells.length !== next.cells.length) return false;
	for (let index = 0; index < next.cells.length; index += 1) {
		const previousCell = previous.cells[index];
		const nextCell = next.cells[index];
		if (!previousCell || !nextCell) return false;
		const previousGrapheme =
			previousTables.graphemes[previousCell.graphemeIndex];
		const nextGrapheme = nextTables.graphemes[nextCell.graphemeIndex];
		if (!previousGrapheme || !nextGrapheme) {
			if (
				previousGrapheme !== nextGrapheme ||
				previousCell.graphemeIndex !== nextCell.graphemeIndex
			) {
				return false;
			}
		} else if (
			previousGrapheme.text !== nextGrapheme.text ||
			previousGrapheme.displayWidth !== nextGrapheme.displayWidth
		) {
			return false;
		}
		const previousStyle = previousTables.styles[previousCell.styleIndex];
		const nextStyle = nextTables.styles[nextCell.styleIndex];
		if (!previousStyle || !nextStyle) {
			if (
				previousStyle !== nextStyle ||
				previousCell.styleIndex !== nextCell.styleIndex
			) {
				return false;
			}
		} else if (previousStyle.identity !== nextStyle.identity) {
			return false;
		}
	}
	return true;
}

function materializeRow(
	row: TerminalRow,
	tables: MaterializedTables,
	asciiRunCapability: TerminalAsciiRunCapability,
): MaterializedRow {
	const sources: MaterializedRunSource[] = [];
	for (const cell of row.cells) {
		const grapheme = tables.graphemes[cell.graphemeIndex];
		const materializedStyle = tables.styles[cell.styleIndex];
		if (!grapheme || !materializedStyle) continue;
		const coalescible =
			asciiRunCapability === "fixed_cell_advance" &&
			isSafeAsciiCell(grapheme.text, grapheme.displayWidth);
		const { style, styleIndex, hyperlink, identity } = materializedStyle;
		const previous = sources[sources.length - 1];
		if (
			previous?.coalescible &&
			coalescible &&
			previous.identity === identity
		) {
			appendMaterializedCell(previous, grapheme.text, grapheme.displayWidth);
			continue;
		}
		const source: MaterializedRunSource = {
			text: [],
			columns: 0,
			cellCount: 0,
			cellMap: null,
			coalescible,
			style,
			styleIndex,
			hyperlink,
			identity,
		};
		appendMaterializedCell(source, grapheme.text, grapheme.displayWidth);
		sources.push(source);
	}
	const runs = sources.flatMap<MaterializedRun>((source) => {
		const text = source.text.join("");
		const cellMap = source.cellMap?.join(",") ?? null;
		let parts = [text];
		if (source.coalescible && text.trim()) {
			// Keep padding independently hittable without splitting words or cell maps.
			const start = text.length - text.trimStart().length;
			const end = text.trimEnd().length;
			parts = [
				text.slice(0, start),
				text.slice(start, end),
				text.slice(end),
			].filter((part) => part.length > 0);
		}
		return parts.map((text) => {
			const columns = source.coalescible ? text.length : source.columns;
			return {
				text,
				columns,
				cellMap,
				positionedCell: !source.coalescible,
				style: source.style,
				styleIndex: source.styleIndex,
				hyperlink: source.hyperlink,
				identity: JSON.stringify([source.identity, columns, text, cellMap]),
			};
		});
	});
	return {
		source: row,
		text: runs.map((run) => run.text).join(""),
		runs,
		anchorIdentity: rowAnchorIdentity(row),
		identity: rowIdentity(row, runs),
	};
}

function materializeStyles(
	installed: InstalledTerminalViewportFrame,
): readonly (MaterializedStyle | undefined)[] {
	const tables = installed.frame.tables;
	if (!tables) return [];
	return tables.styles.map((style, styleIndex) => {
		const hyperlink =
			style.hyperlinkIndex === 0
				? undefined
				: tables.hyperlinks[style.hyperlinkIndex - 1];
		return {
			style,
			styleIndex,
			hyperlink,
			identity: runStyleIdentity(style, hyperlink),
		};
	});
}

function isSafeAsciiCell(text: string, columns: number): boolean {
	// Chromium may shape or reorder every broader Unicode class independently
	// of the Host grid. Printable ASCII is the only one-to-one LTR subset that
	// may share a text run without losing authoritative cell boundaries.
	if (columns !== 1 || text.length !== 1) return false;
	const code = text.charCodeAt(0);
	return code >= 0x20 && code <= 0x7e;
}

function appendMaterializedCell(
	run: MaterializedRunSource,
	text: string,
	columns: number,
): void {
	// ASCII-like cells need no metadata: their UTF-16 and terminal-column
	// offsets are identical. Only exceptional graphemes carry a compact map,
	// preserving native selection without one layout node per terminal cell.
	const unitCell = text.length === 1 && columns === 1;
	if (run.cellMap) {
		run.cellMap.push(encodedCell(text, columns));
	} else if (!unitCell) {
		run.cellMap = Array.from({ length: run.cellCount }, () => "1.1");
		run.cellMap.push(encodedCell(text, columns));
	}
	run.text.push(text);
	run.columns += columns;
	run.cellCount += 1;
}

function encodedCell(text: string, columns: number): string {
	return `${text.length.toString(36)}.${columns.toString(36)}`;
}

function rowIdentity(
	row: TerminalRow,
	runs: readonly MaterializedRun[],
): string {
	return JSON.stringify([
		row.logicalLineId.toString(),
		row.logicalCellOffset,
		row.logicalCellSpan,
		row.continuesFromPrevious ? 1 : 0,
		row.termination,
		runs.map((run) => run.identity),
	]);
}

function rowAnchorIdentity(row: TerminalRow): string {
	return JSON.stringify([
		row.logicalLineId.toString(),
		row.logicalCellOffset,
		row.logicalCellSpan,
		row.continuesFromPrevious ? 1 : 0,
		row.termination,
	]);
}

function runStyleIdentity(
	style: CellStyle,
	hyperlink: Hyperlink | undefined,
): string {
	return JSON.stringify([
		terminalColorIdentity(style.foreground),
		terminalColorIdentity(style.background),
		terminalColorIdentity(style.underlineColor),
		style.flags.toString(),
		style.underline,
		hyperlink?.uri ?? "",
		hyperlink?.params ?? "",
	]);
}

function terminalColorIdentity(color: TerminalColor | undefined): string {
	return color ? `${color.kind}:${color.value}` : "default";
}
