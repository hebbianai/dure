import { type RefObject, useLayoutEffect } from "react";
import type { HmuxStructuredTerminalAccess } from "@/lib/ipc";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import { terminalIntentReceiptPendingKinds } from "@/lib/terminal/state/terminalIntentReceiptSequence";
import type { TerminalViewportFrameReplica } from "@/lib/terminal/state/terminalViewportFrameReplica";
import type { UpstreamSequence } from "./structuredTerminalViewportTransportContract";

interface WriterRetirementOptions {
	workspaceActive: boolean;
	hasRetainedInteraction: () => boolean;
	replicaRef: RefObject<
		TerminalViewportFrameReplica<InstalledTerminalViewportFrame>
	>;
	upstreamSequenceRef: RefObject<UpstreamSequence | undefined>;
	attachedObserverRef: RefObject<string | undefined>;
	setAccess: (access: HmuxStructuredTerminalAccess) => void;
}

/** Retire a hidden writer only after its tail, receipts and interactions settle. */
export function useStructuredTerminalWriterRetirement({
	workspaceActive,
	hasRetainedInteraction,
	replicaRef,
	upstreamSequenceRef,
	attachedObserverRef,
	setAccess,
}: WriterRetirementOptions): void {
	useLayoutEffect(() => {
		if (workspaceActive) {
			setAccess("writer");
			return;
		}
		const current = replicaRef.current;
		const sequence = upstreamSequenceRef.current;
		if (
			!sequence ||
			sequence.failed ||
			attachedObserverRef.current !== sequence.observerId ||
			current.frame?.frame.followTail !== true ||
			current.issuedIntentSeq !== current.appliedIntentSeq ||
			Object.values(terminalIntentReceiptPendingKinds(sequence.receipts)).some(
				Boolean,
			) ||
			hasRetainedInteraction()
		) {
			return;
		}
		// Detaching the writer releases its width proposal on existing Hosts.
		// A replacement starts at the tail: keep pinned views and pending work
		// on their original attachment instead of losing history or receipts.
		setAccess("read_only");
	}, [workspaceActive, hasRetainedInteraction]);
}
