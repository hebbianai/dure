// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { expect, it, vi } from "vitest";
import { useStructuredTerminalKeyInput } from "./useStructuredTerminalKeyInput";
import { useStructuredTerminalTextInput } from "./useStructuredTerminalTextInput";

function InputFixture({
	sendText,
	sendKey,
}: {
	sendText: (text: string) => bigint;
	sendKey: () => void;
}) {
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const input = useStructuredTerminalTextInput({
		inputRef,
		surfaceId: "composition-recovery-test",
		attachmentId: "same-attachment",
		terminalEpoch: "same-epoch",
		inputReady: true,
		restoreFocus: false,
		currentCursor: null,
		sendText,
		onInputFocus: () => ({ projectionMs: 0, intentDispatchMs: 0 }),
	});
	const onKeyDown = useStructuredTerminalKeyInput({
		inputReady: true,
		terminalId: "composition-recovery-test",
		shortcutOverrides: {},
		selectedText: () => "",
		finishCompositionHandoff: input.finishCompositionHandoff,
		sendUserInput: sendKey,
	});
	return (
		<textarea
			ref={inputRef}
			onFocus={input.onFocus}
			onBlur={input.clearComposition}
			onKeyDown={onKeyDown}
			onInput={input.onInput}
			onCompositionStart={input.onCompositionStart}
			onCompositionUpdate={input.onCompositionUpdate}
			onCompositionEnd={input.onCompositionEnd}
		/>
	);
}

it.each([
	{ key: "a", code: "KeyA", keyCode: 65 },
	{ key: " ", code: "Space", keyCode: 32 },
])(
	"accepts $code after an interrupted composition without a blur",
	(firstKey) => {
		const sendText = vi.fn(() => 1n);
		const sendKey = vi.fn();
		const view = render(<InputFixture sendText={sendText} sendKey={sendKey} />);
		const input = view.getByRole("textbox") as HTMLTextAreaElement;
		try {
			input.focus();
			fireEvent.compositionStart(input, { data: "ㅎ" });
			fireEvent.input(input, {
				target: { value: "한" },
				inputType: "insertCompositionText",
				isComposing: true,
			});
			expect(sendText).not.toHaveBeenCalled();

			// The browser has left composition, but no compositionend reached React.
			fireEvent.keyDown(input, {
				key: "Backspace",
				code: "Backspace",
				keyCode: 8,
				isComposing: false,
			});
			expect(sendKey).toHaveBeenCalledOnce();
			for (const { key, code, keyCode } of [
				firstKey,
				{ key: "x", code: "KeyX", keyCode: 88 },
			]) {
				fireEvent.keyDown(input, { key, code, keyCode, isComposing: false });
				input.dispatchEvent(
					new InputEvent("beforeinput", {
						bubbles: true,
						inputType: "insertText",
						data: key,
						isComposing: false,
					}),
				);
				fireEvent.input(input, {
					target: { value: key },
					inputType: "insertText",
					data: key,
					isComposing: false,
				});
			}
			expect(document.activeElement).toBe(input);
			expect(sendText.mock.calls).toEqual([[firstKey.key], ["x"]]);
			fireEvent.compositionEnd(input, { data: "한" });
			expect(sendText.mock.calls).toEqual([[firstKey.key], ["x"]]);
		} finally {
			view.unmount();
		}
	},
);
