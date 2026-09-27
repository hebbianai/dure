import { type RefObject, useCallback, useRef } from "react";
import type { TerminalBoxCache } from "@/lib/terminal/geometry/terminalBoxCache";
import { encodeTerminalResizeIntent } from "@/lib/terminal/state/terminalInputIntent";
import {
	observeTerminalResizeGeometry,
	terminalResizeRetryAfterFailure,
} from "@/lib/terminal/state/terminalIntentReceiptPolicy";
import type { TerminalCanvasRenderer } from "./TerminalCanvasRenderer";
import {
	isCurrentTerminalCanvasPresentation,
	type PaintedPresentation,
} from "./terminalCanvasPresentation";
import type { StructuredTerminalViewportTransport } from "./structuredTerminalViewportTransportContract";
import type { useStructuredTerminalAttachmentLifecycle } from "./useStructuredTerminalAttachmentLifecycle";
import type { useStructuredTerminalLargeViewLifecycle } from "./useStructuredTerminalLargeViewLifecycle";
import type { useTerminalResizePresentation } from "./useTerminalResizePresentation";

interface GeometryCommitOptions {
	containerRef: RefObject<HTMLDivElement | null>;
	viewportTransport: StructuredTerminalViewportTransport;
	workspaceActiveRef: RefObject<boolean>;
	surfaceBox: TerminalBoxCache;
	canvasRenderer: TerminalCanvasRenderer;
	resolvedFontFamily: string;
	fontSize: number;
	lineHeight: number;
	phoneColumns: number | undefined;
	phoneWidthPendingRef: RefObject<boolean>;
	resizeController: ReturnType<typeof useTerminalResizePresentation>;
	attachmentLifecycle: ReturnType<
		typeof useStructuredTerminalAttachmentLifecycle
	>;
	syncLargeViewReturnTarget: ReturnType<
		typeof useStructuredTerminalLargeViewLifecycle
	>;
	attachedGeometryPendingRef: RefObject<string | undefined>;
	paintedPresentationRef: RefObject<PaintedPresentation | null>;
	sessionId: string;
}

/** Publish measured desktop geometry and verified phone width on the same attachment. */
export function useStructuredTerminalGeometryCommit({
	containerRef,
	viewportTransport,
	workspaceActiveRef,
	surfaceBox,
	canvasRenderer,
	resolvedFontFamily,
	fontSize,
	lineHeight,
	phoneColumns,
	phoneWidthPendingRef,
	resizeController,
	attachmentLifecycle,
	syncLargeViewReturnTarget,
	attachedGeometryPendingRef,
	paintedPresentationRef,
	sessionId,
}: GeometryCommitOptions) {
	const measuredGridRef = useRef<{ columns: number; rows: number } | undefined>(
		undefined,
	);
	const {
		replica: viewportReplica,
		observerIdRef,
		attachedObserverRef,
		presentationIsCurrent,
		sendInput,
	} = viewportTransport;
	const installedFrame = viewportReplica.frame;
	const {
		presentationRef: resizePresentationRef,
		request: requestResizePresentation,
		applied: applyResizePresentation,
		finish: finishResizePresentation,
		releaseFailed: releaseFailedResizePresentation,
	} = resizeController;
	const {
		confirmedGeometryRef,
		geometryRef,
		resizeRetryRef,
		hasIssuedGeometryRef,
		scheduleGeometryCommit,
	} = attachmentLifecycle;
	const commitGeometry = useCallback((): Promise<boolean> | boolean => {
		const host = containerRef.current;
		const observerId = observerIdRef.current;
		if (!host || !observerId || attachedObserverRef.current !== observerId)
			return false;
		if (!viewportTransport.writable) return false;
		if (workspaceActiveRef.current) {
			const bounds = surfaceBox.read();
			if (bounds.width <= 0 || bounds.height <= 0) return false;
			const measured = canvasRenderer.measure(
				bounds.width,
				bounds.height,
				resolvedFontFamily,
				fontSize,
				lineHeight,
			);
			measuredGridRef.current = {
				columns: measured.columns,
				rows: measured.rows,
			};
		}
		const measured = measuredGridRef.current;
		if (!measured) return false;
		// Existing Hosts still choose the narrowest writer. Lift this desktop's
		// proposal while a verified Hub phone connection needs a wider grid.
		const metrics = {
			columns: Math.max(measured.columns, phoneColumns ?? measured.columns),
			rows: measured.rows,
		};
		if (
			resizePresentationRef.current.requestGeneration !== undefined &&
			resizePresentationRef.current.finalGrid?.columns === metrics.columns &&
			resizePresentationRef.current.finalGrid.rows === metrics.rows
		) {
			phoneWidthPendingRef.current = false;
			syncLargeViewReturnTarget();
			return true;
		}
		if (
			resizePresentationRef.current.requestGeneration === undefined &&
			confirmedGeometryRef.current.columns === metrics.columns &&
			confirmedGeometryRef.current.rows === metrics.rows
		) {
			finishResizePresentation();
			phoneWidthPendingRef.current = false;
			syncLargeViewReturnTarget();
			return true;
		}
		if (!presentationIsCurrent || !installedFrame) {
			attachedGeometryPendingRef.current = observerId;
			return false;
		}
		geometryRef.current = { columns: metrics.columns, rows: metrics.rows };
		resizeRetryRef.current = observeTerminalResizeGeometry(
			resizeRetryRef.current,
			metrics,
		);
		syncLargeViewReturnTarget();
		const requestGeneration = requestResizePresentation(
			{ columns: metrics.columns, rows: metrics.rows },
			hasIssuedGeometryRef.current &&
				(installedFrame.frame.canonicalColumns !== metrics.columns ||
					installedFrame.frame.viewportRows !== metrics.rows),
			isCurrentTerminalCanvasPresentation(
				paintedPresentationRef.current,
				sessionId,
				viewportReplica.attachmentId,
				viewportReplica.terminalEpoch,
			),
		);
		hasIssuedGeometryRef.current = true;
		const recordId = sendInput(
			(recordId, fence) =>
				encodeTerminalResizeIntent(
					recordId,
					fence,
					metrics.columns,
					metrics.rows,
				),
			"resize",
			{
				onApplied: (outcome, afterProjectionRevision, recordId) => {
					if (outcome.case !== "appliedToTerminal") return;
					resizeRetryRef.current = undefined;
					applyResizePresentation(
						requestGeneration,
						outcome.value.columns,
						afterProjectionRevision,
						recordId,
					);
				},
				onFailure: (_failure, outcome) => {
					if (
						resizePresentationRef.current.requestGeneration !==
						requestGeneration
					)
						return false;
					geometryRef.current = confirmedGeometryRef.current;
					syncLargeViewReturnTarget();
					releaseFailedResizePresentation(requestGeneration);
					const retry = terminalResizeRetryAfterFailure(
						resizeRetryRef.current,
						metrics,
						outcome,
					);
					resizeRetryRef.current = retry.state;
					if (!retry.retry) return false;
					phoneWidthPendingRef.current = true;
					scheduleGeometryCommit();
					return true;
				},
			},
		);
		if (recordId === undefined) {
			attachedGeometryPendingRef.current = observerId;
			geometryRef.current = confirmedGeometryRef.current;
			releaseFailedResizePresentation(requestGeneration);
			return false;
		}
		phoneWidthPendingRef.current = false;
		return true;
	}, [
		applyResizePresentation,
		canvasRenderer,
		finishResizePresentation,
		fontSize,
		phoneColumns,
		viewportTransport.writable,
		installedFrame,
		lineHeight,
		presentationIsCurrent,
		resolvedFontFamily,
		releaseFailedResizePresentation,
		requestResizePresentation,
		scheduleGeometryCommit,
		sendInput,
		sessionId,
		surfaceBox,
		syncLargeViewReturnTarget,
		viewportReplica,
	]);
	return commitGeometry;
}
