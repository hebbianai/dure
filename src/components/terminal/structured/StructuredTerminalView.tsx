import { structuredTerminalAttachmentKey } from "@/lib/terminal/structuredTerminalRecordAdapter";
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
import { useHubTerminalWidth } from "@/lib/hub/useHubTerminalWidth";
import { TerminalBoxCache } from "@/lib/terminal/geometry/terminalBoxCache";
import { terminalDocumentResizePhase } from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import { terminalWindowFocusProbeForSurface } from "@/lib/terminal/qa/terminalWindowFocusProbeRegistry";
import { terminalFontStack } from "@/lib/terminal/renderer/terminalFont";
import {
	encodeTerminalPasteIntent,
	encodeTerminalTextIntent,
} from "@/lib/terminal/state/terminalInputIntent";
import { encodeTerminalViewportScrollRowsIntent } from "@/lib/terminal/state/terminalViewportIntent";
import { StructuredTerminalCompositionOverlay } from "./StructuredTerminalCompositionOverlay";
import { StructuredTerminalRecoveryStatus } from "./StructuredTerminalRecoveryStatus";
import { useStructuredTerminalGeometryCommit } from "./useStructuredTerminalGeometryCommit";
import { useStructuredTerminalPointerInput } from "./useStructuredTerminalPointerInput";
import { StructuredTerminalScrollToBottom } from "./StructuredTerminalScrollToBottom";
import type { StructuredTerminalViewProps } from "./structuredTerminalViewContract";
import { createTerminalCanvasRenderer } from "./TerminalCanvasRenderer";
import { createTerminalViewportDomRenderer } from "./TerminalViewportDomRenderer";
import {
	isCurrentTerminalCanvasPresentation,
	type PaintedPresentation,
} from "./terminalCanvasPresentation";
import { useTerminalCanvasTheme } from "./terminalCanvasTheme";
import { useStructuredTerminalHorizontalViewport } from "./useStructuredTerminalHorizontalViewport";
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
	const terminalContentRef = useRef<HTMLDivElement>(null);
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
	const isInputFocused = useCallback(() => focusedRef.current, []);
	const horizontalViewport = useStructuredTerminalHorizontalViewport({
		viewportRef: presentationLayerRef,
		contentRef: terminalContentRef,
		isFocused: isInputFocused,
	});
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
	// A hidden retained writer can follow a verified phone width using its last
	// measured grid. Skipped-subtree boxes must never become resize proposals.
	const workspaceActive = useWorkspaceRuntimeActive();
	const workspaceActiveRef = useRef(workspaceActive);
	workspaceActiveRef.current = workspaceActive;
	const phoneWidthPendingRef = useRef(false);
	const canPublishGeometry = useCallback(
		() => workspaceActiveRef.current || phoneWidthPendingRef.current,
		[],
	);
	// A hidden desktop's pane accepts no input. The flag flips one render after
	// the blur below, because a disabled element cannot run the unfocusing
	// steps in every engine.
	const [inputHiddenWithDesktop, setInputHiddenWithDesktop] = useState(
		!workspaceActive,
	);
	const resizeController = useTerminalResizePresentation({
		presentationLayerRef,
		paintedPresentationRef,
	});
	const {
		presentationRef: resizePresentationRef,
		paintRevision: resizePaintRevision,
		setPaintRevision: setResizePaintRevision,
		hold: holdResizePresentation,
		holdLargeView: holdLargeViewPresentation,
		releaseLargeView: releaseLargeViewPresentation,
		complete: completeResizePresentation,
		reset: resetResizePresentation,
		finish: finishResizePresentation,
	} = resizeController;
	const attachmentLifecycle = useStructuredTerminalAttachmentLifecycle({
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
	const {
		prepareAttach,
		onAttached,
		onAttachmentRetired,
		recordTerminalAttachPhase,
		recordTerminalProjection,
		recordFirstTerminalPaint,
		geometryRef,
		confirmedGeometryRef,
		paintedRef,
		geometryFrameRef,
		resizeRegistrationRef,
		scheduleGeometryCommit,
	} = attachmentLifecycle;
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
	const retainedInteractionRef = useRef<() => boolean>(() => false);
	const hasRetainedInteraction = useCallback(() => {
		const host = containerRef.current;
		const selection = host?.ownerDocument.getSelection();
		return (
			retainedInteractionRef.current() ||
			(!!host &&
				!!selection &&
				!selection.isCollapsed &&
				(host.contains(selection.anchorNode) || host.contains(selection.focusNode)))
		);
	}, []);
	const viewportTransport = useStructuredTerminalViewportTransport({
		paneApi,
		surfaceId,
		binding,
		presentationRole,
		hasRetainedInteraction,
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
	const sendUserInput = useCallback(
		(encode: Parameters<typeof structuredInputLatency.sendUserInput>[0]) => {
			const recordId = structuredInputLatency.sendUserInput(encode);
			if (recordId !== undefined) horizontalViewport.beginInput();
			return recordId;
		},
		[horizontalViewport.beginInput, structuredInputLatency.sendUserInput],
	);

	inputLatencyReceiptObserverRef.current =
		structuredInputLatency.onInputReceipt;
	inputLatencyFrameObserverRef.current =
		structuredInputLatency.onViewportFrameReceived;
	const phoneColumns = useHubTerminalWidth(binding, viewportReplica.terminalEpoch);
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
		viewportTransport.writable &&
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
		sendMeasuredInput: sendUserInput,
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
			return sendUserInput((recordId, fence) =>
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
		sendUserInput: sendUserInput,
		focus: structuredTextInput.focusPaneInput,
	});
	const { compositionText, inputAttachmentKey } = structuredTextInput;
	const reportAfterPresentationPainted = useStructuredTerminalAfterPaint({
		presentationRoleRef,
		recordTerminalProjection,
		observerIdRef,
		attachedObserverRef,
		publishPaneHealth,
		onTextInputPainted: structuredTextInput.onPresentationPainted,
		onInputLatencyPainted: structuredInputLatency.onPresentationPainted,
	});
	const afterPresentationPainted = useCallback(
		(...args: Parameters<typeof reportAfterPresentationPainted>) => {
			horizontalViewport.painted(args[0]);
			reportAfterPresentationPainted(...args);
		},
		[horizontalViewport.painted, reportAfterPresentationPainted],
	);
	const handleFirstPaint = useCallback(() => {
		recordFirstTerminalPaint(viewportReplica.attachmentId);
		onFirstPaint?.();
	}, [onFirstPaint, recordFirstTerminalPaint, viewportReplica.attachmentId]);

	const commitGeometry = useStructuredTerminalGeometryCommit({
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
	});
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

	useLayoutEffect(() => {
		if (!viewportTransport.writable) return;
		phoneWidthPendingRef.current = true;
		const observation = resizeRegistrationRef.current?.noteGeometryChanged();
		if (observation) scheduleGeometryCommit(observation);
	}, [
		phoneColumns,
		viewportTransport.writable,
		viewportReplica.terminalEpoch,
		resizeRegistrationRef,
		scheduleGeometryCommit,
	]);

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
	const issuePointer = useStructuredTerminalPointerInput({
		inputReady,
		terminalSurfaceRef,
		paintedPresentationRef,
		issueViewportScrollRows,
		sendInput,
		sendViewportIntent,
		supportsCapability,
	});

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
	retainedInteractionRef.current = () =>
		selectionDrag.hasSelection() || structuredTextInput.hasPendingComposition();
	const forwardPastedText = useCallback(
		(text: string) => {
			if (inputDisabled) return;
			sendUserInput((recordId, fence) =>
				encodeTerminalPasteIntent(recordId, fence, text),
			);
		},
		[inputDisabled, sendUserInput],
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
		sendUserInput: sendUserInput,
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
				className="absolute inset-0 size-full overflow-x-auto overflow-y-hidden scrollbar-none"
			>
				<div
					ref={terminalContentRef}
					className="relative h-full min-w-full"
					onCompositionStartCapture={horizontalViewport.beginInput}
					onBlurCapture={horizontalViewport.endInput}
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
			</div>
			<StructuredTerminalRecoveryStatus
				paneId={paneApi?.id}
				connectionPending={!viewportTransport.presentationIsCurrent || viewportReplica.frame === null}
				error={terminalError}
				errorMessageId={terminalErrorMessageId}
				onDismiss={dismissTerminalError}
				attachRecovery={viewportTransport.reconnect ? {
					intent: "reconnect",
					ownerKey: structuredTerminalAttachmentKey(binding),
					resume: viewportTransport.reconnect,
					context: attachRecovery?.context ?? `session=${binding.sessionId}`,
					transitioning: attachRecovery?.transitioning,
				} : terminalRecoveryAvailable ? attachRecovery : undefined}
				onPresentationChange={onAttachRecoveryPresentationChange}
			/>
			<StructuredTerminalScrollToBottom frame={paintedAttachmentIsCurrent ? presentedFrame?.frame ?? null : null} sendViewportIntent={sendViewportIntent} />
		</TerminalViewChrome>
	);
	return renderedView;
}
