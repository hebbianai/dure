/** The native scroll surface and the content layer that a deviation offsets. */
export interface GestureScrollSurface {
	readScrollOffset(): number;
	writeScrollOffset(offset: number): void;
	/** Shift the content so a deviation is visible without a scroll write. */
	showDeviation(deviation: number): void;
	/** A hidden surface keeps its deviation until it can be written. */
	isVisible(): boolean;
}

/** Trackpad momentum reports wheel and scroll events every frame; a gap this
 * long means the gesture and its momentum have ended. */
export const GESTURE_IDLE_MS = 160;

/**
 * Keeps scroll corrections out of a user's wheel or touch gesture.
 *
 * WebKit cancels trackpad momentum when script writes the scroll position, and
 * a write computed from the last scroll event discards whatever distance the
 * scrolling thread covered since. While a gesture is live, a requested logical
 * offset becomes a deviation: the content shifts by the difference and the
 * native position is left alone. When the gesture ends, one native write
 * applies the deviation in the same task that clears the shift, so the frame
 * that paints shows the same rows in the same place. Content above the shifted
 * layer cannot be reached natively, so reaching the top edge applies it early.
 *
 * Only wheel or touch input starts a gesture. Scrollbar, keyboard and script
 * scrolling keep writing directly.
 *
 * Logical offset = native offset + deviation.
 */
export function createGestureScrollDeviation(surface: GestureScrollSurface) {
	let deviation = 0;
	let gesture = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	// Native offset last reported to the caller. Corrections are relative to
	// it, so movement the user made since then is preserved.
	let eventOffset = 0;

	const setDeviation = (next: number) => {
		if (next === deviation) return;
		deviation = next;
		surface.showDeviation(next);
	};
	const write = (offset: number) => {
		setDeviation(0);
		surface.writeScrollOffset(offset);
		eventOffset = surface.readScrollOffset();
	};
	const stopTimer = () => {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	const end = () => {
		stopTimer();
		gesture = false;
		if (deviation !== 0 && surface.isVisible())
			write(surface.readScrollOffset() + deviation);
	};
	const extend = () => {
		stopTimer();
		idleTimer = setTimeout(end, GESTURE_IDLE_MS);
	};

	return {
		/** Wheel or touch input on the surface. */
		input() {
			gesture = true;
			extend();
		},
		/** A scroll position report. Returns the logical offset. */
		scrolled(nativeOffset: number, moving: boolean): number {
			eventOffset = nativeOffset;
			if (gesture && moving) {
				extend();
				if (
					deviation !== 0 &&
					(nativeOffset <= 0 || nativeOffset + deviation < 0)
				)
					write(nativeOffset + deviation);
			}
			return Math.max(0, eventOffset + deviation);
		},
		/** Requests a logical offset. */
		scrollTo(offset: number) {
			if (gesture) setDeviation(offset - eventOffset);
			else write(offset);
		},
		/** An explicit navigation ends the gesture before it writes. */
		release: end,
		offset(): number {
			return surface.readScrollOffset() + deviation;
		},
		dispose: stopTimer,
	};
}
