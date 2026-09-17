import { HmuxStructuredTerminalAttachError } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";

const STRUCTURED_TERMINAL_ATTACHMENT_RETIRED = "attachment_retired" as const;

export type StructuredTerminalAttachmentRetirementReason =
	| "binding_replaced"
	| "generation_retired"
	| "source_absent";

export interface StructuredTerminalAttachmentRetired {
	readonly status: typeof STRUCTURED_TERMINAL_ATTACHMENT_RETIRED;
	readonly reason: StructuredTerminalAttachmentRetirementReason;
}

export function structuredTerminalAttachmentRetired(
	reason: StructuredTerminalAttachmentRetirementReason,
): StructuredTerminalAttachmentRetired {
	return { status: STRUCTURED_TERMINAL_ATTACHMENT_RETIRED, reason };
}

export function isStructuredTerminalAttachmentRetired(
	value: unknown,
): value is StructuredTerminalAttachmentRetired {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		value.status === STRUCTURED_TERMINAL_ATTACHMENT_RETIRED &&
		"reason" in value &&
		(value.reason === "binding_replaced" ||
			value.reason === "generation_retired" ||
			value.reason === "source_absent")
	);
}

export class StructuredTerminalAttachRetiredError extends Error {
	readonly code = "structured_terminal_attach_retired";

	constructor(
		readonly reason: StructuredTerminalAttachmentRetirementReason = "generation_retired",
	) {
		super(`structured_terminal_attach_retired:${reason}`);
		this.name = "StructuredTerminalAttachRetiredError";
	}
}

export function isStructuredTerminalAttachRetiredError(
	value: unknown,
): value is StructuredTerminalAttachRetiredError {
	return (
		value instanceof StructuredTerminalAttachRetiredError ||
		(typeof value === "object" &&
			value !== null &&
			"code" in value &&
			value.code === "structured_terminal_attach_retired")
	);
}

/** Translate only an explicitly retryable backend preparation into the
 * terminal attachment's existing bounded reconnect protocol. Every terminal,
 * stale-generation, contract, and authority failure retains its original
 * identity and fail-closed handling. */
export function structuredTerminalAttachPreparationError(
	cause: unknown,
): unknown {
	if (
		cause instanceof DureBackendRequestError &&
		cause.failure.kind === "operation" &&
		cause.failure.disposition === "retry_same"
	) {
		return new HmuxStructuredTerminalAttachError({
			code: cause.code,
			message: cause.message,
			retryDirective: "reconnect",
		});
	}
	return cause;
}
