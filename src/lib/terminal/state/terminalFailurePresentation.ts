import { isHmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import type { TerminalIntentReceiptKind } from "./terminalIntentReceiptSequence";

export const TERMINAL_CONNECTION_FAILURE_MESSAGE_ID =
	"terminal.failure.connection" as const;
export type TerminalFailureMessageId =
	typeof TERMINAL_CONNECTION_FAILURE_MESSAGE_ID;

export type TerminalFailurePresentation =
	| {
			readonly kind: "general";
			readonly message: string;
			readonly messageId?: TerminalFailureMessageId;
			/** Input/resize loss notices never authorize process replacement. */
			readonly recoveryAvailable: boolean;
			/**
			 * True when a later complete frame proves this failure is over. A
			 * connection failure is; a refused input is a loss notice the user
			 * still needs after the pane resumes serving frames.
			 */
			readonly retiredByCompleteFrame: boolean;
	  }
	| {
			/**
			 * The Host answered one intent with a refusal. The receipt proves the
			 * attachment carried the result, so this is a notice about that one
			 * operation, retired by a later success of the same kind.
			 */
			readonly kind: "receipt";
			readonly operation: TerminalIntentReceiptKind;
			readonly message: string;
			readonly attachmentToken: string;
			readonly failedRecordId: bigint;
	  };

export function presentTerminalFailure(
	cause: unknown,
	retiredByCompleteFrame = false,
	messageId?: TerminalFailureMessageId,
): TerminalFailurePresentation {
	return {
		kind: "general",
		recoveryAvailable:
			isHmuxSessionFailureError(cause) ||
			messageId === TERMINAL_CONNECTION_FAILURE_MESSAGE_ID,
		message: isHmuxSessionFailureError(cause) ? cause.message : String(cause),
		...(messageId ? { messageId } : {}),
		retiredByCompleteFrame,
	};
}

export function presentTerminalReceiptFailure(
	cause: unknown,
	operation: TerminalIntentReceiptKind,
	attachmentToken: string,
	failedRecordId: bigint,
): TerminalFailurePresentation {
	return {
		kind: "receipt",
		operation,
		message: String(cause),
		attachmentToken,
		failedRecordId,
	};
}

/**
 * A complete frame is the proof that the attachment serves again, so the
 * general failure it recovered from retires with it. A refused receipt is
 * resolved by its own kind of success and must survive an unrelated frame on
 * the attachment that refused it; a frame from a later attachment proves that
 * attachment is gone, and its refusal with it.
 */
export function resolveTerminalFailureWithCompleteFrame(
	presentation: TerminalFailurePresentation | undefined,
	attachmentToken: string,
): TerminalFailurePresentation | undefined {
	if (presentation?.kind === "general") {
		return presentation.retiredByCompleteFrame ? undefined : presentation;
	}
	return presentation?.attachmentToken === attachmentToken
		? presentation
		: undefined;
}

/**
 * A later accepted receipt of the same operation kind on the same attachment
 * proves the refused one is history. Another kind's success says nothing
 * about it: a keystroke landing does not make a refused resize fit. The pane
 * shows one notice at a time, so a newer refusal of any kind replaces an
 * older one; this resolver only decides when the standing notice is over.
 */
export function resolveTerminalReceiptFailure(
	presentation: TerminalFailurePresentation | undefined,
	operation: TerminalIntentReceiptKind,
	attachmentToken: string,
	appliedRecordId: bigint,
): TerminalFailurePresentation | undefined {
	if (
		presentation?.kind !== "receipt" ||
		presentation.operation !== operation ||
		presentation.attachmentToken !== attachmentToken ||
		appliedRecordId <= presentation.failedRecordId
	) {
		return presentation;
	}
	return undefined;
}
