// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
	installWindowEventLoopLagMonitor,
	readWindowEventLoopLag,
	WindowEventLoopLagTracker,
} from "./windowEventLoopLag";

describe("window event-loop lag tracker", () => {
	it.each([
		{ ticks: [251, 500, 751, 1_000], expectedMaxMs: 1 },
		{ ticks: [250.5, 500, 750.5, 1_000], expectedMaxMs: 0.5 },
		{ ticks: [251, 500, 1_250, 1_500], expectedMaxMs: 500 },
	])("measures delivered intervals without skipping early ticks: $ticks", ({
		ticks,
		expectedMaxMs,
	}) => {
		const tracker = new WindowEventLoopLagTracker();
		const context = { visible: true, focused: true };
		tracker.begin(context, 0, 1_000);
		for (const now of ticks) tracker.sample(context, now, 1_000 + now);

		expect(tracker.snapshot()).toMatchObject({
			sampleCount: ticks.length,
			recentP95Ms: expectedMaxMs,
			recentMaxMs: expectedMaxMs,
			lastSampleAtMs: 1_000 + ticks[ticks.length - 1],
		});
	});

	it("keeps a bounded recent p95 and maximum", () => {
		const tracker = new WindowEventLoopLagTracker();
		tracker.begin({ visible: true, focused: true }, 0, 1_000);
		for (let delay = 0; delay < 70; delay += 1) {
			tracker.record(delay, 1_000 + delay);
		}

		expect(tracker.snapshot()).toEqual({
			visible: true,
			focused: true,
			contextChangedAtMs: 1_000,
			lastSampleAtMs: 1_069,
			sampleCount: 64,
			recentP95Ms: 66,
			recentMaxMs: 69,
		});
	});

	it("keeps inactive WebKit timer clamping outside a fresh foreground epoch", () => {
		let visible = true;
		let focused = true;
		let monotonicNowMs = 0;
		let intervalTick: (() => void) | undefined;
		vi.spyOn(performance, "now").mockImplementation(() => monotonicNowMs);
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
			visible ? "visible" : "hidden",
		);
		vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
		vi.spyOn(window, "setInterval").mockImplementation((handler) => {
			if (typeof handler !== "function") {
				throw new Error("expected an event-loop sampler callback");
			}
			intervalTick = handler;
			// jsdom 위에서도 `window.setInterval` 의 반환 타입은 Node 의
			// `Timeout` 으로 잡힌다. 이 시험이 쓰는 것은 핸들이 아니라 핸들러라,
			// 숫자를 그 타입으로 통과시킨다.
			return 17 as unknown as ReturnType<typeof window.setInterval>;
		});
		vi.spyOn(window, "clearInterval").mockImplementation(() => {});
		const timeOriginMs = performance.timeOrigin;
		const tick = () => {
			if (!intervalTick)
				throw new Error("event-loop sampler was not installed");
			intervalTick();
		};
		const uninstall = installWindowEventLoopLagMonitor();

		try {
			monotonicNowMs = 250;
			tick();
			monotonicNowMs = 1_000;
			focused = false;
			window.dispatchEvent(new Event("blur"));
			monotonicNowMs = 1_250;
			tick();

			expect(readWindowEventLoopLag()).toEqual({
				visible: true,
				focused: false,
				contextChangedAtMs: timeOriginMs + 1_000,
				lastSampleAtMs: timeOriginMs + 250,
				sampleCount: 1,
				recentP95Ms: 0,
				recentMaxMs: 0,
			});

			monotonicNowMs = 1_500;
			focused = true;
			window.dispatchEvent(new Event("focus"));
			expect(readWindowEventLoopLag()).toEqual({
				visible: true,
				focused: true,
				contextChangedAtMs: timeOriginMs + 1_500,
				lastSampleAtMs: null,
				sampleCount: 0,
				recentP95Ms: null,
				recentMaxMs: null,
			});

			monotonicNowMs = 2_250;
			tick();
			expect(readWindowEventLoopLag()).toEqual({
				visible: true,
				focused: true,
				contextChangedAtMs: timeOriginMs + 1_500,
				lastSampleAtMs: null,
				sampleCount: 0,
				recentP95Ms: null,
				recentMaxMs: null,
			});
			monotonicNowMs = 2_500;
			tick();
			expect(readWindowEventLoopLag()).toMatchObject({
				lastSampleAtMs: timeOriginMs + 2_500,
				sampleCount: 1,
				recentP95Ms: 0,
				recentMaxMs: 0,
			});

			monotonicNowMs = 2_750;
			visible = false;
			document.dispatchEvent(new Event("visibilitychange"));
			monotonicNowMs = 3_500;
			tick();
			expect(readWindowEventLoopLag()).toMatchObject({
				visible: false,
				focused: true,
				contextChangedAtMs: timeOriginMs + 2_750,
				lastSampleAtMs: timeOriginMs + 2_500,
				sampleCount: 1,
			});

			monotonicNowMs = 3_750;
			visible = true;
			document.dispatchEvent(new Event("visibilitychange"));
			expect(readWindowEventLoopLag()).toMatchObject({
				visible: true,
				focused: true,
				contextChangedAtMs: timeOriginMs + 3_750,
				lastSampleAtMs: null,
				sampleCount: 0,
			});
			monotonicNowMs = 4_500;
			tick();
			expect(readWindowEventLoopLag()).toMatchObject({
				lastSampleAtMs: null,
				sampleCount: 0,
			});
			monotonicNowMs = 4_750;
			tick();
			expect(readWindowEventLoopLag()).toMatchObject({
				lastSampleAtMs: timeOriginMs + 4_750,
				sampleCount: 1,
				recentMaxMs: 0,
			});
		} finally {
			uninstall();
			vi.restoreAllMocks();
		}
	});

	it("detects a missed focus transition before sampling its delayed callback", () => {
		let focused = true;
		let monotonicNowMs = 0;
		let intervalTick: (() => void) | undefined;
		vi.spyOn(performance, "now").mockImplementation(() => monotonicNowMs);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
		vi.spyOn(window, "setInterval").mockImplementation((handler) => {
			if (typeof handler !== "function") {
				throw new Error("expected an event-loop sampler callback");
			}
			intervalTick = handler;
			// jsdom 위에서도 `window.setInterval` 의 반환 타입은 Node 의
			// `Timeout` 으로 잡힌다. 이 시험이 쓰는 것은 핸들이 아니라 핸들러라,
			// 숫자를 그 타입으로 통과시킨다.
			return 18 as unknown as ReturnType<typeof window.setInterval>;
		});
		vi.spyOn(window, "clearInterval").mockImplementation(() => {});
		const timeOriginMs = performance.timeOrigin;
		const tick = () => {
			if (!intervalTick)
				throw new Error("event-loop sampler was not installed");
			intervalTick();
		};
		const uninstall = installWindowEventLoopLagMonitor();

		try {
			monotonicNowMs = 250;
			tick();
			focused = false;
			monotonicNowMs = 1_000;
			tick();
			expect(readWindowEventLoopLag()).toMatchObject({
				focused: false,
				contextChangedAtMs: timeOriginMs + 1_000,
				lastSampleAtMs: timeOriginMs + 250,
				sampleCount: 1,
				recentMaxMs: 0,
			});

			focused = true;
			monotonicNowMs = 1_500;
			tick();
			expect(readWindowEventLoopLag()).toMatchObject({
				focused: true,
				contextChangedAtMs: timeOriginMs + 1_500,
				lastSampleAtMs: null,
				sampleCount: 0,
			});

			monotonicNowMs = 1_750;
			tick();
			expect(readWindowEventLoopLag()).toMatchObject({
				lastSampleAtMs: timeOriginMs + 1_750,
				sampleCount: 1,
				recentMaxMs: 0,
			});
		} finally {
			uninstall();
			vi.restoreAllMocks();
		}
	});

	it("keeps stale cleanup behind the monitor installation it owns", () => {
		let nextTimer = 1;
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		vi.spyOn(window, "setInterval").mockImplementation(
			() => nextTimer++ as unknown as ReturnType<typeof window.setInterval>,
		);
		const clearInterval = vi
			.spyOn(window, "clearInterval")
			.mockImplementation(() => {});
		const stopFirst = installWindowEventLoopLagMonitor();
		let stopSecond = () => {};

		try {
			stopFirst();
			stopSecond = installWindowEventLoopLagMonitor();
			stopFirst();
			expect(clearInterval).toHaveBeenCalledTimes(1);
			stopSecond();
			expect(clearInterval).toHaveBeenNthCalledWith(2, 2);
		} finally {
			stopSecond();
			vi.restoreAllMocks();
		}
	});
});
