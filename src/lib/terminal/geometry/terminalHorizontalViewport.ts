/** A wider canonical terminal keeps its cell coordinates while the local
 * presentation scrolls over it. This never changes the Host's geometry. */
export function terminalHorizontalScrollLimit(
	viewportWidth: number,
	columns: number,
	cellWidth: number,
): number {
	return Math.max(0, columns * cellWidth - viewportWidth);
}

export function terminalCursorScrollLeft({
	scrollLeft,
	viewportWidth,
	columns,
	cellWidth,
	cursorColumn,
}: {
	readonly scrollLeft: number;
	readonly viewportWidth: number;
	readonly columns: number;
	readonly cellWidth: number;
	readonly cursorColumn: number;
}): number {
	const limit = terminalHorizontalScrollLimit(
		viewportWidth,
		columns,
		cellWidth,
	);
	const current = Math.max(0, Math.min(limit, scrollLeft));
	const left = cursorColumn * cellWidth;
	const right = left + cellWidth;
	if (left < current) return Math.max(0, left);
	if (right > current + viewportWidth)
		return Math.min(limit, Math.max(0, right - viewportWidth));
	return current;
}
