// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	label: "win-session-agent-1",
	onTop: false,
	fullscreen: false,
	isAlwaysOnTop: vi.fn(),
	setAlwaysOnTop: vi.fn(),
	isFullscreen: vi.fn(),
	focusListeners: new Set<(focused: boolean) => void>(),
	resizeListeners: new Set<() => void>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		label: mocks.label,
		isAlwaysOnTop: mocks.isAlwaysOnTop,
		setAlwaysOnTop: mocks.setAlwaysOnTop,
		isFullscreen: mocks.isFullscreen,
	}),
}));
vi.mock("@/lib/workspace/window/currentWindowFocus", () => ({
	subscribeCurrentWindowFocus: (listener: (focused: boolean) => void) => {
		mocks.focusListeners.add(listener);
		listener(true);
		return () => mocks.focusListeners.delete(listener);
	},
}));
vi.mock("@/lib/workspace/window/currentWindowResize", () => ({
	subscribeCurrentWindowResize: (listener: () => void) => {
		mocks.resizeListeners.add(listener);
		return () => mocks.resizeListeners.delete(listener);
	},
}));
vi.mock("@/lib/ipc", () => ({
	nativeWindowCornerRadius: vi.fn(async () => null),
}));

import { WindowKeepOnTopToggle } from "@/components/workspace/WindowKeepOnTopToggle";
import { t } from "@/lib/i18n";
import { chromeDragIntent } from "@/lib/workspace/window/windowChromeDrag";
import {
	keepOnTopPreferred,
	rememberKeepOnTop,
} from "@/lib/workspace/window/windowKeepOnTop";

/** Lets the native reads and writes the hook started settle. */
async function settle() {
	await act(async () => {
		for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
	});
}

function toggle() {
	return screen.getByRole("button", { name: t("workspace.window.keepOnTop") });
}

async function focusChanged(focused: boolean) {
	for (const listener of [...mocks.focusListeners]) listener(focused);
	await settle();
}

beforeEach(() => {
	localStorage.clear();
	mocks.label = "win-session-agent-1";
	mocks.onTop = false;
	mocks.fullscreen = false;
	mocks.isAlwaysOnTop.mockReset().mockImplementation(async () => mocks.onTop);
	mocks.setAlwaysOnTop.mockReset().mockImplementation(async (next: boolean) => {
		mocks.onTop = next;
	});
	mocks.isFullscreen
		.mockReset()
		.mockImplementation(async () => mocks.fullscreen);
	mocks.focusListeners.clear();
	mocks.resizeListeners.clear();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("WindowKeepOnTopToggle", () => {
	it("shows the native level of the window", async () => {
		mocks.onTop = true;
		render(<WindowKeepOnTopToggle />);
		await settle();

		expect(toggle().getAttribute("aria-pressed")).toBe("true");
		expect(mocks.setAlwaysOnTop).not.toHaveBeenCalled();
	});

	it("keeps the window on top and remembers it for this window's label", async () => {
		render(<WindowKeepOnTopToggle />);
		await settle();
		expect(toggle().getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(toggle());
		await settle();

		expect(mocks.setAlwaysOnTop).toHaveBeenCalledWith(true);
		expect(toggle().getAttribute("aria-pressed")).toBe("true");
		expect(keepOnTopPreferred(localStorage, "win-session-agent-1")).toBe(true);
		expect(keepOnTopPreferred(localStorage, "win-session-agent-2")).toBe(false);

		fireEvent.click(toggle());
		await settle();

		expect(mocks.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
		expect(toggle().getAttribute("aria-pressed")).toBe("false");
		expect(keepOnTopPreferred(localStorage, "win-session-agent-1")).toBe(false);
	});

	it("puts a remembered window back on top when it opens at the normal level", async () => {
		rememberKeepOnTop(localStorage, "win-session-agent-1", true);
		render(<WindowKeepOnTopToggle />);
		await settle();

		expect(mocks.setAlwaysOnTop).toHaveBeenCalledExactlyOnceWith(true);
		expect(toggle().getAttribute("aria-pressed")).toBe("true");
	});

	it("leaves the toggle off and the choice unchanged when the request is refused", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.setAlwaysOnTop.mockRejectedValue(new Error("not permitted"));
		render(<WindowKeepOnTopToggle />);
		await settle();

		fireEvent.click(toggle());
		await settle();

		expect(toggle().getAttribute("aria-pressed")).toBe("false");
		expect(keepOnTopPreferred(localStorage, "win-session-agent-1")).toBe(false);
		expect(warn).toHaveBeenCalled();
	});

	it("shows a window manager that ignored the request once focus changes, keeping the choice", async () => {
		// The request resolves, but the window manager leaves the window at
		// the normal level and says nothing.
		mocks.setAlwaysOnTop.mockResolvedValue(undefined);
		render(<WindowKeepOnTopToggle />);
		await settle();

		fireEvent.click(toggle());
		await settle();
		expect(toggle().getAttribute("aria-pressed")).toBe("true");

		await focusChanged(false);

		expect(toggle().getAttribute("aria-pressed")).toBe("false");
		expect(keepOnTopPreferred(localStorage, "win-session-agent-1")).toBe(true);
		// The saved choice is applied once per mount, not on every focus.
		expect(mocks.setAlwaysOnTop).toHaveBeenCalledOnce();
	});

	it("does not let a read that started before a change overwrite it", async () => {
		let answerRead: (onTop: boolean) => void = () => {};
		render(<WindowKeepOnTopToggle />);
		await settle();
		mocks.isAlwaysOnTop.mockImplementationOnce(
			() => new Promise<boolean>((resolve) => (answerRead = resolve)),
		);
		await focusChanged(true);

		fireEvent.click(toggle());
		await settle();
		answerRead(false);
		await settle();

		expect(toggle().getAttribute("aria-pressed")).toBe("true");
	});

	it("steps aside while the window is in full screen", async () => {
		mocks.fullscreen = true;
		render(<WindowKeepOnTopToggle />);
		await settle();

		expect(
			screen.queryByRole("button", { name: t("workspace.window.keepOnTop") }),
		).toBeNull();

		mocks.fullscreen = false;
		await act(async () => {
			for (const listener of [...mocks.resizeListeners]) listener();
		});
		await settle();

		expect(toggle()).toBeTruthy();
	});

	it("does not start a window drag from a chrome strip", async () => {
		render(<WindowKeepOnTopToggle />);
		await settle();

		expect(
			chromeDragIntent({ button: 0, detail: 1, target: toggle() }),
		).toBeUndefined();
		expect(
			chromeDragIntent({
				button: 0,
				detail: 1,
				target: toggle().querySelector("svg"),
			}),
		).toBeUndefined();
	});
});
