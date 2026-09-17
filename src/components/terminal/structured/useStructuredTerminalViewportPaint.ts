import { openUrl } from "@tauri-apps/plugin-opener";
import { useLayoutEffect, useRef } from "react";
import type { TerminalBoxCache } from "@/lib/terminal/geometry/terminalBoxCache";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import type {
	TerminalCanvasRenderer,
	TerminalCanvasTheme,
} from "./TerminalCanvasRenderer";
import type { TerminalViewportDomRenderer } from "./TerminalViewportDomRenderer";
import {
	holdTerminalCanvasPresentation,
	type PaintedPresentation,
	releaseTerminalCanvasPresentation,
	type TerminalProjectionTiming,
} from "./terminalCanvasPresentation";
import type { TerminalResizePresentationState } from "./useTerminalResizePresentation";

interface MutableRef<T> {
	current: T;
}

interface StructuredTerminalViewportPaintOptions {
	readonly sessionId: string;
	readonly terminalSurfaceRef: MutableRef<HTMLDivElement | null>;
	readonly presentationLayerRef: MutableRef<HTMLDivElement | null>;
	readonly surfaceBox: TerminalBoxCache;
	readonly paintedPresentationRef: MutableRef<PaintedPresentation | null>;
	readonly paintedRef: MutableRef<boolean>;
	readonly geometryRef: MutableRef<{ columns: number; rows: number }>;
	readonly confirmedGeometryRef: MutableRef<{ columns: number; rows: number }>;
	readonly resizePresentationRef: MutableRef<TerminalResizePresentationState>;
	readonly resizePresentationReady: boolean;
	readonly resizePaintRevision: number;
	readonly completeResizePresentation: (requestGeneration: number) => void;
	readonly installedFrame: InstalledTerminalViewportFrame | null;
	readonly attachmentId: string;
	readonly terminalEpoch: string | null;
	readonly throughOutputSeq: bigint;
	readonly focused: boolean;
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly lineHeight: number;
	readonly canvasTheme: TerminalCanvasTheme;
	readonly canvasRenderer: TerminalCanvasRenderer;
	readonly viewportRenderer: TerminalViewportDomRenderer;
	readonly reportPresentationPainted: (
		presentation: PaintedPresentation,
	) => void;
	readonly afterPresentationPainted?: (
		presentation: PaintedPresentation,
		throughOutputSeq: bigint,
		timing: TerminalProjectionTiming,
	) => void;
	readonly onResizePresentationPainted?: (recordId: bigint) => void;
	readonly onFirstPaint?: () => void;
}

/** Owns the DOM projection paint boundary. Focus changes update only the
 * existing DOM cursor; frame/geometry/theme changes alone run the full layout
 * measurement and publish a painted-presentation receipt. */
export function useStructuredTerminalViewportPaint({
	sessionId,
	terminalSurfaceRef,
	presentationLayerRef,
	surfaceBox,
	paintedPresentationRef,
	paintedRef,
	geometryRef,
	confirmedGeometryRef,
	resizePresentationRef,
	resizePresentationReady,
	resizePaintRevision,
	completeResizePresentation,
	installedFrame,
	attachmentId,
	terminalEpoch,
	throughOutputSeq,
	focused,
	fontFamily,
	fontSize,
	lineHeight,
	canvasTheme,
	canvasRenderer,
	viewportRenderer,
	reportPresentationPainted,
	afterPresentationPainted,
	onResizePresentationPainted,
	onFirstPaint,
}: StructuredTerminalViewportPaintOptions): void {
	const focusedRef = useRef(focused);
	focusedRef.current = focused;

	useLayoutEffect(() => {
		const terminalSurface = terminalSurfaceRef.current;
		if (terminalSurface) viewportRenderer.setFocused(terminalSurface, focused);
	}, [focused, terminalSurfaceRef, viewportRenderer]);

	useLayoutEffect(() => {
		const terminalSurface = terminalSurfaceRef.current;
		const presentationLayer = presentationLayerRef.current;
		if (!terminalSurface || !presentationLayer) return;
		const resizePresentation = resizePresentationRef.current;
		let paintedResizeRecordId: bigint | undefined;
		if (
			(resizePresentation.held || resizePresentation.largeViewHeld) &&
			paintedPresentationRef.current !== null &&
			(resizePresentation.largeViewHeld || !resizePresentationReady)
		) {
			return;
		}
		if (
			resizePresentationReady &&
			resizePresentation.finalGrid &&
			resizePresentation.requestGeneration !== undefined
		) {
			const finalGrid = resizePresentation.finalGrid;
			paintedResizeRecordId = resizePresentation.appliedRecordId;
			confirmedGeometryRef.current = finalGrid;
			geometryRef.current = finalGrid;
			completeResizePresentation(resizePresentation.requestGeneration);
		}
		if (!resizePresentationRef.current.held) {
			releaseTerminalCanvasPresentation(presentationLayer);
		}
		if (!installedFrame) {
			viewportRenderer.clear(terminalSurface);
			presentationLayer.style.removeProperty(
				"--terminal-cursor-cell-foreground",
			);
			presentationLayer.style.removeProperty(
				"--terminal-cursor-cell-background",
			);
			paintedPresentationRef.current = null;
			return;
		}
		const projectionStartedAt = performance.now();
		const bounds = surfaceBox.read();
		const metrics = canvasRenderer.measure(
			bounds.width,
			bounds.height,
			fontFamily,
			fontSize,
			lineHeight,
		);
		const painted = viewportRenderer.render(terminalSurface, installedFrame, {
			attachmentId,
			terminalEpoch,
			fontFamily,
			fontSize,
			lineHeight,
			focused: focusedRef.current,
			theme: canvasTheme,
			metrics,
			openHyperlink: (uri) => {
				void openUrl(uri).catch(() => {});
			},
		});
		// The browser-owned IME overlay is a sibling of the imperative terminal
		// DOM, so publish its cursor-cell colors at their shared paint boundary.
		if (
			presentationLayer.style.getPropertyValue(
				"--terminal-cursor-cell-foreground",
			) !== painted.cursorCellColors.foreground
		) {
			presentationLayer.style.setProperty(
				"--terminal-cursor-cell-foreground",
				painted.cursorCellColors.foreground,
			);
		}
		if (
			presentationLayer.style.getPropertyValue(
				"--terminal-cursor-cell-background",
			) !== painted.cursorCellColors.background
		) {
			presentationLayer.style.setProperty(
				"--terminal-cursor-cell-background",
				painted.cursorCellColors.background,
			);
		}
		const projectionCommittedAt = performance.now();
		const paintedPresentation = {
			width: bounds.width,
			height: bounds.height,
			sessionId,
			attachmentId,
			terminalEpoch,
			frame: installedFrame,
			paint: painted,
		};
		paintedPresentationRef.current = paintedPresentation;
		reportPresentationPainted(paintedPresentation);
		afterPresentationPainted?.(paintedPresentation, throughOutputSeq, {
			projectionStartedAt,
			projectionCommittedAt,
		});
		if (paintedResizeRecordId !== undefined) {
			onResizePresentationPainted?.(paintedResizeRecordId);
		}
		if (resizePresentationRef.current.held) {
			holdTerminalCanvasPresentation(presentationLayer, paintedPresentation);
		}
		if (!paintedRef.current) {
			paintedRef.current = true;
			onFirstPaint?.();
		}
	}, [
		attachmentId,
		afterPresentationPainted,
		canvasRenderer,
		canvasTheme,
		completeResizePresentation,
		confirmedGeometryRef,
		fontFamily,
		fontSize,
		lineHeight,
		geometryRef,
		installedFrame,
		onFirstPaint,
		onResizePresentationPainted,
		paintedPresentationRef,
		paintedRef,
		presentationLayerRef,
		reportPresentationPainted,
		resizePaintRevision,
		resizePresentationReady,
		resizePresentationRef,
		sessionId,
		surfaceBox,
		terminalEpoch,
		terminalSurfaceRef,
		throughOutputSeq,
		viewportRenderer,
	]);
}
