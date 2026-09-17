import type { IDockviewPanelProps } from "dockview-react";
import { type RefObject, useEffect } from "react";
import {
	type DroppedFilePayload,
	describeExternalFileDropError,
} from "@/lib/files/externalFileDrop";
import { t } from "@/lib/i18n";
import { installTerminalFileDrop } from "@/lib/terminal/interaction/terminalFileDrop";

interface StructuredTerminalFileDropOptions {
	readonly containerRef: RefObject<HTMLDivElement | null>;
	readonly inputRef: RefObject<HTMLTextAreaElement | null>;
	readonly prepareFiles: (files: DroppedFilePayload[]) => Promise<string[]>;
	readonly inputReady: boolean;
	/** The pane to raise on drop. Kept whole rather than as a bare
	 *  `paneApi.setActive` reference: dockview's `setActive` reads
	 *  `this.accessor`, so an unbound method throws the moment a file lands. */
	readonly paneApi?: Pick<IDockviewPanelProps["api"], "setActive">;
	/** The attachment this surface would send to right now, if any. */
	readonly currentAttachmentId: () => string | undefined;
	readonly forwardUserInput: (text: string) => void;
	readonly reportFailure: (cause: unknown) => void;
}

/**
 * Owns external file drops on the structured terminal surface.
 *
 * The dropped files are put where this session's shell can open them — a local
 * temp directory, or a fresh private directory on the remote host — and the
 * prepared path bundle then enters as one paste, exactly like a clipboard
 * paste. Preparation is asynchronous, so the attachment that received the drop
 * is pinned when the drop starts and re-checked before the input is sent: a
 * surface replaced mid-upload must not inherit someone else's paths.
 */
export function useStructuredTerminalFileDrop({
	containerRef,
	inputRef,
	prepareFiles,
	inputReady,
	paneApi,
	currentAttachmentId,
	forwardUserInput,
	reportFailure,
}: StructuredTerminalFileDropOptions): void {
	useEffect(() => {
		const host = containerRef.current;
		if (!host || !inputReady) return;
		let droppedAttachmentId: string | undefined;
		return installTerminalFileDrop(host, {
			prepareFiles,
			activateInputTarget: () => {
				droppedAttachmentId = currentAttachmentId();
				paneApi?.setActive();
				inputRef.current?.focus();
			},
			forwardUserInput: (text) => {
				if (
					!droppedAttachmentId ||
					currentAttachmentId() !== droppedAttachmentId
				) {
					return;
				}
				forwardUserInput(text);
			},
			onError: (cause) => {
				if (currentAttachmentId() !== droppedAttachmentId) return;
				reportFailure(describeExternalFileDropError(cause, t));
			},
		});
	}, [
		containerRef,
		currentAttachmentId,
		forwardUserInput,
		inputReady,
		inputRef,
		paneApi,
		prepareFiles,
		reportFailure,
	]);
}
