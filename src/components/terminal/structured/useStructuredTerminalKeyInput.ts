import type { KeyboardEvent } from "react";
import { useCallback } from "react";
import type { ShortcutOverrides } from "@/lib/settings/shortcutBindings";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import { terminalEditingSequence } from "@/lib/terminal/interaction/terminalKeyBindings";
import {
	encodeTerminalKeyIntent,
	encodeTerminalTextIntent,
	shouldSendTerminalKey,
} from "@/lib/terminal/state/terminalInputIntent";
import type { TerminalInputFence } from "@/lib/terminal/state/terminalInputIntent";

type SendUserInput = (
	encode: (recordId: bigint, fence: TerminalInputFence) => Uint8Array,
) => unknown;

interface StructuredTerminalKeyInputOptions {
	readonly inputReady: boolean;
	readonly terminalId: string;
	readonly shortcutOverrides: ShortcutOverrides;
	readonly selectedText: () => string;
	readonly finishCompositionHandoff: () => void;
	readonly sendUserInput: SendUserInput;
}

/**
 * Owns what a keydown on the structured input surface becomes.
 *
 * Three outcomes, in order: the native copy of a selection stays with the
 * browser; a terminal editing chord (⌘⌫ / ⌘← / ⌘→ / ⌥⌫) becomes its control
 * sequence; everything else the Host can encode becomes a key intent. The
 * chord layer exists because `shouldSendTerminalKey` drops every ⌘ chord and
 * the Host does not encode ⌘ as a terminal key, so the mapping the
 * 설정 › 단축키 catalog advertises would otherwise be unreachable here.
 * Which chord means which action stays in `lib/terminalKeyBindings` — this
 * hook only decides where the answer goes.
 */
export function useStructuredTerminalKeyInput({
	inputReady,
	terminalId,
	shortcutOverrides,
	selectedText,
	finishCompositionHandoff,
	sendUserInput,
}: StructuredTerminalKeyInputOptions) {
	return useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			terminalInputLatency.markSemanticKeydown(terminalId);
			if (!inputReady) return;
			if (
				selectedText() &&
				event.key.toLowerCase() === "c" &&
				(event.metaKey || (event.ctrlKey && event.shiftKey))
			) {
				return;
			}
			const editing = terminalEditingSequence(
				event.nativeEvent,
				shortcutOverrides,
			);
			if (editing === null && !shouldSendTerminalKey(event.nativeEvent)) {
				return;
			}
			terminalInputLatency.markSemanticKeydownDecision(terminalId);
			finishCompositionHandoff();
			event.preventDefault();
			sendUserInput((recordId, fence) =>
				editing === null
					? encodeTerminalKeyIntent(recordId, fence, event.nativeEvent)
					: encodeTerminalTextIntent(recordId, fence, editing),
			);
		},
		[
			finishCompositionHandoff,
			inputReady,
			selectedText,
			sendUserInput,
			shortcutOverrides,
			terminalId,
		],
	);
}
