import type { HmuxStructuredTerminalRetryDirective } from "@/lib/hmux/failure/structuredTerminalAttachFailure";

export interface TerminalCarrierClose {
	readonly code?: string;
	readonly message?: string;
	/**
	 * The posture the protocol/client boundary owns, projected through the
	 * closed carrier record. Reading it here is the whole point: the pane used
	 * to re-derive recoverability from the error code, which cannot work — the
	 * Host sends `hmux_resource_limit` with `reconnect` for an output backlog
	 * and with `never` for an oversized frame.
	 */
	readonly retryDirective: HmuxStructuredTerminalRetryDirective;
	/**
	 * Whether this attachment still had input the Host had not acknowledged.
	 * The Host cannot know this, so it stays a client-side term. It colours the
	 * cause the user is told, never the disposition: an unacknowledged
	 * keystroke is a possible loss on the transport, not evidence that the
	 * provider process is gone.
	 */
	readonly pendingInput: boolean;
}

export interface TerminalCarrierCloseReport {
	/** `recoverable` defers the message until a successor attach also fails. */
	readonly disposition: "recoverable" | "permanent";
	readonly cause: string;
}

/** Appended to the cause when the close may have dropped a keystroke. */
export const TERMINAL_CARRIER_CLOSE_PENDING_INPUT_NOTE =
	"input sent before the close may not have reached the session";

/**
 * Projects a carrier close into what the pane should report.
 *
 * The Host's retry posture is the only authority on recoverability. A
 * `reconnect` close is a subscriber being dropped (an output backlog, a
 * transport hiccup) while the provider keeps running; the pane reattaches with
 * snapshot recovery. It used to become permanent whenever input was still
 * unacknowledged, which turned every close during typing into a "process is
 * gone" overlay whose Resume replaced a live provider mid-turn.
 *
 * `retry_after_resync` is treated as permanent: no producer on this path emits
 * it today, so admitting it would be inventing behaviour rather than projecting
 * it.
 */
export function terminalCarrierClose({
	code,
	message,
	retryDirective,
	pendingInput,
}: TerminalCarrierClose): TerminalCarrierCloseReport {
	const cause = message ?? code ?? "structured terminal closed";
	return {
		disposition: retryDirective === "reconnect" ? "recoverable" : "permanent",
		cause: pendingInput
			? `${cause}; ${TERMINAL_CARRIER_CLOSE_PENDING_INPUT_NOTE}`
			: cause,
	};
}
