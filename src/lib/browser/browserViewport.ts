export interface BrowserViewport {
	readonly width: number;
	readonly height: number;
	readonly scale: number;
}

/** Normalize a DOM measurement once into the existing viewport request's
 * dimensions. Lower capture density on large displays within its pixel budget. */
export function browserViewport(
	width: number,
	height: number,
	density: number,
): BrowserViewport | undefined {
	if (![width, height, density].every(Number.isFinite) || density <= 0)
		return undefined;
	width = Math.floor(width);
	height = Math.floor(height);
	if (width < 1 || height < 1 || width > 65_535 || height > 65_535)
		return undefined;
	let scale =
		Math.floor(
			Math.min(
				density,
				8,
				65_535 / width,
				65_535 / height,
				Math.sqrt(16_000_000 / (width * height)),
			) * 1024,
		) / 1024;
	// Capture allocates whole pixels, so fractional area alone is insufficient.
	while (Math.ceil(width * scale) * Math.ceil(height * scale) > 16_000_000)
		scale -= 1 / 1024;
	if (scale < 0.1) return undefined;
	return { width, height, scale };
}
