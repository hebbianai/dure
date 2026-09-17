import { type MutableRefObject, useEffect, useRef } from "react";
import type { InputReceipt } from "@/contracts/terminalStateProtocol";
import { terminalPaneInputAction } from "@/lib/terminal/interaction/terminalPaneInputAction";
import { createTerminalQuickCommandInput } from "@/lib/terminal/interaction/terminalQuickCommandInput";
import {
	encodeTerminalKeyIntent,
	encodeTerminalPasteIntent,
} from "@/lib/terminal/state/terminalInputIntent";
import { registerPaneActions } from "@/lib/workspace/pane/paneActionRegistry";
import { registerPaneQuickCommandTarget } from "@/lib/workspace/pane/paneQuickCommandTarget";
import type { StructuredTerminalViewportTransport } from "./structuredTerminalViewportTransportContract";

export function useStructuredTerminalQuickCommands(options: {
	paneId?: string;
	surfaceId: string;
	attachmentId: string;
	terminalEpoch: string | null;
	inputReady: boolean;
	observerIdRef: MutableRefObject<string | undefined>;
	receiptObserverRef: MutableRefObject<
		((receipt: InputReceipt) => void) | undefined
	>;
	readLatestCompleteFrame: StructuredTerminalViewportTransport["readLatestCompleteFrame"];
	sendUserInput: (
		encode: Parameters<StructuredTerminalViewportTransport["sendInput"]>[0],
	) => bigint | undefined;
	focus: () => void;
}) {
	const latest = useRef(options);
	latest.current = options;
	const {
		paneId,
		surfaceId,
		attachmentId,
		terminalEpoch,
		inputReady,
		receiptObserverRef,
	} = options;
	useEffect(() => {
		if (!inputReady) return;
		const controller = createTerminalQuickCommandInput({
			isCurrent: () =>
				latest.current.inputReady &&
				latest.current.attachmentId === attachmentId &&
				latest.current.terminalEpoch === terminalEpoch &&
				latest.current.observerIdRef.current === attachmentId,
			canPasteMultiline: () =>
				latest.current.readLatestCompleteFrame()?.frame.inputModes
					?.bracketedPaste === true,
			paste: (text) =>
				latest.current.sendUserInput((recordId, fence) =>
					encodeTerminalPasteIntent(recordId, fence, text),
				),
			enter: () =>
				latest.current.sendUserInput((recordId, fence) =>
					encodeTerminalKeyIntent(recordId, fence, {
						key: "Enter",
						code: "Enter",
						shiftKey: false,
						altKey: false,
						ctrlKey: false,
						metaKey: false,
						repeat: false,
						getModifierState: () => false,
					}),
				),
		});
		receiptObserverRef.current = controller.onReceipt;
		const unregister = registerPaneQuickCommandTarget(surfaceId, (command) => {
			latest.current.focus();
			return controller.run(command);
		});
		const unregisterAction = paneId
			? registerPaneActions({
					owner: controller,
					paneId,
					actions: {
						"terminal.input": terminalPaneInputAction((command) =>
							controller.run(command),
						),
					},
				})
			: undefined;
		return () => {
			unregisterAction?.();
			unregister();
			controller.dispose();
			if (receiptObserverRef.current === controller.onReceipt)
				receiptObserverRef.current = undefined;
		};
	}, [
		paneId,
		surfaceId,
		attachmentId,
		terminalEpoch,
		inputReady,
		receiptObserverRef,
	]);
}
