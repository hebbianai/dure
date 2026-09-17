import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreatedSecondaryWindow,
	revealSecondaryWindow,
	lookupSecondaryWindow,
	SECONDARY_WINDOW_EVENT_TIMEOUT_MS,
	SECONDARY_WINDOW_LOOKUP_TIMEOUT_MS,
	SECONDARY_WINDOW_REVEAL_TIMEOUT_MS,
	waitForSecondaryWindowCreation,
} from "./secondaryWindowOperation";

afterEach(() => {
	vi.useRealTimers();
});

describe("secondary window operations", () => {
	it("recovers a missed created event through the stable label", async () => {
		vi.useFakeTimers();
		const unlisten = vi.fn();
		const window = {
			show: vi.fn(async () => {}),
			unminimize: vi.fn(async () => {}),
			setFocus: vi.fn(async () => {}),
			once: vi.fn(async () => unlisten),
		};
		const pending = waitForSecondaryWindowCreation(window, async () => window);
		await vi.advanceTimersByTimeAsync(SECONDARY_WINDOW_EVENT_TIMEOUT_MS);

		await expect(pending).resolves.toBe(window);
		expect(unlisten).toHaveBeenCalledTimes(2);
	});

	it("bounds a reveal callback that never settles", async () => {
		vi.useFakeTimers();
		const window = {
			show: vi.fn(() => new Promise<void>(() => {})),
			unminimize: vi.fn(async () => {}),
			setFocus: vi.fn(async () => {}),
		};
		const pending = expect(revealSecondaryWindow(window)).rejects.toThrow(
			"secondary window reveal timed out",
		);
		await vi.advanceTimersByTimeAsync(SECONDARY_WINDOW_REVEAL_TIMEOUT_MS);

		await pending;
		expect(window.unminimize).not.toHaveBeenCalled();
		expect(window.setFocus).not.toHaveBeenCalled();
	});

	it("bounds the initial stable-label lookup", async () => {
		vi.useFakeTimers();
		const pending = expect(
			lookupSecondaryWindow(() => new Promise(() => {})),
		).rejects.toThrow("secondary window lookup timed out");

		await vi.advanceTimersByTimeAsync(SECONDARY_WINDOW_LOOKUP_TIMEOUT_MS);
		await pending;
	});

	it("uses the remaining lookup deadline when a later poll stalls", async () => {
		vi.useFakeTimers();
		const find = vi
			.fn<() => Promise<CreatedSecondaryWindow | null>>()
			.mockResolvedValueOnce(null)
			.mockImplementationOnce(() => new Promise(() => {}));
		const window = {
			show: vi.fn(async () => {}),
			unminimize: vi.fn(async () => {}),
			setFocus: vi.fn(async () => {}),
			once: vi.fn(async () => () => {}),
		};
		const pending = expect(
			waitForSecondaryWindowCreation(window, find),
		).rejects.toThrow("secondary window lookup timed out");

		await vi.advanceTimersByTimeAsync(
			SECONDARY_WINDOW_EVENT_TIMEOUT_MS +
				SECONDARY_WINDOW_LOOKUP_TIMEOUT_MS,
		);
		await pending;
	});
});
