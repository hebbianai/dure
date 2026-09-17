import {
	BufferId,
	type CellStyle,
	ColorKind,
	type InputModes,
	MouseEncoding,
	MouseTrackingMode,
	RowTermination,
	type TerminalRow,
	type TerminalTables,
	UnderlineKind,
	type UnicodeWidthProfile,
} from "../../../contracts/terminalStateProtocol";
import {
	TERMINAL_STATE_PROTOCOL_MINOR,
	TerminalStateProtocolError,
} from "./terminalStateLimits";
import {
	validateEnumNumber,
	validateUint32,
	validateUint64,
} from "./terminalStateNumericValidation";

const MAX_COLUMNS = 1024;
export const MAX_GRID_ROWS = 512;
const MAX_TABLE_ENTRIES = 65_536;
export const MAX_URI_BYTES = 4096;
export const MAX_EVENT_TEXT_BYTES = 4096;
const MAX_GRAPHEME_BYTES = 1024;

export function validateTerminalGeometry(columns: number, rows: number): void {
	validateUint32(columns, "terminal columns are not a uint32");
	validateUint32(rows, "terminal rows are not a uint32");
	if (
		columns <= 0 ||
		columns > MAX_COLUMNS ||
		rows <= 0 ||
		rows > MAX_GRID_ROWS
	) {
		fail("terminal geometry is outside caps");
	}
}

export function validateTerminalBufferId(value: BufferId): void {
	validateEnumNumber(
		value,
		[BufferId.NORMAL, BufferId.ALTERNATE],
		"buffer id is invalid",
	);
}

function validateTerminalRowBounds(
	row: TerminalRow,
	columns: number,
	schemaMinor = TERMINAL_STATE_PROTOCOL_MINOR,
): void {
	validateUint32(columns, "terminal columns are not a uint32");
	validateUint64(row.rowId, "row id is not a uint64");
	validateUint64(row.logicalLineId, "logical line id is not a uint64");
	validateUint32(row.logicalCellOffset, "logical cell offset is not a uint32");
	validateUint32(row.logicalCellSpan, "logical cell span is not a uint32");
	if (row.rowId === 0n) fail("row id must be nonzero");
	if (row.logicalLineId === 0n) fail("logical line id must be nonzero");
	if (row.continuesFromPrevious !== row.logicalCellOffset > 0) {
		fail("logical row continuation and cell offset disagree");
	}
	if (row.cells.length > columns) fail("row has too many cells");
	if (schemaMinor >= 2 && row.logicalCellSpan > columns) {
		fail("logical cell span exceeds the grid");
	}
	validateEnumNumber(
		row.termination,
		[RowTermination.NONE, RowTermination.SOFT_WRAP, RowTermination.HARD_BREAK],
		"row termination is invalid",
	);
	if (
		row.cells.some((cell) => {
			validateUint32(cell.graphemeIndex, "cell grapheme index is not a uint32");
			validateUint32(cell.styleIndex, "cell style index is not a uint32");
			return (
				cell.graphemeIndex >= MAX_TABLE_ENTRIES ||
				cell.styleIndex >= MAX_TABLE_ENTRIES
			);
		})
	) {
		fail("row table index exceeds entry cap");
	}
}

export function validateTerminalRows(
	rows: readonly TerminalRow[],
	columns: number,
	tables?: TerminalTables,
	schemaMinor = TERMINAL_STATE_PROTOCOL_MINOR,
): void {
	const physicalIds = new Set<bigint>();
	let previous: TerminalRow | undefined;
	for (const row of rows) {
		if (physicalIds.has(row.rowId)) fail("physical row id is duplicated");
		physicalIds.add(row.rowId);
		if (tables) validateRow(row, columns, tables, schemaMinor);
		else validateTerminalRowBounds(row, columns, schemaMinor);
		if (previous) validateLogicalRowOrder(previous, row, schemaMinor);
		previous = row;
	}
}

export function validateTerminalInputModes(modes: InputModes): void {
	validateEnumNumber(
		modes.mouseTracking,
		[
			MouseTrackingMode.NONE,
			MouseTrackingMode.X10,
			MouseTrackingMode.BUTTON,
			MouseTrackingMode.ANY,
		],
		"terminal input modes contain an invalid enum",
	);
	validateEnumNumber(
		modes.mouseEncoding,
		[
			MouseEncoding.DEFAULT,
			MouseEncoding.UTF8,
			MouseEncoding.SGR,
			MouseEncoding.URXVT,
			MouseEncoding.PIXEL_SGR,
		],
		"terminal input modes contain an invalid enum",
	);
}

export function validateTerminalBytes(
	value: Uint8Array,
	minimum: number,
	maximum: number,
	message: string,
): void {
	if (value.byteLength < minimum || value.byteLength > maximum) fail(message);
}

export function validateTerminalText(
	value: string,
	minimum: number,
	maximum: number,
	message: string,
): void {
	validateTerminalBytes(
		new TextEncoder().encode(value),
		minimum,
		maximum,
		message,
	);
}

export function validateTerminalTables(tables: TerminalTables): void {
	if (tables.graphemes.length === 0 || tables.styles.length === 0) {
		fail("grapheme and style tables must be nonempty");
	}
	validateTableLengths(
		tables.graphemes.length,
		tables.styles.length,
		tables.hyperlinks.length,
	);
	for (const grapheme of tables.graphemes) validateGrapheme(grapheme);
	for (const style of tables.styles)
		validateStyle(style, tables.hyperlinks.length);
	for (const hyperlink of tables.hyperlinks) validateHyperlink(hyperlink);
}

function validateTableLengths(
	graphemes: number,
	styles: number,
	hyperlinks: number,
): void {
	if (
		graphemes > MAX_TABLE_ENTRIES ||
		styles > MAX_TABLE_ENTRIES ||
		hyperlinks > MAX_TABLE_ENTRIES
	) {
		fail("terminal table exceeds its entry cap");
	}
}

function validateGrapheme(grapheme: TerminalTables["graphemes"][number]): void {
	validateTerminalText(
		grapheme.text,
		0,
		MAX_GRAPHEME_BYTES,
		"grapheme is oversized",
	);
	validateUint32(grapheme.displayWidth, "grapheme width is not a uint32");
	if (grapheme.displayWidth > 2) fail("grapheme width exceeds two cells");
}

function validateStyle(style: CellStyle, hyperlinkCount: number): void {
	validateUint32(style.hyperlinkIndex, "style hyperlink index is not a uint32");
	validateUint64(style.flags, "style decoration flags are not a uint64");
	if (style.hyperlinkIndex > hyperlinkCount)
		fail("style hyperlink index is invalid");
	if (style.flags > 0x1ffn) fail("style decoration flags contain unknown bits");
	validateEnumNumber(
		style.underline,
		[
			UnderlineKind.NONE,
			UnderlineKind.SINGLE,
			UnderlineKind.DOUBLE,
			UnderlineKind.CURLY,
			UnderlineKind.DOTTED,
			UnderlineKind.DASHED,
		],
		"underline kind is invalid",
	);
	for (const color of [
		style.foreground,
		style.background,
		style.underlineColor,
	]) {
		if (!color) continue;
		validateEnumNumber(
			color.kind,
			[ColorKind.DEFAULT, ColorKind.PALETTE, ColorKind.RGB],
			"color kind is invalid",
		);
		validateUint32(color.value, "terminal color value is not a uint32");
		if (color.kind === ColorKind.RGB && color.value > 0x00ff_ffff) {
			fail("RGB color exceeds 24 bits");
		}
		if (color.kind === ColorKind.PALETTE && color.value > 255) {
			fail("palette color index exceeds 255");
		}
	}
}

function validateHyperlink(
	hyperlink: TerminalTables["hyperlinks"][number],
): void {
	validateTerminalText(
		hyperlink.uri,
		1,
		MAX_URI_BYTES,
		"hyperlink URI is empty or oversized",
	);
	validateTerminalText(
		hyperlink.params,
		0,
		MAX_EVENT_TEXT_BYTES,
		"hyperlink params are oversized",
	);
}

function validateRow(
	row: TerminalRow,
	columns: number,
	tables: TerminalTables,
	schemaMinor: number,
): void {
	validateTerminalRowBounds(row, columns, schemaMinor);
	let displayColumns = 0;
	for (const cell of row.cells) {
		const grapheme = tables.graphemes[cell.graphemeIndex];
		if (!grapheme) fail("cell grapheme index is invalid");
		if (!tables.styles[cell.styleIndex]) fail("cell style index is invalid");
		displayColumns += grapheme.displayWidth;
	}
	if (displayColumns > columns) fail("row display width exceeds the grid");
	if (schemaMinor >= 2 && displayColumns !== row.logicalCellSpan) {
		fail("logical cell span does not match row cells");
	}
}

function validateLogicalRowOrder(
	previous: TerminalRow,
	current: TerminalRow,
	schemaMinor: number,
): void {
	if (current.logicalLineId < previous.logicalLineId) {
		fail("logical line ids are out of order");
	}
	if (current.logicalLineId === previous.logicalLineId) {
		if (previous.termination !== RowTermination.SOFT_WRAP) {
			fail("logical line segments are out of order");
		}
		if (
			schemaMinor >= 2 &&
			current.logicalCellOffset !==
				previous.logicalCellOffset + previous.logicalCellSpan
		) {
			fail("logical line segments are not contiguous");
		}
		if (
			schemaMinor < 2 &&
			current.logicalCellOffset <= previous.logicalCellOffset
		) {
			fail("logical line segments are out of order");
		}
		return;
	}
	if (
		previous.termination === RowTermination.SOFT_WRAP ||
		current.logicalCellOffset !== 0 ||
		current.continuesFromPrevious
	) {
		fail("logical line boundary is inconsistent");
	}
}

export function validateTerminalUnicodeWidth(
	profile: UnicodeWidthProfile,
): void {
	validateTerminalText(
		profile.unicodeVersion,
		1,
		32,
		"Unicode width version is empty or oversized",
	);
	validateUint32(profile.ambiguousWidth, "ambiguous width is not a uint32");
	validateUint32(profile.emojiWidth, "emoji width is not a uint32");
	if (
		profile.ambiguousWidth < 1 ||
		profile.ambiguousWidth > 2 ||
		profile.emojiWidth < 1 ||
		profile.emojiWidth > 2
	) {
		fail("Unicode width values must be one or two cells");
	}
}

function fail(message: string): never {
	throw new TerminalStateProtocolError("invalid_record", message);
}
