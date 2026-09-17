// The Dure loader: six dots on a circle, each stretching sideways in turn
// until the ring is full, then relaxing in the same order — the confirmed
// 12px handoff, variant D (design: dure-loader-12px-D, 2026-09-03). The
// container never rotates.
//
// Geometry is two ratios, not per-size tables: the orbit radius is 0.4167 of
// the box and the dot diameter 0.3920 of the radius (the handoff's own
// proportions). Rounded in that order they give 8: 3.33/1.31, 12: 5/1.96,
// 16: 6.67/2.61, 20: 8.33/3.27 — the handoff's variants to the hundredth,
// bar the 16px dot it listed as 2.62 — so another size is one number.
// Timing and the stretch factor live in the stylesheet (`.dure-loader` in
// components/ui/dure-loader.css).
const DURE_LOADER_ORBIT_RATIO = 0.4167;
const DURE_LOADER_DOT_RATIO = 0.392;
export const DURE_LOADER_DOT_COUNT = 6;

export interface DureLoaderGeometry {
	/** Box edge, px. */
	readonly size: number;
	/** Centre → dot centre, px. */
	readonly radius: number;
	/** Dot diameter, px. */
	readonly dot: number;
}

const roundToHundredth = (value: number) => Math.round(value * 100) / 100;

export function dureLoaderGeometry(size: number): DureLoaderGeometry {
	const radius = roundToHundredth(size * DURE_LOADER_ORBIT_RATIO);
	return {
		size,
		radius,
		dot: roundToHundredth(radius * DURE_LOADER_DOT_RATIO),
	};
}
