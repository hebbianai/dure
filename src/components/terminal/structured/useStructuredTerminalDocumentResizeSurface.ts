import { type MutableRefObject, useLayoutEffect } from "react";
import {
	registerTerminalDocumentResizeSurface,
	type TerminalDocumentResizePhase,
	type TerminalDocumentResizeSurfaceRegistration,
	terminalDocumentResizeTargetsSurface,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";

interface StructuredTerminalDocumentResizeSurfaceOptions {
	readonly ownerDocument: Document;
	readonly surfaceId: string;
	readonly sessionId: string;
	readonly observerIdRef: MutableRefObject<string | undefined>;
	readonly attachedObserverRef: MutableRefObject<string | undefined>;
	readonly commitGeometryRef: MutableRefObject<
		() => Promise<boolean> | boolean
	>;
	readonly geometryFrameRef: MutableRefObject<number | undefined>;
	readonly resizeRegistrationRef: MutableRefObject<
		TerminalDocumentResizeSurfaceRegistration | undefined
	>;
	/** Only the on-screen desktop may publish canonical geometry; a retained
	 * hidden presentation measures a skipped subtree and must stay silent. */
	readonly canPublishGeometry: () => boolean;
	readonly holdResizePresentation: (transactionGeneration?: number) => void;
	readonly finishResizePresentation: () => void;
	readonly onInputResizePhaseChange: (
		phase: TerminalDocumentResizePhase,
		transactionGeneration: number,
	) => void;
}

export function useStructuredTerminalDocumentResizeSurface({
	ownerDocument,
	surfaceId,
	sessionId,
	observerIdRef,
	attachedObserverRef,
	commitGeometryRef,
	geometryFrameRef,
	resizeRegistrationRef,
	canPublishGeometry,
	holdResizePresentation,
	finishResizePresentation,
	onInputResizePhaseChange,
}: StructuredTerminalDocumentResizeSurfaceOptions): void {
	useLayoutEffect(() => {
		const registration = registerTerminalDocumentResizeSurface(ownerDocument, {
			surfaceKey: surfaceId,
			sessionKey: sessionId,
			canCommit: () =>
				canPublishGeometry() &&
				observerIdRef.current !== undefined &&
				attachedObserverRef.current === observerIdRef.current,
			commit: () => commitGeometryRef.current(),
			preview: holdResizePresentation,
			onPhaseChange: (phase, transactionGeneration) => {
				onInputResizePhaseChange(phase, transactionGeneration);
				if (
					phase === "dragging" &&
					terminalDocumentResizeTargetsSurface(ownerDocument, surfaceId)
				) {
					holdResizePresentation(transactionGeneration);
				}
				if (phase === "idle") {
					finishResizePresentation();
					return;
				}
				if (geometryFrameRef.current !== undefined) {
					cancelAnimationFrame(geometryFrameRef.current);
					geometryFrameRef.current = undefined;
				}
			},
		});
		resizeRegistrationRef.current = registration;
		return () => {
			if (resizeRegistrationRef.current === registration) {
				resizeRegistrationRef.current = undefined;
			}
			registration.dispose();
		};
	}, [
		attachedObserverRef,
		canPublishGeometry,
		commitGeometryRef,
		finishResizePresentation,
		geometryFrameRef,
		holdResizePresentation,
		onInputResizePhaseChange,
		observerIdRef,
		ownerDocument,
		resizeRegistrationRef,
		sessionId,
		surfaceId,
	]);
}
