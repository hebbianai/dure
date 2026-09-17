import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useLayoutEffect,
	useRef,
} from "react";
import type {
	TerminalDocumentResizeSurfaceRegistration,
	TerminalResizeObservation,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import type { PaintedPresentation } from "./terminalCanvasPresentation";
import { useTerminalCanvasFontReadiness } from "./useTerminalCanvasFontReadiness";

interface TerminalCanvasSurfaceRefreshOptions {
	readonly geometryFrameRef: RefObject<number | undefined>;
	readonly paintedPresentationRef: RefObject<PaintedPresentation | null>;
	readonly resizeRegistrationRef: RefObject<
		TerminalDocumentResizeSurfaceRegistration | undefined
	>;
	readonly setPaintRevision: Dispatch<SetStateAction<number>>;
	readonly invalidateFontMetrics: () => void;
	readonly metricRevision: string;
	readonly holdPresentation: () => void;
}

export function useTerminalCanvasSurfaceRefresh({
	geometryFrameRef,
	paintedPresentationRef,
	resizeRegistrationRef,
	setPaintRevision,
	invalidateFontMetrics,
	metricRevision,
	holdPresentation,
}: TerminalCanvasSurfaceRefreshOptions): (
	observation?: TerminalResizeObservation,
) => void {
	const scheduleGeometryCommit = useCallback(
		(observation?: TerminalResizeObservation) => {
			const registration = resizeRegistrationRef.current;
			if (!registration) return;
			const captured = observation ?? registration.captureObservation();
			if (geometryFrameRef.current !== undefined) {
				cancelAnimationFrame(geometryFrameRef.current);
			}
			geometryFrameRef.current = requestAnimationFrame(() => {
				geometryFrameRef.current = undefined;
				void registration.commitOrdinary(captured);
			});
		},
		[geometryFrameRef, resizeRegistrationRef],
	);
	const refreshCanvasMetrics = useCallback(() => {
		holdPresentation();
		invalidateFontMetrics();
		if (paintedPresentationRef.current === null) return;
		const observation = resizeRegistrationRef.current?.noteGeometryChanged();
		setPaintRevision((revision) => revision + 1);
		if (observation) scheduleGeometryCommit(observation);
	}, [
		paintedPresentationRef,
		holdPresentation,
		invalidateFontMetrics,
		resizeRegistrationRef,
		scheduleGeometryCommit,
		setPaintRevision,
	]);
	const metricRevisionRef = useRef(metricRevision);
	useLayoutEffect(() => {
		if (metricRevisionRef.current === metricRevision) return;
		metricRevisionRef.current = metricRevision;
		refreshCanvasMetrics();
	}, [metricRevision, refreshCanvasMetrics]);
	useTerminalCanvasFontReadiness(refreshCanvasMetrics);
	return scheduleGeometryCommit;
}
