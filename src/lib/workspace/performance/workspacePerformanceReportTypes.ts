import type { LatencyStats } from "@/lib/workspace/performance/latencyStats";
import type {
	WorkspacePerformanceSnapshot,
	WorkspaceTransitionCacheState,
	WorkspaceTransitionSample,
} from "@/lib/workspace/performance/workspacePerformanceTypes";

export interface PaneOpenStats {
	/** First open includes lazy chunk loading; subsequent opens use the cache. */
	cold: LatencyStats;
	warm: LatencyStats;
}

export interface WorkspaceJourneyStats {
	activationCommit: LatencyStats;
	commitMicrotask: LatencyStats;
	commitMessageTask: LatencyStats;
	firstFrame: LatencyStats;
	workspacePaint: LatencyStats;
	firstInteractivePane: LatencyStats;
	firstTerminalPaint: LatencyStats;
	allTerminalStable: LatencyStats;
	/** Same-transition delay after the first visible terminal paint. */
	firstPaintToAllStable: LatencyStats;
	/** One entry per visible-pane completion rank, ordered first to last. */
	terminalPaintByRank: readonly LatencyStats[];
	terminalStableByRank: readonly LatencyStats[];
}

/** Stable report schema projected from window-local performance samples. */
export interface WorkspacePerformanceReport {
	/** Applied shell-cache decision plus inactive presentation activity. */
	workspaceCache: NonNullable<
		WorkspacePerformanceSnapshot["workspaceCache"]
	> | null;
	/** Every authoritative structured DOM commit in this WebView. */
	terminalPresentation: WorkspacePerformanceSnapshot["terminalPresentation"];
	journeys: {
		initialWorkspace: WorkspaceJourneyStats;
		firstVisit: WorkspaceJourneyStats;
		revisit: WorkspaceJourneyStats;
	};
	switchPaint: { warm: LatencyStats; cold: LatencyStats };
	switchPaintByCache: Record<WorkspaceTransitionCacheState, LatencyStats>;
	firstTerminalPaint: { warm: LatencyStats; cold: LatencyStats };
	firstInteractivePane: { warm: LatencyStats; cold: LatencyStats };
	firstInteractivePaneByCache: Record<
		WorkspaceTransitionCacheState,
		LatencyStats
	>;
	firstTerminalPaintByCache: Record<
		WorkspaceTransitionCacheState,
		LatencyStats
	>;
	allTerminalPaintByCache: Record<WorkspaceTransitionCacheState, LatencyStats>;
	firstTerminalStableByCache: Record<
		WorkspaceTransitionCacheState,
		LatencyStats
	>;
	allTerminalStableByCache: Record<WorkspaceTransitionCacheState, LatencyStats>;
	recentTransitions: readonly WorkspaceTransitionSample[];
	terminalAttach: {
		recovery: WorkspacePerformanceSnapshot["terminalRecovery"] | null;
		frontendPreparation: LatencyStats;
		renderableWait: LatencyStats;
		prepare: LatencyStats;
		preAttachResize: LatencyStats;
		backendCommand: LatencyStats;
		frontendHydrationBarrier: LatencyStats;
		receiptToBarrier: LatencyStats;
		barrierToPaint: LatencyStats;
		paintToStable: LatencyStats;
		invokeToStable: LatencyStats;
		incompleteCount: number;
		integrity: WorkspacePerformanceSnapshot["terminalAttachIntegrity"];
		recent: WorkspacePerformanceSnapshot["terminalAttaches"];
	};
	remountCost: LatencyStats;
	remountAttach: LatencyStats;
	paneOpen: {
		all: PaneOpenStats;
		byKind: Record<string, PaneOpenStats>;
	};
	agentReady: {
		all: PaneOpenStats;
		byProvider: Record<string, PaneOpenStats>;
		breakdown: { preflight: LatencyStats; create: LatencyStats };
		failureCount: number;
	};
	terminalInput: {
		dispatch: LatencyStats;
		keydownDispatchStages: {
			captureToSemanticHandler: LatencyStats;
			semanticHandlerToDispatch: LatencyStats;
			semanticHandlerToDecision: LatencyStats;
			semanticDecisionToDispatch: LatencyStats;
			byReplacementState: Record<
				"inactive" | "active" | "unknown",
				{
					dispatch: LatencyStats;
					captureToSemanticHandler: LatencyStats;
					semanticHandlerToDispatch: LatencyStats;
					semanticHandlerToDecision: LatencyStats;
					semanticDecisionToDispatch: LatencyStats;
				}
			>;
		};
		keydownToHostReceipt: LatencyStats;
		keydownToEchoPaint: LatencyStats;
		hostReceiptToEchoPaint: LatencyStats;
		inputToHostReceipt: LatencyStats;
		inputDispatchToTransportConfirmation: LatencyStats;
		inputTransportConfirmationToHostReceipt: LatencyStats;
		inputHostReceiptBeforeTransportConfirmationCount: number;
		inputHostAcceptedToOutput: LatencyStats;
		inputHostOutputToProjectionStart: LatencyStats;
		inputToOutputReceived: LatencyStats;
		inputReceiptToOutputReceived: LatencyStats;
		inputToEchoPaint: LatencyStats;
		inputOutputToEchoPaint: LatencyStats;
		inputOutputToProjectionStart: LatencyStats;
		inputProjectionWork: LatencyStats;
		inputProjectionCommitToTask: LatencyStats;
		inputTaskToFrame: LatencyStats;
		inputFrameBeforeTaskCount: number;
		inputProjectionCommitToFrame: LatencyStats;
		inputFrameToPostPaint: LatencyStats;
		inputProjectionCommitToEchoPaint: LatencyStats;
		inputReceiptToEchoPaint: LatencyStats;
		bySource: Record<
			"keydown" | "input",
			{
				completedCount: number;
				correlationSupersededCount: number;
				failedCount: number;
				timedOutCount: number;
				timedOutAfterSuccessorOutputCount: number;
				timedOutWithoutSuccessorCount: number;
				dispatchToTransportConfirmation: LatencyStats;
				transportConfirmationToHostReceipt: LatencyStats;
				hostReceiptBeforeTransportConfirmationCount: number;
				hostAcceptedToOutput: LatencyStats;
				projectionCommitToTask: LatencyStats;
				taskToFrame: LatencyStats;
				frameBeforeTaskCount: number;
				projectionCommitToFrame: LatencyStats;
				frameToPostPaint: LatencyStats;
				inputToEchoPaint: LatencyStats;
			}
		>;
		completedCount: number;
		correlationSupersededCount: number;
		failedCount: number;
		timedOutCount: number;
		timedOutAfterSuccessorOutputCount: number;
		timedOutWithoutSuccessorCount: number;
		inFlightCount: number;
		recent: NonNullable<
			WorkspacePerformanceSnapshot["terminalInput"]
		>["samples"];
	};
	chatInput: {
		inputToCommit: LatencyStats;
		commitToFrame: LatencyStats;
		frameToPostPaint: LatencyStats;
		commitToPaint: LatencyStats;
		inputToPaint: LatencyStats;
		completedCount: number;
		timedOutCount: number;
		inFlightCount: number;
		latestSampleAgeMs: number | null;
		recent: NonNullable<WorkspacePerformanceSnapshot["chatInput"]>["samples"];
	};
	paneFocus: {
		commit: LatencyStats;
		eventMicrotask: LatencyStats;
		eventMessageTask: LatencyStats;
		eventTask: LatencyStats;
		firstFrame: LatencyStats;
		localGeometry: LatencyStats;
		terminalRoleCommit: LatencyStats;
		terminalRoleEffect: LatencyStats;
		terminalInputFocusCommit: LatencyStats;
		terminalInputFocusCall: LatencyStats;
		terminalInputFocusPreHandler: LatencyStats;
		terminalInputFocusHandler: LatencyStats;
		terminalInputFocusPostHandler: LatencyStats;
		terminalInputFocusProjection: LatencyStats;
		terminalInputFocusIntentDispatch: LatencyStats;
		terminalInputFocusNativeRemainder: LatencyStats;
		paint: LatencyStats;
		terminalInteractive: LatencyStats;
		incompleteTerminalCount: number;
		supersededCount: number;
		abortedCount: number;
		recent: NonNullable<WorkspacePerformanceSnapshot["paneFocus"]>;
	};
	totals: WorkspacePerformanceSnapshot["totals"];
	render: WorkspacePerformanceSnapshot["render"];
	sampleCount: number;
}
