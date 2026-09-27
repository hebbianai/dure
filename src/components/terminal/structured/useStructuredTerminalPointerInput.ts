import { type RefObject, useCallback } from "react";
import { PointerKind } from "@/contracts/terminalStateProtocol";
import {
	encodeTerminalPointerIntent,
	encodeTerminalViewportWheelIntent,
} from "@/lib/terminal/state/terminalInputIntent";
import { TERMINAL_VIEWPORT_WHEEL_CAPABILITY } from "@/lib/terminal/protocol/terminalStateProtocol";
import type { PaintedPresentation } from "./terminalCanvasPresentation";
import type { StructuredTerminalViewportTransport } from "./structuredTerminalViewportTransportContract";

interface PointerInputOptions
	extends Pick<
		StructuredTerminalViewportTransport,
		"sendInput" | "sendViewportIntent" | "supportsCapability"
	> {
	inputReady: boolean;
	terminalSurfaceRef: RefObject<HTMLDivElement | null>;
	paintedPresentationRef: RefObject<PaintedPresentation | null>;
	issueViewportScrollRows: (rows: number) => unknown;
}

export function useStructuredTerminalPointerInput({
	inputReady,
	terminalSurfaceRef,
	paintedPresentationRef,
	issueViewportScrollRows,
	sendInput,
	sendViewportIntent,
	supportsCapability,
}: PointerInputOptions) {
	const issuePointer = useCallback(
		(
			event: MouseEvent,
			kind:
				| PointerKind.DOWN
				| PointerKind.UP
				| PointerKind.MOVE
				| PointerKind.WHEEL,
			wheelDeltaX = 0,
			wheelDeltaY = 0,
			button = event.button,
			buttons = event.buttons,
		) => {
			if (!inputReady) return;
			const terminalSurface = terminalSurfaceRef.current;
			const metrics = paintedPresentationRef.current?.paint.metrics;
			if (!terminalSurface || !metrics) return;
			const bounds = terminalSurface.getBoundingClientRect();
			const scale = Math.max(1, window.devicePixelRatio || 1);
			const cellWidth = Math.max(1, Math.round(metrics.cellWidth * scale));
			const cellHeight = Math.max(1, Math.round(metrics.rowHeight * scale));
			const surfaceWidth = Math.max(1, metrics.columns * cellWidth);
			const surfaceHeight = Math.max(1, metrics.rows * cellHeight);
			const pixelX = Math.min(
				surfaceWidth - 1,
				Math.max(0, Math.floor((event.clientX - bounds.left) * scale)),
			);
			const pixelY = Math.min(
				surfaceHeight - 1,
				Math.max(0, Math.floor((event.clientY - bounds.top) * scale)),
			);
			const pointer = {
				kind,
				column: Math.floor(pixelX / cellWidth),
				row: Math.floor(pixelY / cellHeight),
				button:
					kind === PointerKind.MOVE || kind === PointerKind.WHEEL ? 0 : button,
				buttons,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				wheelDeltaX,
				wheelDeltaY,
				pixelX,
				pixelY,
				surfaceWidth,
				surfaceHeight,
				cellWidth,
				cellHeight,
				paddingTop: 0,
				paddingBottom: 0,
				paddingRight: 0,
				paddingLeft: 0,
			};
			if (kind === PointerKind.WHEEL) {
				if (!supportsCapability(TERMINAL_VIEWPORT_WHEEL_CAPABILITY)) {
					const rows = -(wheelDeltaY === 0 ? wheelDeltaX : wheelDeltaY);
					issueViewportScrollRows(rows);
					return;
				}
				sendViewportIntent(
					(recordId, fence, viewportFence) =>
						encodeTerminalViewportWheelIntent(recordId, fence, viewportFence, {
							...pointer,
							kind: PointerKind.WHEEL,
						}),
					"wheel",
				);
				return;
			}
			sendInput((recordId, fence) =>
				encodeTerminalPointerIntent(recordId, fence, pointer),
			);
		},
		[
			issueViewportScrollRows,
			inputReady,
			sendInput,
			sendViewportIntent,
			supportsCapability,
		],
	);

	return issuePointer;
}
