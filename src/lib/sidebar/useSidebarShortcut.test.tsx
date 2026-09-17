// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ShortcutOverrides,
	setShortcutCaptureActive,
} from "@/lib/settings/shortcutBindings";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useSidebarShortcut } from "./useSidebarShortcut";

const settings = vi.hoisted(() => ({
	shortcutOverrides: {} as ShortcutOverrides,
	uiPrefs: { shortcutTerminalFirst: false },
}));
vi.mock("@/store", () => ({ useStore: { getState: () => settings } }));

function press(target: EventTarget = window, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", {
		key: "s",
		metaKey: true,
		bubbles: true,
		cancelable: true,
		...init,
	});
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

describe("sidebar shortcut", () => {
	beforeEach(() => {
		settings.shortcutOverrides = {};
		settings.uiPrefs.shortcutTerminalFirst = false;
		useWindowSidebarStore.setState({ open: true });
		setShortcutCaptureActive(false);
	});
	afterEach(() => {
		cleanup();
		setShortcutCaptureActive(false);
		document.body.replaceChildren();
	});

	it("closes and opens the sidebar, consumes the event, and ignores held-key repeats", () => {
		renderHook(useSidebarShortcut);
		expect(press().defaultPrevented).toBe(true);
		expect(useWindowSidebarStore.getState().open).toBe(false);
		press(window, { repeat: true });
		expect(useWindowSidebarStore.getState().open).toBe(false);
		press();
		expect(useWindowSidebarStore.getState().open).toBe(true);
	});

	it("respects capture, reassignment, unassignment, modifiers, and cleanup", () => {
		const { unmount } = renderHook(useSidebarShortcut);
		setShortcutCaptureActive(true);
		expect(press().defaultPrevented).toBe(false);
		setShortcutCaptureActive(false);
		expect(press(window, { shiftKey: true }).defaultPrevented).toBe(false);
		settings.shortcutOverrides = {
			"toggle-sidebar": { key: "b", mod: true, shift: false, alt: false },
		};
		expect(press().defaultPrevented).toBe(false);
		press(window, { key: "b" });
		expect(useWindowSidebarStore.getState().open).toBe(false);
		settings.shortcutOverrides = { "toggle-sidebar": null };
		expect(press(window, { key: "b" }).defaultPrevented).toBe(false);
		settings.shortcutOverrides = {};
		unmount();
		expect(press().defaultPrevented).toBe(false);
	});

	it("preserves editor save and terminal-first behavior, otherwise consumes terminal input", () => {
		renderHook(useSidebarShortcut);
		const container = document.createElement("div");
		const input = document.createElement("textarea");
		container.append(input);
		document.body.append(container);
		container.className = "cm-editor";
		expect(press(input).defaultPrevented).toBe(false);
		container.className = "xterm";
		input.focus();
		settings.uiPrefs.shortcutTerminalFirst = true;
		expect(press(input).defaultPrevented).toBe(false);
		settings.uiPrefs.shortcutTerminalFirst = false;
		const terminalInput = vi.fn();
		input.addEventListener("keydown", terminalInput);
		expect(press(input).defaultPrevented).toBe(true);
		expect(terminalInput).not.toHaveBeenCalled();
		expect(useWindowSidebarStore.getState().open).toBe(false);
	});
});
