import { afterEach, expect, it, vi } from "vitest";
import type { MobileFrame } from "@/lib/ipc/mobileSimulator";
import { MobileLiveObserver } from "./live";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
it("bounds frame conversion to one frame and releases the worker after conversion settles", async () => {
	vi.useFakeTimers();
	const converted = deferred<void>();
	const native = {
		liveStart: vi.fn().mockResolvedValue("lease"),
		liveStop: vi.fn().mockResolvedValue(undefined),
		liveFrame: vi
			.fn()
			.mockResolvedValue({ dataUrl: "frame", width: 10, height: 20 }),
	};
	const stop = new MobileLiveObserver(native).observe({
		target: { platform: "ios", id: "device" },
		publish: () => converted.promise,
		fail: vi.fn(),
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect(native.liveFrame).toHaveBeenCalledOnce();
	stop();
	converted.resolve();
	await vi.advanceTimersByTimeAsync(1000);
	expect(native.liveFrame).toHaveBeenCalledOnce();
	expect(native.liveStop).toHaveBeenCalledExactlyOnceWith("lease");
});
it("releases a late-starting worker before starting the newly selected device", async () => {
	const started = deferred<string>();
	const stopped = deferred<void>();
	const native = {
		liveStart: vi
			.fn()
			.mockReturnValueOnce(started.promise)
			.mockResolvedValue("second"),
		liveStop: vi
			.fn()
			.mockReturnValueOnce(stopped.promise)
			.mockResolvedValue(undefined),
		liveFrame: vi.fn().mockResolvedValue(null),
	};
	const observer = new MobileLiveObserver(native);
	const publish = vi.fn();
	const fail = vi.fn();
	const stop = observer.observe({
		target: { platform: "ios", id: "first" },
		publish,
		fail,
	});
	stop();
	const next = observer.observe({
		target: { platform: "ios", id: "second" },
		publish,
		fail,
	});
	started.resolve("first-lease");
	await vi.waitFor(() =>
		expect(native.liveStop).toHaveBeenCalledWith("first-lease"),
	);
	expect(native.liveStart).toHaveBeenCalledTimes(1);
	expect(native.liveFrame).not.toHaveBeenCalled();
	next();
	stopped.resolve();
	await Promise.resolve();
	expect(publish).not.toHaveBeenCalled();
	expect(fail).not.toHaveBeenCalled();
});
it("discards frames after hide and never reconnects a failed stream automatically", async () => {
	const frame = deferred<MobileFrame>();
	const native = {
		liveStart: vi.fn().mockResolvedValue("lease"),
		liveStop: vi.fn().mockResolvedValue(undefined),
		liveFrame: vi.fn().mockReturnValue(frame.promise),
	};
	const observer = new MobileLiveObserver(native);
	const publish = vi.fn();
	const fail = vi.fn();
	const observation = {
		target: { platform: "ios", id: "device" } as const,
		publish,
		fail,
	};
	const stop = observer.observe(observation);
	await vi.waitFor(() => expect(native.liveFrame).toHaveBeenCalledOnce());
	stop();
	frame.resolve({
		dataUrl: "data:image/jpeg;base64,YQ==",
		width: 10,
		height: 20,
	});
	await vi.waitFor(() => expect(native.liveStop).toHaveBeenCalledOnce());
	expect(publish).not.toHaveBeenCalled();
	native.liveFrame.mockRejectedValue(new Error("helper exited"));
	observer.observe(observation);
	await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
	expect(native.liveStart).toHaveBeenCalledTimes(2);
	expect(native.liveStop).toHaveBeenCalledTimes(2);
});
