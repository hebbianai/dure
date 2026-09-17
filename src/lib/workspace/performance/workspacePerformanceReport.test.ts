import { describe, expect, it } from "vitest";
import type { TerminalInputLatencySample } from "@/lib/terminal/interaction/terminalInputLatency";
import type { WorkspacePerformanceSnapshot } from "@/lib/workspace/performance/workspacePerformance";
import { summarizeWorkspacePerformance } from "@/lib/workspace/performance/workspacePerformanceReport";
import { emptyStructuredTerminalPresentationSnapshot } from "./structuredTerminalPresentationPerformance";

function snapshot(
  transitions: WorkspacePerformanceSnapshot["transitions"],
  paneOpens: WorkspacePerformanceSnapshot["paneOpens"] = [],
): WorkspacePerformanceSnapshot {
  return {
    transitions,
    terminalAttaches: [],
    terminalAttachIntegrity: {
      duplicatePhaseEvents: 0,
      missingPredecessorEvents: 0,
    },
    paneOpens,
    agentReady: [],
    workspaces: [],
    totals: {
      mountedWorkspaces: 2,
      terminalSurfaces: 3,
      webglContexts: 3,
      hmuxObservers: 1,
    },
    render: null,
    terminalPresentation: emptyStructuredTerminalPresentationSnapshot(),
  };
}

const p = (
  over: Partial<WorkspacePerformanceSnapshot["paneOpens"][number]>,
): WorkspacePerformanceSnapshot["paneOpens"][number] => ({
  sequence: 1,
  paneId: "pane",
  kind: "file",
  warm: true,
  startedAt: 0,
  openMs: null,
  ...over,
});

const t = (
  over: Partial<WorkspacePerformanceSnapshot["transitions"][number]>,
): WorkspacePerformanceSnapshot["transitions"][number] => ({
  sequence: 1,
  desktopId: "d",
  cacheState: "renderer",
  warm: true,
  startedAt: 0,
  workspaceCommitMs: null,
  workspaceCommitMicrotaskMs: null,
  workspaceCommitMessageTaskMs: null,
  workspaceFirstFrameMs: null,
  workspacePaintMs: null,
	firstInteractivePaneMs: null,
	firstInteractiveTerminalId: null,
  firstTerminalPaintMs: null,
  allTerminalPaintMs: null,
  firstTerminalStableMs: null,
  allTerminalStableMs: null,
  terminalPaintRanksMs: [],
  terminalStableRanksMs: [],
  expectedTerminalPanes: null,
  paintedTerminalPanes: 0,
  stableTerminalPanes: 0,
  slowestTerminalId: null,
  remountCostMs: null,
  remountAttachMs: null,
  ...over,
});

describe("summarizeWorkspacePerformance", () => {
	it("preserves structured projection counters without reinterpreting them", () => {
		const input = snapshot([
			t({ sequence: 1, visitKind: "revisit", workspacePaintMs: 99 }),
		]);
		input.terminalPresentation.byRole.background.commits = 4;
		input.terminalPresentation.byRole.background.totalMs = 9;
		input.terminalPresentation.byRole.background.maxMs = 3;
		input.terminalPresentation.total = {
			commits: 4,
			totalMs: 9,
			maxMs: 3,
		};

		const report = summarizeWorkspacePerformance(input, {
			afterTransitionSequence: 1,
		});
		expect(report.recentTransitions).toEqual([]);
		expect(report.terminalPresentation).toEqual(input.terminalPresentation);
	});

	it("preserves content-free workspace cache diagnostics", () => {
		const input = snapshot([]);
		input.workspaceCache = {
			budget: {
				maxWorkspaces: 6,
				maxTerminalSurfaces: 14,
				retainedWorkspaces: 12,
				retainedTerminalModelBytes: 2_147_483_648,
				reason: "high-resource",
			},
			occupancy: {
				total: {
					workspaces: 10,
					projectedTerminalSurfaces: 30,
					projectedTerminalModelBytes: 240,
				},
				warm: {
					workspaces: 3,
					projectedTerminalSurfaces: 9,
					projectedTerminalModelBytes: 72,
				},
				frozen: {
					workspaces: 7,
					projectedTerminalSurfaces: 21,
					projectedTerminalModelBytes: 168,
				},
			},
			backgroundPresentation: {
				terminalSurfaces: 0,
				recentWriterSurfaces: 0,
				bufferedBytes: 0,
				maxRecentWriteLatencyMs: 0,
			},
		};

		expect(summarizeWorkspacePerformance(input).workspaceCache).toEqual(
			input.workspaceCache,
		);
	});

	it("separates initial, first-visit, and revisit user journeys", () => {
		const report = summarizeWorkspacePerformance(
			snapshot([
				t({
					visitKind: "initial",
					workspaceCommitMs: 100,
					workspaceCommitMicrotaskMs: 110,
					workspaceCommitMessageTaskMs: 180,
					workspaceFirstFrameMs: 260,
					workspacePaintMs: 420,
					firstInteractivePaneMs: 520,
					allTerminalStableMs: 900,
				}),
				t({
					visitKind: "first_visit",
					workspacePaintMs: 180,
					allTerminalStableMs: 460,
				}),
				t({
					visitKind: "revisit",
					workspacePaintMs: 24,
					firstInteractivePaneMs: 40,
					allTerminalStableMs: 90,
				}),
			]),
		);

		expect(report.journeys.initialWorkspace.workspacePaint.median).toBe(420);
		expect(report.journeys.initialWorkspace.activationCommit.median).toBe(100);
		expect(report.journeys.initialWorkspace.commitMicrotask.median).toBe(110);
		expect(report.journeys.initialWorkspace.commitMessageTask.median).toBe(180);
		expect(report.journeys.initialWorkspace.firstFrame.median).toBe(260);
		expect(report.journeys.initialWorkspace.firstInteractivePane.median).toBe(520);
		expect(report.journeys.firstVisit.allTerminalStable.median).toBe(460);
		expect(report.journeys.revisit.workspacePaint.median).toBe(24);
		expect(report.switchPaint.cold.count).toBe(0);
		expect(report.switchPaint.warm.count).toBe(2);
	});

	it("reports content-free terminal paint and stable ranks within each journey", () => {
		const first = t({
			visitKind: "first_visit",
			firstTerminalPaintMs: 100,
			allTerminalStableMs: 700,
		});
		first.terminalPaintRanksMs = [100, 350, 680];
		first.terminalStableRanksMs = [120, 420, 700];

		const report = summarizeWorkspacePerformance(snapshot([first]));

		expect(report.journeys.firstVisit).toMatchObject({
			firstPaintToAllStable: {
				count: 1,
				median: 600,
				p95: 600,
				max: 600,
			},
			terminalPaintByRank: [
				{ count: 1, median: 100, p95: 100, max: 100 },
				{ count: 1, median: 350, p95: 350, max: 350 },
				{ count: 1, median: 680, p95: 680, max: 680 },
			],
			terminalStableByRank: [
				{ count: 1, median: 120, p95: 120, max: 120 },
				{ count: 1, median: 420, p95: 420, max: 420 },
				{ count: 1, median: 700, p95: 700, max: 700 },
			],
		});
	});

	it("reports pane-focus paint separately from terminal readiness", () => {
		const report = summarizeWorkspacePerformance({
			...snapshot([]),
			paneFocus: [
				{
					sequence: 1,
					desktopId: "desktop-1",
					panelId: "file:one",
					terminal: false,
					startedAt: 0,
					commitMs: 5,
					eventMicrotaskMs: 6,
					eventMessageTaskMs: 7,
					eventTaskMs: 8,
					firstFrameMs: 12,
					commitToFirstFrameSchedulerActivity: null,
					localGeometryMs: 0,
					localGeometryCount: 0,
					terminalRoleCommitMs: null,
					terminalRoleEffectMs: 0,
					terminalInputFocusCommitMs: null,
					terminalInputFocusCallMs: 0,
					terminalInputFocusPreHandlerMs: null,
					terminalInputFocusHandlerMs: null,
					terminalInputFocusPostHandlerMs: null,
					terminalInputFocusProjectionMs: null,
					terminalInputFocusIntentDispatchMs: null,
					terminalInputFocusNativeRemainderMs: null,
					paintMs: 20,
					interactiveMs: null,
					outcome: "complete",
				},
				{
					sequence: 2,
					desktopId: "desktop-1",
					panelId: "term:one",
					terminal: true,
					startedAt: 100,
					commitMs: 8,
					eventMicrotaskMs: 9,
					eventMessageTaskMs: 10,
					eventTaskMs: 11,
					firstFrameMs: 16,
					commitToFirstFrameSchedulerActivity: {
						reveal: { unitsRun: 1, msSpent: 2, starvationRescues: 0 },
						catchup: { unitsRun: 3, msSpent: 4, starvationRescues: 1 },
						maintenance: { unitsRun: 5, msSpent: 6, starvationRescues: 2 },
					},
					localGeometryMs: 4,
					localGeometryCount: 1,
					terminalRoleCommitMs: 14,
					terminalRoleEffectMs: 2,
					terminalInputFocusCommitMs: 15,
					terminalInputFocusCallMs: 3,
					terminalInputFocusPreHandlerMs: 0.25,
					terminalInputFocusHandlerMs: 2,
					terminalInputFocusPostHandlerMs: 0.75,
					terminalInputFocusProjectionMs: 0.5,
					terminalInputFocusIntentDispatchMs: 1,
					terminalInputFocusNativeRemainderMs: 1,
					paintMs: 24,
					interactiveMs: 45,
					outcome: "complete",
				},
				{
					sequence: 3,
					desktopId: "desktop-1",
					panelId: "term:slow",
					terminal: true,
					startedAt: 200,
					commitMs: 12,
					eventMicrotaskMs: 13,
					eventMessageTaskMs: 14,
					eventTaskMs: 15,
					firstFrameMs: 18,
					commitToFirstFrameSchedulerActivity: null,
					localGeometryMs: 9,
					localGeometryCount: 2,
					terminalRoleCommitMs: 17,
					terminalRoleEffectMs: 3,
					terminalInputFocusCommitMs: 18,
					terminalInputFocusCallMs: 4,
					terminalInputFocusPreHandlerMs: 0.5,
					terminalInputFocusHandlerMs: 3,
					terminalInputFocusPostHandlerMs: 0.5,
					terminalInputFocusProjectionMs: 1,
					terminalInputFocusIntentDispatchMs: null,
					terminalInputFocusNativeRemainderMs: 1,
					paintMs: 30,
					interactiveMs: null,
					outcome: "pending",
				},
				{
					sequence: 4,
					desktopId: "desktop-1",
					panelId: "term:superseded",
					terminal: true,
					startedAt: 300,
					commitMs: null,
					eventMicrotaskMs: null,
					eventMessageTaskMs: null,
					eventTaskMs: null,
					firstFrameMs: null,
					commitToFirstFrameSchedulerActivity: null,
					localGeometryMs: 0,
					localGeometryCount: 0,
					terminalRoleCommitMs: null,
					terminalRoleEffectMs: 0,
					terminalInputFocusCommitMs: null,
					terminalInputFocusCallMs: 0,
					terminalInputFocusPreHandlerMs: null,
					terminalInputFocusHandlerMs: null,
					terminalInputFocusPostHandlerMs: null,
					terminalInputFocusProjectionMs: null,
					terminalInputFocusIntentDispatchMs: null,
					terminalInputFocusNativeRemainderMs: null,
					paintMs: null,
					interactiveMs: null,
					outcome: "superseded",
				},
				{
					sequence: 5,
					desktopId: "desktop-1",
					panelId: "term:aborted",
					terminal: true,
					startedAt: 400,
					commitMs: null,
					eventMicrotaskMs: null,
					eventMessageTaskMs: null,
					eventTaskMs: null,
					firstFrameMs: null,
					commitToFirstFrameSchedulerActivity: null,
					localGeometryMs: 0,
					localGeometryCount: 0,
					terminalRoleCommitMs: null,
					terminalRoleEffectMs: 0,
					terminalInputFocusCommitMs: null,
					terminalInputFocusCallMs: 0,
					terminalInputFocusPreHandlerMs: null,
					terminalInputFocusHandlerMs: null,
					terminalInputFocusPostHandlerMs: null,
					terminalInputFocusProjectionMs: null,
					terminalInputFocusIntentDispatchMs: null,
					terminalInputFocusNativeRemainderMs: null,
					paintMs: null,
					interactiveMs: null,
					outcome: "aborted",
				},
			],
		});

		expect(report.paneFocus.paint).toMatchObject({
			count: 3,
			median: 24,
			max: 30,
		});
		expect(report.paneFocus.commit).toMatchObject({
			count: 3,
			median: 8,
			max: 12,
		});
		expect(report.paneFocus.firstFrame).toMatchObject({
			count: 3,
			median: 16,
			max: 18,
		});
		expect(report.paneFocus.localGeometry).toMatchObject({
			count: 2,
			median: 4,
			max: 9,
		});
		expect(report.paneFocus.terminalInputFocusCall).toMatchObject({
			count: 2,
			median: 3,
			max: 4,
		});
		expect(report.paneFocus.terminalInputFocusPreHandler).toMatchObject({
			count: 2,
			median: 0.25,
			max: 0.5,
		});
		expect(report.paneFocus.terminalInputFocusHandler).toMatchObject({
			count: 2,
			median: 2,
			max: 3,
		});
		expect(report.paneFocus.terminalInputFocusPostHandler).toMatchObject({
			count: 2,
			median: 0.5,
			max: 0.75,
		});
		expect(report.paneFocus.terminalInputFocusProjection).toMatchObject({
			count: 2,
			median: 0.5,
			max: 1,
		});
		expect(report.paneFocus.terminalInputFocusIntentDispatch).toMatchObject({
			count: 1,
			median: 1,
			max: 1,
		});
		expect(report.paneFocus.terminalInputFocusNativeRemainder).toMatchObject({
			count: 2,
			median: 1,
			max: 1,
		});
		expect(report.paneFocus.terminalInteractive.median).toBe(45);
		expect(report.paneFocus.incompleteTerminalCount).toBe(1);
		expect(report.paneFocus.supersededCount).toBe(1);
		expect(report.paneFocus.abortedCount).toBe(1);
		expect(
			report.paneFocus.recent[1]?.commitToFirstFrameSchedulerActivity,
		).toEqual({
			reveal: { unitsRun: 1, msSpent: 2, starvationRescues: 0 },
			catchup: { unitsRun: 3, msSpent: 4, starvationRescues: 1 },
			maintenance: { unitsRun: 5, msSpent: 6, starvationRescues: 2 },
		});
	});

	it("summarizes real keydown to Host receipt and echo-paint stages", () => {
		const report = summarizeWorkspacePerformance({
			...snapshot([]),
			terminalInput: {
				inFlightCount: 1,
				samples: [
					{
						sequence: 1,
						terminalId: "terminal-1",
						desktopId: "desktop-1",
						source: "keydown",
						startedAt: 10,
						dispatchMs: 3,
						captureToSemanticHandlerMs: 1,
						semanticHandlerToDispatchMs: 2,
						semanticHandlerToDecisionMs: 1,
						semanticDecisionToDispatchMs: 1,
						replacementChainActiveAtCapture: false,
						transportConfirmationMs: 8,
						hostReceiptBeforeTransportConfirmation: false,
						hostReceiptMs: 28,
						successorOutputObserved: true,
						hostInputAcceptedToOutputMs: 17,
						hostOutputToProjectionStartMs: 5,
						outputReceivedMs: 34,
						projectionStartedMs: 36,
						projectionCommittedMs: 39,
						echoTaskMs: 40,
						echoFrameMs: 42,
						frameBeforeTask: false,
						taskToFrameSchedulerActivity: {
							unitsRun: 4,
							msSpent: 7,
							terminalPresentationUnitsRun: 3,
							terminalPresentationMsSpent: 5,
						},
						echoPaintMs: 44,
						receiptToOutputMs: 6,
						outputToPaintMs: 10,
						receiptToPaintMs: 16,
						outcome: "complete",
					},
					{
						sequence: 2,
						terminalId: "terminal-1",
						desktopId: "desktop-1",
						source: "input",
						startedAt: 100,
						dispatchMs: 0,
						captureToSemanticHandlerMs: null,
						semanticHandlerToDispatchMs: null,
						semanticHandlerToDecisionMs: null,
						semanticDecisionToDispatchMs: null,
						replacementChainActiveAtCapture: null,
						transportConfirmationMs: 14,
						hostReceiptBeforeTransportConfirmation: true,
						hostReceiptMs: 12,
						successorOutputObserved: true,
						hostInputAcceptedToOutputMs: 8,
						hostOutputToProjectionStartMs: 2,
						outputReceivedMs: 15,
						projectionStartedMs: 16,
						projectionCommittedMs: 18,
						echoTaskMs: 20,
						echoFrameMs: 19,
						frameBeforeTask: true,
						taskToFrameSchedulerActivity: null,
						echoPaintMs: 20,
						receiptToOutputMs: 3,
						outputToPaintMs: 5,
						receiptToPaintMs: 8,
						outcome: "complete",
					},
					{
						sequence: 3,
						terminalId: "terminal-2",
						desktopId: null,
						source: "keydown",
						startedAt: 200,
						dispatchMs: 1,
						captureToSemanticHandlerMs: 1,
						semanticHandlerToDispatchMs: 0,
						semanticHandlerToDecisionMs: 0,
						semanticDecisionToDispatchMs: 0,
						replacementChainActiveAtCapture: true,
						transportConfirmationMs: null,
						hostReceiptBeforeTransportConfirmation: null,
						hostReceiptMs: null,
						successorOutputObserved: false,
						hostInputAcceptedToOutputMs: null,
						hostOutputToProjectionStartMs: null,
						outputReceivedMs: null,
						projectionStartedMs: null,
						projectionCommittedMs: null,
						echoTaskMs: null,
						echoFrameMs: null,
						frameBeforeTask: null,
						taskToFrameSchedulerActivity: null,
						echoPaintMs: null,
						receiptToOutputMs: null,
						outputToPaintMs: null,
						receiptToPaintMs: null,
						outcome: "failed",
					},
					{
						sequence: 4,
						terminalId: "terminal-2",
						desktopId: null,
						source: "input",
						startedAt: 300,
						dispatchMs: 0,
						captureToSemanticHandlerMs: null,
						semanticHandlerToDispatchMs: null,
						semanticHandlerToDecisionMs: null,
						semanticDecisionToDispatchMs: null,
						replacementChainActiveAtCapture: null,
						transportConfirmationMs: null,
						hostReceiptBeforeTransportConfirmation: null,
						hostReceiptMs: 1,
						successorOutputObserved: false,
						hostInputAcceptedToOutputMs: null,
						hostOutputToProjectionStartMs: null,
						outputReceivedMs: null,
						projectionStartedMs: null,
						projectionCommittedMs: null,
						echoTaskMs: null,
						echoFrameMs: null,
						frameBeforeTask: null,
						taskToFrameSchedulerActivity: null,
						echoPaintMs: null,
						receiptToOutputMs: null,
						outputToPaintMs: null,
						receiptToPaintMs: null,
						outcome: "timed_out",
					},
				],
			},
		});

		expect(report.terminalInput).toMatchObject({
			dispatch: { count: 1, median: 3, p95: 3, max: 3 },
			keydownDispatchStages: {
				captureToSemanticHandler: {
					count: 1,
					median: 1,
					p95: 1,
					max: 1,
				},
				semanticHandlerToDispatch: {
					count: 1,
					median: 2,
					p95: 2,
					max: 2,
				},
				semanticHandlerToDecision: {
					count: 1,
					median: 1,
					p95: 1,
					max: 1,
				},
				semanticDecisionToDispatch: {
					count: 1,
					median: 1,
					p95: 1,
					max: 1,
				},
				byReplacementState: {
					inactive: {
						dispatch: { count: 1, median: 3, p95: 3, max: 3 },
						captureToSemanticHandler: {
							count: 1,
							median: 1,
							p95: 1,
							max: 1,
						},
						semanticHandlerToDispatch: {
							count: 1,
							median: 2,
							p95: 2,
							max: 2,
						},
						semanticHandlerToDecision: {
							count: 1,
							median: 1,
							p95: 1,
							max: 1,
						},
						semanticDecisionToDispatch: {
							count: 1,
							median: 1,
							p95: 1,
							max: 1,
						},
					},
					active: {
						dispatch: {
							count: 0,
							median: null,
							p95: null,
							max: null,
						},
					},
					unknown: {
						dispatch: { count: 0 },
					},
				},
			},
			keydownToHostReceipt: { count: 1, median: 28, p95: 28, max: 28 },
			keydownToEchoPaint: { count: 1, median: 44, p95: 44, max: 44 },
			hostReceiptToEchoPaint: { count: 1, median: 16, p95: 16, max: 16 },
			inputToHostReceipt: { count: 3, median: 12, p95: 28, max: 28 },
			inputDispatchToTransportConfirmation: {
				count: 2,
				median: 5,
				p95: 14,
				max: 14,
			},
			inputTransportConfirmationToHostReceipt: {
				count: 1,
				median: 20,
				p95: 20,
				max: 20,
			},
			inputHostReceiptBeforeTransportConfirmationCount: 1,
			inputHostAcceptedToOutput: {
				count: 2,
				median: 8,
				p95: 17,
				max: 17,
			},
			inputHostOutputToProjectionStart: {
				count: 2,
				median: 2,
				p95: 5,
				max: 5,
			},
			inputToOutputReceived: { count: 2, median: 15, p95: 34, max: 34 },
			inputReceiptToOutputReceived: { count: 2, median: 3, p95: 6, max: 6 },
			inputToEchoPaint: { count: 2, median: 20, p95: 44, max: 44 },
			inputOutputToEchoPaint: { count: 2, median: 5, p95: 10, max: 10 },
			inputOutputToProjectionStart: {
				count: 2,
				median: 1,
				p95: 2,
				max: 2,
			},
			inputProjectionWork: { count: 2, median: 2, p95: 3, max: 3 },
			inputProjectionCommitToTask: {
				count: 1,
				median: 1,
				p95: 1,
				max: 1,
			},
			inputTaskToFrame: { count: 1, median: 2, p95: 2, max: 2 },
			inputFrameBeforeTaskCount: 1,
			inputProjectionCommitToFrame: {
				count: 2,
				median: 1,
				p95: 3,
				max: 3,
			},
			inputFrameToPostPaint: {
				count: 2,
				median: 1,
				p95: 2,
				max: 2,
			},
			inputProjectionCommitToEchoPaint: {
				count: 2,
				median: 2,
				p95: 5,
				max: 5,
			},
			inputReceiptToEchoPaint: { count: 2, median: 8, p95: 16, max: 16 },
			bySource: {
				keydown: {
					completedCount: 1,
					failedCount: 1,
					timedOutCount: 0,
					dispatchToTransportConfirmation: {
						count: 1,
						median: 5,
						p95: 5,
						max: 5,
					},
					transportConfirmationToHostReceipt: {
						count: 1,
						median: 20,
						p95: 20,
						max: 20,
					},
					hostReceiptBeforeTransportConfirmationCount: 0,
					hostAcceptedToOutput: {
						count: 1,
						median: 17,
						p95: 17,
						max: 17,
					},
					projectionCommitToTask: {
						count: 1,
						median: 1,
						p95: 1,
						max: 1,
					},
					taskToFrame: {
						count: 1,
						median: 2,
						p95: 2,
						max: 2,
					},
					frameBeforeTaskCount: 0,
					projectionCommitToFrame: {
						count: 1,
						median: 3,
						p95: 3,
						max: 3,
					},
					frameToPostPaint: {
						count: 1,
						median: 2,
						p95: 2,
						max: 2,
					},
					inputToEchoPaint: { count: 1, median: 44, p95: 44, max: 44 },
				},
				input: {
					completedCount: 1,
					failedCount: 0,
					timedOutCount: 1,
					dispatchToTransportConfirmation: {
						count: 1,
						median: 14,
						p95: 14,
						max: 14,
					},
					transportConfirmationToHostReceipt: {
						count: 0,
						median: null,
						p95: null,
						max: null,
					},
					hostReceiptBeforeTransportConfirmationCount: 1,
					hostAcceptedToOutput: {
						count: 1,
						median: 8,
						p95: 8,
						max: 8,
					},
					projectionCommitToTask: {
						count: 0,
						median: null,
						p95: null,
						max: null,
					},
					taskToFrame: {
						count: 0,
						median: null,
						p95: null,
						max: null,
					},
					frameBeforeTaskCount: 1,
					projectionCommitToFrame: {
						count: 1,
						median: 1,
						p95: 1,
						max: 1,
					},
					frameToPostPaint: {
						count: 1,
						median: 1,
						p95: 1,
						max: 1,
					},
					inputToEchoPaint: { count: 1, median: 20, p95: 20, max: 20 },
				},
			},
			completedCount: 2,
			failedCount: 1,
			timedOutCount: 1,
			inFlightCount: 1,
		});
		expect(report.terminalInput.recent).toHaveLength(4);
		expect(
			report.terminalInput.recent[0]?.taskToFrameSchedulerActivity,
		).toEqual({
			unitsRun: 4,
			msSpent: 7,
			terminalPresentationUnitsRun: 3,
			terminalPresentationMsSpent: 5,
		});
	});

	it("separates missing, uncorrelated, and superseded input successors", () => {
		const base: Omit<
			TerminalInputLatencySample,
			"outcome" | "sequence" | "successorOutputObserved"
		> = {
			terminalId: "terminal-1",
			desktopId: "desktop-1",
			source: "input",
			startedAt: 10,
			dispatchMs: 0,
			captureToSemanticHandlerMs: null,
			semanticHandlerToDispatchMs: null,
			semanticHandlerToDecisionMs: null,
			semanticDecisionToDispatchMs: null,
			replacementChainActiveAtCapture: null,
			transportConfirmationMs: 1,
			hostReceiptBeforeTransportConfirmation: false,
			hostReceiptMs: 2,
			hostInputAcceptedToOutputMs: null,
			hostOutputToProjectionStartMs: null,
			outputReceivedMs: null,
			projectionStartedMs: null,
			projectionCommittedMs: null,
			echoTaskMs: null,
			echoFrameMs: null,
			frameBeforeTask: null,
			taskToFrameSchedulerActivity: null,
			echoPaintMs: null,
			receiptToOutputMs: null,
			outputToPaintMs: null,
			receiptToPaintMs: null,
		};
		const report = summarizeWorkspacePerformance({
			...snapshot([]),
			terminalInput: {
				inFlightCount: 0,
				samples: [
					{
						...base,
						sequence: 1,
						successorOutputObserved: false,
						outcome: "timed_out",
					},
					{
						...base,
						sequence: 2,
						successorOutputObserved: true,
						outcome: "timed_out",
					},
					{
						...base,
						sequence: 3,
						successorOutputObserved: true,
						outcome: "correlation_superseded",
					},
				],
			},
		});

		expect(report.terminalInput).toMatchObject({
			completedCount: 0,
			correlationSupersededCount: 1,
			inputToHostReceipt: { count: 3, median: 2, p95: 2, max: 2 },
			inputDispatchToTransportConfirmation: {
				count: 3,
				median: 1,
				p95: 1,
				max: 1,
			},
			inputTransportConfirmationToHostReceipt: {
				count: 3,
				median: 1,
				p95: 1,
				max: 1,
			},
			timedOutCount: 2,
			timedOutAfterSuccessorOutputCount: 1,
			timedOutWithoutSuccessorCount: 1,
			bySource: {
				input: {
					correlationSupersededCount: 1,
					dispatchToTransportConfirmation: {
						count: 3,
						median: 1,
						p95: 1,
						max: 1,
					},
					transportConfirmationToHostReceipt: {
						count: 3,
						median: 1,
						p95: 1,
						max: 1,
					},
					timedOutCount: 2,
					timedOutAfterSuccessorOutputCount: 1,
					timedOutWithoutSuccessorCount: 1,
				},
			},
		});
	});

	it("summarizes Structured Chat input commit and paint stages", () => {
		const report = summarizeWorkspacePerformance({
			...snapshot([]),
			chatInput: {
				inFlightCount: 1,
				latestSampleAgeMs: 12,
				samples: [
					{
						sequence: 1,
						startedAt: 10,
						commitMs: 3,
						commitToFrameMs: 6,
						frameToPostPaintMs: 11,
						paintMs: 20,
						commitToPaintMs: 17,
						outcome: "complete",
					},
					{
						sequence: 2,
						startedAt: 100,
						commitMs: null,
						commitToFrameMs: null,
						frameToPostPaintMs: null,
						paintMs: null,
						commitToPaintMs: null,
						outcome: "timed_out",
					},
				],
			},
		});

		expect(report.chatInput).toMatchObject({
			inputToCommit: { count: 1, median: 3, p95: 3, max: 3 },
			commitToFrame: { count: 1, median: 6, p95: 6, max: 6 },
			frameToPostPaint: { count: 1, median: 11, p95: 11, max: 11 },
			commitToPaint: { count: 1, median: 17, p95: 17, max: 17 },
			inputToPaint: { count: 1, median: 20, p95: 20, max: 20 },
			completedCount: 1,
			timedOutCount: 1,
			inFlightCount: 1,
			latestSampleAgeMs: 12,
		});
		expect(report.chatInput.recent).toHaveLength(2);
	});

  it("splits switch-paint latency into warm and cold with median/p95/max", () => {
    const report = summarizeWorkspacePerformance(
      snapshot([
        t({ warm: true, workspacePaintMs: 10 }),
        t({ warm: true, workspacePaintMs: 20 }),
        t({ warm: true, workspacePaintMs: 30 }),
        t({ warm: false, workspacePaintMs: 200 }),
      ]),
    );
    expect(report.switchPaint.warm.count).toBe(3);
    expect(report.switchPaint.warm.median).toBe(20);
    expect(report.switchPaint.warm.max).toBe(30);
    expect(report.switchPaint.cold.count).toBe(1);
    expect(report.switchPaint.cold.median).toBe(200);
  });

  it("separates renderer reuse from retained DOM-model reveal", () => {
    const report = summarizeWorkspacePerformance(
      snapshot([
        t({ cacheState: "renderer", warm: true, workspacePaintMs: 12 }),
        t({ cacheState: "model", warm: true, workspacePaintMs: 28 }),
        t({ cacheState: "cold", warm: false, workspacePaintMs: 180 }),
      ]),
    );

    expect(report.switchPaintByCache.renderer.median).toBe(12);
    expect(report.switchPaintByCache.model.median).toBe(28);
    expect(report.switchPaintByCache.cold.median).toBe(180);
  });

  it("reports first/all pane stable readiness by cache and preserves recent raw samples", () => {
    const report = summarizeWorkspacePerformance(
      snapshot([
        t({
          desktopId: "gesto",
          cacheState: "model",
					firstInteractivePaneMs: 120,
					firstInteractiveTerminalId: "pane-focus",
          firstTerminalStableMs: 180,
          allTerminalStableMs: 240,
          expectedTerminalPanes: 2,
          stableTerminalPanes: 2,
          slowestTerminalId: "pane-slow",
        }),
        t({
          desktopId: "main",
          cacheState: "renderer",
          firstTerminalStableMs: 24,
          allTerminalStableMs: 40,
          expectedTerminalPanes: 3,
          stableTerminalPanes: 3,
        }),
      ]),
    );

    expect(report.firstTerminalStableByCache.model.median).toBe(180);
		expect(report.firstInteractivePaneByCache.model.median).toBe(120);
		expect(report.firstInteractivePane.warm.median).toBe(120);
    expect(report.allTerminalStableByCache.model.median).toBe(240);
    expect(report.allTerminalStableByCache.renderer.median).toBe(40);
    expect(report.recentTransitions[0]).toMatchObject({
      desktopId: "gesto",
      slowestTerminalId: "pane-slow",
      expectedTerminalPanes: 2,
    });
  });

  it("summarizes redacted terminal attach segments and incomplete samples", () => {
    const base = snapshot([]);
    const report = summarizeWorkspacePerformance({
      ...base,
      terminalAttaches: [
        {
          sequence: 1,
          transitionSequence: 3,
          frontendPreparationMs: 20,
          renderableWaitMs: 5,
          prepareMs: 10,
          preAttachResizeMs: 5,
          frontendInvokeMs: 70,
          backendCommandMs: 50,
          frontendHydrationBarrierMs: 60,
          receiptToBarrierMs: 40,
          barrierToPaintMs: 16,
          paintToStableMs: 80,
          invokeToStableMs: 186,
          outcome: "stable",
        },
        {
          sequence: 2,
          transitionSequence: 4,
          frontendPreparationMs: 30,
          renderableWaitMs: 10,
          prepareMs: 15,
          preAttachResizeMs: 5,
          frontendInvokeMs: 90,
          backendCommandMs: 70,
          frontendHydrationBarrierMs: null,
          receiptToBarrierMs: null,
          barrierToPaintMs: null,
          paintToStableMs: null,
          invokeToStableMs: null,
          outcome: "in_flight",
        },
      ],
      terminalAttachIntegrity: {
        duplicatePhaseEvents: 1,
        missingPredecessorEvents: 2,
      },
    });

    expect(report.terminalAttach.backendCommand).toMatchObject({
      count: 2,
      median: 50,
      max: 70,
    });
    expect(report.terminalAttach.frontendHydrationBarrier.median).toBe(60);
    expect(report.terminalAttach.paintToStable.median).toBe(80);
    expect(report.terminalAttach.incompleteCount).toBe(1);
    expect(report.terminalAttach.integrity).toEqual({
      duplicatePhaseEvents: 1,
      missingPredecessorEvents: 2,
    });
  });

  it("summarizes cold remount cost from samples that measured it", () => {
    const report = summarizeWorkspacePerformance(
      snapshot([
        t({ warm: false, workspacePaintMs: 200, remountCostMs: 150 }),
        t({ warm: false, workspacePaintMs: 240, remountCostMs: 190 }),
        t({ warm: true, workspacePaintMs: 20 }),
      ]),
    );
    expect(report.remountCost.count).toBe(2);
    expect(report.remountCost.median).toBe(150);
    expect(report.remountCost.max).toBe(190);
  });

  it("ignores samples whose metric is null (paint not yet observed)", () => {
    const report = summarizeWorkspacePerformance(
      snapshot([
        t({ warm: true, workspacePaintMs: 15, firstTerminalPaintMs: null }),
        t({ warm: true, workspacePaintMs: null, firstTerminalPaintMs: 40 }),
      ]),
    );
    expect(report.switchPaint.warm.count).toBe(1);
    expect(report.switchPaint.warm.median).toBe(15);
    expect(report.firstTerminalPaint.warm.count).toBe(1);
    expect(report.firstTerminalPaint.warm.median).toBe(40);
    expect(report.sampleCount).toBe(2);
  });

  it("can summarize only transitions after a harness phase boundary", () => {
    const report = summarizeWorkspacePerformance(
      snapshot([
        t({ sequence: 4, workspacePaintMs: 500 }),
        t({ sequence: 5, workspacePaintMs: 18 }),
        t({ sequence: 6, workspacePaintMs: 20 }),
      ]),
      { afterTransitionSequence: 4 },
    );

    expect(report.switchPaint.warm).toMatchObject({
      count: 2,
      median: 18,
      max: 20,
    });
    expect(report.sampleCount).toBe(2);
    expect(report.recentTransitions.map((sample) => sample.sequence)).toEqual([
      5, 6,
    ]);
  });

  it("returns null stats when there are no samples", () => {
    const report = summarizeWorkspacePerformance(snapshot([]));
    expect(report.switchPaint.warm).toEqual({
      count: 0,
      median: null,
      p95: null,
      max: null,
    });
    expect(report.sampleCount).toBe(0);
  });

  it("passes render/totals through for a full performance read", () => {
    const report = summarizeWorkspacePerformance(snapshot([]));
    expect(report.totals.webglContexts).toBe(3);
    expect(report.render).toBeNull();
  });

  it("summarizes pane-open latency by kind, split into cold and warm", () => {
    const report = summarizeWorkspacePerformance(
      snapshot(
        [],
        [
          p({ kind: "file", warm: false, openMs: 120 }),
          p({ kind: "file", warm: true, openMs: 8 }),
          p({ kind: "file", warm: true, openMs: 12 }),
          p({ kind: "diff", warm: false, openMs: 90 }),
        ],
      ),
    );
    expect(report.paneOpen.byKind.file.cold.count).toBe(1);
    expect(report.paneOpen.byKind.file.cold.median).toBe(120);
    expect(report.paneOpen.byKind.file.warm.count).toBe(2);
    // nearest-rank median of [8,12] is the lower element (rank 1).
    expect(report.paneOpen.byKind.file.warm.median).toBe(8);
    expect(report.paneOpen.byKind.file.warm.max).toBe(12);
    expect(report.paneOpen.byKind.diff.cold.median).toBe(90);
    // all은 kind를 합산한다: cold 2건(120,90), warm 2건(8,12).
    expect(report.paneOpen.all.cold.count).toBe(2);
    expect(report.paneOpen.all.warm.count).toBe(2);
  });

  it("ignores pane opens still in flight (openMs null)", () => {
    const report = summarizeWorkspacePerformance(
      snapshot([], [p({ kind: "file", warm: false, openMs: null })]),
    );
    expect(report.paneOpen.all.cold.count).toBe(0);
    expect(report.paneOpen.byKind.file.cold.count).toBe(0);
  });

  it("summarizes agent provider-ready by provider with preflight/create breakdown", () => {
    const a = (
      over: Partial<WorkspacePerformanceSnapshot["agentReady"][number]>,
    ): WorkspacePerformanceSnapshot["agentReady"][number] => ({
      sequence: 1,
      provider: "claude",
      warm: false,
      ok: true,
      totalMs: 1000,
      preflightMs: 200,
      createMs: 800,
      ...over,
    });
    const base = snapshot([]);
    const report = summarizeWorkspacePerformance({
      ...base,
      agentReady: [
        a({ provider: "claude", warm: false, totalMs: 2000, preflightMs: 400, createMs: 1600 }),
        a({ provider: "claude", warm: true, totalMs: 900, preflightMs: 100, createMs: 800 }),
        a({ provider: "claude", warm: true, totalMs: 1100, preflightMs: 150, createMs: 950 }),
        a({ provider: "codex", warm: false, totalMs: 3000, preflightMs: 500, createMs: 2500 }),
        // 실패 스폰: 지연 통계에서 빠지고 failureCount로만 잡힌다.
        a({ provider: "codex", warm: false, ok: false, totalMs: 30000, preflightMs: 600, createMs: 29400 }),
      ],
    });
    expect(report.agentReady.byProvider.claude.cold.count).toBe(1);
    expect(report.agentReady.byProvider.claude.cold.median).toBe(2000);
    expect(report.agentReady.byProvider.claude.warm.count).toBe(2);
    // nearest-rank median of [900,1100] is the lower element.
    expect(report.agentReady.byProvider.claude.warm.median).toBe(900);
    expect(report.agentReady.byProvider.codex.cold.median).toBe(3000);
    expect(report.agentReady.byProvider.codex.cold.count).toBe(1);
    expect(report.agentReady.all.cold.count).toBe(2);
    expect(report.agentReady.all.warm.count).toBe(2);
    // breakdown은 warm/cold 구분 없이 병목 위치(preflight vs create)를 본다.
    expect(report.agentReady.breakdown.preflight.count).toBe(4);
    expect(report.agentReady.breakdown.preflight.max).toBe(500);
    expect(report.agentReady.breakdown.create.max).toBe(2500);
    expect(report.agentReady.failureCount).toBe(1);
  });
});
