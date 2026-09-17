export interface TerminalViewportFillInput {
	containerHeight: number;
	gridHeight: number;
	blockInsets?: number;
	rows: number;
	tolerancePx?: number;
}

export interface TerminalViewportFillObservation {
	containerHeight: number;
	gridHeight: number;
	effectiveGridHeight: number;
	rowHeight: number | null;
	unfilledHeight: number;
	overflowHeight: number;
	fillsContainer: boolean;
}

/**
 * A fitted terminal may leave less than one partial cell below its integer row
 * grid. Anything larger is stale geometry, not harmless FitAddon rounding.
 */
export function terminalViewportFillObservation(
	input: TerminalViewportFillInput,
): TerminalViewportFillObservation {
	const containerHeight = Math.max(0, input.containerHeight);
	const gridHeight = Math.max(0, input.gridHeight);
	const effectiveGridHeight = gridHeight + Math.max(0, input.blockInsets ?? 0);
	const rowHeight =
		input.rows > 0 && gridHeight > 0 ? gridHeight / input.rows : null;
	const unfilledHeight = Math.max(0, containerHeight - effectiveGridHeight);
	const overflowHeight = Math.max(0, effectiveGridHeight - containerHeight);
	const tolerancePx = input.tolerancePx ?? 2;
	return {
		containerHeight,
		gridHeight,
		effectiveGridHeight,
		rowHeight,
		unfilledHeight,
		overflowHeight,
		fillsContainer:
			containerHeight > 0 &&
			rowHeight !== null &&
			overflowHeight <= tolerancePx &&
			unfilledHeight <= rowHeight + tolerancePx,
	};
}
