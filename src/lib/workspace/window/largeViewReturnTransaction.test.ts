import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LargeViewReturnSourceTransaction,
	LargeViewSurfaceRetirementDrain,
} from "./largeViewReturnTransaction";

function createTransaction(failOpenMs = 500) {
	const visibility = { conceal: vi.fn(), reveal: vi.fn() };
	const transaction = new LargeViewReturnSourceTransaction(
		visibility,
		{
			setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimer: (timer) => clearTimeout(timer),
		},
		failOpenMs,
	);
	return { transaction, visibility };
}

describe("LargeViewReturnSourceTransaction", () => {
	afterEach(() => vi.useRealTimers());

	it("conceals once and reveals only for the active generation", () => {
		const { transaction, visibility } = createTransaction();

		expect(transaction.prepare("return-1")).toBe(true);
		expect(transaction.prepare("return-1")).toBe(true);
		expect(transaction.currentGeneration()).toBe("return-1");
		expect(visibility.conceal).toHaveBeenCalledOnce();

		expect(transaction.complete("return-1")).toBe(true);
		expect(visibility.reveal).toHaveBeenCalledOnce();
	});

	it("does not let an old resize receipt reveal a newer return", () => {
		const { transaction, visibility } = createTransaction();
		transaction.prepare("return-1");
		transaction.prepare("return-2");

		expect(transaction.complete("return-1")).toBe(false);
		expect(visibility.reveal).not.toHaveBeenCalled();
		expect(transaction.complete("return-2")).toBe(true);
		expect(visibility.reveal).toHaveBeenCalledOnce();
	});

	it("fails open when the large surface retirement never arrives", async () => {
		vi.useFakeTimers();
		const { transaction, visibility } = createTransaction(500);
		transaction.prepare("return-1");

		await vi.advanceTimersByTimeAsync(499);
		expect(visibility.reveal).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(visibility.reveal).toHaveBeenCalledOnce();
		expect(transaction.currentGeneration()).toBeUndefined();
	});
});

describe("LargeViewSurfaceRetirementDrain", () => {
	it("retains a predecessor failure after a replacement retires", async () => {
		const drain = new LargeViewSurfaceRetirementDrain();
		const predecessorFailure = new Error("predecessor detach failed");

		drain.report(Promise.reject(predecessorFailure));
		drain.report(Promise.resolve());

		await expect(drain.wait()).rejects.toBe(predecessorFailure);
	});
});
