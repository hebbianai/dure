// How tall a capped list of rows stands so it ends on a row boundary instead
// of slicing its last visible row against the line below. Pure: the caller
// measures the rows and applies the height. The module imports no React.

/** Half a device pixel: a row whose bottom lands this close past the cap
 * still fits whole. */
const SUBPIXEL = 0.5;

/** The height for a list whose rows end at `rowBottoms` (from the list's
 * top, in order) under a `cap`: the bottom of the last row that fits whole.
 * Undefined when every row fits or there is no cap, so the list keeps its
 * natural height. A cap shorter than the first row keeps the cap, so the
 * list never collapses to nothing. */
export function rowSnappedHeight(
	rowBottoms: readonly number[],
	cap: number,
): number | undefined {
	const last = rowBottoms[rowBottoms.length - 1];
	if (!Number.isFinite(cap) || last === undefined || last <= cap + SUBPIXEL) {
		return undefined;
	}
	let fits: number | undefined;
	for (const bottom of rowBottoms) {
		if (bottom > cap + SUBPIXEL) break;
		fits = bottom;
	}
	return fits ?? cap;
}
