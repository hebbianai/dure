import type { BrowserFrame } from "@/lib/browser/browserResourceContract";

/** Match a top-left, contained image without treating letterboxing as page
 * content. Physical density cancels out; CDP input uses viewport CSS pixels. */
export function browserFramePoint(
	frame: BrowserFrame,
	bounds: { left: number; top: number; width: number; height: number },
	clientX: number,
	clientY: number,
	allowOutside = false,
): { x: number; y: number } | undefined {
	const scale = Math.min(
		bounds.width / frame.viewport.width,
		bounds.height / frame.viewport.height,
	);
	if (!Number.isFinite(scale) || scale <= 0) return undefined;
	const x = (clientX - bounds.left) / scale;
	const y = (clientY - bounds.top) / scale;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
	if (
		!allowOutside &&
		(x < 0 || y < 0 || x >= frame.viewport.width || y >= frame.viewport.height)
	)
		return undefined;
	return { x, y };
}
