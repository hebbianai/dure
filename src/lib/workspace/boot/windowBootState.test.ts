// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	markWindowContentPainted,
	WINDOW_CONTENT_PAINTED_EVENT,
	resetWindowBootForTest,
	subscribeWindowBoot,
	windowContentPainted,
} from "@/lib/workspace/boot/windowBootState";

afterEach(() => {
	resetWindowBootForTest();
});

describe("windowBootState", () => {
	it("starts unpainted and flips once, telling subscribers once", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeWindowBoot(listener);
		expect(windowContentPainted()).toBe(false);
		markWindowContentPainted();
		markWindowContentPainted();
		expect(windowContentPainted()).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("announces the paint on the document exactly once", () => {
		const heard = vi.fn();
		document.addEventListener(WINDOW_CONTENT_PAINTED_EVENT, heard);
		markWindowContentPainted();
		markWindowContentPainted();
		document.removeEventListener(WINDOW_CONTENT_PAINTED_EVENT, heard);
		expect(heard).toHaveBeenCalledTimes(1);
	});

	it("stops notifying after unsubscribe", () => {
		const listener = vi.fn();
		subscribeWindowBoot(listener)();
		markWindowContentPainted();
		expect(listener).not.toHaveBeenCalled();
	});
});
