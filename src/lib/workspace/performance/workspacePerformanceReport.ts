import {
  type LatencyStats,
  summarizeLatencyStats as stats,
} from "@/lib/workspace/performance/latencyStats";
import type {
  PaneOpenStats,
  WorkspaceJourneyStats,
  WorkspacePerformanceReport,
} from "@/lib/workspace/performance/workspacePerformanceReportTypes";
import type {
  AgentReadySample,
  PaneOpenSample,
  WorkspacePerformanceSnapshot,
  WorkspaceTransitionCacheState,
  WorkspaceTransitionSample,
} from "@/lib/workspace/performance/workspacePerformanceTypes";
import { summarizeTerminalInputPerformance } from "./terminalInputPerformanceReport";

export type { LatencyStats } from "@/lib/workspace/performance/latencyStats";
export type {
  PaneOpenStats,
  WorkspaceJourneyStats,
  WorkspacePerformanceReport,
} from "@/lib/workspace/performance/workspacePerformanceReportTypes";

function measuredInterval(
  startedMs: number | null,
  completedMs: number | null,
): number[] {
  if (startedMs === null || completedMs === null || completedMs < startedMs) {
    return [];
  }
  return [completedMs - startedMs];
}

function split(
  transitions: readonly WorkspaceTransitionSample[],
  field: WorkspaceLatencyField,
): { warm: LatencyStats; cold: LatencyStats } {
  const pick = (warm: boolean) =>
    transitions
      .filter((sample) => sample.warm === warm && sample[field] !== null)
      .map((sample) => sample[field] as number);
  return { warm: stats(pick(true)), cold: stats(pick(false)) };
}

function splitByCache(
  transitions: readonly WorkspaceTransitionSample[],
  field: WorkspaceLatencyField,
): Record<WorkspaceTransitionCacheState, LatencyStats> {
  const pick = (cacheState: WorkspaceTransitionCacheState) =>
    transitions
      .filter(
        (sample) => sample.cacheState === cacheState && sample[field] !== null,
      )
      .map((sample) => sample[field] as number);
  return {
    renderer: stats(pick("renderer")),
    model: stats(pick("model")),
    cold: stats(pick("cold")),
  };
}

function journeyStats(
  transitions: readonly WorkspaceTransitionSample[],
): WorkspaceJourneyStats {
  const pick = (field: WorkspaceLatencyField) =>
    stats(
      transitions.flatMap((sample) => {
        const value = sample[field];
        return value === null ? [] : [value];
      }),
    );
  const byRank = (
    field: "terminalPaintRanksMs" | "terminalStableRanksMs",
  ) => {
    const rankCount = Math.max(0, ...transitions.map((sample) => sample[field].length));
    return Array.from({ length: rankCount }, (_, rank) =>
      stats(
        transitions.flatMap((sample) => {
          const value = sample[field][rank];
          return value === undefined ? [] : [value];
        }),
      ),
    );
  };
  return {
    activationCommit: pick("workspaceCommitMs"),
    commitMicrotask: pick("workspaceCommitMicrotaskMs"),
    commitMessageTask: pick("workspaceCommitMessageTaskMs"),
    firstFrame: pick("workspaceFirstFrameMs"),
    workspacePaint: pick("workspacePaintMs"),
    firstInteractivePane: pick("firstInteractivePaneMs"),
    firstTerminalPaint: pick("firstTerminalPaintMs"),
    allTerminalStable: pick("allTerminalStableMs"),
    firstPaintToAllStable: stats(
      transitions.flatMap((sample) =>
        measuredInterval(
          sample.firstTerminalPaintMs,
          sample.allTerminalStableMs,
        ),
      ),
    ),
    terminalPaintByRank: byRank("terminalPaintRanksMs"),
    terminalStableByRank: byRank("terminalStableRanksMs"),
  };
}

type WorkspaceLatencyField =
  | "workspaceCommitMs"
  | "workspaceCommitMicrotaskMs"
  | "workspaceCommitMessageTaskMs"
  | "workspaceFirstFrameMs"
  | "workspacePaintMs"
  | "firstInteractivePaneMs"
  | "firstTerminalPaintMs"
  | "allTerminalPaintMs"
  | "firstTerminalStableMs"
  | "allTerminalStableMs";

function paneStats(samples: readonly PaneOpenSample[]): PaneOpenStats {
  const pick = (warm: boolean) =>
    samples
      .filter((sample) => sample.warm === warm && sample.openMs !== null)
      .map((sample) => sample.openMs as number);
  return { cold: stats(pick(false)), warm: stats(pick(true)) };
}

function summarizePaneOpens(
  samples: readonly PaneOpenSample[],
): WorkspacePerformanceReport["paneOpen"] {
  const byKind: Record<string, PaneOpenStats> = {};
  for (const kind of new Set(samples.map((sample) => sample.kind))) {
    byKind[kind] = paneStats(samples.filter((sample) => sample.kind === kind));
  }
  return { all: paneStats(samples), byKind };
}

/** provider-ready 집계 — cold(프로바이더 첫 스폰)/warm 분리 + 병목 격리용
 *  sub-timing(preflight=로그인셸, create=broker/host/ready-poll).
 *  실패(ok:false) 샘플은 지연 통계에서 빼고 개수만 보고한다. */
function summarizeAgentReady(
  samples: readonly AgentReadySample[],
): WorkspacePerformanceReport["agentReady"] {
  const succeeded = samples.filter((sample) => sample.ok);
  const byWarm = (subset: readonly AgentReadySample[]): PaneOpenStats => ({
    cold: stats(subset.filter((s) => !s.warm).map((s) => s.totalMs)),
    warm: stats(subset.filter((s) => s.warm).map((s) => s.totalMs)),
  });
  const byProvider: Record<string, PaneOpenStats> = {};
  for (const provider of new Set(succeeded.map((sample) => sample.provider))) {
    byProvider[provider] = byWarm(
      succeeded.filter((sample) => sample.provider === provider),
    );
  }
  return {
    all: byWarm(succeeded),
    byProvider,
    breakdown: {
      preflight: stats(succeeded.map((sample) => sample.preflightMs)),
      create: stats(succeeded.map((sample) => sample.createMs)),
    },
    failureCount: samples.length - succeeded.length,
  };
}

export function summarizeWorkspacePerformance(
  snapshot: WorkspacePerformanceSnapshot,
  options: { afterTransitionSequence?: number } = {},
): WorkspacePerformanceReport {
  const afterTransitionSequence = options.afterTransitionSequence;
  const transitions =
    afterTransitionSequence === undefined
      ? snapshot.transitions
      : snapshot.transitions.filter(
          (sample) => sample.sequence > afterTransitionSequence,
        );
  const switchTransitions = transitions.filter(
    (sample) => sample.visitKind !== "initial",
  );
  const terminalAttaches =
    afterTransitionSequence === undefined
      ? snapshot.terminalAttaches
      : snapshot.terminalAttaches.filter(
          (sample) =>
            sample.transitionSequence !== null &&
            sample.transitionSequence > afterTransitionSequence,
        );
  const attachStats = (
    field: keyof (typeof terminalAttaches)[number],
  ): LatencyStats =>
    stats(
      terminalAttaches.flatMap((sample) => {
        const value = sample[field];
        return typeof value === "number" ? [value] : [];
      }),
    );
  const chatInput = snapshot.chatInput ?? {
    samples: [],
    inFlightCount: 0,
    latestSampleAgeMs: null,
  };
  const completedChatInputs = chatInput.samples.filter(
    (sample) => sample.outcome === "complete",
  );
  const paneFocus = snapshot.paneFocus ?? [];
  return {
    workspaceCache: snapshot.workspaceCache ?? null,
    terminalPresentation: snapshot.terminalPresentation,
    journeys: {
      initialWorkspace: journeyStats(
        transitions.filter((sample) => sample.visitKind === "initial"),
      ),
      firstVisit: journeyStats(
        transitions.filter((sample) => sample.visitKind === "first_visit"),
      ),
      // Samples written before visit-kind instrumentation are real revisits.
      revisit: journeyStats(
        transitions.filter(
          (sample) =>
            sample.visitKind === "revisit" || sample.visitKind === undefined,
        ),
      ),
    },
    switchPaint: split(switchTransitions, "workspacePaintMs"),
    switchPaintByCache: splitByCache(switchTransitions, "workspacePaintMs"),
    firstInteractivePane: split(switchTransitions, "firstInteractivePaneMs"),
    firstInteractivePaneByCache: splitByCache(
      switchTransitions,
      "firstInteractivePaneMs",
    ),
    firstTerminalPaint: split(switchTransitions, "firstTerminalPaintMs"),
    firstTerminalPaintByCache: splitByCache(
      switchTransitions,
      "firstTerminalPaintMs",
    ),
    allTerminalPaintByCache: splitByCache(
      switchTransitions,
      "allTerminalPaintMs",
    ),
    firstTerminalStableByCache: splitByCache(
      switchTransitions,
      "firstTerminalStableMs",
    ),
    allTerminalStableByCache: splitByCache(
      switchTransitions,
      "allTerminalStableMs",
    ),
    recentTransitions: transitions.slice(-12),
    terminalAttach: {
      recovery: snapshot.terminalRecovery ?? null,
      frontendPreparation: attachStats("frontendPreparationMs"),
      renderableWait: attachStats("renderableWaitMs"),
      prepare: attachStats("prepareMs"),
      preAttachResize: attachStats("preAttachResizeMs"),
      backendCommand: attachStats("backendCommandMs"),
      frontendHydrationBarrier: attachStats(
        "frontendHydrationBarrierMs",
      ),
      receiptToBarrier: attachStats("receiptToBarrierMs"),
      barrierToPaint: attachStats("barrierToPaintMs"),
      paintToStable: attachStats("paintToStableMs"),
      invokeToStable: attachStats("invokeToStableMs"),
      incompleteCount: terminalAttaches.filter(
				(sample) => sample.outcome === "in_flight",
      ).length,
      integrity: snapshot.terminalAttachIntegrity,
      recent: terminalAttaches.slice(-24),
    },
    remountCost: stats(
      switchTransitions
        .filter((sample) => sample.remountCostMs !== null)
        .map((sample) => sample.remountCostMs as number),
    ),
    remountAttach: stats(
      switchTransitions
        .filter((sample) => sample.remountAttachMs !== null)
        .map((sample) => sample.remountAttachMs as number),
    ),
    paneOpen: summarizePaneOpens(snapshot.paneOpens),
    agentReady: summarizeAgentReady(snapshot.agentReady),
    terminalInput: summarizeTerminalInputPerformance(snapshot.terminalInput),
    chatInput: {
      inputToCommit: stats(
        completedChatInputs.flatMap((sample) =>
          sample.commitMs === null ? [] : [sample.commitMs],
        ),
      ),
      commitToFrame: stats(
        completedChatInputs.flatMap((sample) =>
          sample.commitToFrameMs === null ? [] : [sample.commitToFrameMs],
        ),
      ),
      frameToPostPaint: stats(
        completedChatInputs.flatMap((sample) =>
          sample.frameToPostPaintMs === null
            ? []
            : [sample.frameToPostPaintMs],
        ),
      ),
      commitToPaint: stats(
        completedChatInputs.flatMap((sample) =>
          sample.commitToPaintMs === null ? [] : [sample.commitToPaintMs],
        ),
      ),
      inputToPaint: stats(
        completedChatInputs.flatMap((sample) =>
          sample.paintMs === null ? [] : [sample.paintMs],
        ),
      ),
      completedCount: completedChatInputs.length,
      timedOutCount: chatInput.samples.filter(
        (sample) => sample.outcome === "timed_out",
      ).length,
      inFlightCount: chatInput.inFlightCount,
      latestSampleAgeMs: chatInput.latestSampleAgeMs,
      recent: chatInput.samples.slice(-24),
    },
    paneFocus: {
      commit: stats(
        paneFocus.flatMap((sample) =>
          sample.commitMs === null ? [] : [sample.commitMs],
        ),
      ),
      eventMicrotask: stats(
        paneFocus.flatMap((sample) =>
          sample.eventMicrotaskMs === null ? [] : [sample.eventMicrotaskMs],
        ),
      ),
      eventMessageTask: stats(
        paneFocus.flatMap((sample) =>
          sample.eventMessageTaskMs === null
            ? []
            : [sample.eventMessageTaskMs],
        ),
      ),
      eventTask: stats(
        paneFocus.flatMap((sample) =>
          sample.eventTaskMs === null ? [] : [sample.eventTaskMs],
        ),
      ),
      firstFrame: stats(
        paneFocus.flatMap((sample) =>
          sample.firstFrameMs === null ? [] : [sample.firstFrameMs],
        ),
      ),
      localGeometry: stats(
        paneFocus.flatMap((sample) =>
          sample.localGeometryCount === 0 ? [] : [sample.localGeometryMs],
        ),
      ),
      terminalRoleCommit: stats(
        paneFocus.flatMap((sample) =>
          sample.terminalRoleCommitMs === null
            ? []
            : [sample.terminalRoleCommitMs],
        ),
      ),
      terminalRoleEffect: stats(
        paneFocus.flatMap((sample) =>
          sample.terminalRoleCommitMs === null
            ? []
            : [sample.terminalRoleEffectMs],
        ),
      ),
      terminalInputFocusCommit: stats(
        paneFocus.flatMap((sample) =>
          sample.terminalInputFocusCommitMs === null
            ? []
            : [sample.terminalInputFocusCommitMs],
        ),
      ),
      terminalInputFocusCall: stats(
        paneFocus.flatMap((sample) =>
          sample.terminalInputFocusCommitMs === null
            ? []
            : [sample.terminalInputFocusCallMs],
        ),
      ),
      terminalInputFocusPreHandler: stats(
        paneFocus.flatMap((sample) =>
          typeof sample.terminalInputFocusPreHandlerMs === "number"
            ? [sample.terminalInputFocusPreHandlerMs]
            : [],
        ),
      ),
      terminalInputFocusHandler: stats(
        paneFocus.flatMap((sample) =>
          typeof sample.terminalInputFocusHandlerMs === "number"
            ? [sample.terminalInputFocusHandlerMs]
            : [],
        ),
      ),
      terminalInputFocusPostHandler: stats(
        paneFocus.flatMap((sample) =>
          typeof sample.terminalInputFocusPostHandlerMs === "number"
            ? [sample.terminalInputFocusPostHandlerMs]
            : [],
        ),
      ),
      terminalInputFocusProjection: stats(
        paneFocus.flatMap((sample) =>
          typeof sample.terminalInputFocusProjectionMs === "number"
            ? [sample.terminalInputFocusProjectionMs]
            : [],
        ),
      ),
      terminalInputFocusIntentDispatch: stats(
        paneFocus.flatMap((sample) =>
          typeof sample.terminalInputFocusIntentDispatchMs === "number"
            ? [sample.terminalInputFocusIntentDispatchMs]
            : [],
        ),
      ),
      terminalInputFocusNativeRemainder: stats(
        paneFocus.flatMap((sample) =>
          typeof sample.terminalInputFocusNativeRemainderMs === "number"
            ? [sample.terminalInputFocusNativeRemainderMs]
            : [],
        ),
      ),
      paint: stats(
        paneFocus.flatMap((sample) =>
          sample.paintMs === null ? [] : [sample.paintMs],
        ),
      ),
      terminalInteractive: stats(
        paneFocus.flatMap((sample) =>
          sample.terminal && sample.interactiveMs !== null
            ? [sample.interactiveMs]
            : [],
        ),
      ),
      incompleteTerminalCount: paneFocus.filter(
        (sample) => sample.terminal && sample.outcome === "pending",
      ).length,
      supersededCount: paneFocus.filter(
        (sample) => sample.outcome === "superseded",
      ).length,
      abortedCount: paneFocus.filter((sample) => sample.outcome === "aborted")
        .length,
      recent: paneFocus.slice(-24),
    },
    totals: snapshot.totals,
    render: snapshot.render,
    sampleCount: transitions.length,
  };
}
