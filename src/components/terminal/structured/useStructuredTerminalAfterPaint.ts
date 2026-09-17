import { type MutableRefObject, useCallback } from "react";
import type { TerminalPresentationRole } from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import type {
	PaintedPresentation,
	TerminalProjectionTiming,
} from "./terminalCanvasPresentation";
import type { StructuredTerminalPaneHealthPublisher } from "./useStructuredTerminalPaneHealth";

interface StructuredTerminalAfterPaintOptions {
	readonly presentationRoleRef: MutableRefObject<TerminalPresentationRole>;
	readonly recordTerminalProjection: (
		attachmentId: string,
		role: TerminalPresentationRole,
		timing: TerminalProjectionTiming,
	) => void;
	readonly observerIdRef: MutableRefObject<string | undefined>;
	readonly attachedObserverRef: MutableRefObject<string | undefined>;
	readonly publishPaneHealth: StructuredTerminalPaneHealthPublisher;
	readonly onTextInputPainted: (
		presentation: PaintedPresentation,
		throughOutputSeq: bigint,
	) => void;
	readonly onInputLatencyPainted: (
		presentation: PaintedPresentation,
		throughOutputSeq: bigint,
		timing: TerminalProjectionTiming,
	) => void;
}

/** Fan out one authoritative canvas commit to its downstream observers. */
export function useStructuredTerminalAfterPaint({
	presentationRoleRef,
	recordTerminalProjection,
	observerIdRef,
	attachedObserverRef,
	publishPaneHealth,
	onTextInputPainted,
	onInputLatencyPainted,
}: StructuredTerminalAfterPaintOptions) {
	return useCallback(
		(
			presentation: PaintedPresentation,
			throughOutputSeq: bigint,
			timing: TerminalProjectionTiming,
		) => {
			if (
				presentation.terminalEpoch &&
				observerIdRef.current === presentation.attachmentId &&
				attachedObserverRef.current === presentation.attachmentId
			) {
				publishPaneHealth({
					kind: "frame_presented",
					terminalEpoch: presentation.terminalEpoch,
					sequence: throughOutputSeq.toString(),
				});
			}
			recordTerminalProjection(
				presentation.attachmentId,
				presentationRoleRef.current,
				timing,
			);
			onTextInputPainted(presentation, throughOutputSeq);
			onInputLatencyPainted(presentation, throughOutputSeq, timing);
		},
		[
			attachedObserverRef,
			onInputLatencyPainted,
			onTextInputPainted,
			observerIdRef,
			presentationRoleRef,
			publishPaneHealth,
			recordTerminalProjection,
		],
	);
}
