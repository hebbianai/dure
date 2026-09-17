import { describe, expect, it, vi } from "vitest";
import { createManagedAgentStopObservers } from "@/lib/sessions/managed/managedAgentStopObserver";

describe("managed Agent stop observers", () => {
	it.each(["exact", "chain"] as const)(
		"retries a rejected %s cleanup through its durable authority",
		async (kind) => {
			const firstFailure = new Error(`${kind} first failure`);
			const applyExact = vi.fn().mockResolvedValue(true);
			const applyChain = vi.fn().mockResolvedValue(true);
			const apply = kind === "exact" ? applyExact : applyChain;
			apply.mockRejectedValueOnce(firstFailure).mockResolvedValueOnce(true);
			const report = vi.fn();
			const observers = createManagedAgentStopObservers({
				applyExact,
				applyChain,
				report,
			});
			const payload = { kind };

			await expect(observers[kind](payload)).resolves.toBeUndefined();

			expect(apply).toHaveBeenCalledTimes(2);
			expect(apply).toHaveBeenNthCalledWith(1, payload);
			expect(apply).toHaveBeenNthCalledWith(2, payload);
			expect(report).toHaveBeenCalledWith(firstFailure);
		},
	);

	it("reports and consumes a final retry rejection", async () => {
		const firstFailure = new Error("first failure");
		const finalFailure = new Error("final failure");
		const applyExact = vi
			.fn()
			.mockRejectedValueOnce(firstFailure)
			.mockRejectedValueOnce(finalFailure);
		const report = vi.fn();
		const observers = createManagedAgentStopObservers({
			applyExact,
			applyChain: vi.fn().mockResolvedValue(true),
			report,
		});

		await expect(observers.exact({})).resolves.toBeUndefined();
		expect(report.mock.calls).toEqual([[firstFailure], [finalFailure]]);
	});
});
