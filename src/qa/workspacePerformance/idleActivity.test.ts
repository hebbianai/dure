import { describe, expect, it } from "vitest";
import { installIdleActivityCounters } from "./idleActivity";

describe("idle activity counters", () => {
	it("counts invokes by command and store notifications until disposed", async () => {
		const calls: unknown[][] = [];
		const original = (command: string, ...rest: unknown[]) => {
			calls.push([command, ...rest]);
			return Promise.resolve(command);
		};
		const host = { invoke: original };
		const listeners = new Set<() => void>();
		const counters = installIdleActivityCounters(host, (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		});

		await expect(host.invoke("a", { x: 1 })).resolves.toBe("a");
		await host.invoke("a");
		await host.invoke("plugin:window|is_visible");
		for (const listener of listeners) listener();

		expect(counters.read()).toEqual({
			invokesByCommand: { a: 2, "plugin:window|is_visible": 1 },
			storeNotifications: 1,
		});
		expect(calls[0]).toEqual(["a", { x: 1 }]);

		counters.dispose();
		expect(host.invoke).toBe(original);
		expect(listeners.size).toBe(0);
	});

	it("still counts store notifications without a Tauri host", () => {
		let notify = () => {};
		const counters = installIdleActivityCounters(undefined, (listener) => {
			notify = listener;
			return () => {};
		});
		notify();
		expect(counters.read()).toEqual({
			invokesByCommand: {},
			storeNotifications: 1,
		});
	});
});
