const ATTACHMENT_RETIRED_MESSAGE =
	"structured terminal connection is not attached";

/** Parse the raw desktop invoke failure once at the upstream boundary. An
 * absent observer proves that attachment generation retired; other failures
 * remain input outcomes that a later output frame cannot reinterpret. */
export function isRetiredStructuredTerminalAttachment(
	cause: unknown,
): boolean {
	const message = cause instanceof Error ? cause.message : String(cause);
	return message === ATTACHMENT_RETIRED_MESSAGE;
}
