// Cells on the painted viewport grid that an overlay marks: find matches, the
// link under the pointer. The Host's frame and the link detector both speak in
// viewport rows and columns; this turns them into pixel boxes once.

/** A run of cells on one viewport row. `endColumn` is exclusive. */
export interface TerminalCellSpan {
	readonly row: number;
	readonly startColumn: number;
	readonly endColumn: number;
}

export interface TerminalCellMetrics {
	readonly cellWidth: number;
	readonly rowHeight: number;
}

export interface TerminalCellBox {
	readonly key: string;
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

/** The pixel box a span covers at the painted metrics. */
export function terminalCellSpanBox(
	span: TerminalCellSpan,
	metrics: TerminalCellMetrics,
): TerminalCellBox {
	return {
		key: `${span.row}:${span.startColumn}`,
		left: span.startColumn * metrics.cellWidth,
		top: span.row * metrics.rowHeight,
		width: (span.endColumn - span.startColumn) * metrics.cellWidth,
		height: metrics.rowHeight,
	};
}
