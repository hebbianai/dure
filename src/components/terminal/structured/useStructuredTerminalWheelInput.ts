import {
	type WheelEvent as ReactWheelEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
} from "react";
import {
	terminalPointerWheelRowDelta,
	terminalPointerWheelRows,
} from "./structuredTerminalPointerWheel";

interface StructuredTerminalWheelMetrics {
	readonly rowHeight: number;
	readonly rows: number;
}

interface UseStructuredTerminalWheelInputOptions {
	readonly enabled: boolean;
	readonly inputDisabled: boolean;
	readonly presentationIsCurrent: boolean;
	readonly attachmentId: string;
	readonly observerIdRef: RefObject<string | undefined>;
	readonly attachedObserverRef: RefObject<string | undefined>;
	readonly readMetrics: () => StructuredTerminalWheelMetrics | undefined;
	readonly scrollRows: (rows: number) => void;
	readonly sendPointerWheel: (
		event: MouseEvent,
		wheelRowsX: number,
		wheelRowsY: number,
	) => void;
}

interface PendingWheelInput {
	readonly observerId: string;
	readonly animationFrame: number;
	readonly event: MouseEvent;
	readonly wheelRowsX: number;
	readonly wheelRowsY: number;
}

/** Coalesces browser wheel bursts into one attachment-fenced terminal intent. */
export function useStructuredTerminalWheelInput({
	enabled,
	inputDisabled,
	presentationIsCurrent,
	attachmentId,
	observerIdRef,
	attachedObserverRef,
	readMetrics,
	scrollRows,
	sendPointerWheel,
}: UseStructuredTerminalWheelInputOptions) {
	const pendingRef = useRef<PendingWheelInput | null>(null);
	const cancelPending = useCallback(() => {
		const pending = pendingRef.current;
		if (!pending) return;
		cancelAnimationFrame(pending.animationFrame);
		pendingRef.current = null;
	}, []);
	useEffect(
		() => () => cancelPending(),
		[cancelPending, presentationIsCurrent, attachmentId],
	);

	return (event: ReactWheelEvent) => {
		event.stopPropagation();
		event.preventDefault();
		if (!enabled) return;
		const metrics = readMetrics();
		if (!metrics || (event.deltaX === 0 && event.deltaY === 0)) return;
		const normalizedRows = (delta: number) =>
			terminalPointerWheelRowDelta({
				deltaY: delta,
				deltaMode: event.deltaMode,
				rowHeight: metrics.rowHeight,
				viewportRows: metrics.rows,
			});
		const wheelRowsX = event.deltaX === 0 ? 0 : normalizedRows(event.deltaX);
		const wheelRowsY = event.deltaY === 0 ? 0 : normalizedRows(event.deltaY);
		const observerId = observerIdRef.current;
		if (!observerId || attachedObserverRef.current !== observerId) return;
		const pending = pendingRef.current;
		if (pending?.observerId === observerId) {
			pendingRef.current = {
				...pending,
				event: event.nativeEvent,
				wheelRowsX: pending.wheelRowsX + wheelRowsX,
				wheelRowsY: pending.wheelRowsY + wheelRowsY,
			};
			return;
		}
		if (pending) cancelPending();
		const animationFrame = requestAnimationFrame(() => {
			const current = pendingRef.current;
			if (
				current?.animationFrame !== animationFrame ||
				current.observerId !== observerId
			) {
				return;
			}
			pendingRef.current = null;
			if (
				observerIdRef.current !== observerId ||
				attachedObserverRef.current !== observerId
			) {
				return;
			}
			const boundedX = terminalPointerWheelRows(current.wheelRowsX);
			const boundedY = terminalPointerWheelRows(current.wheelRowsY);
			if (boundedX === 0 && boundedY === 0) return;
			if (inputDisabled) {
				scrollRows(-(boundedY === 0 ? boundedX : boundedY));
				return;
			}
			sendPointerWheel(current.event, boundedX, boundedY);
		});
		pendingRef.current = {
			observerId,
			animationFrame,
			event: event.nativeEvent,
			wheelRowsX,
			wheelRowsY,
		};
	};
}
