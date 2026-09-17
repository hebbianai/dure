import { terminalInputLatency } from "./terminalInputLatency";
import { terminalTextReplacement } from "./terminalTextReplacement";

interface TerminalReplacementInputOptions {
	input: HTMLTextAreaElement;
	terminalId: string;
	forwardUserInput(data: string): Promise<void>;
}

const MODIFIER_KEYS = new Set([
	"Shift",
	"Control",
	"Alt",
	"Meta",
	"CapsLock",
	"AltGraph",
	"Dead",
	"Process",
]);

/**
 * WKWebView can deliver text-service updates as replacement input without a
 * composition session. Preserve the helper textarea and forward only its
 * code-point diff so the renderer cannot clear the in-progress text.
 */
export function installTerminalReplacementInput(
	options: TerminalReplacementInputOptions,
) {
	const inputElement = options.input;
	const observedEvents = [
		"keydown",
		"beforeinput",
		"input",
		"compositionstart",
		"compositionupdate",
		"compositionend",
		"focus",
		"blur",
	];
	const observeInput = (event: Event) =>
		terminalInputLatency.noteBrowserInput(options.terminalId, event);
	for (const type of observedEvents) {
		inputElement.addEventListener(type, observeInput, true);
	}
	let chainActive = false;
	let lastValue = "";
	const endChain = (clear: boolean) => {
		if (!chainActive) return;
		chainActive = false;
		lastValue = "";
		if (clear) inputElement.value = "";
	};
	let ordinaryTextKeydownPending = false;
	const onBeforeInput = (event: Event) => {
		const input = event as InputEvent;
		const followsOrdinaryTextKeydown = ordinaryTextKeydownPending;
		ordinaryTextKeydownPending = false;
		if (
			input.inputType === "insertText" &&
			!input.isComposing &&
			input.data &&
			followsOrdinaryTextKeydown
		) {
			terminalInputLatency.markNativeTextInputExpected(options.terminalId);
			return;
		}
		if (
			chainActive ||
			(input.inputType !== "insertText" &&
				input.inputType !== "insertReplacementText") ||
			!input.data
		) {
			return;
		}
		chainActive = true;
		lastValue = inputElement.value;
	};
	const onInput = (event: Event) => {
		ordinaryTextKeydownPending = false;
		if (!chainActive) return;
		event.stopPropagation();
		const value = inputElement.value;
		if (value === lastValue) return;
		const edit = terminalTextReplacement(lastValue, value);
		const delta = "\x7f".repeat(edit.deleteBefore) + edit.text;
		if (delta) {
			terminalInputLatency.noteInput(options.terminalId);
			options.forwardUserInput(delta).catch(() => {});
		}
		lastValue = value;
	};
	const onKeydown = (event: KeyboardEvent) => {
		if (event.keyCode === 229 || MODIFIER_KEYS.has(event.key)) {
			ordinaryTextKeydownPending = false;
			if (
				chainActive &&
				(event.key === "Backspace" || event.key === "Delete")
			) {
				event.stopPropagation();
			}
			return;
		}
		ordinaryTextKeydownPending =
			event.key.length === 1 &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey;
		terminalInputLatency.noteKeydown(options.terminalId, chainActive);
		endChain(true);
	};
	const onKeyup = () => {
		ordinaryTextKeydownPending = false;
	};
	const onCompositionStart = () => {
		ordinaryTextKeydownPending = false;
		endChain(false);
	};
	const onBlur = () => {
		ordinaryTextKeydownPending = false;
		endChain(true);
	};

	inputElement.addEventListener("beforeinput", onBeforeInput, true);
	inputElement.addEventListener("input", onInput, true);
	inputElement.addEventListener("keydown", onKeydown, true);
	inputElement.addEventListener("keyup", onKeyup, true);
	inputElement.addEventListener("compositionstart", onCompositionStart, true);
	inputElement.addEventListener("blur", onBlur, true);
	return () => {
		for (const type of observedEvents) {
			inputElement.removeEventListener(type, observeInput, true);
		}
		inputElement.removeEventListener("beforeinput", onBeforeInput, true);
		inputElement.removeEventListener("input", onInput, true);
		inputElement.removeEventListener("keydown", onKeydown, true);
		inputElement.removeEventListener("keyup", onKeyup, true);
		inputElement.removeEventListener(
			"compositionstart",
			onCompositionStart,
			true,
		);
		inputElement.removeEventListener("blur", onBlur, true);
	};
}
