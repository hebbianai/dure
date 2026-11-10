import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGestureScrollDeviation,
	GESTURE_IDLE_MS,
} from "@/lib/ui/gestureScrollDeviation";

function surface(initial = 1000, max = 5000) {
	const state = {
		native: initial,
		max,
		visible: true,
		writes: [] as number[],
		shown: 0,
	};
	const deviation = createGestureScrollDeviation({
		readScrollOffset: () => (state.visible ? state.native : 0),
		writeScrollOffset: (offset) => {
			state.writes.push(offset);
			state.native = Math.min(state.max, Math.max(0, offset));
		},
		showDeviation: (value) => {
			state.shown = value;
		},
		isVisible: () => state.visible,
	});
	// Wheel input moves the native position and reports a scroll event.
	const wheel = (offset: number) => {
		deviation.input();
		state.native = offset;
		return deviation.scrolled(offset, true);
	};
	return { state, deviation, wheel };
}

describe("createGestureScrollDeviation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes requested offsets directly without wheel or touch input", () => {
		const { state, deviation } = surface();
		deviation.scrollTo(1200);
		expect(state.writes).toEqual([1200]);
		// Script, scrollbar and keyboard scrolling do not start a gesture.
		state.native = 0;
		expect(deviation.scrolled(0, true)).toBe(0);
		deviation.scrollTo(300);
		expect(state.writes).toEqual([1200, 300]);
		expect(state.shown).toBe(0);
	});

	it("absorbs corrections during a gesture and applies them when it ends", () => {
		const { state, deviation, wheel } = surface();
		expect(wheel(980)).toBe(980);
		// A row above the viewport measured 300 px taller than its estimate.
		deviation.scrollTo(980 + 300);
		expect(state.writes).toEqual([]);
		expect(state.shown).toBe(300);
		// The user keeps moving; the correction travels with the gesture.
		expect(wheel(940)).toBe(1240);
		deviation.scrollTo(1240 - 40);
		expect(state.shown).toBe(260);
		expect(deviation.offset()).toBe(1200);

		vi.advanceTimersByTime(GESTURE_IDLE_MS - 1);
		expect(state.writes).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(state.writes).toEqual([1200]);
		expect(state.shown).toBe(0);
		expect(deviation.scrolled(1200, true)).toBe(1200);
		deviation.scrollTo(1250);
		expect(state.writes).toEqual([1200, 1250]);
	});

	it("keeps the gesture live through momentum scroll events", () => {
		const { state, deviation, wheel } = surface();
		wheel(990);
		deviation.scrollTo(990 + 50);
		for (let offset = 980; offset > 900; offset -= 10) {
			vi.advanceTimersByTime(GESTURE_IDLE_MS / 2);
			state.native = offset;
			deviation.scrolled(offset, true);
		}
		expect(state.writes).toEqual([]);
		// The idle report after the last movement does not extend the gesture.
		deviation.scrolled(910, false);
		vi.advanceTimersByTime(GESTURE_IDLE_MS);
		expect(state.writes).toEqual([960]);
	});

	it("keeps movement made after the last scroll event when absorbing", () => {
		const { state, deviation, wheel } = surface();
		wheel(900);
		// The scrolling thread has already moved on before the correction runs.
		state.native = 860;
		deviation.scrollTo(900 + 100);
		expect(state.shown).toBe(100);
		expect(deviation.offset()).toBe(960);
	});

	it("applies the deviation at the top edge so the first rows stay reachable", () => {
		const { state, deviation, wheel } = surface(300);
		wheel(250);
		deviation.scrollTo(250 + 200);
		expect(wheel(100)).toBe(300);
		expect(state.writes).toEqual([]);
		// Native scrolling stops at zero; the shifted rows above need the write.
		expect(wheel(0)).toBe(200);
		expect(state.writes).toEqual([200]);
		expect(state.shown).toBe(0);
		expect(wheel(150)).toBe(150);
	});

	it("never leaves a gap above the first row", () => {
		const { state, deviation, wheel } = surface(300);
		wheel(250);
		// Rows above measured shorter than estimated.
		deviation.scrollTo(250 - 200);
		expect(wheel(120)).toBe(0);
		expect(state.writes).toEqual([-80]);
		expect(state.native).toBe(0);
		expect(state.shown).toBe(0);
	});

	it("keeps the deviation while hidden and clears it on the next write", () => {
		const { state, deviation, wheel } = surface();
		wheel(950);
		deviation.scrollTo(1000);
		state.visible = false;
		vi.advanceTimersByTime(GESTURE_IDLE_MS);
		expect(state.writes).toEqual([]);
		expect(state.shown).toBe(50);
		state.visible = true;
		deviation.scrollTo(2000);
		expect(state.writes).toEqual([2000]);
		expect(state.shown).toBe(0);
	});

	it("ends the gesture for an explicit navigation", () => {
		const { state, deviation, wheel } = surface();
		wheel(950);
		deviation.scrollTo(1000);
		deviation.release();
		deviation.scrollTo(4000);
		expect(state.writes).toEqual([1000, 4000]);
		expect(state.shown).toBe(0);
	});

	it("stops its idle timer when disposed", () => {
		const { state, deviation, wheel } = surface();
		wheel(950);
		deviation.scrollTo(1000);
		deviation.dispose();
		vi.advanceTimersByTime(GESTURE_IDLE_MS * 2);
		expect(state.writes).toEqual([]);
	});
});
