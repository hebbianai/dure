// recoverAttachment — extracted verbatim from
// useStructuredTerminalViewportTransport when 9b37efc45 pushed that file past
// the 900-line god-file ceiling. Same useCallback, same deps, same ref
// contract; the transport hook passes its refs/setters through unchanged so
// rerender and recovery semantics are identical.
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from "react";
import type {
	AttachmentRecoveryDisposition,
	AttachmentRecoveryHighWater,
	StructuredTerminalAttachmentIdentity,
	UpstreamSequence,
} from "./structuredTerminalViewportTransportContract";

export function useStructuredTerminalRecoverAttachment({
	isCurrentAttachment,
	cancelPendingPresentation,
	upstreamSequenceRef,
	recoveryHighWaterRef,
	setAttachmentGeneration,
}: {
	isCurrentAttachment: (
		attachment: StructuredTerminalAttachmentIdentity,
		requireAttached?: boolean,
	) => boolean;
	cancelPendingPresentation: (
		attachment: StructuredTerminalAttachmentIdentity,
	) => void;
	upstreamSequenceRef: MutableRefObject<UpstreamSequence | undefined>;
	recoveryHighWaterRef: MutableRefObject<AttachmentRecoveryHighWater>;
	setAttachmentGeneration: Dispatch<SetStateAction<number>>;
}) {
	return useCallback(
		(
			attachment: StructuredTerminalAttachmentIdentity,
		): AttachmentRecoveryDisposition => {
			if (!isCurrentAttachment(attachment)) return { status: "stale" };
			const sequence = upstreamSequenceRef.current;
			if (!sequence || sequence.attachment !== attachment) {
				return { status: "stale" };
			}
			if (sequence.failed) return { status: "duplicate" };
			sequence.failed = true;
			cancelPendingPresentation(attachment);
			if (recoveryHighWaterRef.current.state !== "armed") {
				return { status: "bounded" };
			}
			recoveryHighWaterRef.current = { state: "waiting_for_seed" };
			setAttachmentGeneration((generation) => generation + 1);
			return { status: "started" };
		},
		[
			cancelPendingPresentation,
			isCurrentAttachment,
			recoveryHighWaterRef,
			setAttachmentGeneration,
			upstreamSequenceRef,
		],
	);
}
