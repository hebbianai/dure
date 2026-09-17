import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	WebviewKeyboardFocusRecovery,
	type WebviewKeyboardFocusRecoveryBackend,
} from "./webviewKeyboardFocusRecovery";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function setup(initialDomFocus = false) {
	let domFocused = initialDomFocus;
	let nativeListener: ((focused: boolean) => void) | undefined;
	const setFocus = vi.fn<() => Promise<void>>().mockResolvedValue();
	const target = { setFocus };
	const backend: WebviewKeyboardFocusRecoveryBackend = {
		hasDomFocus: vi.fn(() => domFocused),
		loadTarget: vi.fn(async () => target),
		subscribeNativeFocus: vi.fn(async (listener) => {
			nativeListener = listener;
			return vi.fn();
		}),
	};
	const recovery = new WebviewKeyboardFocusRecovery(backend);
	return {
		backend,
		recovery,
		setDomFocus: (focused: boolean) => {
			domFocused = focused;
		},
		setFocus,
		emitNativeFocus: (focused: boolean) => nativeListener?.(focused),
	};
}

describe("WebviewKeyboardFocusRecovery", () => {
	beforeEach(() => vi.useFakeTimers());

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("does not overwrite an accepted first click when native activation arrives later", async () => {
		const harness = setup(false);
		harness.recovery.start();
		await vi.waitFor(() => expect(harness.setFocus).toHaveBeenCalledOnce());

		// This covers both a Space button click and an xterm textarea focus: DOM
		// owns the more specific interaction before native activation is emitted.
		harness.setDomFocus(true);
		harness.emitNativeFocus(true);
		await Promise.resolve();

		expect(harness.setFocus).toHaveBeenCalledOnce();
		harness.recovery.dispose();
	});

	it("cancels an in-flight startup claim when the first click wins DOM focus", async () => {
		const targetReady = deferred<{ setFocus(): Promise<void> }>();
		const harness = setup(false);
		harness.backend.loadTarget = vi.fn(() => targetReady.promise);
		harness.recovery.start();

		harness.setDomFocus(true);
		targetReady.resolve({ setFocus: harness.setFocus });
		await targetReady.promise;
		await Promise.resolve();

		expect(harness.setFocus).not.toHaveBeenCalled();
		harness.recovery.dispose();
	});

	it("coalesces concurrent native recovery requests", async () => {
		const targetReady = deferred<{ setFocus(): Promise<void> }>();
		const harness = setup(false);
		harness.backend.loadTarget = vi.fn(() => targetReady.promise);
		harness.recovery.start();
		await vi.waitFor(() =>
			expect(harness.backend.subscribeNativeFocus).toHaveBeenCalledOnce(),
		);

		harness.emitNativeFocus(true);
		harness.emitNativeFocus(true);
		expect(harness.backend.loadTarget).toHaveBeenCalledOnce();
		targetReady.resolve({ setFocus: harness.setFocus });
		await targetReady.promise;
		await Promise.resolve();

		expect(harness.setFocus).toHaveBeenCalledOnce();
		harness.recovery.dispose();
	});

	it("does not mutate focus after disposal", async () => {
		const targetReady = deferred<{ setFocus(): Promise<void> }>();
		const harness = setup(false);
		harness.backend.loadTarget = vi.fn(() => targetReady.promise);
		harness.recovery.start();
		harness.recovery.dispose();

		targetReady.resolve({ setFocus: harness.setFocus });
		await targetReady.promise;
		await Promise.resolve();

		expect(harness.setFocus).not.toHaveBeenCalled();
	});

	it("starts only one recovery lifecycle", async () => {
		const harness = setup(true);
		harness.recovery.start();
		harness.recovery.start();
		await Promise.resolve();

		expect(harness.backend.subscribeNativeFocus).toHaveBeenCalledOnce();
		harness.recovery.dispose();
	});
});
