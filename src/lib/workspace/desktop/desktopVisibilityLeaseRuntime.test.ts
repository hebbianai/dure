// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isMinimized: vi.fn(),
	isFocused: vi.fn(),
	isVisible: vi.fn(),
	nativeFocusStop: vi.fn(),
	onFocusChanged: vi.fn(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		isFocused: mocks.isFocused,
		isMinimized: mocks.isMinimized,
		isVisible: mocks.isVisible,
		onFocusChanged: mocks.onFocusChanged,
	}),
}));

import { readDesktopVisibilityLease } from "@/lib/workspace/desktop/desktopVisibilityLease";
import { installDesktopVisibilityLeasePublisher } from "@/lib/workspace/desktop/desktopVisibilityLeaseRuntime";
import { subscribeCurrentWindowFocus } from "@/lib/workspace/window/currentWindowFocus";
import { useStore } from "@/store";

const CURRENT_WINDOW_FOCUS_AUTHORITY_KEY =
	"__dureCurrentWindowFocusAuthorityV1";

beforeEach(() => {
	delete (globalThis as unknown as Record<string, unknown>)[
		CURRENT_WINDOW_FOCUS_AUTHORITY_KEY
	];
	localStorage.clear();
	mocks.isFocused.mockReset().mockResolvedValue(false);
	mocks.isMinimized.mockReset().mockResolvedValue(false);
	mocks.isVisible.mockReset().mockResolvedValue(true);
	mocks.nativeFocusStop.mockReset();
	mocks.onFocusChanged
		.mockReset()
		.mockResolvedValue(mocks.nativeFocusStop);
	useStore.setState({
		activeSpaceId: "desktop-1",
		spaces: [
			{ id: "desktop-1", name: "First" },
			{ id: "desktop-2", name: "Second" },
		],
	});
});

describe("desktop visibility lease publisher", () => {
	it("protects a newly selected desktop synchronously", async () => {
		const dispose = installDesktopVisibilityLeasePublisher();
		expect(readDesktopVisibilityLease("main")).toMatchObject({
			desktopId: "desktop-1",
			visible: true,
		});

		useStore.setState({ activeSpaceId: "desktop-2" });

		expect(readDesktopVisibilityLease("main")).toMatchObject({
			desktopId: "desktop-2",
			visible: true,
		});
		dispose();
		expect(readDesktopVisibilityLease("main")).toBeUndefined();
	});

	it("reports a minimized native window as off-screen", async () => {
		mocks.isMinimized.mockResolvedValue(true);
		const dispose = installDesktopVisibilityLeasePublisher();

		await vi.waitFor(() =>
			expect(readDesktopVisibilityLease("main")).toMatchObject({
				desktopId: "desktop-1",
				visible: false,
			}),
		);

		dispose();
	});

	it("shares the realm focus source with desktop visibility and only removes local clients", async () => {
		const stopFocus = subscribeCurrentWindowFocus(vi.fn());
		const disposeVisibility = installDesktopVisibilityLeasePublisher();

		await vi.waitFor(() => expect(mocks.isFocused).toHaveBeenCalledOnce());
		expect.soft(mocks.onFocusChanged).toHaveBeenCalledTimes(1);

		stopFocus();
		disposeVisibility();
		expect.soft(mocks.nativeFocusStop).not.toHaveBeenCalled();
	});
});
