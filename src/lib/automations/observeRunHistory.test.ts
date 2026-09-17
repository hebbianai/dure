import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeRunHistory } from "./observeRunHistory";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
	return {
		list: vi.fn(async () => ["run-1"]),
		select: (runs: string[]) => runs[0],
		inspect: vi.fn(async (id: string) => ({ id })),
		onList: vi.fn(),
		onResult: vi.fn(),
		onError: vi.fn(),
		onLoading: vi.fn(),
	};
}

it("publishes an empty history without inspecting an invented run", async () => {
	const observer = fixture();
	observer.list.mockResolvedValue([]);
	const stop = observeRunHistory(observer);
	await vi.advanceTimersByTimeAsync(0);
	expect(observer.inspect).not.toHaveBeenCalled();
	expect(observer.onResult).toHaveBeenCalledWith([], undefined);
	stop();
	expect(vi.getTimerCount()).toBe(0);
});

it.each(["list", "inspect"] as const)(
	"recovers from %s failure on the same bounded read cadence",
	async (stage) => {
		const observer = fixture();
		const error = new Error("temporarily unavailable");
		observer[stage].mockRejectedValueOnce(error);
		const stop = observeRunHistory(observer);
		await vi.advanceTimersByTimeAsync(0);
		expect(observer.onError).toHaveBeenCalledWith(error);
		expect(observer.onResult).not.toHaveBeenCalled();
		expect(observer.onList).toHaveBeenCalledTimes(stage === "inspect" ? 1 : 0);
		expect(observer.onLoading.mock.calls).toEqual([[true], [false]]);
		await vi.advanceTimersByTimeAsync(4999);
		expect(observer.list).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(observer.onResult).toHaveBeenCalledWith(["run-1"], { id: "run-1" });
		stop();
		await vi.advanceTimersByTimeAsync(10000);
		expect(observer.list).toHaveBeenCalledTimes(2);
	},
);

it.each(["success", "failure"])(
	"does not publish or reschedule a retired inspection's %s",
	async (outcome) => {
		const observer = fixture();
		let resolve!: (value: { id: string }) => void;
		let reject!: (error: unknown) => void;
		observer.inspect.mockReturnValue(
			new Promise((yes, no) => {
				resolve = yes;
				reject = no;
			}),
		);
		const stop = observeRunHistory(observer);
		await vi.advanceTimersByTimeAsync(20000);
		expect(observer.list).toHaveBeenCalledOnce();
		expect(observer.inspect).toHaveBeenCalledOnce();
		stop();
		stop();
		if (outcome === "success") resolve({ id: "run-1" });
		else reject(new Error("retired"));
		await vi.advanceTimersByTimeAsync(20000);
		expect(observer.onResult).not.toHaveBeenCalled();
		expect(observer.onError).not.toHaveBeenCalled();
		expect(observer.onLoading.mock.calls).toEqual([[true]]);
		expect(observer.list).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	},
);
