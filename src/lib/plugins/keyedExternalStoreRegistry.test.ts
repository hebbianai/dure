import { describe, expect, it, vi } from "vitest";
import {
	KeyedExternalStoreRegistry,
	type KeyedExternalStoreResource,
} from "@/lib/plugins/keyedExternalStoreRegistry";

interface TestResource extends KeyedExternalStoreResource<string> {
	id: number;
}

describe("KeyedExternalStoreRegistry", () => {
	it("shares keyed resources and disposes only after the last subscriber leaves", async () => {
		const registry = new KeyedExternalStoreRegistry<string, TestResource>(
			"empty",
		);
		const create = vi.fn((id: number) => ({
			id,
			snapshot: "loading",
		}));
		const start = vi.fn();
		const dispose = vi.fn();
		const first = vi.fn();
		const second = vi.fn();

		const unsubscribeFirst = registry.subscribe(
			"shared",
			1,
			first,
			create,
			start,
			dispose,
		);
		const unsubscribeSecond = registry.subscribe(
			"shared",
			2,
			second,
			create,
			start,
			dispose,
		);

		expect(create).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		const resource = registry.get("shared");
		if (!resource) throw new Error("shared resource was not created");
		registry.publish(resource, "ready");
		expect(registry.snapshot("shared")).toBe("ready");
		expect(first).toHaveBeenCalledTimes(2);
		expect(second).toHaveBeenCalledTimes(2);

		unsubscribeFirst();
		await Promise.resolve();
		expect(dispose).not.toHaveBeenCalled();
		unsubscribeSecond();
		expect(registry.get("shared")).toBe(resource);
		await Promise.resolve();
		expect(dispose).toHaveBeenCalledWith(resource);
		expect(resource?.active).toBe(false);
		expect(registry.snapshot("shared")).toBe("empty");
	});

	it("suspends at once, keeps the snapshot through the grace period, and resumes a returning subscriber", async () => {
		vi.useFakeTimers();
		try {
			const registry = new KeyedExternalStoreRegistry<string, TestResource>(
				"empty",
			);
			const create = vi.fn((id: number) => ({ id, snapshot: "loading" }));
			const start = vi.fn();
			const dispose = vi.fn();
			const suspend = vi.fn();
			const resume = vi.fn();
			const hooks = { graceMs: 1_000, resume, suspend };

			const unsubscribe = registry.subscribe(
				"shared",
				1,
				vi.fn(),
				create,
				start,
				dispose,
				hooks,
			);
			const resource = registry.get("shared");
			if (!resource) throw new Error("shared resource was not created");
			registry.publish(resource, "ready");

			unsubscribe();
			await vi.advanceTimersByTimeAsync(0);
			expect(suspend).toHaveBeenCalledWith(resource);
			expect(dispose).not.toHaveBeenCalled();
			expect(resource.active).toBe(true);
			expect(registry.snapshot("shared")).toBe("ready");

			await vi.advanceTimersByTimeAsync(500);
			const unsubscribeAgain = registry.subscribe(
				"shared",
				1,
				vi.fn(),
				create,
				start,
				dispose,
				hooks,
			);
			expect(create).toHaveBeenCalledTimes(1);
			expect(start).toHaveBeenCalledTimes(1);
			expect(resume).toHaveBeenCalledWith(resource);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(dispose).not.toHaveBeenCalled();

			unsubscribeAgain();
			await vi.advanceTimersByTimeAsync(0);
			expect(suspend).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(dispose).toHaveBeenCalledWith(resource);
			expect(resource.active).toBe(false);
			expect(registry.get("shared")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("disposes immediately without a grace period", async () => {
		const registry = new KeyedExternalStoreRegistry<string, TestResource>(
			"empty",
		);
		const dispose = vi.fn();
		const unsubscribe = registry.subscribe(
			"shared",
			1,
			vi.fn(),
			(id: number) => ({ id, snapshot: "loading" }),
			vi.fn(),
			dispose,
		);
		unsubscribe();
		await Promise.resolve();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("ignores absent inputs and protects a replacement from stale cleanup", async () => {
		const registry = new KeyedExternalStoreRegistry<string, TestResource>(
			"empty",
		);
		let nextId = 0;
		const create = () => ({
			id: ++nextId,
			snapshot: "loading",
		});
		const start = vi.fn();
		const dispose = vi.fn();
		const listener = vi.fn();

		expect(
			registry.subscribe(null, 1, listener, create, start, dispose),
		).toBeTypeOf("function");
		expect(listener).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();

		const unsubscribe = registry.subscribe(
			"same",
			1,
			listener,
			create,
			start,
			dispose,
		);
		const retired = registry.get("same");
		unsubscribe();
		registry.reset(dispose);
		const keepAlive = vi.fn();
		registry.subscribe("same", 2, keepAlive, create, start, dispose);
		const replacement = registry.get("same");
		await Promise.resolve();

		expect(retired?.active).toBe(false);
		expect(replacement?.id).not.toBe(retired?.id);
		expect(registry.get("same")).toBe(replacement);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledWith(retired);
	});
});
