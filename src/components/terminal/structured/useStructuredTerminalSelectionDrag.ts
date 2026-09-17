import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import type { ViewportFrame } from "@/contracts/terminalStateProtocol";
import {
	canStartTerminalSelection,
	terminalSelectionMove,
	terminalSelectionScrollDirection,
} from "@/lib/terminal/interaction/terminalSelectionGesture";
import { applyTerminalViewportSelection } from "@/lib/terminal/presentation/terminalViewportSelection";
import {
	hitTerminalSelectionPoint,
	mergeTerminalSelectionDocumentRows,
	type TerminalSelection,
	type TerminalSelectionDocumentDirection,
	type TerminalSelectionDocumentRow,
	terminalSelectionDocumentRows,
	terminalSelectionDocumentText,
} from "@/lib/terminal/state/terminalSelection";

interface StructuredTerminalSelectionMetrics {
	readonly cellWidth: number;
	readonly rowHeight: number;
}

interface StructuredTerminalClick {
	readonly button: number;
	readonly buttons: number;
	readonly forwardClickToTerminal: boolean;
}

interface StructuredTerminalSelectionDragOptions {
	readonly enabled: boolean;
	readonly attachmentIdentity: string;
	readonly terminalSurfaceRef: RefObject<HTMLDivElement | null>;
	readonly frame: ViewportFrame | null;
	readonly readMetrics: () => StructuredTerminalSelectionMetrics | null;
	readonly scrollRows: (rows: number) => bigint | undefined;
	readonly onStart: () => void;
	readonly onClick: (
		event: PointerEvent,
		click: StructuredTerminalClick,
	) => void;
	readonly onCommit: (text: string | undefined) => void;
}

interface StructuredTerminalSelectionDrag {
	readonly pointerId: number;
	readonly originX: number;
	readonly originY: number;
	readonly button: number;
	readonly buttons: number;
	readonly forwardClickToTerminal: boolean;
	clientX: number;
	clientY: number;
	moved: boolean;
	nativeSelection: boolean;
	crossedViewport: boolean;
	direction: 1 | -1 | 0;
	pendingIntentSeq?: bigint;
	projectionRevision?: bigint;
	selection: TerminalSelection | null;
	rows: readonly TerminalSelectionDocumentRow[];
	text: string;
}

/** Owns one local selection drag. Terminal history remains Host-owned: edge
 * movement sends ordered relative viewport intents, while this controller
 * retains only the rows observed during the active presentation gesture. */
export function useStructuredTerminalSelectionDrag(
	options: StructuredTerminalSelectionDragOptions,
) {
	const optionsRef = useRef(options);
	const dragRef = useRef<StructuredTerminalSelectionDrag | null>(null);
	const completedTextRef = useRef("");
	const animationFrameRef = useRef<number | undefined>(undefined);
	optionsRef.current = options;

	const cancelScheduledScroll = useCallback(() => {
		const animationFrame = animationFrameRef.current;
		if (animationFrame === undefined) return;
		cancelAnimationFrame(animationFrame);
		animationFrameRef.current = undefined;
	}, []);

	const updateSelection = useCallback(
		(drag: StructuredTerminalSelectionDrag, frame: ViewportFrame) => {
			const current = optionsRef.current;
			const surface = current.terminalSurfaceRef.current;
			const metrics = current.readMetrics();
			const tables = frame.tables;
			const rows = frame.rows.slice(0, frame.viewportRows);
			if (!surface || !metrics || !tables || rows.length === 0) return;
			const bounds = surface.getBoundingClientRect();
			const direction = terminalSelectionScrollDirection(
				drag,
				bounds,
				metrics.rowHeight,
				frame,
			);
			drag.direction = direction;
			const documentDirection = terminalSelectionDocumentDirection(
				drag,
				bounds,
			);
			const frameChanged = drag.projectionRevision !== frame.projectionRevision;
			if (frameChanged) {
				drag.rows = mergeTerminalSelectionDocumentRows(
					drag.rows,
					terminalSelectionDocumentRows(rows, tables),
					documentDirection,
				);
				drag.projectionRevision = frame.projectionRevision;
			}
			if (!drag.selection) {
				const anchor =
					selectionPointForClient(
						rows,
						tables,
						metrics,
						bounds,
						drag.originX,
						drag.originY,
						"start",
					) ??
					selectionPointForClient(
						rows,
						tables,
						metrics,
						bounds,
						drag.clientX,
						drag.clientY,
						"start",
					);
				if (!anchor) return;
				drag.selection = { anchor, focus: anchor };
			}
			const focus = selectionPointForClient(
				rows,
				tables,
				metrics,
				bounds,
				drag.clientX,
				drag.clientY,
				selectionFocusEdge(drag),
			);
			if (!drag.selection.anchor || !focus) return;
			const selectionChanged =
				drag.selection.focus.logicalLineId !== focus.logicalLineId ||
				drag.selection.focus.logicalCellOffset !== focus.logicalCellOffset;
			drag.selection = { anchor: drag.selection.anchor, focus };
			if (!frameChanged && !selectionChanged) return;
			drag.text = terminalSelectionDocumentText(drag.rows, drag.selection);
			applyTerminalViewportSelection(
				surface,
				drag.selection,
				documentDirection === "newer" ? "start" : "end",
			);
		},
		[],
	);

	const scheduleScroll = useCallback(() => {
		if (animationFrameRef.current !== undefined) return;
		animationFrameRef.current = requestAnimationFrame(() => {
			animationFrameRef.current = undefined;
			const drag = dragRef.current;
			const current = optionsRef.current;
			const frame = current.frame;
			if (!drag?.moved || !frame || drag.pendingIntentSeq !== undefined) return;
			updateSelection(drag, frame);
			if (drag.direction === 0) return;
			const intentSeq = current.scrollRows(drag.direction);
			if (intentSeq !== undefined) {
				drag.crossedViewport = true;
				drag.pendingIntentSeq = intentSeq;
			}
		});
	}, [updateSelection]);

	const finish = useCallback(
		(event: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== event.pointerId) return;
			drag.clientX = event.clientX;
			drag.clientY = event.clientY;
			cancelScheduledScroll();
			const current = optionsRef.current;
			if (drag.moved || drag.nativeSelection) {
				completedTextRef.current = drag.crossedViewport ? drag.text : "";
				current.onCommit(drag.crossedViewport ? drag.text : undefined);
			} else {
				completedTextRef.current = "";
				current.onClick(event, drag);
			}
			dragRef.current = null;
		},
		[cancelScheduledScroll],
	);

	const cancel = useCallback(
		(pointerId?: number) => {
			const drag = dragRef.current;
			if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) {
				return;
			}
			cancelScheduledScroll();
			dragRef.current = null;
		},
		[cancelScheduledScroll],
	);

	useEffect(() => {
		const onMove = (event: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;
			const transition = terminalSelectionMove(drag, event);
			if (transition === "unrelated") return;
			if (transition === "cancel") {
				cancel(event.pointerId);
				return;
			}
			drag.clientX = event.clientX;
			drag.clientY = event.clientY;
			drag.moved = transition === "drag";
			if (!drag.moved) return;
			event.preventDefault();
			const current = optionsRef.current;
			if (current.frame) updateSelection(drag, current.frame);
			scheduleScroll();
		};
		const onCancel = (event: PointerEvent) => cancel(event.pointerId);
		const onBlur = () => cancel();
		const surface = optionsRef.current.terminalSurfaceRef.current;
		const onMouseDown = (event: MouseEvent) => {
			const drag = dragRef.current;
			if (!drag || !canStartTerminalSelection(event)) return;
			if (event.detail >= 2) {
				drag.nativeSelection = true;
				return;
			}
			// The logical drag owns single-click selection. Native word/line
			// multi-click selection remains available on the same DOM surface.
			// Do not clear the document selection: it can be the focused helper
			// textarea's native caret, which focus() alone will not recreate.
			event.preventDefault();
		};
		surface?.addEventListener("mousedown", onMouseDown);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", finish);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("blur", onBlur);
		return () => {
			surface?.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", finish);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("blur", onBlur);
			cancelScheduledScroll();
			dragRef.current = null;
		};
	}, [cancel, cancelScheduledScroll, finish, scheduleScroll, updateSelection]);

	useLayoutEffect(() => {
		const drag = dragRef.current;
		const frame = options.frame;
		if (!drag?.moved || !frame) return;
		updateSelection(drag, frame);
		if (
			drag.pendingIntentSeq !== undefined &&
			frame.appliedIntentSeq >= drag.pendingIntentSeq
		) {
			drag.pendingIntentSeq = undefined;
			scheduleScroll();
		}
	}, [options.frame, scheduleScroll, updateSelection]);

	useEffect(() => {
		completedTextRef.current = "";
		cancel();
	}, [cancel, options.attachmentIdentity]);

	useEffect(() => {
		if (!options.enabled) cancel();
	}, [cancel, options.enabled]);

	const begin = useCallback(
		(event: PointerEvent, forwardClickToTerminal: boolean) => {
			const current = optionsRef.current;
			if (!current.enabled || !canStartTerminalSelection(event)) return false;
			cancelScheduledScroll();
			completedTextRef.current = "";
			dragRef.current = {
				pointerId: event.pointerId,
				originX: event.clientX,
				originY: event.clientY,
				button: event.button,
				buttons: event.buttons,
				forwardClickToTerminal,
				clientX: event.clientX,
				clientY: event.clientY,
				moved: false,
				nativeSelection: false,
				crossedViewport: false,
				direction: 0,
				selection: null,
				rows: [],
				text: "",
			};
			current.onStart();
			return true;
		},
		[cancelScheduledScroll],
	);

	const ownsPointer = useCallback(
		(pointerId: number) => dragRef.current?.pointerId === pointerId,
		[],
	);
	const selectedText = useCallback(() => {
		const drag = dragRef.current;
		return drag?.crossedViewport ? drag.text : completedTextRef.current;
	}, []);

	return { begin, cancel, ownsPointer, selectedText };
}

function terminalSelectionDocumentDirection(
	drag: StructuredTerminalSelectionDrag,
	bounds: DOMRect,
): TerminalSelectionDocumentDirection {
	if (drag.clientY < bounds.top) return "older";
	if (drag.clientY >= bounds.bottom) return "newer";
	return drag.clientY > drag.originY ||
		(drag.clientY === drag.originY && drag.clientX >= drag.originX)
		? "newer"
		: "older";
}

function selectionFocusEdge(
	drag: StructuredTerminalSelectionDrag,
): "start" | "end" {
	return drag.clientY > drag.originY ||
		(drag.clientY === drag.originY && drag.clientX >= drag.originX)
		? "end"
		: "start";
}

function selectionPointForClient(
	rows: ViewportFrame["rows"],
	tables: NonNullable<ViewportFrame["tables"]>,
	metrics: StructuredTerminalSelectionMetrics,
	bounds: DOMRect,
	clientX: number,
	clientY: number,
	edge: "start" | "end",
) {
	const rowIndex = Math.min(
		rows.length - 1,
		Math.max(0, Math.floor((clientY - bounds.top) / metrics.rowHeight)),
	);
	const row = rows[rowIndex];
	if (!row) return null;
	const column = Math.min(
		Math.max(0, row.logicalCellSpan - 1),
		Math.max(0, Math.floor((clientX - bounds.left) / metrics.cellWidth)),
	);
	return hitTerminalSelectionPoint(rows, tables, rowIndex, column, edge);
}
