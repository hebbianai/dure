import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
} from "react";
import {
	hmuxStructuredTerminalAttachError,
	waitForStructuredTerminalAttachReconnect,
} from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import {
	TERMINAL_CONNECTION_FAILURE_MESSAGE_ID,
	type TerminalFailureMessageId,
} from "@/lib/terminal/state/terminalFailurePresentation";
import { isStructuredTerminalAttachRetiredError } from "@/lib/terminal/structuredTerminalAttachPreparation";
import type {
	AttachmentRecoveryDisposition,
	LastGoodTerminalPresentation,
	PendingAttachmentRecoveryFailure,
	RecoverableAttachmentFailureOrigin,
	StructuredTerminalAttachmentIdentity,
	UseStructuredTerminalViewportTransportOptions,
} from "./structuredTerminalViewportTransportContract";

interface StructuredTerminalAttachmentRecoveryOptions {
	readonly attachmentKey: string;
	readonly hostHealthy: boolean;
	readonly connectionFailed: boolean;
	readonly onAttachPhaseRef: MutableRefObject<
		UseStructuredTerminalViewportTransportOptions["onAttachPhase"]
	>;
	readonly isCurrentAttachment: (
		attachment: StructuredTerminalAttachmentIdentity,
	) => boolean;
	readonly recoverAttachment: (
		attachment: StructuredTerminalAttachmentIdentity,
	) => AttachmentRecoveryDisposition;
	/** Present a session-exited attach refusal through the same exit receipt a
	 * live stream would deliver, when the surface can consume it — a managed
	 * pane's exit presentation owns the pane from there. Returns false when no
	 * such presentation exists (a standalone shell, a surface without an exit
	 * consumer) so the caller keeps the failure visible instead. */
	readonly presentSessionExit: (
		attachment: StructuredTerminalAttachmentIdentity,
		reason: string,
	) => boolean;
	readonly reportFailureForAttachment: (
		attachment: StructuredTerminalAttachmentIdentity,
		cause: unknown,
		retiredByCompleteFrame?: boolean,
		messageId?: TerminalFailureMessageId,
	) => boolean;
	readonly reportTerminalForAttachment: (
		attachment: StructuredTerminalAttachmentIdentity,
		cause: unknown,
	) => boolean;
	readonly resolveFailureForAttachment: (
		attachment: StructuredTerminalAttachmentIdentity,
	) => void;
	readonly lastGoodPresentationRef: MutableRefObject<LastGoodTerminalPresentation | null>;
	readonly pendingRecoveryFailureRef: MutableRefObject<PendingAttachmentRecoveryFailure | null>;
	readonly onPaneConnectionStateRef: MutableRefObject<
		UseStructuredTerminalViewportTransportOptions["onPaneConnectionState"]
	>;
	readonly attachReconnectRef: MutableRefObject<{
		attachmentKey: string;
		failures: number;
	}>;
	readonly setAttachmentGeneration: Dispatch<SetStateAction<number>>;
}

interface StructuredTerminalAttachFailureInput {
	readonly attachment: StructuredTerminalAttachmentIdentity;
	readonly cause: unknown;
	readonly signal: AbortSignal;
	readonly isLive: () => boolean;
}

/** Coordinate one bounded attachment recovery episode and its pane-health outcome. */
export function useStructuredTerminalAttachmentRecovery({
	attachmentKey,
	hostHealthy,
	connectionFailed,
	onAttachPhaseRef,
	isCurrentAttachment,
	recoverAttachment,
	presentSessionExit,
	reportFailureForAttachment,
	reportTerminalForAttachment,
	resolveFailureForAttachment,
	lastGoodPresentationRef,
	pendingRecoveryFailureRef,
	onPaneConnectionStateRef,
	attachReconnectRef,
	setAttachmentGeneration,
}: StructuredTerminalAttachmentRecoveryOptions) {
	const previousHealth = useRef({ attachmentKey, hostHealthy });
	useEffect(() => {
		const previous = previousHealth.current;
		previousHealth.current = { attachmentKey, hostHealthy };
		// A new exact healthy observation rearms a spent connection episode.
		// Consume the existing shared census; do not poll or replace a provider.
		// An attached surface or an input/permanent refusal needs no reconnect.
		if (
			previous.attachmentKey === attachmentKey &&
			!previous.hostHealthy &&
			hostHealthy &&
			connectionFailed
		) {
			attachReconnectRef.current = { attachmentKey, failures: 0 };
			setAttachmentGeneration((generation) => generation + 1);
		}
	}, [
		attachmentKey,
		hostHealthy,
		connectionFailed,
		attachReconnectRef,
		setAttachmentGeneration,
	]);
	const reportExhausted = useCallback(
		(
			attachment: StructuredTerminalAttachmentIdentity,
			reason: "no_progress" | "reconnect_limit" | "replacement_failed",
		) => {
			onAttachPhaseRef.current?.({
				phase: "recovery",
				correlationId: attachment.observerId,
				event: { state: "exhausted", reason },
			});
		},
		[onAttachPhaseRef],
	);
	const publishRecoveryDisposition = useCallback(
		(
			disposition: AttachmentRecoveryDisposition,
			cause: unknown,
			attachment: StructuredTerminalAttachmentIdentity,
		) => {
			if (disposition.status === "started") {
				onPaneConnectionStateRef.current?.("recovering", String(cause));
			} else if (disposition.status === "bounded") {
				reportExhausted(attachment, "no_progress");
				onPaneConnectionStateRef.current?.("error", String(cause));
			}
		},
		[onPaneConnectionStateRef, reportExhausted],
	);
	const reportAttachmentFailure = useCallback(
		(
			attachment: StructuredTerminalAttachmentIdentity,
			cause: unknown,
			// This reporter carries both connection faults and refused input,
			// so the caller states which. Only a connection fault is something
			// a later complete frame can prove is over.
			retiredByCompleteFrame = false,
		) => {
			if (
				!reportFailureForAttachment(
					attachment,
					cause,
					retiredByCompleteFrame,
					retiredByCompleteFrame
						? TERMINAL_CONNECTION_FAILURE_MESSAGE_ID
						: undefined,
				)
			) {
				return;
			}
			publishRecoveryDisposition(
				recoverAttachment(attachment),
				cause,
				attachment,
			);
		},
		[publishRecoveryDisposition, recoverAttachment, reportFailureForAttachment],
	);
	const reportRecoverableFailure = useCallback(
		(
			attachment: StructuredTerminalAttachmentIdentity,
			origin: RecoverableAttachmentFailureOrigin,
			cause: unknown,
		) => {
			// A connection failure is over once a complete frame arrives; a
			// refused input is a loss notice the frame does not undo.
			const connectionFailure =
				origin === "attach" || origin === "carrier_closed";
			const pending = pendingRecoveryFailureRef.current;
			if (
				pending?.failedAttachmentKey === attachment.attachmentKey &&
				pending.replacementAttachmentToken === attachment.attachmentToken
			) {
				const accepted = reportFailureForAttachment(
					attachment,
					cause,
					connectionFailure,
					connectionFailure
						? TERMINAL_CONNECTION_FAILURE_MESSAGE_ID
						: undefined,
				);
				if (accepted) reportExhausted(attachment, "replacement_failed");
				onPaneConnectionStateRef.current?.("error", String(cause));
				return;
			}
			const disposition = recoverAttachment(attachment);
			publishRecoveryDisposition(disposition, cause, attachment);
			if (
				disposition.status === "duplicate" ||
				disposition.status === "stale"
			) {
				return;
			}
			const retained = lastGoodPresentationRef.current;
			if (
				disposition.status === "started" &&
				retained?.attachmentKey === attachment.attachmentKey &&
				retained.attachmentToken === attachment.attachmentToken &&
				retained.replica.attachmentId === attachment.observerId
			) {
				pendingRecoveryFailureRef.current = {
					origin,
					message: String(cause),
					failedObserverId: attachment.observerId,
					failedAttachmentKey: attachment.attachmentKey,
					failedAttachmentToken: attachment.attachmentToken,
					replacementAttachmentToken: attachment.replacementAttachmentToken,
				};
				return;
			}
			reportFailureForAttachment(
				attachment,
				cause,
				connectionFailure,
				connectionFailure ? TERMINAL_CONNECTION_FAILURE_MESSAGE_ID : undefined,
			);
		},
		[
			lastGoodPresentationRef,
			onPaneConnectionStateRef,
			pendingRecoveryFailureRef,
			reportExhausted,
			publishRecoveryDisposition,
			recoverAttachment,
			reportFailureForAttachment,
		],
	);
	const handleAttachFailure = useCallback(
		async ({
			attachment,
			cause,
			signal,
			isLive,
		}: StructuredTerminalAttachFailureInput) => {
			if (isStructuredTerminalAttachRetiredError(cause)) return;
			if (!isLive() || !isCurrentAttachment(attachment)) return;
			if (reportTerminalForAttachment(attachment, cause)) {
				onPaneConnectionStateRef.current?.("error", String(cause));
				return;
			}
			const attachFailure = hmuxStructuredTerminalAttachError(cause);
			// The refusal names the same session fact a live stream reports as
			// an exit record: the session is over and its Host is gone. Converge
			// through the exit receipt instead of stranding the pane on an error
			// the exited-recovery UI can never see past. A surface that cannot
			// consume the receipt keeps the visible failure, so its own recovery
			// (the pill, automatic standalone respawn) still engages.
			if (attachFailure?.code === "hmux_session_exited") {
				if (presentSessionExit(attachment, attachFailure.message)) return;
				if (
					reportFailureForAttachment(
						attachment,
						attachFailure,
						false,
						TERMINAL_CONNECTION_FAILURE_MESSAGE_ID,
					)
				) {
					onPaneConnectionStateRef.current?.("error", attachFailure.message);
				}
				return;
			}
			// Every successor repeats adapter preparation and native discovery,
			// so endpoint resync uses this same bounded reconnect episode.
			if (
				attachFailure?.retryDirective === "reconnect" ||
				attachFailure?.retryDirective === "retry_after_resync"
			) {
				const failures = attachReconnectRef.current.failures;
				attachReconnectRef.current.failures += 1;
				onPaneConnectionStateRef.current?.("recovering", attachFailure.message);
				const shouldReconnect = await waitForStructuredTerminalAttachReconnect(
					failures,
					signal,
				);
				if (signal.aborted || !isLive() || !isCurrentAttachment(attachment)) {
					return;
				}
				if (!shouldReconnect) {
					reportExhausted(attachment, "reconnect_limit");
					if (
						reportFailureForAttachment(
							attachment,
							attachFailure,
							true,
							TERMINAL_CONNECTION_FAILURE_MESSAGE_ID,
						)
					) {
						onPaneConnectionStateRef.current?.("error", attachFailure.message);
					}
					return;
				}
				setAttachmentGeneration((generation) => generation + 1);
				return;
			}
			if (attachFailure?.retryDirective === "never") {
				if (
					reportFailureForAttachment(
						attachment,
						attachFailure,
						false,
						TERMINAL_CONNECTION_FAILURE_MESSAGE_ID,
					)
				) {
					onPaneConnectionStateRef.current?.("error", attachFailure.message);
				}
				return;
			}
			reportRecoverableFailure(attachment, "attach", cause);
		},
		[
			attachReconnectRef,
			isCurrentAttachment,
			onPaneConnectionStateRef,
			presentSessionExit,
			reportFailureForAttachment,
			reportRecoverableFailure,
			reportTerminalForAttachment,
			reportExhausted,
			setAttachmentGeneration,
		],
	);
	const resolveFailureWithCompleteFrame = useCallback(
		(attachment: StructuredTerminalAttachmentIdentity) => {
			if (!isCurrentAttachment(attachment)) return;
			// A complete frame retires the visible failure too, not only the
			// deferred one. A pane that kept reporting a failure it had already
			// recovered from read as a fresh recurrence.
			resolveFailureForAttachment(attachment);
			const pending = pendingRecoveryFailureRef.current;
			if (!pending) return;
			if (
				pending.failedAttachmentKey !== attachment.attachmentKey ||
				pending.replacementAttachmentToken !== attachment.attachmentToken
			) {
				return;
			}
			pendingRecoveryFailureRef.current = null;
		},
		[
			isCurrentAttachment,
			pendingRecoveryFailureRef,
			resolveFailureForAttachment,
		],
	);

	return {
		handleAttachFailure,
		reportAttachmentFailure,
		reportRecoverableFailure,
		resolveFailureWithCompleteFrame,
	};
}
