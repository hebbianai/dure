import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SETTINGS_PREFERENCES,
	type ScrollSpeed,
	saveSettingsPreferences,
} from "./settingsPreferences";
import { attachTerminalScroll } from "./terminalScroll";

/** A touch event the way WKWebView delivers one: bubbling, cancelable, with a finger. */
function touch(type: string, clientY: number): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "touches", {
		value: [{ identifier: 1, clientX: 100, clientY }],
		configurable: true,
	});
	return event;
}

describe("attachTerminalScroll", () => {
	let stage: HTMLElement;
	let scroller: HTMLElement;
	let stop: () => void;

	const seed = (scrollSpeed: ScrollSpeed): void => {
		saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, scrollSpeed });
		stop = attachTerminalScroll(scroller, {
			rowHeight: () => 20,
			scrollRows: () => {},
		});
	};

	beforeEach(() => {
		localStorage.clear();
		stage = document.createElement("div");
		scroller = document.createElement("div");
		stage.append(scroller);
		document.body.append(stage);
		Object.defineProperties(scroller, {
			clientHeight: { value: 400 },
			scrollHeight: { value: 1000 },
		});
		scroller.scrollTop = 100;
		stop = () => {};
	});

	afterEach(() => {
		stop();
		document.getSelection()?.removeAllRanges();
		stage.remove();
		localStorage.clear();
	});

	it("leaves successive native selection-handle moves to WebKit without scrolling the Host", () => {
		const scrollRows = vi.fn();
		stop = attachTerminalScroll(scroller, { rowHeight: () => 20, scrollRows });
		scroller.textContent = "선택할 터미널 텍스트";
		const range = document.createRange();
		range.selectNodeContents(scroller);
		document.getSelection()?.addRange(range);
		scroller.dispatchEvent(touch("touchstart", 100));
		for (const y of [150, 200, 250]) {
			const move = touch("touchmove", y);
			scroller.dispatchEvent(move);
			expect(move.defaultPrevented).toBe(false);
		}
		expect(scroller.scrollTop).toBe(100);
		expect(scrollRows).not.toHaveBeenCalled();
	});

	it("빠르게: a 20px drag moves the viewport by 32px", () => {
		seed("fast");
		scroller.dispatchEvent(touch("touchstart", 100));
		scroller.dispatchEvent(touch("touchmove", 80));
		expect(scroller.scrollTop).toBe(132);
	});

	it("느리게: the same drag moves the viewport by 12px", () => {
		seed("slow");
		scroller.dispatchEvent(touch("touchstart", 100));
		scroller.dispatchEvent(touch("touchmove", 80));
		expect(scroller.scrollTop).toBe(112);
	});

	it("보통: a 20px drag moves the viewport by 20px", () => {
		seed("normal");
		scroller.dispatchEvent(touch("touchstart", 100));
		scroller.dispatchEvent(touch("touchmove", 80));
		expect(scroller.scrollTop).toBe(120);
	});

	it("yields to a move a capture listener above it has cancelled, and measures the next one from there", () => {
		seed("fast");
		let cancel = true;
		stage.addEventListener(
			"touchmove",
			(event) => {
				if (cancel) event.preventDefault();
			},
			{ capture: true },
		);
		scroller.dispatchEvent(touch("touchstart", 100));
		scroller.dispatchEvent(touch("touchmove", 80));
		expect(scroller.scrollTop).toBe(100);
		// The finger is at 80 now; a move to 70 once nothing cancels is 10px, not 30.
		cancel = false;
		scroller.dispatchEvent(touch("touchmove", 70));
		expect(scroller.scrollTop).toBe(116);
	});

	it("stops listening once stopped", () => {
		seed("fast");
		stop();
		stop = () => {};
		scroller.dispatchEvent(touch("touchstart", 100));
		scroller.dispatchEvent(touch("touchmove", 80));
		expect(scroller.scrollTop).toBe(100);
	});

	it("consumes the local overflow before requesting history, retaining fractional rows", () => {
		const scrollRows = vi.fn();
		stop = attachTerminalScroll(scroller, { rowHeight: () => 20, scrollRows });
		scroller.scrollTop = 10;
		scroller.dispatchEvent(touch("touchstart", 100));
		scroller.dispatchEvent(touch("touchmove", 140));
		expect(scroller.scrollTop).toBe(0);
		expect(scrollRows.mock.calls).toEqual([[1, { identifier: 1, clientX: 100, clientY: 140 }]]);
		scroller.dispatchEvent(touch("touchmove", 150));
		expect(scrollRows.mock.calls.map(([rows]) => rows)).toEqual([1, 1]);
		scroller.dispatchEvent(touch("touchmove", 110));
		expect(scroller.scrollTop).toBe(40);
		expect(scrollRows).toHaveBeenCalledTimes(2);
	});

	it("returns toward newer Host rows after reaching the bottom of the visible grid", () => {
		const scrollRows = vi.fn();
		stop = attachTerminalScroll(scroller, { rowHeight: () => 20, scrollRows });
		scroller.scrollTop = 600;
		scroller.dispatchEvent(touch("touchstart", 200));
		scroller.dispatchEvent(touch("touchmove", 140));
		expect(scrollRows.mock.calls.map(([rows]) => rows)).toEqual([-3]);
	});

	it("leaves horizontal panning native and abandons a gesture when a second finger joins", () => {
		const scrollRows = vi.fn();
		stop = attachTerminalScroll(scroller, { rowHeight: () => 20, scrollRows });
		scroller.dispatchEvent(touch("touchstart", 100));
		const horizontal = touch("touchmove", 100);
		Object.defineProperty(horizontal, "touches", {
			value: [{ identifier: 1, clientX: 120, clientY: 100 }],
			configurable: true,
		});
		scroller.dispatchEvent(horizontal);
		expect(horizontal.defaultPrevented).toBe(false);
		const pinch = new Event("touchmove", { cancelable: true });
		Object.defineProperty(pinch, "touches", { value: [{}, {}] });
		scroller.dispatchEvent(pinch);
		scroller.dispatchEvent(touch("touchmove", 300));
		expect(pinch.defaultPrevented).toBe(false);
		expect(scroller.scrollTop).toBe(100);
		expect(scrollRows).not.toHaveBeenCalled();
	});
});
