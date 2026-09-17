import type { IDockviewPanelProps } from "dockview-react";
import {
	type CompositionEvent,
	type FormEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { InputReceipt } from "@/contracts/terminalStateProtocol";
import type { TerminalDocumentResizePhase } from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import {
	retirePaintedTerminalCompositionHandoffs,
	type TerminalCompositionHandoffFence,
	type TerminalCompositionPaintFence,
	terminalActiveCompositionText,
	terminalCompositionProjectionText,
} from "@/lib/terminal/interaction/terminalCompositionHandoff";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import { installTerminalReplacementInput } from "@/lib/terminal/interaction/terminalReplacementInput";
import {
	terminalTextInputAuthorityIsCurrent,
	terminalTextInputMayForward,
} from "@/lib/terminal/interaction/terminalTextInputAuthority";
import type { TerminalInputFocusHandlerStages } from "@/lib/workspace/performance/workspacePaneFocusPerformance";
import type { PaintedPresentation } from "./terminalCanvasPresentation";
import { useStructuredTerminalPaneFocus } from "./useStructuredTerminalPaneFocus";

interface CompositionHandoff extends TerminalCompositionHandoffFence {
	readonly recordId: bigint;
	readonly text: string;
}

export function useStructuredTerminalTextInput(options: {
	readonly paneApi?: IDockviewPanelProps["api"];
	readonly inputRef: RefObject<HTMLTextAreaElement | null>;
	readonly surfaceId: string;
	readonly attachmentId: string;
	readonly terminalEpoch: string | null;
	readonly inputReady: boolean;
	readonly restoreFocus: boolean;
	readonly currentCursor: {
		readonly column: number;
		readonly row: number;
	} | null;
	readonly sendText: (text: string) => bigint | undefined;
	readonly onInputFocus: () => TerminalInputFocusHandlerStages;
}) {
	const { focusPaneInput, recordInputFocusHandler } =
		useStructuredTerminalPaneFocus(options);
	const inputAttachmentKey = `${options.attachmentId}\u001f${options.terminalEpoch ?? "pending"}`;
	const attachmentToken =
		options.terminalEpoch === null ? null : inputAttachmentKey;
	const [compositionText, setCompositionText] = useState("");
	const [compositionAnchor, setCompositionAnchor] = useState<{
		readonly column: number;
		readonly row: number;
	} | null>(null);
	const compositionCommitRef = useRef<{
		text: string;
		generation: number;
	} | null>(null);
	const compositionCommitGenerationRef = useRef(0);
	const compositionHandoffsRef = useRef<readonly CompositionHandoff[]>([]);
	const activeCompositionTextRef = useRef("");
	const lastPaintFenceRef = useRef<TerminalCompositionPaintFence | null>(null);
	const compositionSessionRef = useRef<{
		readonly attachmentToken: string | null;
		readonly host: HTMLTextAreaElement;
	} | null>(null);
	const currentAttachmentRef = useRef(attachmentToken);
	currentAttachmentRef.current = attachmentToken;
	const inputReadyRef = useRef(options.inputReady);
	inputReadyRef.current = options.inputReady;
	const previousAttachmentRef = useRef(attachmentToken);
	const pendingFocusTransferRef = useRef(false);
	// A document resize may temporarily move DOM focus to the sash/body, but it
	// does not replace the terminal's keyboard authority. Remember only the
	// transaction that began while this exact textarea owned the keyboard, then
	// restore it at the existing transaction boundary if nobody else claimed
	// focus. Resize success/failure is deliberately absent from this authority.
	const resizeKeyboardOwnerGenerationRef = useRef<number | null>(null);
	const currentCursorRef = useRef(options.currentCursor);
	currentCursorRef.current = options.currentCursor;
	const sendTextRef = useRef(options.sendText);
	sendTextRef.current = options.sendText;
	const refreshCompositionProjection = useCallback(() => {
		const text = terminalCompositionProjectionText(
			compositionHandoffsRef.current,
			activeCompositionTextRef.current,
		);
		setCompositionText(text);
		if (!text) setCompositionAnchor(null);
	}, []);
	const retirePaintedCompositionHandoffs = useCallback(
		(paint: TerminalCompositionPaintFence | null) => {
			const current = compositionHandoffsRef.current;
			const remaining = retirePaintedTerminalCompositionHandoffs(
				current,
				paint,
			);
			if (remaining === current) return;
			compositionHandoffsRef.current = remaining;
			setCompositionAnchor(null);
			refreshCompositionProjection();
		},
		[refreshCompositionProjection],
	);
	const authorityFor = useCallback(
		(
			host: HTMLTextAreaElement,
			expectedAttachment = currentAttachmentRef.current,
		) => ({
			attachmentCurrent:
				expectedAttachment !== null &&
				expectedAttachment === currentAttachmentRef.current,
			keyboardOwnerCurrent: host.ownerDocument.activeElement === host,
		}),
		[],
	);

	useEffect(() => {
		if (previousAttachmentRef.current === attachmentToken) return;
		previousAttachmentRef.current = attachmentToken;
		pendingFocusTransferRef.current = options.restoreFocus;
		resizeKeyboardOwnerGenerationRef.current = null;
		compositionCommitRef.current = null;
		compositionHandoffsRef.current = [];
		activeCompositionTextRef.current = "";
		if (lastPaintFenceRef.current?.attachmentToken !== attachmentToken) {
			lastPaintFenceRef.current = null;
		}
		compositionSessionRef.current = null;
		const input = options.inputRef.current;
		if (input) input.value = "";
		setCompositionText("");
		setCompositionAnchor(null);
	}, [attachmentToken, options.inputRef, options.restoreFocus]);

	const onResizePhaseChange = useCallback(
		(phase: TerminalDocumentResizePhase, transactionGeneration: number) => {
			const input = options.inputRef.current;
			if (phase === "dragging") {
				resizeKeyboardOwnerGenerationRef.current =
					input && input.ownerDocument.activeElement === input
						? transactionGeneration
						: null;
				return;
			}
			if (
				phase !== "idle" ||
				resizeKeyboardOwnerGenerationRef.current !== transactionGeneration
			) {
				return;
			}
			resizeKeyboardOwnerGenerationRef.current = null;
			if (
				!input ||
				input.disabled ||
				!inputReadyRef.current ||
				currentAttachmentRef.current === null
			) {
				return;
			}
			const ownerDocument = input.ownerDocument;
			if (ownerDocument.activeElement === input) return;
			// A real control or another pane wins. Only the neutral body left by the
			// resize gesture can return the keyboard to its previous terminal owner.
			if (ownerDocument.activeElement !== ownerDocument.body) return;
			input.focus();
		},
		[options.inputRef],
	);

	useEffect(() => {
		if (
			attachmentToken === null ||
			!pendingFocusTransferRef.current ||
			!options.inputReady
		) {
			return;
		}
		if (!options.restoreFocus) {
			pendingFocusTransferRef.current = false;
			return;
		}
		const input = options.inputRef.current;
		if (!input || input.disabled) return;
		const ownerDocument = input.ownerDocument;
		if (ownerDocument.activeElement === input) {
			pendingFocusTransferRef.current = false;
			return;
		}
		if (ownerDocument.activeElement !== ownerDocument.body) {
			pendingFocusTransferRef.current = false;
			return;
		}
		pendingFocusTransferRef.current = false;
		input.focus();
	}, [
		attachmentToken,
		options.inputReady,
		options.inputRef,
		options.restoreFocus,
	]);

	useEffect(() => {
		const input = options.inputRef.current;
		if (!input || attachmentToken === null) return;
		const boundAttachment = attachmentToken;
		return installTerminalReplacementInput({
			input,
			terminalId: options.surfaceId,
			forwardUserInput: async (data) => {
				if (
					terminalTextInputMayForward(
						authorityFor(input, boundAttachment),
						data,
					)
				) {
					sendTextRef.current(data);
				}
			},
		});
	}, [attachmentToken, authorityFor, options.inputRef, options.surfaceId]);

	const clearComposition = useCallback(() => {
		compositionCommitRef.current = null;
		compositionHandoffsRef.current = [];
		activeCompositionTextRef.current = "";
		compositionSessionRef.current = null;
		const input = options.inputRef.current;
		if (input) input.value = "";
		setCompositionText("");
		setCompositionAnchor(null);
	}, [options.inputRef]);
	const finishCompositionHandoff = useCallback(() => {
		if (compositionSessionRef.current) return;
		activeCompositionTextRef.current = "";
		refreshCompositionProjection();
	}, [refreshCompositionProjection]);
	const onFocus = useCallback(() => {
		if (!inputReadyRef.current) return;
		const handlerStartedAt = performance.now();
		const timing = options.onInputFocus();
		const handlerEndedAt = performance.now();
		recordInputFocusHandler({
			...timing,
			handlerStartedAt,
			handlerEndedAt,
		});
	}, [options.onInputFocus, recordInputFocusHandler]);
	const onInputReceipt = useCallback(
		(receipt: InputReceipt) => {
			const current = compositionHandoffsRef.current;
			const handoffIndex = current.findIndex(
				(handoff) => handoff.recordId === receipt.inReplyToRecordId,
			);
			if (handoffIndex < 0) return;
			const handoff = current[handoffIndex];
			if (receipt.outcome.case !== "writtenToPty") {
				compositionHandoffsRef.current = [
					...current.slice(0, handoffIndex),
					...current.slice(handoffIndex + 1),
				];
				if (handoffIndex === 0) setCompositionAnchor(null);
				refreshCompositionProjection();
				return;
			}
			const acknowledged = {
				...handoff,
				writtenToPty: true,
				inputBaselineOutputSequence:
					receipt.outcome.value.inputBaselineOutputSequence,
			};
			compositionHandoffsRef.current = current.map((candidate, index) =>
				index === handoffIndex ? acknowledged : candidate,
			);
			retirePaintedCompositionHandoffs(lastPaintFenceRef.current);
		},
		[refreshCompositionProjection, retirePaintedCompositionHandoffs],
	);
	const onPresentationPainted = useCallback(
		(presentation: PaintedPresentation, throughOutputSeq: bigint) => {
			lastPaintFenceRef.current = {
				attachmentToken: `${presentation.attachmentId}\u001f${presentation.terminalEpoch ?? "pending"}`,
				projectionRevision: presentation.frame.frame.projectionRevision,
				throughOutputSeq,
			};
			retirePaintedCompositionHandoffs(lastPaintFenceRef.current);
		},
		[retirePaintedCompositionHandoffs],
	);
	const onCompositionStart = useCallback(
		(event: CompositionEvent<HTMLTextAreaElement>) => {
			if (
				!terminalTextInputAuthorityIsCurrent(authorityFor(event.currentTarget))
			) {
				return;
			}
			compositionCommitRef.current = null;
			compositionSessionRef.current = {
				attachmentToken: currentAttachmentRef.current,
				host: event.currentTarget,
			};
			if (compositionHandoffsRef.current.length === 0) {
				setCompositionAnchor(null);
			}
			activeCompositionTextRef.current = terminalActiveCompositionText(
				event.data,
				event.currentTarget.value,
			);
			refreshCompositionProjection();
		},
		[authorityFor, refreshCompositionProjection],
	);
	const onCompositionUpdate = useCallback(
		(event: CompositionEvent<HTMLTextAreaElement>) => {
			if (
				!terminalTextInputAuthorityIsCurrent(authorityFor(event.currentTarget))
			) {
				return;
			}
			activeCompositionTextRef.current = terminalActiveCompositionText(
				event.data,
				event.currentTarget.value,
			);
			refreshCompositionProjection();
		},
		[authorityFor, refreshCompositionProjection],
	);
	const onCompositionEnd = useCallback(
		(event: CompositionEvent<HTMLTextAreaElement>) => {
			const compositionSession = compositionSessionRef.current;
			if (compositionSession?.host !== event.currentTarget) {
				event.currentTarget.value = "";
				return;
			}
			const authority = authorityFor(event.currentTarget);
			if (!terminalTextInputAuthorityIsCurrent(authority)) {
				compositionCommitRef.current = null;
				compositionSessionRef.current = null;
				activeCompositionTextRef.current = "";
				event.currentTarget.value = "";
				refreshCompositionProjection();
				return;
			}
			activeCompositionTextRef.current = "";
			const generation = ++compositionCommitGenerationRef.current;
			compositionCommitRef.current = { text: event.data, generation };
			const startedAttachment = compositionSession.attachmentToken;
			compositionSessionRef.current = null;
			if (
				startedAttachment !== null &&
				startedAttachment === currentAttachmentRef.current &&
				terminalTextInputMayForward(authority, event.data)
			) {
				terminalInputLatency.noteInput(options.surfaceId);
				const recordId = sendTextRef.current(event.data);
				const paint = lastPaintFenceRef.current;
				if (
					recordId !== undefined &&
					paint?.attachmentToken === startedAttachment
				) {
					const handoff: CompositionHandoff = {
						recordId,
						text: event.data,
						attachmentToken: startedAttachment,
						baselineProjectionRevision: paint.projectionRevision,
						baselineThroughOutputSeq: paint.throughOutputSeq,
						writtenToPty: false,
					};
					if (compositionHandoffsRef.current.length === 0) {
						setCompositionAnchor(currentCursorRef.current);
					}
					compositionHandoffsRef.current = [
						...compositionHandoffsRef.current,
						handoff,
					];
				}
			}
			refreshCompositionProjection();
			event.currentTarget.value = "";
			window.queueMicrotask(() => {
				if (compositionCommitRef.current?.generation === generation) {
					compositionCommitRef.current = null;
				}
			});
		},
		[authorityFor, options.surfaceId, refreshCompositionProjection],
	);
	const onInput = useCallback(
		(event: FormEvent<HTMLTextAreaElement>) => {
			const authority = authorityFor(event.currentTarget);
			if (!terminalTextInputAuthorityIsCurrent(authority)) {
				event.currentTarget.value = "";
				return;
			}
			const nativeInput = event.nativeEvent as InputEvent;
			// A new non-composing text edit supersedes an interrupted IME session,
			// even when its compositionend never reached this textarea. Composition
			// updates and commits retain their existing exact-once handoff path.
			if (nativeInput.inputType === "insertText" && !nativeInput.isComposing) {
				compositionSessionRef.current = null;
			}
			if (compositionSessionRef.current) {
				activeCompositionTextRef.current = terminalActiveCompositionText(
					"",
					event.currentTarget.value,
				);
				refreshCompositionProjection();
				return;
			}
			const value = event.currentTarget.value;
			event.currentTarget.value = "";
			const committed = compositionCommitRef.current;
			if (committed) {
				compositionCommitRef.current = null;
				if (value === committed.text || value === "") return;
			}
			finishCompositionHandoff();
			if (terminalTextInputMayForward(authority, value)) {
				terminalInputLatency.noteNativeTextInput(options.surfaceId);
				sendTextRef.current(value);
			}
		},
		[
			authorityFor,
			finishCompositionHandoff,
			options.surfaceId,
			refreshCompositionProjection,
		],
	);

	return {
		clearComposition,
		compositionAnchor,
		compositionText,
		finishCompositionHandoff,
		focusPaneInput,
		inputAttachmentKey,
		onFocus,
		onResizePhaseChange,
		onCompositionEnd,
		onCompositionStart,
		onCompositionUpdate,
		onInputReceipt,
		onInput,
		onPresentationPainted,
	};
}
