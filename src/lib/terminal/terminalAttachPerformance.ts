import type { TerminalRecoveryTimingEvent } from "./terminalRecoveryPerformance";

export type TerminalAttachTimingEvent =
  | TerminalAttachSegmentTimingEvent
  | TerminalRecoveryTimingEvent;

type TerminalAttachSegmentTimingEvent =
  | {
      phase: "invoke_started";
      correlationId: string;
      renderableWaitMs?: number;
      prepareMs?: number;
      preAttachResizeMs?: number;
    }
  | {
      phase: "receipt";
      correlationId: string;
      backendCommandMs?: number;
      frontendInvokeMs: number;
    }
  | {
      phase: "barrier";
      correlationId: string;
    };

export interface TerminalAttachSegmentSample {
  /** Window-local, redacted correlation. Native observer/session ids stay private. */
  sequence: number;
  /** Space transition that owned the attach, when one was active. */
  transitionSequence: number | null;
  frontendPreparationMs: number | null;
  renderableWaitMs: number | null;
  prepareMs: number | null;
  preAttachResizeMs: number | null;
  /** Nested diagnostic for the frontend invoke round trip. */
  frontendInvokeMs: number | null;
  /** Native command entry through response construction. */
  backendCommandMs: number | null;
  /** Invoke overhead plus receipt-to-renderer-barrier work, excluding backend time. */
  frontendHydrationBarrierMs: number | null;
  receiptToBarrierMs: number | null;
  barrierToPaintMs: number | null;
  paintToStableMs: number | null;
  /** Exact frontend monotonic invoke-start through stable-ready duration. */
  invokeToStableMs: number | null;
  outcome: "in_flight" | "synchronized" | "stable" | "superseded";
}

export interface TerminalAttachIntegrity {
  duplicatePhaseEvents: number;
  missingPredecessorEvents: number;
}

interface AttachProgress {
  terminalId: string;
  correlationId: string;
  invokeStartedAt: number;
  receiptAt?: number;
  barrierAt?: number;
  paintAt?: number;
  synchronized: boolean;
  hidden: boolean;
  sample: TerminalAttachSegmentSample;
}

const DEFAULT_MAX_SAMPLES = 96;

/**
 * Window-local attach segmentation. It accepts opaque runtime ids for matching,
 * but snapshots expose only bounded numeric correlations and durations.
 */
export class TerminalAttachPerformanceTracker {
  private readonly presentationRequestedAt = new Map<string, number>();
  private readonly byCorrelation = new Map<string, AttachProgress>();
  private readonly currentByTerminal = new Map<string, AttachProgress>();
  private readonly samples: TerminalAttachSegmentSample[] = [];
  private readonly integrity: TerminalAttachIntegrity = {
    duplicatePhaseEvents: 0,
    missingPredecessorEvents: 0,
  };
  private nextSequence = 1;

  constructor(
    private readonly now: () => number,
    private readonly maxSamples = DEFAULT_MAX_SAMPLES,
  ) {}

  markPresentationRequested(terminalId: string) {
    if (!this.presentationRequestedAt.has(terminalId)) {
      this.presentationRequestedAt.set(terminalId, this.now());
    }
  }

  markPhase(
    terminalId: string,
    transitionSequence: number | undefined,
    event: TerminalAttachSegmentTimingEvent,
  ): number | undefined {
    if (event.phase === "invoke_started") {
      if (this.byCorrelation.has(event.correlationId)) {
        this.integrity.duplicatePhaseEvents += 1;
        return this.byCorrelation.get(event.correlationId)?.sample.sequence;
      }
      const previous = this.currentByTerminal.get(terminalId);
      if (previous && previous.sample.outcome === "in_flight") {
        previous.sample.outcome = "superseded";
        this.byCorrelation.delete(previous.correlationId);
      }
      const now = this.now();
      const requestedAt = this.presentationRequestedAt.get(terminalId);
      const sample: TerminalAttachSegmentSample = {
        sequence: this.nextSequence++,
        transitionSequence: transitionSequence ?? null,
        frontendPreparationMs:
          requestedAt === undefined ? null : Math.max(0, now - requestedAt),
        renderableWaitMs: finiteDuration(event.renderableWaitMs),
        prepareMs: finiteDuration(event.prepareMs),
        preAttachResizeMs: finiteDuration(event.preAttachResizeMs),
        frontendInvokeMs: null,
        backendCommandMs: null,
        frontendHydrationBarrierMs: null,
        receiptToBarrierMs: null,
        barrierToPaintMs: null,
        paintToStableMs: null,
        invokeToStableMs: null,
        outcome: "in_flight",
      };
      const progress: AttachProgress = {
        terminalId,
        correlationId: event.correlationId,
        invokeStartedAt: now,
        synchronized: false,
        hidden: false,
        sample,
      };
      this.samples.push(sample);
      this.byCorrelation.set(event.correlationId, progress);
      this.currentByTerminal.set(terminalId, progress);
      this.trim();
      return sample.sequence;
    }

    const progress = this.byCorrelation.get(event.correlationId);
    if (!progress || progress.terminalId !== terminalId) {
      this.integrity.missingPredecessorEvents += 1;
      return undefined;
    }
    if (event.phase === "receipt") {
      if (progress.receiptAt !== undefined) {
        this.integrity.duplicatePhaseEvents += 1;
        return progress.sample.sequence;
      }
      progress.receiptAt = this.now();
      progress.sample.frontendInvokeMs = finiteDuration(event.frontendInvokeMs);
      progress.sample.backendCommandMs = finiteDuration(event.backendCommandMs);
      return progress.sample.sequence;
    }

    if (progress.receiptAt === undefined) {
      this.integrity.missingPredecessorEvents += 1;
      return progress.sample.sequence;
    }
    if (progress.barrierAt !== undefined) {
      this.integrity.duplicatePhaseEvents += 1;
      return progress.sample.sequence;
    }
    progress.barrierAt = this.now();
    progress.sample.receiptToBarrierMs = Math.max(
      0,
      progress.barrierAt - progress.receiptAt,
    );
    const invokeMs = progress.sample.frontendInvokeMs;
    const backendMs = progress.sample.backendCommandMs;
    if (invokeMs !== null && backendMs !== null) {
      progress.sample.frontendHydrationBarrierMs =
        Math.max(0, invokeMs - backendMs) +
        progress.sample.receiptToBarrierMs;
    }
    this.finishHiddenSynchronization(progress);
    return progress.sample.sequence;
  }

  markPaint(terminalId: string) {
    const progress = this.currentByTerminal.get(terminalId);
    if (progress?.sample.outcome !== "in_flight") return;
    // Workspace paint callbacks also cover retained surfaces and geometry
    // refreshes. Only a paint after this attach's barrier is attributable.
    if (progress.barrierAt === undefined) return;
    if (progress.paintAt !== undefined) return;
    progress.hidden = false;
    progress.paintAt = this.now();
    progress.sample.barrierToPaintMs = Math.max(
      0,
      progress.paintAt - progress.barrierAt,
    );
  }

  /**
   * Synchronization and timing are delivered by separate callbacks. Retain
   * both facts until they converge so either callback order closes a hidden
   * prewarm without inventing a visible paint.
   */
  markSynchronized(terminalId: string, hidden = false) {
    const progress = this.currentByTerminal.get(terminalId);
    if (progress?.sample.outcome !== "in_flight") return;
    progress.synchronized = true;
    progress.hidden ||= hidden;
    this.finishHiddenSynchronization(progress);
  }

  /** Retain visibility independently from synchronization callback order. */
  markHidden(terminalId: string) {
    const progress = this.currentByTerminal.get(terminalId);
    if (progress?.sample.outcome !== "in_flight") return;
    progress.hidden = true;
    this.finishHiddenSynchronization(progress);
  }

  markStable(terminalId: string) {
    const progress = this.currentByTerminal.get(terminalId);
    if (progress?.sample.outcome !== "in_flight") return;
    // Stable callbacks are terminal-wide too; an attach with no correlated
    // paint stays incomplete instead of reporting a false protocol gap.
    if (progress.paintAt === undefined) return;
    const now = this.now();
    progress.sample.paintToStableMs = Math.max(0, now - progress.paintAt);
    progress.sample.invokeToStableMs = Math.max(
      0,
      now - progress.invokeStartedAt,
    );
    progress.sample.outcome = "stable";
    this.finish(progress);
  }

  snapshot() {
    return {
      samples: this.samples.map((sample) => ({ ...sample })),
      integrity: { ...this.integrity },
    };
  }

  private trim() {
    while (this.samples.length > this.maxSamples) {
      const removed = this.samples.shift();
      if (!removed) return;
      for (const [correlationId, progress] of this.byCorrelation) {
        if (progress.sample !== removed) continue;
        this.byCorrelation.delete(correlationId);
        if (this.currentByTerminal.get(progress.terminalId) === progress) {
          this.currentByTerminal.delete(progress.terminalId);
        }
        break;
      }
    }
  }

  private finishHiddenSynchronization(progress: AttachProgress) {
    if (
      !progress.synchronized ||
      !progress.hidden ||
      progress.barrierAt === undefined ||
      progress.paintAt !== undefined
    ) {
      return;
    }
    progress.sample.outcome = "synchronized";
    this.finish(progress);
  }

  private finish(progress: AttachProgress) {
    this.byCorrelation.delete(progress.correlationId);
    if (this.currentByTerminal.get(progress.terminalId) === progress) {
      this.currentByTerminal.delete(progress.terminalId);
    }
    this.presentationRequestedAt.delete(progress.terminalId);
  }
}

function finiteDuration(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}
