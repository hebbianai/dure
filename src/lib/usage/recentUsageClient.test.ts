import { describe, expect, it, vi } from "vitest";
import { createRecentUsageClient } from "./recentUsageClient";

describe("recent usage client", () => {
	it("manual refresh bypasses a fresh cache and ordinary readers join it", async () => {
		const initial = { fiveHours: 1, twentyFourHours: 2, telemetry: null };
		const updated = { fiveHours: 3, twentyFourHours: 4, telemetry: null };
		let finish!: (value: typeof initial) => void;
		const load = vi
			.fn()
			.mockResolvedValueOnce(initial)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
		const client = createRecentUsageClient<number>(load);
		await expect(client.get(5)).resolves.toBe(1);
		const manual = client.refresh("codex");
		const duplicate = client.refresh("codex");
		const reader = client.get(24);
		expect(load).toHaveBeenCalledTimes(2);
		expect(load).toHaveBeenLastCalledWith("codex");
		finish(updated);
		await expect(manual).resolves.toEqual(updated);
		await expect(duplicate).resolves.toEqual(updated);
		await expect(reader).resolves.toBe(4);
		await expect(client.get(5)).resolves.toBe(3);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("waits for an ordinary read before making the requested provider refresh", async () => {
		const initial = { fiveHours: 1, twentyFourHours: 2, telemetry: null };
		const updated = { fiveHours: 3, twentyFourHours: 4, telemetry: null };
		let finish!: (value: typeof initial) => void;
		const load = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			)
			.mockResolvedValue(updated);
		const client = createRecentUsageClient<number>(load);
		const read = client.get(5);
		const manual = client.refresh("claude");
		const duplicate = client.refresh("claude");
		expect(load).toHaveBeenCalledTimes(1);
		finish(initial);
		await expect(read).resolves.toBe(1);
		await expect(manual).resolves.toEqual(updated);
		await expect(duplicate).resolves.toEqual(updated);
		expect(load).toHaveBeenCalledTimes(2);
		expect(load).toHaveBeenLastCalledWith("claude");
	});

	it("retains cached readings after failure and permits another manual attempt", async () => {
		const initial = { fiveHours: 1, twentyFourHours: 2, telemetry: null };
		const updated = { fiveHours: 3, twentyFourHours: 4, telemetry: null };
		const load = vi
			.fn()
			.mockResolvedValueOnce(initial)
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(updated);
		const client = createRecentUsageClient<number>(load);
		await client.get(5);
		await expect(client.refresh("codex")).rejects.toThrow("offline");
		await expect(client.get(5)).resolves.toBe(1);
		await expect(client.refresh("codex")).resolves.toEqual(updated);
		expect(load).toHaveBeenCalledTimes(3);
	});

	it("coalesces 5h and 24h consumers into one backend snapshot", async () => {
		let resolve!: (value: {
			fiveHours: string;
			twentyFourHours: string;
			telemetry: null;
		}) => void;
		const load = vi.fn(
			() =>
				new Promise<{
					fiveHours: string;
					twentyFourHours: string;
					telemetry: null;
				}>((done) => {
					resolve = done;
				}),
		);
		const client = createRecentUsageClient(load);

		const five = client.get(5);
		const day = client.get(24);
		expect(load).toHaveBeenCalledTimes(1);
		resolve({ fiveHours: "five", twentyFourHours: "day", telemetry: null });
		await expect(five).resolves.toBe("five");
		await expect(day).resolves.toBe("day");
	});

	it("does not overlap a slow refresh after the freshness window", async () => {
		let now = 0;
		const pending: Array<
			(value: {
				fiveHours: number;
				twentyFourHours: number;
				telemetry: null;
			}) => void
		> = [];
		const load = vi.fn(
			() =>
				new Promise<{
					fiveHours: number;
					twentyFourHours: number;
					telemetry: null;
				}>((resolve) => pending.push(resolve)),
		);
		const client = createRecentUsageClient(load, {
			freshForMs: 100,
			now: () => now,
		});

		const first = client.get(5);
		pending.shift()?.({ fiveHours: 1, twentyFourHours: 2, telemetry: null });
		await first;
		now = 101;
		const refresh = client.get(5);
		const joined = client.get(24);
		expect(load).toHaveBeenCalledTimes(2);
		pending.shift()?.({ fiveHours: 3, twentyFourHours: 4, telemetry: null });
		await expect(refresh).resolves.toBe(3);
		await expect(joined).resolves.toBe(4);
	});
});
