const MAX_POINTER_WHEEL_ROWS = 64;

export function terminalPointerWheelRowDelta(input: {
	readonly deltaY: number;
	readonly deltaMode: number;
	readonly rowHeight: number;
	readonly viewportRows: number;
}): number {
	return input.deltaMode === WheelEvent.DOM_DELTA_LINE
		? input.deltaY
		: input.deltaMode === WheelEvent.DOM_DELTA_PAGE
			? input.deltaY * Math.max(1, input.viewportRows)
			: input.deltaY / Math.max(1, input.rowHeight);
}

export function terminalPointerWheelRows(rows: number): number {
	if (!Number.isFinite(rows) || rows === 0) return 0;
	const magnitude = Math.min(
		MAX_POINTER_WHEEL_ROWS,
		Math.max(1, Math.round(Math.abs(rows))),
	);
	return Math.sign(rows) * magnitude;
}
