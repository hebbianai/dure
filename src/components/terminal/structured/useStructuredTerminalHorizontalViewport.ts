import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import {
	terminalCursorScrollLeft,
	terminalHorizontalScrollLimit,
} from "@/lib/terminal/geometry/terminalHorizontalViewport";
import type { PaintedPresentation } from "./terminalCanvasPresentation";

/** Scroll the presentation, keeping pointer, selection and IME coordinates
 * relative to the same full-width content element. */
export function useStructuredTerminalHorizontalViewport({
	viewportRef,
	contentRef,
	isFocused,
}: {
	readonly viewportRef: RefObject<HTMLDivElement | null>;
	readonly contentRef: RefObject<HTMLDivElement | null>;
	readonly isFocused: () => boolean;
}) {
	const presentationRef = useRef<PaintedPresentation | null>(null);
	const followCursorRef = useRef(false);
	const beginInput = useCallback(() => {
		followCursorRef.current = true;
	}, []);
	const endInput = useCallback(() => {
		followCursorRef.current = false;
	}, []);
	const painted = useCallback(
		(presentation: PaintedPresentation) => {
			const viewport = viewportRef.current;
			const content = contentRef.current;
			if (!viewport || !content) return;
			const previous = presentationRef.current;
			if (
				previous?.attachmentId !== presentation.attachmentId ||
				previous?.terminalEpoch !== presentation.terminalEpoch
			)
				viewport.scrollLeft = 0;
			presentationRef.current = presentation;
			const { columns, cellWidth } = presentation.paint.metrics;
			const width = `${Math.max(presentation.width, columns * cellWidth)}px`;
			if (content.style.width !== width) content.style.width = width;
			const limit = terminalHorizontalScrollLimit(
				presentation.width,
				columns,
				cellWidth,
			);
			if (limit === 0) {
				if (viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
				return;
			}
			const cursor = presentation.frame.frame.cursor;
			if (
				!followCursorRef.current ||
				!isFocused() ||
				!cursor ||
				!presentation.frame.frame.followTail
			)
				return;
			const next = terminalCursorScrollLeft({
				scrollLeft: viewport.scrollLeft,
				viewportWidth: presentation.width,
				columns,
				cellWidth,
				cursorColumn: cursor.column,
			});
			if (viewport.scrollLeft !== next) viewport.scrollLeft = next;
		},
		[contentRef, isFocused, viewportRef],
	);
	const wheel = useCallback(
		(event: WheelEvent): boolean => {
			const viewport = viewportRef.current;
			const presentation = presentationRef.current;
			if (!viewport || !presentation || presentation.width <= 0) return false;
			const { columns, cellWidth } = presentation.paint.metrics;
			const limit = terminalHorizontalScrollLimit(
				presentation.width,
				columns,
				cellWidth,
			);
			const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
			if (
				limit <= 0 ||
				(!horizontal && !(event.shiftKey && event.deltaY !== 0))
			)
				return false;
			const delta = horizontal ? event.deltaX : event.deltaY;
			const unit =
				event.deltaMode === 1
					? cellWidth
					: event.deltaMode === 2
						? presentation.width
						: 1;
			followCursorRef.current = false;
			viewport.scrollLeft = Math.max(
				0,
				Math.min(limit, viewport.scrollLeft + delta * unit),
			);
			event.stopPropagation();
			event.preventDefault();
			return true;
		},
		[viewportRef],
	);
	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		// React delegates wheel passively. A local pan must cancel native
		// scrolling before it reaches the terminal's vertical wheel handler.
		viewport.addEventListener("wheel", wheel, { passive: false });
		return () => viewport.removeEventListener("wheel", wheel);
	}, [viewportRef, wheel]);
	return { painted, beginInput, endInput };
}
