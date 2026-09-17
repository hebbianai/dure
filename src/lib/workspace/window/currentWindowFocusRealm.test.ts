// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	focusHandlers: [] as Array<(event: { payload: boolean }) => void>,
	isFocused: vi.fn(),
	nativeStop: vi.fn(),
	onFocusChanged: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		isFocused: native.isFocused,
		onFocusChanged: native.onFocusChanged,
	}),
}));

const CURRENT_WINDOW_FOCUS_AUTHORITY_KEY =
	"__dureCurrentWindowFocusAuthorityV1";

describe("current window focus realm lifetime", () => {
	beforeEach(() => {
		delete (globalThis as unknown as Record<string, unknown>)[
			CURRENT_WINDOW_FOCUS_AUTHORITY_KEY
		];
		native.focusHandlers.length = 0;
		native.isFocused.mockReset().mockResolvedValue(false);
		native.nativeStop.mockReset();
		native.onFocusChanged.mockReset().mockImplementation((handler) => {
			native.focusHandlers.push(handler);
			return Promise.resolve(native.nativeStop);
		});
		vi.resetModules();
	});

	it("adopts one native source after same-realm module replacement", async () => {
		const beforeReload = await import("./currentWindowFocus");
		const oldListener = vi.fn();
		const stopOld = beforeReload.subscribeCurrentWindowFocus(oldListener);
		await vi.waitFor(() => expect(native.isFocused).toHaveBeenCalledOnce());

		vi.resetModules();
		const afterReload = await import("./currentWindowFocus");
		const replacementListener = vi.fn();
		const stopReplacement = afterReload.subscribeCurrentWindowFocus(
			replacementListener,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect.soft(native.onFocusChanged).toHaveBeenCalledTimes(1);
		stopOld();
		oldListener.mockClear();
		replacementListener.mockClear();
		native.focusHandlers[0]?.({ payload: true });

		expect.soft(oldListener).not.toHaveBeenCalled();
		expect.soft(replacementListener).toHaveBeenCalledWith(true);
		expect.soft(native.nativeStop).not.toHaveBeenCalled();
		stopReplacement();
	});
});
