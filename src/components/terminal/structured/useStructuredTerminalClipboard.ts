import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { type RefObject, useCallback, useEffect } from "react";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { t } from "@/lib/i18n";
import { createTerminalClipboardPasteHandler } from "@/lib/terminal/interaction/terminalClipboardPaste";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import { showToast } from "@/lib/toast";
import { terminalViewportSelectionText } from "./TerminalViewportDomRenderer";

interface StructuredTerminalClipboardOptions {
	readonly terminalSurfaceRef: RefObject<HTMLDivElement | null>;
	readonly copyOnSelect: boolean;
	readonly prepareFiles: (files: DroppedFilePayload[]) => Promise<string[]>;
	readonly surfaceId: string;
	/** The pane hosting the terminal, so "copied" lands in that pane. */
	readonly paneId?: string;
	readonly currentAttachmentId: () => string | undefined;
	readonly selectionText?: () => string;
	readonly forwardUserInput: (text: string) => void;
	readonly reportFailure: (cause: unknown) => void;
}

/** Owns clipboard interactions while preserving the initiating attachment. */
export function useStructuredTerminalClipboard(
	options: StructuredTerminalClipboardOptions,
) {
	const selectedText = useCallback(
		() => {
			const logicalSelection = options.selectionText?.() ?? "";
			if (logicalSelection) return logicalSelection;
			return terminalViewportSelectionText(
				options.terminalSurfaceRef.current,
				window.getSelection(),
			);
		},
		[options.selectionText, options.terminalSurfaceRef],
	);

	useEffect(() => {
		const ownerDocument =
			options.terminalSurfaceRef.current?.ownerDocument ?? document;
		const onCopy = (event: ClipboardEvent) => {
			const text = selectedText();
			if (!text || !event.clipboardData) return;
			event.preventDefault();
			event.clipboardData.setData("text/plain", text);
		};
		ownerDocument.addEventListener("copy", onCopy);
		return () => ownerDocument.removeEventListener("copy", onCopy);
	}, [options.terminalSurfaceRef, selectedText]);

	const copyNativeSelection = useCallback((selectionText?: string) => {
		if (!options.copyOnSelect) return;
		const text = selectionText ?? selectedText();
		if (!text) return;
		const paneId = options.paneId;
		void writeText(text)
			.then(() => {
				const message = t("common.copiedToClipboard");
				if (paneId) showToast(message, { paneId });
				else showToast(message);
			})
			.catch(() => {});
	}, [options.copyOnSelect, options.paneId, selectedText]);

	const onPaste = useCallback(
		(event: ClipboardEvent) => {
			const attachmentId = options.currentAttachmentId();
			if (!attachmentId || !event.clipboardData) return;
			terminalInputLatency.noteInput(options.surfaceId);
			createTerminalClipboardPasteHandler({
				hostId: undefined,
				prepareFiles: options.prepareFiles,
				canForwardText: () => options.currentAttachmentId() === attachmentId,
				refreshControlState: () => {},
				textPasteEncoding: "host",
				bracketedPasteMode: () => false,
				forwardUserInput: async (text) => {
					if (options.currentAttachmentId() !== attachmentId) return;
					options.forwardUserInput(text);
				},
				onError: (cause) => {
					if (options.currentAttachmentId() === attachmentId) {
						options.reportFailure(cause);
					}
				},
			})(event);
		},
		[options],
	);

	return { copyNativeSelection, onPaste, selectedText };
}
