import {
	type MutableRefObject,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { isHmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import {
	presentTerminalFailure,
	presentTerminalReceiptFailure,
	resolveTerminalFailureWithCompleteFrame,
	resolveTerminalReceiptFailure,
	type TerminalFailureMessageId,
	type TerminalFailurePresentation,
} from "@/lib/terminal/state/terminalFailurePresentation";
import type { TerminalIntentReceiptKind } from "@/lib/terminal/state/terminalIntentReceiptSequence";
import type {
	PendingAttachmentRecoveryFailure,
	StructuredTerminalAttachmentIdentity,
	UpstreamSequence,
} from "./structuredTerminalViewportTransportContract";

interface UseStructuredTerminalFailurePresentationOptions {
	readonly isCurrentAttachment: (
		attachment: StructuredTerminalAttachmentIdentity,
		requireAttached?: boolean,
	) => boolean;
	readonly pendingRecoveryFailureRef: MutableRefObject<PendingAttachmentRecoveryFailure | null>;
	readonly upstreamSequenceRef: MutableRefObject<UpstreamSequence | undefined>;
}

export function useStructuredTerminalFailurePresentation({
	isCurrentAttachment,
	pendingRecoveryFailureRef,
	upstreamSequenceRef,
}: UseStructuredTerminalFailurePresentationOptions) {
	const [presentation, setPresentationState] = useState<
		TerminalFailurePresentation | undefined
	>();
	// The ref is the synchronous truth so receipt handling can decide without
	// waiting for a render; state only carries it to the view.
	const presentationRef = useRef(presentation);
	const setPresentation = useCallback(
		(next: TerminalFailurePresentation | undefined) => {
			presentationRef.current = next;
			setPresentationState(next);
		},
		[],
	);
	const reportFailure = useCallback(
		(
			cause: unknown,
			retiredByCompleteFrame = false,
			messageId?: TerminalFailureMessageId,
		) => {
			pendingRecoveryFailureRef.current = null;
			setPresentation(
				presentTerminalFailure(cause, retiredByCompleteFrame, messageId),
			);
		},
		[pendingRecoveryFailureRef, setPresentation],
	);
	const reportFailureForAttachment = useCallback(
		(
			attachment: StructuredTerminalAttachmentIdentity,
			cause: unknown,
			retiredByCompleteFrame = false,
			messageId?: TerminalFailureMessageId,
		) => {
			if (!isCurrentAttachment(attachment)) return false;
			reportFailure(cause, retiredByCompleteFrame, messageId);
			return true;
		},
		[isCurrentAttachment, reportFailure],
	);
	const reportTerminalFailureForAttachment = useCallback(
		(attachment: StructuredTerminalAttachmentIdentity, cause: unknown) =>
			isHmuxSessionFailureError(cause) &&
			reportFailureForAttachment(attachment, cause),
		[reportFailureForAttachment],
	);
	const reportReceiptFailureForAttachment = useCallback(
		(
			attachment: StructuredTerminalAttachmentIdentity,
			operation: TerminalIntentReceiptKind,
			recordId: bigint,
			cause: unknown,
		) => {
			if (!isCurrentAttachment(attachment)) return false;
			pendingRecoveryFailureRef.current = null;
			setPresentation(
				presentTerminalReceiptFailure(
					cause,
					operation,
					attachment.attachmentToken,
					recordId,
				),
			);
			return true;
		},
		[isCurrentAttachment, pendingRecoveryFailureRef, setPresentation],
	);
	const resolveReceiptFailureForAttachment = useCallback(
		(
			attachment: StructuredTerminalAttachmentIdentity,
			operation: TerminalIntentReceiptKind,
			recordId: bigint,
		) => {
			// Accepted receipts arrive per keystroke; only a standing refusal
			// is worth a state update.
			const current = presentationRef.current;
			if (current?.kind !== "receipt" || !isCurrentAttachment(attachment)) {
				return;
			}
			const next = resolveTerminalReceiptFailure(
				current,
				operation,
				attachment.attachmentToken,
				recordId,
			);
			if (next !== current) setPresentation(next);
		},
		[isCurrentAttachment, setPresentation],
	);
	const resolveCurrentResizeFailure = useCallback(
		(recordId: bigint) => {
			const sequence = upstreamSequenceRef.current;
			if (!sequence || !isCurrentAttachment(sequence.attachment, true)) return;
			resolveReceiptFailureForAttachment(
				sequence.attachment,
				"resize",
				recordId,
			);
		},
		[
			isCurrentAttachment,
			resolveReceiptFailureForAttachment,
			upstreamSequenceRef,
		],
	);
	const resolveFailureWithCompleteFrame = useCallback(
		(attachment: StructuredTerminalAttachmentIdentity) => {
			if (!isCurrentAttachment(attachment)) return;
			const current = presentationRef.current;
			const next = resolveTerminalFailureWithCompleteFrame(
				current,
				attachment.attachmentToken,
			);
			if (next !== current) setPresentation(next);
		},
		[isCurrentAttachment, setPresentation],
	);
	const clearFailure = useCallback(
		() => setPresentation(undefined),
		[setPresentation],
	);
	const dismissNotice = useCallback(() => {
		// A click acknowledges this notice, not a newer failure that arrived
		// before React committed its replacement (including a connection loss).
		if (presentationRef.current === presentation) setPresentation(undefined);
	}, [presentation, setPresentation]);

	const controller = useMemo(
		() => ({
			clear: clearFailure,
			report: reportFailure,
			reportForAttachment: reportFailureForAttachment,
			reportTerminalForAttachment: reportTerminalFailureForAttachment,
			failReceipt: reportReceiptFailureForAttachment,
			applyReceipt: resolveReceiptFailureForAttachment,
			resolveCurrentResize: resolveCurrentResizeFailure,
			resolveWithCompleteFrame: resolveFailureWithCompleteFrame,
		}),
		[
			clearFailure,
			reportFailure,
			reportFailureForAttachment,
			reportTerminalFailureForAttachment,
			reportReceiptFailureForAttachment,
			resolveCurrentResizeFailure,
			resolveFailureWithCompleteFrame,
			resolveReceiptFailureForAttachment,
		],
	);
	return {
		error: presentation?.message,
		dismissError:
			presentation &&
			(presentation.kind === "receipt" ||
				(!presentation.recoveryAvailable &&
					!presentation.retiredByCompleteFrame))
				? dismissNotice
				: undefined,
		connectionFailed:
			presentation?.kind === "general" && presentation.retiredByCompleteFrame,
		recoveryAvailable:
			presentation?.kind === "general" && presentation.recoveryAvailable,
		errorMessageId:
			presentation?.kind === "general" ? presentation.messageId : undefined,
		controller,
	};
}
