// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	liveResizeListener: undefined as
		| undefined
		| ((event: { payload: unknown }) => void),
	liveResizeStop: vi.fn(),
	isFullscreen: vi.fn(),
	nativeStop: vi.fn(),
	onResized: vi.fn(),
	observeCurrentWindowLiveResize: vi.fn(),
	setShellGlass: vi.fn(),
	setTrafficLightDrop: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		isFullscreen: native.isFullscreen,
		label: "main",
		onResized: native.onResized,
	}),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({
		listen: vi.fn(
			async (
				_eventName: string,
				listener: (event: { payload: unknown }) => void,
			) => {
				native.liveResizeListener = listener;
				return native.liveResizeStop;
			},
		),
	}),
}));
vi.mock("@/lib/ipc/system", () => ({
	observeCurrentWindowLiveResize: native.observeCurrentWindowLiveResize,
}));
vi.mock("@/lib/ipc", () => ({
	setShellGlass: native.setShellGlass,
	setTrafficLightDrop: native.setTrafficLightDrop,
}));
vi.mock("@/lib/workspace/desktop/desktopPlatform", () => ({
	isMacPlatform: () => true,
}));

import { subscribeCurrentWindowLiveResize } from "./currentWindowResize";
import { useWindowShellShape } from "./windowShellShape";
import { useNativeTrafficLightDrop } from "./windows";

const CURRENT_WINDOW_RESIZE_AUTHORITY_KEY =
	"__dureCurrentWindowResizeAuthorityV1";

describe("current window resize realm lifetime", () => {
	beforeEach(() => {
		delete (globalThis as unknown as Record<string, unknown>)[
			CURRENT_WINDOW_RESIZE_AUTHORITY_KEY
		];
		native.isFullscreen.mockReset().mockResolvedValue(false);
		native.liveResizeListener = undefined;
		native.liveResizeStop.mockReset();
		native.nativeStop.mockReset();
		native.onResized.mockReset().mockResolvedValue(native.nativeStop);
		native.observeCurrentWindowLiveResize.mockReset().mockResolvedValue(false);
		native.setShellGlass.mockReset().mockResolvedValue(undefined);
		native.setTrafficLightDrop.mockReset().mockResolvedValue(68);
	});

	it("does not seed a stale begin after an observed native end", async () => {
		let resolveAlreadyLive!: (value: boolean) => void;
		native.observeCurrentWindowLiveResize.mockReturnValue(
			new Promise((resolve) => {
				resolveAlreadyLive = resolve;
			}),
		);
		const phases: string[] = [];
		const subscription = subscribeCurrentWindowLiveResize((phase) =>
			phases.push(phase),
		);
		await vi.waitFor(() =>
			expect(native.liveResizeListener).toBeTypeOf("function"),
		);

		native.liveResizeListener?.({ payload: "end" });
		resolveAlreadyLive(true);
		const stop = await subscription;

		expect(phases).toEqual(["end"]);
		stop();
	});

	it("seeds an in-progress native drag after a WebView reload", async () => {
		native.observeCurrentWindowLiveResize.mockResolvedValue(true);
		const listener = vi.fn();

		const stop = await subscribeCurrentWindowLiveResize(listener);

		expect(listener).toHaveBeenCalledOnce();
		expect(listener).toHaveBeenCalledWith("begin");
		stop();
		expect(native.liveResizeStop).toHaveBeenCalledOnce();
	});

	it("retires the exact WebView listener when native installation fails", async () => {
		native.observeCurrentWindowLiveResize.mockRejectedValue(
			new Error("native window unavailable"),
		);

		await expect(subscribeCurrentWindowLiveResize(vi.fn())).rejects.toThrow(
			"native window unavailable",
		);
		expect(native.liveResizeStop).toHaveBeenCalledOnce();
	});

	it("shares one retained native resize source across both shell consumers", async () => {
		const shell = renderHook(() => useWindowShellShape());
		const trafficLights = renderHook(() => useNativeTrafficLightDrop(false));

		await waitFor(() => expect(native.isFullscreen).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(native.setTrafficLightDrop).toHaveBeenCalledOnce(),
		);
		expect.soft(native.onResized).toHaveBeenCalledTimes(1);

		shell.unmount();
		trafficLights.unmount();
		await Promise.resolve();
		expect.soft(native.nativeStop).not.toHaveBeenCalled();
	});
});
