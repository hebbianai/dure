import { describe, expect, it, vi } from "vitest";
import { WebviewEventRoutes } from "./webviewEventRoutes";

interface Envelope {
	route: string;
	value: string;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("WebviewEventRoutes", () => {
	it("shares one native subscription and releases exact local registrations", async () => {
		const pending = deferred<() => void>();
		let dispatch: ((envelope: Envelope) => void) | undefined;
		const subscribeNative = vi.fn((handler: (envelope: Envelope) => void) => {
			dispatch = handler;
			return pending.promise;
		});
		const routes = new WebviewEventRoutes(
			subscribeNative,
			(envelope: Envelope) => envelope.route,
			(envelope) => envelope.value,
		);
		const handler = vi.fn();

		const first = routes.subscribe("a", handler);
		const second = routes.subscribe("a", handler);
		expect(subscribeNative).toHaveBeenCalledTimes(1);

		const nativeUnlisten = vi.fn();
		pending.resolve(nativeUnlisten);
		const stopFirst = await first;
		const stopSecond = await second;
		dispatch?.({ route: "a", value: "both" });
		expect(handler).toHaveBeenCalledTimes(2);

		stopFirst();
		dispatch?.({ route: "a", value: "second" });
		expect(handler).toHaveBeenCalledTimes(3);
		stopSecond();
		dispatch?.({ route: "a", value: "retired" });
		expect(handler).toHaveBeenCalledTimes(3);
		expect(nativeUnlisten).not.toHaveBeenCalled();
	});

	it("allows a later explicit registration after native setup fails", async () => {
		const handlers: Array<(envelope: Envelope) => void> = [];
		const subscribeNative = vi
			.fn()
			.mockRejectedValueOnce(new Error("native listener refused"))
			.mockImplementationOnce((handler: (envelope: Envelope) => void) => {
				handlers.push(handler);
				return Promise.resolve(() => {});
			});
		const routes = new WebviewEventRoutes<Envelope, string>(
			subscribeNative,
			(envelope) => envelope.route,
			(envelope) => envelope.value,
		);

		await expect(routes.subscribe("failed", vi.fn())).rejects.toThrow(
			"native listener refused",
		);
		const recovered = vi.fn();
		await routes.subscribe("current", recovered);
		handlers[0]?.({ route: "failed", value: "stale" });
		handlers[0]?.({ route: "current", value: "live" });

		expect(subscribeNative).toHaveBeenCalledTimes(2);
		expect(recovered).toHaveBeenCalledWith("live");
		expect(recovered).toHaveBeenCalledTimes(1);
	});
});
