import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	MobileDeviceTarget,
	MobileFrame,
} from "@/lib/ipc/mobileSimulator";
import {
	MobileFrameObserver,
	mobileDeviceKey,
	mobileFramePoint,
	readMobileDeviceTarget,
} from "./preview";

const target = { platform: "ios", id: "device-a" } as const;
const frame: MobileFrame = {
	dataUrl: "data:image/png;base64,a",
	width: 390,
	height: 844,
};

function observe({
	capture,
	...options
}: Parameters<MobileFrameObserver["observe"]>[0] & {
	capture: (device: MobileDeviceTarget) => Promise<MobileFrame>;
}) {
	return new MobileFrameObserver(capture).observe(options);
}

afterEach(() => vi.useRealTimers());

describe("mobile simulator observation", () => {
	it("never overlaps captures and stops when the pane is hidden or disposed", async () => {
		vi.useFakeTimers();
		let resolve: (value: MobileFrame) => void = () => {};
		const capture = vi.fn(
			() =>
				new Promise<MobileFrame>((done) => {
					resolve = done;
				}),
		);
		const publish = vi.fn();
		const stop = observe({
			target,
			capture,
			publish,
			fail: vi.fn(),
			repeat: true,
		});
		await vi.advanceTimersByTimeAsync(6000);
		expect(capture).toHaveBeenCalledTimes(1);
		resolve(frame);
		await vi.advanceTimersByTimeAsync(1000);
		expect(capture).toHaveBeenCalledTimes(2);
		stop();
		resolve(frame);
		await vi.advanceTimersByTimeAsync(6000);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(capture).toHaveBeenCalledTimes(2);
	});
	it("does not deliver a previous device's late frame or failure", async () => {
		let resolve: (value: MobileFrame) => void = () => {};
		const publish = vi.fn();
		const stop = observe({
			target,
			capture: () =>
				new Promise((done) => {
					resolve = done;
				}),
			publish,
			fail: vi.fn(),
			repeat: false,
		});
		stop();
		resolve(frame);
		await Promise.resolve();
		expect(publish).not.toHaveBeenCalled();
		const fail = vi.fn();
		const stopError = observe({
			target,
			capture: () => Promise.reject("gone"),
			publish,
			fail,
			repeat: false,
		});
		stopError();
		await Promise.resolve();
		expect(fail).not.toHaveBeenCalled();
	});
	it("reports capture failure once and stops instead of retrying an absent device", async () => {
		vi.useFakeTimers();
		const fail = vi.fn();
		const capture = vi.fn().mockRejectedValue("device gone");
		const stop = observe({
			target,
			capture,
			publish: vi.fn(),
			fail,
			repeat: true,
		});
		await vi.advanceTimersByTimeAsync(10000);
		expect(fail).toHaveBeenCalledWith("device gone");
		expect(capture).toHaveBeenCalledTimes(1);
		stop();
	});
	it("keeps platform in saved identity and refuses incomplete persistence", () => {
		expect(mobileDeviceKey(target)).not.toBe(
			mobileDeviceKey({ ...target, platform: "android" }),
		);
		expect(readMobileDeviceTarget({ ...target, ignored: true })).toEqual(
			target,
		);
		for (const value of [
			null,
			"device-a",
			{ id: "x" },
			{ platform: "ios" },
			{ platform: "web", id: "x" },
		])
			expect(readMobileDeviceTarget(value)).toBeNull();
	});
	it("maps gestures relative to the displayed image and rejects outside touches", () => {
		const rect = { left: 50, top: 20, width: 200, height: 400 };
		expect(mobileFramePoint(rect, 150, 220)).toEqual({ x: 0.5, y: 0.5 });
		expect(mobileFramePoint(rect, 20, 220)).toBeNull();
		expect(mobileFramePoint({ ...rect, width: 0 }, 150, 220)).toBeNull();
	});
});

it("waits for an old native capture before reading a replacement selection", async () => {
	let resolve: (value: MobileFrame) => void = () => {};
	const capture = vi.fn(
		() =>
			new Promise<MobileFrame>((done) => {
				resolve = done;
			}),
	);
	const observer = new MobileFrameObserver(capture);
	const publish = vi.fn();
	const fail = vi.fn();
	const stop = observer.observe({ target, publish, fail, repeat: true });
	stop();
	const nextTarget = { platform: "android", id: "new-device" } as const;
	const stopNext = observer.observe({
		target: nextTarget,
		publish,
		fail,
		repeat: false,
	});
	expect(capture).toHaveBeenCalledTimes(1);
	resolve(frame);
	await Promise.resolve();
	expect(capture).toHaveBeenCalledTimes(2);
	expect(capture).toHaveBeenLastCalledWith(nextTarget);
	expect(publish).not.toHaveBeenCalled();
	stopNext();
	resolve(frame);
	await Promise.resolve();
});
