import { describe, expect, it, vi } from "vitest";
import { DurableRehydrationCoordinator } from "@/lib/persistence/durableRehydrationCoordinator";

describe("durable rehydration coordinator", () => {
	it("accepts an injected scheduler without owning its realm", async () => {
		const queued: VoidFunction[] = [];
		const schedule = vi.fn((operation: VoidFunction) => queued.push(operation));
		const rehydrate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const coordinator = new DurableRehydrationCoordinator(
			rehydrate,
			undefined,
			schedule,
		);

		coordinator.request();
		coordinator.request();
		expect(queued).toHaveLength(1);
		queued.shift()?.();

		await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledOnce());
		expect(schedule).toHaveBeenCalledOnce();
	});

	it("cancels work that was queued before disposal", async () => {
		const queued: VoidFunction[] = [];
		const rehydrate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const coordinator = new DurableRehydrationCoordinator(
			rehydrate,
			undefined,
			(operation) => queued.push(operation),
		);

		coordinator.request();
		coordinator.dispose();
		queued.shift()?.();
		await Promise.resolve();

		expect(rehydrate).not.toHaveBeenCalled();
	});

	it("coalesces queued events and runs one subsequent pass for an in-flight event", async () => {
		let releaseFirst: (() => void) | undefined;
		const rehydrate = vi
			.fn<() => Promise<void>>()
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						releaseFirst = resolve;
					}),
			)
			.mockResolvedValue(undefined);
		const coordinator = new DurableRehydrationCoordinator(rehydrate);

		coordinator.request();
		coordinator.request();
		await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledOnce());
		coordinator.request();
		coordinator.request();
		releaseFirst?.();

		await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(2));
	});

	it("reports a receiver projection failure once", async () => {
		const rehydrate = vi.fn().mockRejectedValue(new Error("projection failed"));
		const onError = vi.fn();
		const coordinator = new DurableRehydrationCoordinator(
			rehydrate,
			onError,
		);

		coordinator.request();

		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
		expect(rehydrate).toHaveBeenCalledOnce();
	});
});
