import { describe, expect, it, vi } from "vitest";
import { createDurableWindowCloseBarrier } from "@/lib/workspace/window/durableWindowClose";

describe("durable window close barrier", () => {
	it("does not close while the durable writer is still held", async () => {
		let releaseDurable: (() => void) | undefined;
		const durable = new Promise<void>((resolve) => {
			releaseDurable = resolve;
		});
		const close = vi.fn(async () => undefined);
		const preventDefault = vi.fn();
		const barrier = createDurableWindowCloseBarrier({
			settleDurableState: () => durable,
			close,
		});

		const closing = barrier.handle({ preventDefault });
		await Promise.resolve();

		expect(preventDefault).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
		releaseDurable?.();
		await closing;
		expect(close).toHaveBeenCalledOnce();
	});

	it("runs preparation before durability and coalesces repeated close requests", async () => {
		const order: string[] = [];
		let releasePreparation: (() => void) | undefined;
		const preparation = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const barrier = createDurableWindowCloseBarrier({
			prepare: async () => {
				order.push("prepare");
				await preparation;
			},
			settleDurableState: async () => {
				order.push("durable");
			},
			close: async () => {
				order.push("close");
			},
		});

		const first = barrier.handle({ preventDefault: vi.fn() });
		const second = barrier.handle({ preventDefault: vi.fn() });
		await Promise.resolve();
		expect(order).toEqual(["prepare"]);
		releasePreparation?.();
		await Promise.all([first, second]);
		expect(order).toEqual(["prepare", "durable", "close"]);
	});

	it("keeps the window open after a durability failure and closes on a second explicit request", async () => {
		const failure = new Error("durable write failed");
		const order: string[] = [];
		const barrier = createDurableWindowCloseBarrier({
			prepare: async () => {
				order.push("prepare");
			},
			settleDurableState: async () => {
				order.push("settle");
				throw failure;
			},
			close: async () => {
				order.push("close");
			},
			onFailure: (error) => {
				expect(error).toBe(failure);
				order.push("failure");
			},
		});

		await barrier.handle({ preventDefault: vi.fn() });
		expect(order).toEqual(["prepare", "settle", "failure"]);

		await barrier.handle({ preventDefault: vi.fn() });
		expect(order).toEqual([
			"prepare",
			"settle",
			"failure",
			"prepare",
			"settle",
			"close",
		]);
	});

	it("closes on a second explicit request after preparation keeps failing", async () => {
		const failure = new Error("preparation failed");
		const close = vi.fn(async () => undefined);
		const onFailure = vi.fn();
		const barrier = createDurableWindowCloseBarrier({
			prepare: async () => {
				throw failure;
			},
			settleDurableState: vi.fn(async () => undefined),
			close,
			onFailure,
		});

		await barrier.handle({ preventDefault: vi.fn() });
		expect(close).not.toHaveBeenCalled();
		expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);

		await barrier.handle({ preventDefault: vi.fn() });
		expect(close).toHaveBeenCalledOnce();
		expect(onFailure).toHaveBeenCalledOnce();
	});
});
