import { terminalTextReplacement } from "@/lib/terminal/interaction/terminalTextReplacement";
import {
	shouldSendTerminalKey,
	type TerminalKeyEvent,
} from "@/lib/terminal/state/terminalInputIntent";
import { attachSpaceTrackpad, type TrackpadHooks } from "./spaceTrackpad";

/** Keep the native textarea intact while the keyboard edits it. Korean iOS
 * input replaces characters through input events without a composition cycle. */
export function attachTerminalKeyboard(
	field: HTMLTextAreaElement,
	actions: {
		text: (text: string) => void;
		key: (event: TerminalKeyEvent) => void;
		paste: (text: string) => void;
		pasteImage?: (image: Blob) => void;
		trackpad: Omit<TrackpadHooks, "begin">;
	},
) {
	const pad = attachSpaceTrackpad(field, {
		...actions.trackpad,
		begin: () => finish(),
	});
	let composing = false;
	let sent = "";
	const key = (name: string): TerminalKeyEvent => ({
		key: name,
		code: name,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		metaKey: false,
		repeat: false,
		isComposing: false,
		getModifierState: () => false,
	});
	const flush = () => {
		if (field.disabled || composing) return;
		const text = pad.read();
		const edit = terminalTextReplacement(sent, text);
		for (let count = 0; count < edit.deleteBefore; count += 1)
			actions.key(key("Backspace"));
		if (edit.text) actions.text(edit.text);
		sent = text;
	};
	/** A terminal key or submission ends the native text-service context. */
	const finish = () => {
		if (!composing && !sent && !pad.read()) return;
		composing = false;
		flush();
		sent = "";
		pad.take();
	};
	const onCompositionStart = () => {
		composing = true;
	};
	const onCompositionEnd = () => {
		composing = false;
		flush();
	};
	const onInput = (event: Event) => {
		const input = event as InputEvent;
		if (field.disabled || input.isComposing || composing) return;
		if (input.inputType === "deleteContentBackward" && !sent && !pad.read()) {
			actions.key(key("Backspace"));
			pad.take();
		} else flush();
	};
	const onKeydown = (event: KeyboardEvent) => {
		if (
			event.keyCode === 229 ||
			["Unidentified", "Shift", "Control", "Alt", "Meta", "CapsLock"].includes(
				event.key,
			)
		)
			return;
		if (composing || field.disabled || !shouldSendTerminalKey(event)) return;
		// iOS ends Korean composition through the native Return action. Cancelling
		// keydown leaves its previous syllable active after submission; forward
		// the resulting beforeinput line break instead.
		if (
			event.key === "Enter" &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.metaKey &&
			!event.shiftKey
		)
			return;
		// Native Backspace must be allowed to revise the keyboard's retained
		// text; its input event sends the corresponding terminal deletion.
		if (
			event.key === "Backspace" &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.metaKey &&
			sent
		)
			return;
		event.preventDefault();
		finish();
		actions.key(event);
	};
	const onBeforeInput = (event: Event) => {
		const input = event as InputEvent;
		if (field.disabled || composing || input.isComposing) return;
		if (input.inputType === "insertLineBreak" && input.cancelable) {
			input.preventDefault();
			finish();
			actions.key(key("Enter"));
		} else if (
			input.inputType === "deleteContentBackward" &&
			!sent &&
			input.cancelable
		) {
			input.preventDefault();
			actions.key(key("Backspace"));
		}
	};
	const onPaste = (event: ClipboardEvent) => {
		if (field.disabled) return;
		const image = Array.from(event.clipboardData?.items ?? [])
			.find(item => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
		if (image && actions.pasteImage) {
			event.preventDefault();
			finish();
			actions.pasteImage(image);
			return;
		}
		const text = event.clipboardData?.getData("text/plain");
		if (!text) return;
		event.preventDefault();
		finish();
		actions.paste(text);
	};
	field.addEventListener("compositionstart", onCompositionStart);
	field.addEventListener("compositionend", onCompositionEnd);
	field.addEventListener("beforeinput", onBeforeInput);
	field.addEventListener("input", onInput);
	field.addEventListener("keydown", onKeydown);
	field.addEventListener("paste", onPaste);
	field.addEventListener("blur", finish);
	return {
		finish,
		dispose() {
			pad.dispose();
			field.removeEventListener("compositionstart", onCompositionStart);
			field.removeEventListener("compositionend", onCompositionEnd);
			field.removeEventListener("beforeinput", onBeforeInput);
			field.removeEventListener("input", onInput);
			field.removeEventListener("keydown", onKeydown);
			field.removeEventListener("paste", onPaste);
			field.removeEventListener("blur", finish);
		},
	};
}
