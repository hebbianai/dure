import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { TerminalViewChrome } from "@/components/terminal/TerminalViewChrome";
import {
	useWorkspaceRuntimeActive,
	useWorkspaceTerminalRecoveryAdmission,
} from "@/components/workspace/WorkspaceRuntimeContext";
import {
	MouseTrackingMode,
	PointerKind,
} from "@/contracts/terminalStateProtocol";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { saveSessionFiles } from "@/lib/files/sessionFileTransfer";
import { t } from "@/lib/i18n";
import { TerminalBoxCache } from "@/lib/terminal/geometry/terminalBoxCache";
import { terminalDocumentResizePhase } from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import { terminalWindowFocusProbeForSurface } from "@/lib/terminal/qa/terminalWindowFocusProbeRegistry";
import { terminalFontStack } from "@/lib/terminal/renderer/terminalFont";
import {
	encodeTerminalPasteIntent,
	encodeTerminalPointerIntent,
	encodeTerminalResizeIntent,
	encodeTerminalTextIntent,
	encodeTerminalViewportWheelIntent,
} from "@/lib/terminal/state/terminalInputIntent";
import {
	observeTerminalResizeGeometry,
	terminalResizeRetryAfterFailure,
} from "@/lib/terminal/state/terminalIntentReceiptPolicy";
import { TERMINAL_VIEWPORT_WHEEL_CAPABILITY } from "@/lib/terminal/protocol/terminalStateProtocol";
import { encodeTerminalViewportScrollRowsIntent } from "@/lib/terminal/state/terminalViewportIntent";
import { StructuredTerminalCompositionOverlay } from "./StructuredTerminalCompositionOverlay";
import { StructuredTerminalRecoveryStatus } from "./StructuredTerminalRecoveryStatus";
import { StructuredTerminalScrollToBottom } from "./StructuredTerminalScrollToBottom";
import type { StructuredTerminalViewProps } from "./structuredTerminalViewContract";
import { createTerminalCanvasRenderer } from "./TerminalCanvasRenderer";
import { createTerminalViewportDomRenderer } from "./TerminalViewportDomRenderer";
import {
	isCurrentTerminalCanvasPresentation,
	type PaintedPresentation,
} from "./terminalCanvasPresentation";
import { useTerminalCanvasTheme } from "./terminalCanvasTheme";
import { useStructuredTerminalAfterPaint } from "./useStructuredTerminalAfterPaint";
import { useStructuredTerminalAttachmentLifecycle } from "./useStructuredTerminalAttachmentLifecycle";
import { useStructuredTerminalClipboard } from "./useStructuredTerminalClipboard";
import { useStructuredTerminalDefaultColorSync } from "./useStructuredTerminalDefaultColorSync";
import { useStructuredTerminalDocumentResizeSurface } from "./useStructuredTerminalDocumentResizeSurface";
import { useStructuredTerminalEvents } from "./useStructuredTerminalEvents";
import { useStructuredTerminalFileDrop } from "./useStructuredTerminalFileDrop";
import { useStructuredTerminalInputLatency } from "./useStructuredTerminalInputLatency";
import { useStructuredTerminalKeyInput } from "./useStructuredTerminalKeyInput";
import { useStructuredTerminalLargeViewLifecycle } from "./useStructuredTerminalLargeViewLifecycle";
import { useStructuredTerminalPaneHealth } from "./useStructuredTerminalPaneHealth";
import { useStructuredTerminalReceiptObservers } from "./useStructuredTerminalReceiptObservers";
import { useStructuredTerminalQuickCommands } from "./useStructuredTerminalQuickCommands";
import { useStructuredTerminalSelectionDrag } from "./useStructuredTerminalSelectionDrag";
import { useStructuredTerminalTextInput } from "./useStructuredTerminalTextInput";
import { useStructuredTerminalViewportPaint } from "./useStructuredTerminalViewportPaint";
import { useStructuredTerminalSurfaceCallbacks } from "./useStructuredTerminalSurfaceCallbacks";
import { useStructuredTerminalViewportTransport } from "./useStructuredTerminalViewportTransport";
import {
	publishHmuxSessionMetadata,
	useStructuredTerminalViewState,
} from "./useStructuredTerminalViewState";
import { useStructuredTerminalWheelInput } from "./useStructuredTerminalWheelInput";
import { useStructuredTerminalWindowFocusProbe } from "./useStructuredTerminalWindowFocusProbe";
import { useTerminalResizePresentation } from "./useTerminalResizePresentation";

export function StructuredTerminalView({
	sessionId,
	providerHint,
	surfaceId = sessionId,
	paneHealthId,
	binding,
	inputDisabled = false,
	paneApi,
	presentationRole = "ungated",
	ensure,
	onSplit,
	onRemoteManagedStarted,
	onProviderConversationIdentity,
	onWorkingDirectory,
	onKill,
	killLabel,
	killDestructive,
	onHmuxSessionExit,
	windowFocusProbe,
	onFirstPaint,
	onGeometryObserved,
	onStructuredSurfaceRetirement,
	onAttachRecoveryPresentationChange,
	attachRecovery,
}: StructuredTerminalViewProps) {
	const workspaceId =
		"workspaceId" in binding ? binding.workspaceId : undefined;
	const terminalProbe =
		windowFocusProbe ?? terminalWindowFocusProbeForSurface(surfaceId);
	const containerRef = useRef<HTMLDivElement>(null);
	const presentationLayerRef = useRef<HTMLDivElement>(null);
	const terminalSurfaceRef = useRef<HTMLDivElement>(null);
	const [surfaceBox] = useState(
		() =>
			new TerminalBoxCache(
				() =>
					containerRef.current?.getBoundingClientRect() ?? {
						width: 0,
						height: 0,
					},
			),
	);
	const [canvasRenderer] = useState(createTerminalCanvasRenderer);
	const [viewportRenderer] = useState(createTerminalViewportDomRenderer);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const {
		fontSize,
		fontFamily,
		lineHeight,
		copyOnSelect,
		allowOsc52,
		shortcutOverrides,
	} = useStructuredTerminalViewState();
	const canvasTheme = useTerminalCanvasTheme();
	const resolvedFontFamily = terminalFontStack(fontFamily);
	const focusedRef = useRef(false);
	const projectTerminalFocus = useCallback(
		(focused: boolean) => {
			if (focusedRef.current === focused) return;
			focusedRef.current = focused;
			const terminalSurface = terminalSurfaceRef.current;
			if (terminalSurface)
				viewportRenderer.setFocused(terminalSurface, focused);
		},
		[viewportRenderer],
	);
	const paintedPresentationRef = useRef<PaintedPresentation | null>(null);
	const selectionCommitRef = useRef<(text?: string) => void>(() => {});
	const attachedGeometryPendingRef = useRef<string | undefined>(undefined);
	const presentationRoleRef = useRef(presentationRole);
	useLayoutEffect(() => {
		presentationRoleRef.current = presentationRole;
	}, [presentationRole]);
	// A warm desktop retains this view while hidden. Its subtree is skipped
	// (content-visibility) there, so canonical geometry may only be published
	// from the active desktop; the reveal below re-measures once.
	const workspaceActive = useWorkspaceRuntimeActive();
	const workspaceActiveRef = useRef(workspaceActive);
	workspaceActiveRef.current = workspaceActive;
	const canPublishGeometry = useCallback(
		() => workspaceActiveRef.current,
		[],
	);
	// A hidden desktop's pane accepts no input. The flag flips one render after
	// the blur below, because a disabled element cannot run the unfocusing
	// steps in every engine.
	const [inputHiddenWithDesktop, setInputHiddenWithDesktop] = useState(
		!workspaceActive,
	);
	const {
		presentationRef: resizePresentationRef,
		paintRevision: resizePaintRevision,
		setPaintRevision: setResizePaintRevision,
		hold: holdResizePresentation,
		holdLargeView: holdLargeViewPresentation,
		releaseLargeView: releaseLargeViewPresentation,
		request: requestResizePresentation,
		applied: applyResizePresentation,
		complete: completeResizePresentation,
		reset: resetResizePresentation,
		finish: finishResizePresentation,
		releaseFailed: releaseFailedResizePresentation,
	} = useTerminalResizePresentation({
		presentationLayerRef,
		paintedPresentationRef,
	});
	const {
		prepareAttach,
		onAttached,
		onAttachmentRetired,
		recordTerminalAttachPhase,
		recordTerminalProjection,
		recordFirstTerminalPaint,
		geometryRef,
		confirmedGeometryRef,
		hasIssuedGeometryRef,
		resizeRetryRef,
		paintedRef,
		geometryFrameRef,
		resizeRegistrationRef,
		scheduleGeometryCommit,
	} = useStructuredTerminalAttachmentLifecycle({
		surfaceId,
		panelId: paneApi?.id,
		ensure,
		containerRef,
		surfaceBox,
		renderer: canvasRenderer,
		fontFamily: resolvedFontFamily,
		fontSize,
		lineHeight,
		paintedPresentationRef,
		setPaintRevision: setResizePaintRevision,
		holdResizePresentation,
		resetResizePresentation,
	});
	const onTerminalEvent = useStructuredTerminalEvents({
		sessionId,
		providerHint,
		binding,
		containerRef,
		allowOsc52,
		onRemoteManagedStarted,
	});
	const publishPaneHealth = useStructuredTerminalPaneHealth(paneHealthId);
	const recoveryAdmission = useWorkspaceTerminalRecoveryAdmission();
	const {
		inputReceiptObserverRef,
		textInputReceiptObserverRef,
		quickCommandReceiptObserverRef,
		inputLatencyReceiptObserverRef,
		inputLatencyFrameObserverRef,
		onInputReceipt,
		onViewportFrameReceived,
	} = useStructuredTerminalReceiptObservers(publishPaneHealth);
	const onLargeViewReturnPrepared = useCallback(() => {
		terminalProbe?.onLargeViewReturnPrepared?.();
	}, [terminalProbe]);
	const surfaceCallbacks = useStructuredTerminalSurfaceCallbacks(
		terminalProbe,
		onStructuredSurfaceRetirement,
	);
	const viewportTransport = useStructuredTerminalViewportTransport({
		paneApi,
		surfaceId,
		binding,
		presentationRole,
		recoveryAdmission,
		prepareAttach,
		onAttachPhase: recordTerminalAttachPhase,
		onAttached,
		onEvent: onTerminalEvent,
		onProviderConversationIdentity,
		onWorkingDirectory,
		onInputReceipt,
		onViewportFrameReceived,
		onPaneConnectionState: (state, reason) =>
			publishPaneHealth({ kind: "connection", state, reason }),
		onSessionMetadata: (metadata) => publishHmuxSessionMetadata(metadata),
		onExit: onHmuxSessionExit,
		...surfaceCallbacks,
		onAttachmentRetired,
	});
	useStructuredTerminalDefaultColorSync(canvasTheme, viewportTransport);
	const {
		replica: viewportReplica,
		readLatestCompleteFrame,
		presentationIsCurrent,
		error: terminalError,
		errorMessageId: terminalErrorMessageId,
		dismissError: dismissTerminalError,
		recoveryAvailable: terminalRecoveryAvailable,
		observerIdRef,
		attachedObserverRef,
		sendInput,
		sendViewportIntent,
		requestViewportRows,
		supportsCapability,
		resolveResizeFailure,
		reportFailure,
	} = viewportTransport;
	const issueViewportScrollRows = useCallback(
		(rows: number) => {
			if (rows === 0) return undefined;
			return sendViewportIntent((recordId, fence, viewportFence) =>
				encodeTerminalViewportScrollRowsIntent(
					recordId,
					fence,
					viewportFence,
					rows,
				),
			);
		},
		[sendViewportIntent],
	);
	const structuredInputLatency = useStructuredTerminalInputLatency({
		surfaceId,
		attachmentId: viewportReplica.attachmentId,
		terminalEpoch: viewportReplica.terminalEpoch,
		observerIdRef,
		sendInput,
	});
	inputLatencyReceiptObserverRef.current =
		structuredInputLatency.onInputReceipt;
	inputLatencyFrameObserverRef.current =
		structuredInputLatency.onViewportFrameReceived;
	const installedFrame = viewportReplica.frame;
	const syncLargeViewReturnTarget = useStructuredTerminalLargeViewLifecycle({
		workspaceId,
		sessionId,
		surfaceId,
		containerRef,
		geometryRef,
		attachedObserverRef,
		attachedGeometryPendingRef,
		resizeRegistrationRef,
		attachmentId: viewportReplica.attachmentId,
		terminalEpoch: viewportReplica.terminalEpoch,
		stateRevision: viewportReplica.stateRevision,
		installedFrame,
		onGeometryObserved,
		onReturnPrepared: onLargeViewReturnPrepared,
		requestReturnRetirementFence: requestViewportRows,
		holdPresentation: holdLargeViewPresentation,
		releasePresentation: releaseLargeViewPresentation,
	});
	const resizePresentation = resizePresentationRef.current;
	const resizePresentationReady =
		terminalDocumentResizePhase(document) === "idle" &&
		resizePresentation.finalGrid !== undefined &&
		resizePresentation.requestGeneration !== undefined &&
		resizePresentation.appliedCanonicalColumns !== undefined &&
		resizePresentation.afterProjectionRevision !== undefined &&
		installedFrame !== null &&
		installedFrame.frame.projectionRevision >
			resizePresentation.afterProjectionRevision &&
		installedFrame.frame.canonicalColumns ===
			resizePresentation.appliedCanonicalColumns &&
		installedFrame.frame.viewportRows === resizePresentation.finalGrid.rows;
	const retainingResizePresentation =
		resizePresentation.held &&
		paintedPresentationRef.current !== null &&
		!resizePresentationReady;
	const retainingLargeViewPresentation =
		resizePresentation.largeViewHeld && paintedPresentationRef.current !== null;
	const retainingPresentation =
		retainingResizePresentation || retainingLargeViewPresentation;
	const presentedFrame = retainingPresentation
		? (paintedPresentationRef.current?.frame ?? installedFrame)
		: installedFrame;
	const paintedPresentationIsCurrent = isCurrentTerminalCanvasPresentation(
		paintedPresentationRef.current,
		sessionId,
		viewportReplica.attachmentId,
		viewportReplica.terminalEpoch,
	);
	const paintedAttachmentIsCurrent =
		presentationIsCurrent &&
		(retainingPresentation
			? paintedPresentationIsCurrent
			: installedFrame !== null && viewportReplica.terminalEpoch !== null);
	const inputReady =
		!inputDisabled &&
		!inputHiddenWithDesktop &&
		installedFrame !== null &&
		paintedAttachmentIsCurrent;
	const activeCursor = presentedFrame?.frame.cursor ?? null;
	const {
		onFocus: onStructuredInputFocus,
		onBlur: onStructuredInputBlur,
		onInputReceipt: observeStructuredInputReceipt,
		onPresentationPainted: reportStructuredPresentationPainted,
		onError: reportStructuredProbeError,
	} = useStructuredTerminalWindowFocusProbe({
		probe: terminalProbe,
		inputRef,
		terminalSurfaceRef,
		paintedPresentationRef,
		readLatestCompleteFrame,
		attachmentId: viewportReplica.attachmentId,
		terminalEpoch: viewportReplica.terminalEpoch,
		inputReady,
		sendInput,
		sendMeasuredInput: structuredInputLatency.sendUserInput,
		scrollRows: issueViewportScrollRows,
		setFocused: projectTerminalFocus,
	});
	inputReceiptObserverRef.current = observeStructuredInputReceipt;
	const structuredTextInput = useStructuredTerminalTextInput({
		paneApi,
		inputRef,
		surfaceId,
		attachmentId: viewportReplica.attachmentId,
		terminalEpoch: viewportReplica.terminalEpoch,
		inputReady,
		restoreFocus: focusedRef.current,
		currentCursor: activeCursor,
		onInputFocus: onStructuredInputFocus,
		sendText: (text) => {
			if (!inputReady) return;
			return structuredInputLatency.sendUserInput((recordId, fence) =>
				encodeTerminalTextIntent(recordId, fence, text),
			);
		},
	});
	textInputReceiptObserverRef.current = structuredTextInput.onInputReceipt;
	useStructuredTerminalQuickCommands({
		paneId: paneApi?.id,
		surfaceId: paneHealthId ?? surfaceId,
		attachmentId: viewportReplica.attachmentId,
		terminalEpoch: viewportReplica.terminalEpoch,
		inputReady,
		observerIdRef,
		receiptObserverRef: quickCommandReceiptObserverRef,
		readLatestCompleteFrame,
		sendUserInput: structuredInputLatency.sendUserInput,
		focus: structuredTextInput.focusPaneInput,
	});
	const { compositionText, inputAttachmentKey } = structuredTextInput;
	const afterPresentationPainted = useStructuredTerminalAfterPaint({
		presentationRoleRef,
		recordTerminalProjection,
		observerIdRef,
		attachedObserverRef,
		publishPaneHealth,
		onTextInputPainted: structuredTextInput.onPresentationPainted,
		onInputLatencyPainted: structuredInputLatency.onPresentationPainted,
	});
	const handleFirstPaint = useCallback(() => {
		recordFirstTerminalPaint(viewportReplica.attachmentId);
		onFirstPaint?.();
	}, [onFirstPaint, recordFirstTerminalPaint, viewportReplica.attachmentId]);

	const commitGeometry = useCallback((): Promise<boolean> | boolean => {
		const host = containerRef.current;
		const observerId = observerIdRef.current;
		if (!host || !observerId || attachedObserverRef.current !== observerId)
			return false;
		const bounds = surfaceBox.read();
		const metrics = canvasRenderer.measure(
			bounds.width,
			bounds.height,
			resolvedFontFamily,
			fontSize,
			lineHeight,
		);
		if (
			resizePresentationRef.current.requestGeneration !== undefined &&
			resizePresentationRef.current.finalGrid?.columns === metrics.columns &&
			resizePresentationRef.current.finalGrid.rows === metrics.rows
		) {
			syncLargeViewReturnTarget();
			return true;
		}
		if (
			resizePresentationRef.current.requestGeneration === undefined &&
			confirmedGeometryRef.current.columns === metrics.columns &&
			confirmedGeometryRef.current.rows === metrics.rows
		) {
			finishResizePresentation();
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
		return true;
	}, [
		applyResizePresentation,
		canvasRenderer,
		finishResizePresentation,
		fontSize,
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
	const commitGeometryRef = useRef(commitGeometry);
	commitGeometryRef.current = commitGeometry;

	useStructuredTerminalDocumentResizeSurface({
		ownerDocument: document,
		surfaceId,
		sessionId: binding.sessionId,
		observerIdRef,
		attachedObserverRef,
		commitGeometryRef,
		geometryFrameRef,
		resizeRegistrationRef,
		canPublishGeometry,
		holdResizePresentation,
		finishResizePresentation,
		onInputResizePhaseChange: structuredTextInput.onResizePhaseChange,
	});

	// Desktop tier transitions of a retained presentation.
	// Hidden: the input must not keep keyboard focus, or every keystroke on the
	// new desktop would still reach this session (input readiness then drops
	// one render later so no focus path can re-enter a hidden desktop).
	// Reveal: re-confirm canonical geometry through the ordinary registration
	// and report the paint the transition tracker expects from every visible
	// pane. A subtree that was skipped (content-visibility) delivered zero
	// boxes; its reveal is finished by the next ResizeObserver delivery below
	// instead of a forced layout per pane, which is the stall the box cache
	// exists to avoid.
	const workspaceWasActiveRef = useRef(workspaceActive);
	const revealAwaitingBoxRef = useRef(false);
	const revealWithMeasuredBox = useCallback(() => {
		revealAwaitingBoxRef.current = false;
		const observation = resizeRegistrationRef.current?.noteGeometryChanged();
		if (observation) scheduleGeometryCommit(observation);
		if (paintedPresentationRef.current !== null) {
			recordFirstTerminalPaint(viewportReplica.attachmentId);
		}
	}, [
		recordFirstTerminalPaint,
		resizeRegistrationRef,
		scheduleGeometryCommit,
		viewportReplica.attachmentId,
	]);
	useLayoutEffect(() => {
		const wasActive = workspaceWasActiveRef.current;
		workspaceWasActiveRef.current = workspaceActive;
		if (wasActive === workspaceActive) return;
		if (!workspaceActive) {
			revealAwaitingBoxRef.current = false;
			const input = inputRef.current;
			if (input && input.ownerDocument.activeElement === input) input.blur();
			setInputHiddenWithDesktop(true);
			return;
		}
		setInputHiddenWithDesktop(false);
		const delivered = surfaceBox.delivered();
		if (delivered && delivered.width > 0 && delivered.height > 0) {
			revealWithMeasuredBox();
			return;
		}
		revealAwaitingBoxRef.current = true;
	}, [revealWithMeasuredBox, surfaceBox, workspaceActive]);

	useLayoutEffect(() => {
		const host = containerRef.current;
		if (!host) return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[entries.length - 1];
			if (entry) surfaceBox.updateFromEntry(entry);
			// A hidden desktop delivers skipped-subtree boxes. Record them, but
			// never hold the presentation or commit from them: nothing could
			// finish that hold until the reveal.
			if (!workspaceActiveRef.current) return;
			if (revealAwaitingBoxRef.current) {
				// First real box after a reveal: hidden paints measured a zero box,
				// so repaint with this one instead of holding a 0px presentation.
				setResizePaintRevision((revision) => revision + 1);
				revealWithMeasuredBox();
				return;
			}
			holdResizePresentation();
			const observation = resizeRegistrationRef.current?.noteGeometryChanged();
			if (observation) scheduleGeometryCommit(observation);
		});
		observer.observe(host);
		return () => observer.disconnect();
	}, [
		holdResizePresentation,
		revealWithMeasuredBox,
		scheduleGeometryCommit,
		setResizePaintRevision,
		surfaceBox,
	]);

	useStructuredTerminalViewportPaint({
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
		attachmentId: viewportReplica.attachmentId,
		terminalEpoch: viewportReplica.terminalEpoch,
		throughOutputSeq: viewportReplica.throughOutputSeq,
		focused: focusedRef.current,
		fontFamily: resolvedFontFamily,
		fontSize,
		lineHeight,
		canvasTheme,
		canvasRenderer,
		viewportRenderer,
		reportPresentationPainted: reportStructuredPresentationPainted,
		afterPresentationPainted,
		onResizePresentationPainted: resolveResizeFailure,
		onFirstPaint: handleFirstPaint,
	});
	useEffect(() => {
		if (terminalError) reportStructuredProbeError(terminalError);
	}, [reportStructuredProbeError, terminalError]);

	const mouseReporting =
		presentedFrame?.frame.inputModes !== undefined &&
		presentedFrame.frame.inputModes.mouseTracking !== MouseTrackingMode.NONE &&
		presentedFrame.frame.inputModes.mouseTracking !==
			MouseTrackingMode.UNSPECIFIED;
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

	const currentInputAttachmentId = useCallback(() => {
		const attachmentId = observerIdRef.current;
		return inputReady &&
			attachmentId &&
			attachedObserverRef.current === attachmentId
			? attachmentId
			: undefined;
	}, [attachedObserverRef, inputReady, observerIdRef]);
	const selectionDrag = useStructuredTerminalSelectionDrag({
		enabled: Boolean(installedFrame && paintedAttachmentIsCurrent),
		attachmentIdentity: `${viewportReplica.attachmentId}:${viewportReplica.terminalEpoch ?? ""}`,
		terminalSurfaceRef,
		frame: presentedFrame?.frame ?? null,
		readMetrics: () => {
			const paint = paintedPresentationRef.current?.paint;
			const metrics = paint?.metrics;
			return metrics
				? {
						cellWidth: metrics.cellWidth,
						rowHeight: metrics.rowHeight,
					}
				: null;
		},
		scrollRows: issueViewportScrollRows,
		onStart: structuredTextInput.finishCompositionHandoff,
		onClick: (event, click) => {
			structuredTextInput.focusPaneInput();
			if (inputDisabled) return;
			if (!click.forwardClickToTerminal) return;
			issuePointer(event, PointerKind.DOWN, 0, 0, click.button, click.buttons);
			issuePointer(event, PointerKind.UP);
		},
		onCommit: (text) => selectionCommitRef.current(text),
	});
	const forwardPastedText = useCallback(
		(text: string) => {
			if (inputDisabled) return;
			structuredInputLatency.sendUserInput((recordId, fence) =>
				encodeTerminalPasteIntent(recordId, fence, text),
			);
		},
		[inputDisabled, structuredInputLatency.sendUserInput],
	);
	const preparePastedFiles = useCallback(
		(files: DroppedFilePayload[]) => {
			const terminalEpoch = viewportReplica.terminalEpoch;
			if (!terminalEpoch) throw new Error("session_file_session_unavailable");
			return saveSessionFiles(
				binding.source === "local" ? undefined : binding.hostId,
				files,
				{
					sessionId: binding.sessionId,
					workspaceId: binding.workspaceId,
					terminalEpoch,
				},
			);
		},
		[
			binding.source,
			binding.hostId,
			binding.sessionId,
			binding.workspaceId,
			viewportReplica.terminalEpoch,
		],
	);
	const { copyNativeSelection, onPaste, selectedText } =
		useStructuredTerminalClipboard({
			terminalSurfaceRef,
			copyOnSelect,
			prepareFiles: preparePastedFiles,
			surfaceId,
			paneId: paneApi?.id,
			currentAttachmentId: currentInputAttachmentId,
			selectionText: selectionDrag.selectedText,
			forwardUserInput: forwardPastedText,
			reportFailure,
		});
	selectionCommitRef.current = copyNativeSelection;
	const onTerminalKeyDown = useStructuredTerminalKeyInput({
		inputReady,
		terminalId: surfaceId,
		shortcutOverrides,
		selectedText,
		finishCompositionHandoff: structuredTextInput.finishCompositionHandoff,
		sendUserInput: structuredInputLatency.sendUserInput,
	});
	// 외부 파일 드롭도 결국 붙여넣기다 — 준비된 경로 묶음이 같은 경로로 들어간다.
	useStructuredTerminalFileDrop({
		containerRef,
		inputRef,
		prepareFiles: preparePastedFiles,
		inputReady,
		paneApi,
		currentAttachmentId: currentInputAttachmentId,
		forwardUserInput: forwardPastedText,
		reportFailure,
	});

	const compositionCursor =
		structuredTextInput.compositionAnchor ?? activeCursor;
	const compositionLeft =
		(compositionCursor?.column ?? 0) *
		(paintedPresentationRef.current?.paint.metrics.cellWidth ?? fontSize * 0.6);
	const compositionTop =
		(compositionCursor?.row ?? 0) *
		(paintedPresentationRef.current?.paint.metrics.rowHeight ??
			fontSize * lineHeight);

	const onWheel = useStructuredTerminalWheelInput({
		enabled: paintedAttachmentIsCurrent,
		inputDisabled,
		presentationIsCurrent,
		attachmentId: viewportReplica.attachmentId,
		observerIdRef,
		attachedObserverRef,
		readMetrics: () => paintedPresentationRef.current?.paint.metrics,
		scrollRows: issueViewportScrollRows,
		sendPointerWheel: (event, wheelRowsX, wheelRowsY) =>
			issuePointer(event, PointerKind.WHEEL, wheelRowsX, wheelRowsY),
	});
	const renderedView = (
		<TerminalViewChrome
			surfaceId={paneHealthId ?? surfaceId}
			containerRef={containerRef}
			// Inset the measured host so launch, resize, and paint share one box.
			// Keep the held presentation flush inside it during resize transactions.
			containerClassName="terminal-host structured-terminal-host relative mx-2.5 h-full overflow-hidden"
			onSplit={onSplit}
			onKill={onKill}
			killLabel={killLabel}
			killDestructive={killDestructive}
		>
			<div
				ref={presentationLayerRef}
				data-testid="structured-terminal-presentation"
				data-terminal-surface-id={surfaceId}
				data-terminal-canonical-columns={installedFrame?.frame.canonicalColumns}
				data-terminal-viewport-rows={installedFrame?.frame.viewportRows}
				data-terminal-cell-width={
					paintedPresentationRef.current?.paint.metrics.cellWidth
				}
				data-terminal-row-height={
					paintedPresentationRef.current?.paint.metrics.rowHeight
				}
				className="absolute inset-0 size-full"
			>
				<div
					ref={terminalSurfaceRef}
					data-testid="structured-terminal-viewport"
					data-selectable
					className="absolute inset-0 size-full"
					onPointerDown={(event) => {
						if (!installedFrame || !paintedAttachmentIsCurrent) {
							// Retain the explicit click until input is ready; no pointer
							// or keyboard intent may reach an unpainted attachment.
							if (event.button === 0) structuredTextInput.focusPaneInput();
							event.preventDefault();
							return;
						}
						const reportClick = !inputDisabled && mouseReporting && !event.shiftKey;
						const selecting = selectionDrag.begin(
							event.nativeEvent,
							reportClick,
						);
						if (!selecting && reportClick) issuePointer(event.nativeEvent, PointerKind.DOWN);
					}}
					onPointerMove={(event) => {
						if (!paintedAttachmentIsCurrent) return;
						if (selectionDrag.ownsPointer(event.pointerId)) return;
						if (mouseReporting)
							issuePointer(event.nativeEvent, PointerKind.MOVE);
					}}
					onPointerUp={(event) => {
						if (selectionDrag.ownsPointer(event.pointerId)) return;
						if (
							!inputDisabled &&
							!event.shiftKey &&
							paintedAttachmentIsCurrent &&
							mouseReporting
						) {
							structuredTextInput.focusPaneInput();
							issuePointer(event.nativeEvent, PointerKind.UP);
						}
					}}
					onPointerCancel={(event) => {
						selectionDrag.cancel(event.pointerId);
					}}
					onWheel={onWheel}
				/>
				<textarea
					key={inputAttachmentKey}
					ref={inputRef}
					aria-label={t("terminal.input.ariaLabel")}
					disabled={!inputReady}
					className="absolute size-px resize-none opacity-0"
					style={{ left: compositionLeft, top: compositionTop }}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					onFocus={structuredTextInput.onFocus}
					onBlur={() => {
						structuredTextInput.clearComposition();
						if (!paintedAttachmentIsCurrent) return;
						onStructuredInputBlur();
					}}
					onKeyDown={onTerminalKeyDown}
					onCompositionStart={structuredTextInput.onCompositionStart}
					onCompositionUpdate={structuredTextInput.onCompositionUpdate}
					onCompositionEnd={structuredTextInput.onCompositionEnd}
					onInput={structuredTextInput.onInput}
					onPaste={(event) => {
						structuredTextInput.finishCompositionHandoff();
						onPaste(event.nativeEvent);
					}}
				/>
				{compositionText && (
					<StructuredTerminalCompositionOverlay
						text={compositionText}
						left={compositionLeft}
						top={compositionTop}
						fontFamily={resolvedFontFamily}
						fontSize={fontSize}
						lineHeight={lineHeight}
					/>
				)}
			</div>
			<StructuredTerminalRecoveryStatus
				paneId={paneApi?.id}
				error={terminalError}
				errorMessageId={terminalErrorMessageId}
				onDismiss={dismissTerminalError}
				attachRecovery={terminalRecoveryAvailable ? attachRecovery : undefined}
				onPresentationChange={onAttachRecoveryPresentationChange}
			/>
			<StructuredTerminalScrollToBottom frame={paintedAttachmentIsCurrent ? presentedFrame?.frame ?? null : null} sendViewportIntent={sendViewportIntent} />
		</TerminalViewChrome>
	);
	return renderedView;
}
