import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameBudgetScheduler } from "@/lib/scheduling/frameBudgetScheduler";
import type { StructuredTerminalCarrierRecord } from "@/lib/terminal/structuredTerminalRecord";
import {
	inputReceiptRecord,
	viewportFrameRecord,
} from "@/test/terminalRecordFixtures";
import { runTerminalRecordDelivery } from "./terminalRecordDelivery";
import { decodeTerminalStateRecord } from "../protocol/terminalStateProtocol";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

function fixture() {
	let workMs = 0;
	const now = () => Date.now() + workMs;
	const scheduler = new FrameBudgetScheduler({
		now,
		requestFrame: (run) =>
			setTimeout(() => run(now()), 16) as unknown as number,
		cancelFrame: (handle) => clearTimeout(handle),
		setTimeout: (run, delay) => setTimeout(run, delay) as unknown as number,
		clearTimeout: (handle) => clearTimeout(handle),
	});
	const encodedFrame = viewportFrameRecord();
	const encodedReceipt = inputReceiptRecord(1n);
	const frame: StructuredTerminalCarrierRecord = {
		kind: "terminal",
		decoded: decodeTerminalStateRecord(encodedFrame),
		encodedByteLength: encodedFrame.byteLength,
	};
	const receipt: StructuredTerminalCarrierRecord = {
		kind: "terminal",
		decoded: decodeTerminalStateRecord(encodedReceipt),
		encodedByteLength: encodedReceipt.byteLength,
	};
	const terminal: StructuredTerminalCarrierRecord = {
		kind: "failure",
		reason: "end of fixture",
		encodedByteLength: 0,
	};
	return {
		scheduler,
		frame,
		receipt,
		terminal,
		spend: (ms: number) => {
			workMs += ms;
		},
	};
}

describe("ordered terminal delivery independent of painting", () => {
	it.each(["foreground", "hovered", "ungated"] as const)(
		"keeps %s input output off the background apply queue",
		async (role) => {
			const f = fixture();
			const records = [f.frame, f.receipt, f.terminal];
			const consume = vi.fn((record) => record !== f.terminal);
			await runTerminalRecordDelivery({
				read: async () => records.shift()!,
				consume,
				isCurrent: () => true,
				readRole: () => role,
				signal: new AbortController().signal,
				scheduler: f.scheduler,
			});
			expect(consume.mock.calls.map(([record]) => record)).toEqual([
				f.frame,
				f.receipt,
				f.terminal,
			]);
			expect(f.scheduler.hasPendingWork()).toBe(false);
			f.scheduler.dispose();
		},
	);

	it("ignores a read completed after its attachment was replaced", async () => {
		const f = fixture();
		let current = true;
		let complete!: (record: StructuredTerminalCarrierRecord) => void;
		const read = vi.fn(
			() =>
				new Promise<StructuredTerminalCarrierRecord>((resolve) => {
					complete = resolve;
				}),
		);
		const consume = vi.fn(() => true);
		const run = runTerminalRecordDelivery({
			read,
			consume,
			isCurrent: () => current,
			readRole: () => "background",
			signal: new AbortController().signal,
			scheduler: f.scheduler,
		});
		current = false;
		complete(f.frame);
		await run;
		expect(consume).not.toHaveBeenCalled();
		expect(read).toHaveBeenCalledOnce();
		expect(f.scheduler.hasPendingWork()).toBe(false);
		f.scheduler.dispose();
	});

	it.each([1, 6, 12])(
		"processes receipts for %i panes without admitting any background paint",
		async (count) => {
			const f = fixture();
			const paint = vi.fn();
			f.scheduler.schedule("catchup", paint, "background paint", {
				completion: "deferred",
			});
			const consumers = Array.from({ length: count }, () =>
				vi.fn((record) => record !== f.terminal),
			);
			const runs = consumers.map((consume) => {
				const records = [f.frame, f.receipt, f.terminal];
				return runTerminalRecordDelivery({
					read: async () => records.shift()!,
					consume,
					isCurrent: () => true,
					readRole: () => "background",
					signal: new AbortController().signal,
					scheduler: f.scheduler,
				});
			});
			await vi.advanceTimersByTimeAsync(16);
			await Promise.all(runs);
			expect(paint).not.toHaveBeenCalled();
			for (const consume of consumers)
				expect(consume.mock.calls.map(([record]) => record)).toEqual([
					f.frame,
					f.receipt,
					f.terminal,
				]);
			f.scheduler.dispose();
		},
	);

	it("shares the apply budget across panes instead of draining an unbounded reader", async () => {
		const f = fixture();
		let applied = 0;
		const reads = Array.from({ length: 12 }, () => {
			const records = [f.frame, f.terminal];
			return vi.fn(async () => records.shift()!);
		});
		const runs = reads.map((read) =>
			runTerminalRecordDelivery({
				read,
				consume: (record) => {
					if (record === f.terminal) return false;
					applied++;
					f.spend(4);
					return true;
				},
				isCurrent: () => true,
				readRole: () => "background",
				signal: new AbortController().signal,
				scheduler: f.scheduler,
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
		for (const read of reads) expect(read).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(16);
		expect(applied).toBe(3);
		expect(reads.filter((read) => read.mock.calls.length === 1)).toHaveLength(
			9,
		);
		await vi.advanceTimersByTimeAsync(48);
		await Promise.all(runs);
		expect(applied).toBe(12);
		f.scheduler.dispose();
	});

	it("cancels queued apply work on retirement without another read or commit", async () => {
		const f = fixture();
		const controller = new AbortController();
		const consume = vi.fn(() => true);
		const read = vi.fn(async () => f.frame);
		const run = runTerminalRecordDelivery({
			read,
			consume,
			isCurrent: () => true,
			readRole: () => "background",
			signal: controller.signal,
			scheduler: f.scheduler,
		});
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await run;
		await vi.advanceTimersByTimeAsync(300);
		expect(read).toHaveBeenCalledOnce();
		expect(consume).not.toHaveBeenCalled();
		expect(f.scheduler.hasPendingWork()).toBe(false);
		f.scheduler.dispose();
	});

	it("propagates apply failure and stops reading", async () => {
		const f = fixture();
		const read = vi.fn(async () => f.frame);
		const run = runTerminalRecordDelivery({
			read,
			consume: () => {
				throw new Error("apply failed");
			},
			isCurrent: () => true,
			readRole: () => "background",
			signal: new AbortController().signal,
			scheduler: f.scheduler,
		});
		const result = expect(run).rejects.toThrow("apply failed");
		await vi.advanceTimersByTimeAsync(16);
		await result;
		expect(read).toHaveBeenCalledOnce();
		f.scheduler.dispose();
	});
});
