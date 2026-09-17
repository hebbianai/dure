import { describe, expect, it } from "vitest";
import {
	advancePulses,
	BOOT_SPLASH,
	bootSplashPhase,
	createDotFrame,
	DOT_FIELD,
	type DotPulse,
	dotFrame,
	type LogoDot,
	sampleDotField,
} from "@/lib/workspace/boot/logoDotField";

/** A deterministic stand-in for Math.random. */
const fixed = (value: number) => () => value;

describe("sampleDotField", () => {
	it("keeps only grid points inside the mark, at the grid pitch", () => {
		// A 100px raster whose left half is opaque.
		const alphaAt = (x: number) => (x < 50 ? 1 : 0);
		const dots = sampleDotField(alphaAt, 100, 10, fixed(0.5));
		expect(dots.length).toBe(5 * 10);
		expect(dots.every((d) => d.x < 50)).toBe(true);
		expect(dots[0]).toMatchObject({ x: 5, y: 5 });
		expect(dots[1]).toMatchObject({ x: 15, y: 5 });
	});

	it("treats faint coverage as outside the mark", () => {
		const dots = sampleDotField(() => DOT_FIELD.alphaThreshold - 0.01, 40, 10);
		expect(dots).toEqual([]);
	});

	it("gives every dot a resting brightness between a half and one", () => {
		const dim = sampleDotField(() => 1, 20, 10, fixed(0));
		const bright = sampleDotField(() => 1, 20, 10, fixed(0.999));
		expect(dim[0].base).toBe(0.5);
		expect(bright[0].base).toBeCloseTo(1, 2);
	});
});

describe("dotFrame", () => {
	const dot = (x: number, y: number): LogoDot => ({
		x,
		y,
		base: 1,
		phase: 0,
		speed: 1,
	});

	it("shimmers each dot within its resting envelope", () => {
		const dots = [dot(10, 10)];
		const out = createDotFrame(1);
		const alphas = [0, 0.5, 1, 1.5, 2.5, 4].map(
			(t) => dotFrame(dots, [], t, out).alpha[0],
		);
		for (const a of alphas) {
			expect(a).toBeGreaterThanOrEqual(DOT_FIELD.shimmer * 0.1 - 1e-9);
			expect(a).toBeLessThanOrEqual(DOT_FIELD.shimmer + 1e-9);
		}
		expect(new Set(alphas.map((a) => a.toFixed(4))).size).toBeGreaterThan(1);
	});

	it("brightens and enlarges only the dots a pulse ring is passing", () => {
		const onRing = dot(100, 0);
		const farAway = dot(900, 900);
		const pulse: DotPulse = { x: 0, y: 0, r: 100 };
		const out = dotFrame([onRing, farAway], [pulse], 0, createDotFrame(2));
		expect(out.alpha[0]).toBeGreaterThan(out.alpha[1]);
		expect(out.alpha[0]).toBeLessThanOrEqual(DOT_FIELD.pulseMaxAlpha);
		expect(out.radius[0]).toBeCloseTo(
			(DOT_FIELD.dotSize + DOT_FIELD.pulseGrow) / 2,
			6,
		);
		expect(out.radius[1]).toBeCloseTo(DOT_FIELD.dotSize / 2, 6);
	});

	it("caps a pulsed dot at the ring's maximum alpha", () => {
		// At the shimmer's peak (sin = 1) a ring adds enough to cross the cap.
		const peak = Math.PI / 2;
		const out = dotFrame(
			[dot(50, 0)],
			[{ x: 0, y: 0, r: 50 }],
			peak,
			createDotFrame(1),
		);
		// Float32Array storage: compare within float precision.
		expect(out.alpha[0]).toBeCloseTo(DOT_FIELD.pulseMaxAlpha, 6);
	});
});

describe("advancePulses", () => {
	const dots: LogoDot[] = [{ x: 30, y: 40, base: 1, phase: 0, speed: 1 }];

	it("spawns a ring from a dot once its time has come, and books the next", () => {
		const pulses: DotPulse[] = [];
		const next = advancePulses(pulses, dots, 1000, 1000, 1200, fixed(0));
		expect(pulses).toEqual([{ x: 30, y: 40, r: DOT_FIELD.pulseSpeed }]);
		expect(next).toBe(1000 + DOT_FIELD.pulseGapMs.min);
	});

	it("does nothing before its time except grow what is already ringing", () => {
		const pulses: DotPulse[] = [{ x: 0, y: 0, r: 10 }];
		const next = advancePulses(pulses, dots, 500, 1000);
		expect(pulses).toEqual([{ x: 0, y: 0, r: 10 + DOT_FIELD.pulseSpeed }]);
		expect(next).toBe(1000);
	});

	it("drops rings that have left the raster", () => {
		const pulses: DotPulse[] = [{ x: 0, y: 0, r: 1200 * 1.2 }];
		advancePulses(pulses, dots, 0, 10_000, 1200);
		expect(pulses).toEqual([]);
	});
});

describe("bootSplashPhase", () => {
	const base = { startedAtMs: 1000, reducedMotion: false };

	it("stays hidden while boot is still quick", () => {
		expect(bootSplashPhase({ ...base, paintedAtMs: null, nowMs: 1000 })).toBe(
			"hidden",
		);
		expect(
			bootSplashPhase({
				...base,
				paintedAtMs: null,
				nowMs: 1000 + BOOT_SPLASH.showDelayMs - 1,
			}),
		).toBe("hidden");
	});

	it("shows once boot has taken longer than the delay", () => {
		expect(
			bootSplashPhase({
				...base,
				paintedAtMs: null,
				nowMs: 1000 + BOOT_SPLASH.showDelayMs,
			}),
		).toBe("visible");
	});

	it("never appears when the workspace paints inside the delay", () => {
		expect(bootSplashPhase({ ...base, paintedAtMs: 1050, nowMs: 1051 })).toBe(
			"done",
		);
	});

	it("fades for a moment after a late paint, then is gone", () => {
		const paintedAtMs = 1000 + BOOT_SPLASH.showDelayMs + 500;
		expect(
			bootSplashPhase({ ...base, paintedAtMs, nowMs: paintedAtMs + 10 }),
		).toBe("fading");
		expect(
			bootSplashPhase({
				...base,
				paintedAtMs,
				nowMs: paintedAtMs + BOOT_SPLASH.fadeMs,
			}),
		).toBe("done");
	});

	it("cuts instead of fading under reduced motion", () => {
		const paintedAtMs = 1000 + BOOT_SPLASH.showDelayMs + 500;
		expect(
			bootSplashPhase({
				...base,
				reducedMotion: true,
				paintedAtMs,
				nowMs: paintedAtMs + 1,
			}),
		).toBe("done");
	});
});
