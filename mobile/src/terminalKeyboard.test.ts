import { afterEach, describe, expect, it, vi } from "vitest";
import { attachTerminalKeyboard } from "./terminalKeyboard";
import { PAD_TEXT } from "./spaceTrackpad";

let stop: (() => void) | undefined;
afterEach(() => {
	stop?.();
	document.body.replaceChildren();
});
function keyboard() {
	const field = document.createElement("textarea");
	document.body.append(field);
	const actions = {
		text: vi.fn(),
		key: vi.fn(),
		paste: vi.fn(),
		trackpad: { press: vi.fn(), direction: vi.fn() },
	};
	const input = attachTerminalKeyboard(field, actions);
	stop = input.dispose;
	field.focus();
	return { field, actions, input };
}
function insert(field: HTMLTextAreaElement, text: string) {
	field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
	field.dispatchEvent(
		new InputEvent("input", {
			bubbles: true,
			inputType: "insertText",
			data: text,
		}),
	);
}

describe("native terminal keyboard context", () => {
	it("ignores iOS unidentified keydowns and sends committed composition once", () => {
		const { field, actions } = keyboard();
		field.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229 }),
		);
		field.dispatchEvent(new CompositionEvent("compositionstart"));
		insert(field, "한");
		expect(actions.text).not.toHaveBeenCalled();
		field.dispatchEvent(new CompositionEvent("compositionend", { data: "한" }));
		field.dispatchEvent(
			new InputEvent("input", {
				inputType: "insertFromComposition",
				data: "한",
			}),
		);
		expect(actions.text.mock.calls).toEqual([["한"]]);
		expect(actions.key).not.toHaveBeenCalled();
	});
	it("starts a fresh keyboard context after a tray action without erasing prior remote input", () => {
		const { field, actions, input } = keyboard();
		insert(field, "한");
		input.finish();
		expect(field.value).toBe(PAD_TEXT);
		insert(field, "글");
		expect(actions.text.mock.calls).toEqual([["한"], ["글"]]);
		expect(actions.key).not.toHaveBeenCalled();
	});
	it("preserves space-bar cursor dragging after typed text", () => {
		const { field, actions } = keyboard();
		insert(field, "한글");
		field.setSelectionRange(field.selectionStart + 1, field.selectionStart + 1);
		document.dispatchEvent(new Event("selectionchange"));
		expect(actions.trackpad.press).toHaveBeenCalledWith("right");
		expect(field.value).toBe(PAD_TEXT);
		insert(field, "a");
		expect(actions.text.mock.calls).toEqual([["한글"], ["a"]]);
		expect(actions.key).not.toHaveBeenCalled();
	});
	it.each([[25], [15, 21]])(
		"does not erase sent text when the trackpad repositions the native caret through %j cells",
		(...moves) => {
			const { field, actions } = keyboard();
			insert(field, "한글");
			for (const cells of moves) {
				const at = field.selectionStart + cells;
				field.setSelectionRange(at, at);
				document.dispatchEvent(new Event("selectionchange"));
			}
			insert(field, "a");
			expect(actions.text.mock.calls).toEqual([["한글"], ["a"]]);
			expect(actions.key).not.toHaveBeenCalled();
		},
	);
	it("sends virtual Return once when the keyboard supplies beforeinput without keydown", () => {
		const { field, actions } = keyboard();
		insert(field, "한글");
		const event = new InputEvent("beforeinput", {
			inputType: "insertLineBreak",
			cancelable: true,
		});
		field.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(actions.key.mock.calls).toEqual([
			[expect.objectContaining({ key: "Enter" })],
		]);
		expect(field.value).toBe(PAD_TEXT);
	});
	it("lets native Return end Korean input before forwarding the line break once", () => {
		const { field, actions } = keyboard();
		insert(field, "한글");
		const down = new KeyboardEvent("keydown", {
			key: "Enter",
			code: "Enter",
			cancelable: true,
		});
		field.dispatchEvent(down);
		expect(down.defaultPrevented).toBe(false);
		expect(actions.key).not.toHaveBeenCalled();
		expect(field.value).toContain("한글");
		field.dispatchEvent(
			new InputEvent("beforeinput", {
				inputType: "insertLineBreak",
				cancelable: true,
			}),
		);
		expect(actions.key.mock.calls).toEqual([
			[expect.objectContaining({ key: "Enter" })],
		]);
		expect(field.value).toBe(PAD_TEXT);
		insert(field, "ㅎ");
		expect(actions.text.mock.calls).toEqual([["한글"], ["ㅎ"]]);
	});
});
