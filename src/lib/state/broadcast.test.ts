import { describe, expect, it, vi } from "vitest";
import { createBroadcast, createValueStore } from "@/lib/state/broadcast";

describe("createBroadcast", () => {
	it("delivers payloads to subscribers until unsubscribe", () => {
		const bus = createBroadcast<string>();
		const seen: string[] = [];
		const stop = bus.subscribe((value) => seen.push(value));
		bus.publish("a");
		stop();
		bus.publish("b");
		expect(seen).toEqual(["a"]);
	});
});

describe("createValueStore", () => {
	it("notifies on change and skips Object.is-equal writes", () => {
		const store = createValueStore<string | null>(null);
		const listener = vi.fn();
		store.subscribe(listener);
		store.set("x");
		store.set("x");
		expect(store.get()).toBe("x");
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
