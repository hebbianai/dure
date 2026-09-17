/**
 * The logo dot field: the Dure mark sampled onto a grid of small dots that
 * breathe slowly, with a ring pulse expanding from a random dot now and then.
 * It is the dure-website hero background (SOUL §3.1's dot motif on the mark),
 * ported for the moments the app has nothing to show yet.
 *
 * Everything here is arithmetic over plain arrays — no canvas, no DOM — so the
 * sampling, the shimmer, the pulse band and the show/fade policy are all
 * testable without a 2D context, which jsdom does not have.
 */

export interface LogoDot {
	readonly x: number;
	readonly y: number;
	/** Resting brightness, 0.5–1: the field is uneven on purpose. */
	readonly base: number;
	readonly phase: number;
	readonly speed: number;
}

export interface DotPulse {
	readonly x: number;
	readonly y: number;
	r: number;
}

/** The website's tuned constants, at its "mid" density. */
export const DOT_FIELD = {
	/** Backing raster the mark is drawn into and sampled from, in px. */
	size: 1200,
	/** Grid pitch; 14 keeps the dot count comfortable for a boot loop. */
	pitch: 14,
	/** Sample alpha below this is outside the mark. */
	alphaThreshold: 0.35,
	dotSize: 5.5,
	/** Peak shimmer alpha as a fraction of a dot's resting brightness. */
	shimmer: 0.15,
	pulseBand: 60,
	pulseBoost: 0.2,
	pulseMaxAlpha: 0.34,
	pulseGrow: 1.8,
	/** Ring radius growth per frame, px. */
	pulseSpeed: 4.2,
	pulseGapMs: { min: 1400, spread: 1200 },
} as const;

/**
 * Sample the mark onto a grid. `alphaAt` reads the rasterized mark's coverage
 * (0..1) at a raster coordinate; the caller owns whatever drew it.
 */
export function sampleDotField(
	alphaAt: (x: number, y: number) => number,
	size: number = DOT_FIELD.size,
	pitch: number = DOT_FIELD.pitch,
	random: () => number = Math.random,
): LogoDot[] {
	const dots: LogoDot[] = [];
	for (let y = pitch / 2; y < size; y += pitch) {
		for (let x = pitch / 2; x < size; x += pitch) {
			if (alphaAt(x, y) < DOT_FIELD.alphaThreshold) continue;
			dots.push({
				x,
				y,
				base: 0.5 + random() * 0.5,
				phase: random() * Math.PI * 2,
				speed: 0.6 + random() * 0.8,
			});
		}
	}
	return dots;
}

/**
 * Grow the live pulses one frame, drop the ones that have left the raster, and
 * seed a new one from a random dot when its time has come. Returns the next
 * spawn time so the caller carries no clock of its own.
 */
export function advancePulses(
	pulses: DotPulse[],
	dots: readonly LogoDot[],
	nowMs: number,
	nextPulseAtMs: number,
	size: number = DOT_FIELD.size,
	random: () => number = Math.random,
): number {
	let next = nextPulseAtMs;
	if (dots.length > 0 && nowMs >= nextPulseAtMs) {
		const origin = dots[Math.floor(random() * dots.length)];
		pulses.push({ x: origin.x, y: origin.y, r: 0 });
		next =
			nowMs + DOT_FIELD.pulseGapMs.min + random() * DOT_FIELD.pulseGapMs.spread;
	}
	for (const pulse of pulses) pulse.r += DOT_FIELD.pulseSpeed;
	while (pulses.length > 0 && pulses[0].r > size * 1.2) pulses.shift();
	return next;
}

export interface DotFrame {
	readonly alpha: Float32Array;
	readonly radius: Float32Array;
}

export function createDotFrame(count: number): DotFrame {
	return { alpha: new Float32Array(count), radius: new Float32Array(count) };
}

/**
 * One frame of the field: each dot's shimmer at time `t` (seconds), brightened
 * and enlarged where a pulse ring is passing. Writes into `out` so a 60 Hz loop
 * allocates nothing.
 */
export function dotFrame(
	dots: readonly LogoDot[],
	pulses: readonly DotPulse[],
	t: number,
	out: DotFrame,
): DotFrame {
	const { dotSize, shimmer, pulseBand, pulseBoost, pulseMaxAlpha, pulseGrow } =
		DOT_FIELD;
	for (let i = 0; i < dots.length; i += 1) {
		const dot = dots[i];
		let alpha =
			dot.base * shimmer * (0.55 + 0.45 * Math.sin(t * dot.speed + dot.phase));
		let size = dotSize;
		for (const pulse of pulses) {
			const band = Math.abs(
				Math.hypot(dot.x - pulse.x, dot.y - pulse.y) - pulse.r,
			);
			if (band >= pulseBand) continue;
			const k = 1 - band / pulseBand;
			alpha = Math.min(pulseMaxAlpha, alpha + k * pulseBoost);
			size = dotSize + k * pulseGrow;
		}
		out.alpha[i] = alpha;
		out.radius[i] = size / 2;
	}
	return out;
}

/** Only show the field if boot is actually taking a while; then leave softly. */
export const BOOT_SPLASH = { showDelayMs: 120, fadeMs: 240 } as const;

export type BootSplashPhase = "hidden" | "visible" | "fading" | "done";

/**
 * Where the splash is in its life, from times alone. A workspace that paints
 * inside the show delay never gets a splash at all — a flash of loading art is
 * worse than none. Under reduced motion the exit is a cut, not a fade.
 */
export function bootSplashPhase(input: {
	readonly startedAtMs: number;
	readonly paintedAtMs: number | null;
	readonly nowMs: number;
	readonly reducedMotion: boolean;
}): BootSplashPhase {
	const { startedAtMs, paintedAtMs, nowMs, reducedMotion } = input;
	if (paintedAtMs !== null) {
		const shownBeforePaint =
			paintedAtMs - startedAtMs >= BOOT_SPLASH.showDelayMs;
		if (!shownBeforePaint || reducedMotion) return "done";
		return nowMs - paintedAtMs < BOOT_SPLASH.fadeMs ? "fading" : "done";
	}
	return nowMs - startedAtMs < BOOT_SPLASH.showDelayMs ? "hidden" : "visible";
}
