import { describe, expect, it, vi } from "vitest";
import {
	CurrentWindowFocusAuthority,
	type CurrentWindowFocusBackend,
} from "./currentWindowFocus";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function setup(initialFocused = false) {
	let nativeListener: ((focused: boolean) => void) | undefined;
	const listenReady = deferred<() => void>();
	const readReady = deferred<boolean>();
	const backend: CurrentWindowFocusBackend = {
		listen: vi.fn((listener) => {
			nativeListener = listener;
			return listenReady.promise;
		}),
		read: vi.fn(() => readReady.promise),
	};
	const authority = new CurrentWindowFocusAuthority(initialFocused, backend);
	return {
		authority,
		backend,
		listenReady,
		readReady,
		native: (value: boolean) => nativeListener?.(value),
	};
}

describe("CurrentWindowFocusAuthority", () => {
	it("uses the native snapshot once the listener is installed", async () => {
		const { authority, listenReady, readReady } = setup(false);
		const changes: boolean[] = [];
		authority.subscribe((focused) => changes.push(focused));
		listenReady.resolve(vi.fn());
		await Promise.resolve();
		readReady.resolve(true);
		await Promise.resolve();
		expect(authority.current()).toBe(true);
		expect(changes).toEqual([false, true]);
	});

	it("does not let a stale snapshot overwrite a newer native event", async () => {
		const { authority, listenReady, readReady, native } = setup(false);
		authority.subscribe(() => {});
		listenReady.resolve(vi.fn());
		await Promise.resolve();
		native(true);
		readReady.resolve(false);
		await Promise.resolve();
		expect(authority.current()).toBe(true);
	});

	it("accepts DOM fallback before native authority and ignores it afterward", async () => {
		const { authority, listenReady, readReady } = setup(false);
		authority.subscribe(() => {});
		authority.updateFallback(true);
		expect(authority.current()).toBe(true);
		listenReady.resolve(vi.fn());
		await Promise.resolve();
		readReady.resolve(false);
		await Promise.resolve();
		authority.updateFallback(true);
		expect(authority.current()).toBe(false);
	});

	it("publishes input readiness when DOM focus follows an earlier native focus edge", () => {
		const { authority, native } = setup(false);
		const readiness: boolean[] = [];
		const claim = vi.fn();
		authority.subscribeInputReady((ready) => {
			readiness.push(ready);
			if (ready) claim();
		});

		native(true);
		expect(authority.current()).toBe(true);
		expect(readiness).toEqual([false]);

		authority.updateFallback(true);
		authority.updateFallback(true);
		expect(readiness).toEqual([false, true]);
		expect(claim).toHaveBeenCalledOnce();
	});

	it("keeps a blurred source window input-inactive until native and DOM focus return", () => {
		const { authority, native } = setup(true);
		const readiness: boolean[] = [];
		authority.subscribeInputReady((ready) => readiness.push(ready));

		native(false);
		authority.updateFallback(true);
		expect(readiness).toEqual([true, false]);

		authority.updateFallback(false);
		native(true);
		expect(readiness).toEqual([true, false]);

		authority.updateFallback(true);
		expect(readiness).toEqual([true, false, true]);
	});

	it("hands input readiness from a source WebView to a detached WebView and back", () => {
		const source = setup(true);
		const detached = setup(false);
		const sourceReadiness: boolean[] = [];
		const detachedReadiness: boolean[] = [];
		source.authority.subscribeInputReady((ready) =>
			sourceReadiness.push(ready),
		);
		detached.authority.subscribeInputReady((ready) =>
			detachedReadiness.push(ready),
		);

		source.native(false);
		detached.native(true);
		source.authority.updateFallback(true);
		expect(sourceReadiness).toEqual([true, false]);
		expect(detachedReadiness).toEqual([false]);

		detached.authority.updateFallback(true);
		detached.authority.updateFallback(true);
		expect(detachedReadiness).toEqual([false, true]);

		detached.native(false);
		source.authority.updateFallback(false);
		source.native(true);
		detached.authority.updateFallback(true);
		expect(sourceReadiness).toEqual([true, false]);
		expect(detachedReadiness).toEqual([false, true, false]);

		source.authority.updateFallback(true);
		source.authority.updateFallback(true);
		expect(sourceReadiness).toEqual([true, false, true]);
	});

	it("installs only one native listener for multiple consumers", () => {
		const { authority, backend } = setup();
		authority.subscribe(() => {});
		authority.subscribe(() => {});
		authority.subscribeInputReady(() => {});
		expect(backend.listen).toHaveBeenCalledTimes(1);
	});
});
