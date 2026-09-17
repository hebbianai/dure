import {
	type MutableRefObject,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { BufferId, type InputReceipt } from "@/contracts/terminalStateProtocol";
import {
	structuredTerminalLogicalProjectionText,
	structuredTerminalQaMarkerCounts,
} from "@/lib/terminal/qa/structuredTerminalLogicalProjection";
import { terminalResizeRenderObservation } from "@/lib/terminal/qa/terminalResizeRenderObservation";
import { terminalViewportFillObservation } from "@/lib/terminal/qa/terminalViewportFill";
import {
	encodeTerminalFocusIntent,
	encodeTerminalTextIntent,
	type TerminalInputFence,
} from "@/lib/terminal/state/terminalInputIntent";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import type { TerminalQaBufferState } from "@/lib/terminal/terminalViewContracts";
import type {
	TerminalQaInputReceipt,
	TerminalWindowFocusProbe,
	TerminalWindowFocusProbeSurface,
} from "@/lib/terminal/terminalWindowFocusProbe";
import type { TerminalInputFocusHandlerStages } from "@/lib/workspace/performance/workspacePaneFocusPerformance";
import type { PaintedPresentation } from "./terminalCanvasPresentation";

type StructuredInputSender = (
	encode: (recordId: bigint, fence: TerminalInputFence) => Uint8Array,
) => bigint | undefined;

interface PendingQaInput {
	readonly recordId: bigint;
	readonly inputStartedAtMs: number;
	readonly byteLength: number;
	readonly attachmentIdentity: string;
	readonly resolve: (receipt: TerminalQaInputReceipt) => void;
	readonly reject: (error: Error) => void;
}

interface UseStructuredTerminalWindowFocusProbeOptions {
	readonly probe?: TerminalWindowFocusProbe;
	readonly inputRef: RefObject<HTMLTextAreaElement | null>;
	readonly terminalSurfaceRef: RefObject<HTMLDivElement | null>;
	readonly paintedPresentationRef: MutableRefObject<PaintedPresentation | null>;
	readonly readLatestCompleteFrame: () => InstalledTerminalViewportFrame | null;
	readonly attachmentId: string;
	readonly terminalEpoch: string | null;
	readonly inputReady: boolean;
	readonly sendInput: StructuredInputSender;
	readonly sendMeasuredInput: StructuredInputSender;
	readonly scrollRows: (rows: number) => bigint | undefined;
	readonly setFocused: (focused: boolean) => void;
}

interface StructuredTerminalWindowFocusProbeBinding {
	readonly onFocus: () => TerminalInputFocusHandlerStages;
	readonly onBlur: () => void;
	readonly onInputReceipt: (receipt: InputReceipt) => void;
	readonly onPresentationPainted: (presentation: PaintedPresentation) => void;
	readonly onError: (error: unknown) => void;
}

/**
 * Native QA observes the same complete projection installed in the structured
 * DOM. This surface never reads xterm buffers, raw transport bytes, or browser
 * history; input actions finish only after their correlated Host receipt.
 */
export function useStructuredTerminalWindowFocusProbe({
	probe,
	inputRef,
	terminalSurfaceRef,
	paintedPresentationRef,
	readLatestCompleteFrame,
	attachmentId,
	terminalEpoch,
	inputReady,
	sendInput,
	sendMeasuredInput,
	scrollRows,
	setFocused,
}: UseStructuredTerminalWindowFocusProbeOptions): StructuredTerminalWindowFocusProbeBinding {
	const probeRef = useRef(probe);
	const sendInputRef = useRef(sendInput);
	const sendMeasuredInputRef = useRef(sendMeasuredInput);
	const inputReadyRef = useRef(inputReady);
	const scrollRowsRef = useRef(scrollRows);
	const attachmentRef = useRef({ attachmentId, terminalEpoch });
	const setFocusedRef = useRef(setFocused);
	const pendingRef = useRef<PendingQaInput | null>(null);
	const suppressDomFocusIntentRef = useRef(false);
	const synchronizedIdentityRef = useRef("");
	const completedWritesRef = useRef(0);
	const completeFrameSwapsRef = useRef(0);
	const maxWriteLatencyMsRef = useRef(0);
	const lastProjectionRevisionRef = useRef<bigint | null>(null);
	probeRef.current = probe;
	sendInputRef.current = sendInput;
	sendMeasuredInputRef.current = sendMeasuredInput;
	inputReadyRef.current = inputReady;
	scrollRowsRef.current = scrollRows;
	attachmentRef.current = { attachmentId, terminalEpoch };
	setFocusedRef.current = setFocused;

	const rejectPending = useCallback((reason: string) => {
		const pending = pendingRef.current;
		pendingRef.current = null;
		pending?.reject(new Error(reason));
	}, []);
	const scrollRowsForQa = useCallback(
		(rows: number) => scrollRowsRef.current(rows),
		[],
	);

	const issueQaInput = useCallback(
		(
			encode: (recordId: bigint, fence: TerminalInputFence) => Uint8Array,
			byteLength: number,
			sender: StructuredInputSender = sendInputRef.current,
		) =>
			new Promise<TerminalQaInputReceipt>((resolve, reject) => {
				if (pendingRef.current) {
					reject(new Error("structured terminal QA input is already pending"));
					return;
				}
				if (!inputReadyRef.current) {
					reject(new Error("structured terminal QA input is not ready"));
					return;
				}
				const inputStartedAtMs = Date.now();
				const attachment = attachmentRef.current;
				const recordId = sender(encode);
				if (recordId === undefined) {
					reject(new Error("structured terminal QA input was not issued"));
					return;
				}
				pendingRef.current = {
					recordId,
					inputStartedAtMs,
					byteLength,
					attachmentIdentity:
						`${attachment.attachmentId}:${attachment.terminalEpoch ?? "pending"}`,
					resolve,
					reject,
				};
			}),
		[],
	);

	const onInputReceipt = useCallback((receipt: InputReceipt) => {
		const pending = pendingRef.current;
		if (!pending || pending.recordId !== receipt.inReplyToRecordId) return;
		pendingRef.current = null;
		const hostReceiptAtMs = Date.now();
		const latency = hostReceiptAtMs - pending.inputStartedAtMs;
		maxWriteLatencyMsRef.current = Math.max(
			maxWriteLatencyMsRef.current,
			latency,
		);
		if (receipt.outcome.case !== "writtenToPty") {
			const error = new Error(
				`structured terminal QA input ${receipt.outcome.case || "failed"}`,
			);
			pending.reject(error);
			probeRef.current?.onError(error);
			return;
		}
		completedWritesRef.current += 1;
		pending.resolve({
			requestId: String(pending.recordId),
			attachmentIdentity: pending.attachmentIdentity,
			state: "written_to_pty",
			inputStartedAtMs: pending.inputStartedAtMs,
			hostReceiptAtMs,
		});
	}, []);

	const focusForQa = useCallback(async () => {
		const input = inputRef.current;
		if (!input) throw new Error("structured terminal input surface is missing");
		suppressDomFocusIntentRef.current = true;
		try {
			input.focus();
		} finally {
			suppressDomFocusIntentRef.current = false;
		}
		setFocusedRef.current(true);
		await issueQaInput(
			(recordId, fence) =>
				encodeTerminalFocusIntent(recordId, fence, true),
			0,
		);
	}, [inputRef, issueQaInput]);

	const releaseForQa = useCallback(async () => {
		const input = inputRef.current;
		suppressDomFocusIntentRef.current = true;
		try {
			input?.blur();
		} finally {
			suppressDomFocusIntentRef.current = false;
		}
		setFocusedRef.current(false);
		await issueQaInput(
			(recordId, fence) =>
				encodeTerminalFocusIntent(recordId, fence, false),
			0,
		);
	}, [inputRef, issueQaInput]);

	const writeMarker = useCallback(
		(marker: string, input?: string) => {
			const escapedMarker = [...marker]
				.map(
					(character) =>
						`\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
				)
				.join("");
			const text = input ?? `printf '${escapedMarker}\\n'\r`;
			return issueQaInput(
				(recordId, fence) =>
					encodeTerminalTextIntent(recordId, fence, text),
				new TextEncoder().encode(text).byteLength,
				sendMeasuredInputRef.current,
			);
		},
		[issueQaInput],
	);

	const bufferState = useCallback(
		(logicalMarker?: string) =>
			structuredTerminalQaPresentationState(
				paintedPresentationRef.current,
				terminalSurfaceRef.current,
				logicalMarker,
			),
		[paintedPresentationRef, terminalSurfaceRef],
	);
	const markerCounts = useCallback(
		() => structuredTerminalQaPaintedMarkerCounts(paintedPresentationRef.current),
		[paintedPresentationRef],
	);
	const projectionMarkerCounts = useCallback(
		() => structuredTerminalQaProjectionMarkerCounts(readLatestCompleteFrame()),
		[readLatestCompleteFrame],
	);
	const renderMetrics = useCallback(() => {
		const pending = pendingRef.current;
		return {
			queuedWrites: pending ? 1 : 0,
			queuedBytes: pending?.byteLength ?? 0,
			activeBytes: pending?.byteLength ?? 0,
			activeWriteAgeMs: pending
				? Math.max(0, Date.now() - pending.inputStartedAtMs)
				: null,
			completedWrites: completedWritesRef.current,
			// The native QA wire name predates structured projections. This count
			// now means complete-frame DOM swaps; no snapshot is retained client-side.
			snapshotCollapses: completeFrameSwapsRef.current,
			maxWriteLatencyMs: maxWriteLatencyMsRef.current,
		};
	}, []);

	const onPresentationPainted = useCallback(
		(presentation: PaintedPresentation) => {
			const projectionRevision = presentation.frame.frame.projectionRevision;
			if (
				lastProjectionRevisionRef.current !== null &&
				lastProjectionRevisionRef.current !== projectionRevision
			) {
				completeFrameSwapsRef.current += 1;
			}
			lastProjectionRevisionRef.current = projectionRevision;
			const identity = `${presentation.attachmentId}\u001f${presentation.terminalEpoch ?? ""}`;
			if (synchronizedIdentityRef.current !== identity) {
				synchronizedIdentityRef.current = identity;
				probeRef.current?.onHydrationChange(false);
				probeRef.current?.onSynchronized();
			}
			probeRef.current?.onPresented(
				structuredTerminalQaPresentationState(
					presentation,
					terminalSurfaceRef.current,
				),
			);
		},
		[terminalSurfaceRef],
	);

	const onFocus = useCallback(() => {
		const startedAt = performance.now();
		setFocusedRef.current(true);
		const projectedAt = performance.now();
		if (suppressDomFocusIntentRef.current || !inputReadyRef.current) {
			return {
				projectionMs: Math.max(0, projectedAt - startedAt),
				intentDispatchMs: null,
			};
		}
		const intentStartedAt = performance.now();
		sendInputRef.current((recordId, fence) =>
			encodeTerminalFocusIntent(recordId, fence, true),
		);
		const dispatchedAt = performance.now();
		return {
			projectionMs: Math.max(0, projectedAt - startedAt),
			intentDispatchMs: Math.max(0, dispatchedAt - intentStartedAt),
		};
	}, []);
	const onBlur = useCallback(() => {
		setFocusedRef.current(false);
		if (suppressDomFocusIntentRef.current || !inputReadyRef.current) return;
		sendInputRef.current((recordId, fence) =>
			encodeTerminalFocusIntent(recordId, fence, false),
		);
	}, []);
	const onError = useCallback((error: unknown) => {
		probeRef.current?.onError(error);
	}, []);

	useLayoutEffect(() => {
		synchronizedIdentityRef.current = "";
		lastProjectionRevisionRef.current = null;
		rejectPending("structured terminal attachment changed");
		probe?.onHydrationChange(true);
	}, [attachmentId, probe, rejectPending, terminalEpoch]);

	useEffect(() => {
		if (!probe) return;
		const surface: TerminalWindowFocusProbeSurface = {
			focus: focusForQa,
			releaseKeyboardControl: releaseForQa,
			writeMarker,
			scrollRows: scrollRowsForQa,
			markerCounts,
			projectionMarkerCounts,
			bufferState,
			renderMetrics,
		};
		return probe.connect(surface);
	}, [
		bufferState,
		focusForQa,
		markerCounts,
		projectionMarkerCounts,
		probe,
		releaseForQa,
		renderMetrics,
		scrollRowsForQa,
		writeMarker,
	]);

	useEffect(
		() => () => rejectPending("structured terminal QA surface disconnected"),
		[rejectPending],
	);

	return { onFocus, onBlur, onInputReceipt, onPresentationPainted, onError };
}

function structuredTerminalQaPaintedMarkerCounts(
	presentation: PaintedPresentation | null,
): Record<string, number> {
	if (!presentation) return {};
	return structuredTerminalQaMarkerCounts(
		presentation.paint.rows,
		presentation.paint.visibleText,
	);
}

function structuredTerminalQaProjectionMarkerCounts(
	installed: InstalledTerminalViewportFrame | null,
): Record<string, number> {
	const tables = installed?.frame.tables;
	const visibleText =
		installed && tables
			? installed.frame.rows.map((row) =>
					row.cells
						.map((cell) => tables.graphemes[cell.graphemeIndex]?.text ?? "")
						.join(""),
				)
			: [];
	return structuredTerminalQaMarkerCounts(
		installed?.frame.rows ?? [],
		visibleText,
	);
}

function structuredTerminalQaPresentationState(
	presentation: PaintedPresentation | null,
	surface: HTMLDivElement | null,
	logicalMarker?: string,
): TerminalQaBufferState {
	const bounds = surface?.getBoundingClientRect();
	const containerHeight = Math.max(0, bounds?.height ?? 0);
	if (!presentation) {
		return {
			columns: 0,
			rows: 0,
			fitColumns: 0,
			fitRows: 0,
			fitDimensionsMatch: false,
			viewportFill: terminalViewportFillObservation({
				containerHeight,
				gridHeight: 0,
				rows: 0,
			}),
			bufferLength: 0,
			scrollbackRows: 0,
			viewportY: 0,
			atBottom: false,
			concealed: false,
			resizeRenderSeedVisible: false,
		};
	}
	const { frame } = presentation.frame;
	const { metrics, visibleText } = presentation.paint;
	const logicalVisibleText = structuredTerminalLogicalProjectionText(
		presentation.paint.rows,
		visibleText,
	);
	const width = Math.max(0, bounds?.width ?? presentation.width);
	const height = Math.max(0, bounds?.height ?? presentation.height);
	const fitColumns = Math.max(0, Math.floor(width / metrics.cellWidth));
	const fitRows = Math.max(0, Math.floor(height / metrics.rowHeight));
	const rowsFromTailValue = frame.rowsFromTail ?? 0n;
	const rowsFromTail = Number(
		rowsFromTailValue > BigInt(Number.MAX_SAFE_INTEGER)
			? BigInt(Number.MAX_SAFE_INTEGER)
			: rowsFromTailValue,
	);
	const visibleScrollbackMarker = logicalVisibleText.match(
		/HMUX_SCROLL_QA_[A-F0-9]{12}_READY/,
	)?.[0];
	return {
		columns: frame.canonicalColumns,
		rows: frame.viewportRows,
		fitColumns,
		fitRows,
		fitDimensionsMatch:
			fitColumns === frame.canonicalColumns && fitRows === frame.viewportRows,
		viewportFill: terminalViewportFillObservation({
			containerHeight: height,
			gridHeight: frame.viewportRows * metrics.rowHeight,
			rows: frame.viewportRows,
		}),
		bufferLength: frame.rows.length,
		// Latest-only projection exposes a bounded viewport, not browser history.
		scrollbackRows: rowsFromTail + (frame.hasMoreBefore ? 1 : 0),
		viewportY: rowsFromTail,
		atBottom: frame.followTail && !frame.hasMoreAfter,
		concealed: false,
		...(visibleScrollbackMarker ? { visibleScrollbackMarker } : {}),
		...(logicalMarker === undefined
			? {}
			: {
					logicalScrollbackMarkerPresent:
						logicalVisibleText.includes(logicalMarker),
				}),
		resizeRenderSeedVisible: visibleText.some((line) =>
			line.includes("DURE_RESIZE_QA_SEED_READY"),
		),
		resizeRender: terminalResizeRenderObservation({
			lines: visibleText,
			buffer:
				frame.activeBuffer === BufferId.ALTERNATE ? "alternate" : "normal",
			columns: frame.canonicalColumns,
			rows: frame.viewportRows,
		}),
	};
}
