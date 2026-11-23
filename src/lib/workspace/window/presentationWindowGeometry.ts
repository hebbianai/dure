/** Share of the display's work area a new presentation window covers. */
const PRESENTATION_WORK_AREA_SHARE = 0.9;
const FALLBACK_SIZE = { width: 1280, height: 860 } as const;

export const PRESENTATION_WINDOW_MIN_SIZE = {
	minWidth: 480,
	minHeight: 360,
} as const;

export interface PresentationMonitor {
	scaleFactor: number;
	workArea: {
		position: { x: number; y: number };
		size: { width: number; height: number };
	};
}

export type PresentationWindowGeometry =
	| { width: number; height: number; x: number; y: number }
	| { width: number; height: number; center: true };

/**
 * Logical frame for a new presentation window: most of the given display's
 * work area (physical pixels), centred on it. Without a usable display the
 * window keeps a large fixed size and the OS centres it.
 */
export function presentationWindowGeometry(
	monitor: PresentationMonitor | null | undefined,
): PresentationWindowGeometry {
	const scale = monitor?.scaleFactor;
	const area = monitor?.workArea;
	if (
		!area ||
		!scale ||
		!Number.isFinite(scale) ||
		scale <= 0 ||
		!(area.size.width > 0) ||
		!(area.size.height > 0)
	) {
		return { ...FALLBACK_SIZE, center: true };
	}
	const left = area.position.x / scale;
	const top = area.position.y / scale;
	const areaWidth = area.size.width / scale;
	const areaHeight = area.size.height / scale;
	const width = Math.round(
		Math.max(
			Math.min(PRESENTATION_WINDOW_MIN_SIZE.minWidth, areaWidth),
			areaWidth * PRESENTATION_WORK_AREA_SHARE,
		),
	);
	const height = Math.round(
		Math.max(
			Math.min(PRESENTATION_WINDOW_MIN_SIZE.minHeight, areaHeight),
			areaHeight * PRESENTATION_WORK_AREA_SHARE,
		),
	);
	return {
		width,
		height,
		x: Math.round(left + (areaWidth - width) / 2),
		y: Math.round(top + (areaHeight - height) / 2),
	};
}
