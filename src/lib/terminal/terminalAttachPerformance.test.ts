import { describe, expect, it } from "vitest";
import { TerminalAttachPerformanceTracker } from "@/lib/terminal/terminalAttachPerformance";

describe("TerminalAttachPerformanceTracker", () => {
  it("records mutually exclusive attach, hydration, paint, and stable segments", () => {
    let now = 0;
    const tracker = new TerminalAttachPerformanceTracker(() => now);

    tracker.markPresentationRequested("terminal-secret");
    now = 10;
    expect(
      tracker.markPhase("terminal-secret", 7, {
        phase: "invoke_started",
        correlationId: "observer-secret-1",
        renderableWaitMs: 4,
        prepareMs: 5,
        preAttachResizeMs: 1,
      }),
    ).toBe(1);
    now = 60;
    tracker.markPhase("terminal-secret", 7, {
      phase: "receipt",
      correlationId: "observer-secret-1",
      backendCommandMs: 40,
      frontendInvokeMs: 50,
    });
    now = 90;
    tracker.markPhase("terminal-secret", 7, {
      phase: "barrier",
      correlationId: "observer-secret-1",
    });
    now = 106;
    tracker.markPaint("terminal-secret");
    now = 150;
    tracker.markStable("terminal-secret");

    expect(tracker.snapshot()).toEqual({
      samples: [
        {
          sequence: 1,
          transitionSequence: 7,
          frontendPreparationMs: 10,
          renderableWaitMs: 4,
          prepareMs: 5,
          preAttachResizeMs: 1,
          frontendInvokeMs: 50,
          backendCommandMs: 40,
          // 10ms invoke bridge + 30ms snapshot/renderer barrier.
          frontendHydrationBarrierMs: 40,
          receiptToBarrierMs: 30,
          barrierToPaintMs: 16,
          paintToStableMs: 44,
          invokeToStableMs: 140,
          outcome: "stable",
        },
      ],
      integrity: {
        duplicatePhaseEvents: 0,
        missingPredecessorEvents: 0,
      },
    });
  });

  it("counts duplicate and out-of-order phases without leaking opaque ids", () => {
    const now = 0;
    const tracker = new TerminalAttachPerformanceTracker(() => now);
    const invoke = {
      phase: "invoke_started" as const,
      correlationId: "private-observer",
    };

    tracker.markPhase("private-terminal", undefined, invoke);
    tracker.markPhase("private-terminal", undefined, invoke);
    tracker.markPhase("private-terminal", undefined, {
      phase: "barrier",
      correlationId: "private-observer",
    });
    // Terminal-wide retained paint/stable callbacks are unrelated until this
    // attach reaches its own barrier and must not inflate protocol integrity.
    tracker.markPaint("private-terminal");
    tracker.markStable("private-terminal");
    tracker.markPhase("private-terminal", undefined, {
      phase: "receipt",
      correlationId: "missing-observer",
      frontendInvokeMs: 1,
    });

    const snapshot = tracker.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect(snapshot.integrity).toEqual({
      duplicatePhaseEvents: 1,
      missingPredecessorEvents: 2,
    });
  });

  it("closes a hidden attach at its synchronized renderer barrier", () => {
    let now = 0;
    const tracker = new TerminalAttachPerformanceTracker(() => now);
    tracker.markPhase("hidden-terminal", undefined, {
      phase: "invoke_started",
      correlationId: "hidden-observer",
    });
    now = 4;
    tracker.markPhase("hidden-terminal", undefined, {
      phase: "receipt",
      correlationId: "hidden-observer",
      frontendInvokeMs: 4,
    });
    now = 8;
    tracker.markPhase("hidden-terminal", undefined, {
      phase: "barrier",
      correlationId: "hidden-observer",
    });
    tracker.markSynchronized("hidden-terminal", true);

    expect(tracker.snapshot().samples).toMatchObject([
      { outcome: "synchronized", receiptToBarrierMs: 4 },
    ]);
  });

  it("retains synchronization when its callback precedes timing barrier", () => {
    let now = 0;
    const tracker = new TerminalAttachPerformanceTracker(() => now);
    tracker.markPhase("hidden-terminal", undefined, {
      phase: "invoke_started",
      correlationId: "hidden-observer",
    });
    tracker.markPhase("hidden-terminal", undefined, {
      phase: "receipt",
      correlationId: "hidden-observer",
      frontendInvokeMs: 0,
    });
    tracker.markSynchronized("hidden-terminal", true);
    expect(tracker.snapshot().samples[0]?.outcome).toBe("in_flight");

    now = 6;
    tracker.markPhase("hidden-terminal", undefined, {
      phase: "barrier",
      correlationId: "hidden-observer",
    });
    expect(tracker.snapshot().samples[0]).toMatchObject({
      outcome: "synchronized",
      receiptToBarrierMs: 6,
    });
  });

  it("closes a synchronized attach when its pane becomes hidden", () => {
    const tracker = new TerminalAttachPerformanceTracker(() => 0);
    tracker.markPhase("terminal", undefined, {
      phase: "invoke_started",
      correlationId: "observer",
    });
    tracker.markPhase("terminal", undefined, {
      phase: "receipt",
      correlationId: "observer",
      frontendInvokeMs: 0,
    });
    tracker.markPhase("terminal", undefined, {
      phase: "barrier",
      correlationId: "observer",
    });
    tracker.markSynchronized("terminal");
    expect(tracker.snapshot().samples[0]?.outcome).toBe("in_flight");
    tracker.markHidden("terminal");
    expect(tracker.snapshot().samples[0]?.outcome).toBe("synchronized");
  });

  it("bounds samples and marks a replaced terminal attach as superseded", () => {
    let now = 0;
    const tracker = new TerminalAttachPerformanceTracker(() => now, 2);

    tracker.markPhase("terminal", 1, {
      phase: "invoke_started",
      correlationId: "first",
    });
    now = 1;
    tracker.markPhase("terminal", 1, {
      phase: "invoke_started",
      correlationId: "second",
    });
    now = 2;
    tracker.markPhase("other", 2, {
      phase: "invoke_started",
      correlationId: "third",
    });

    expect(tracker.snapshot().samples).toMatchObject([
      { sequence: 2, outcome: "in_flight" },
      { sequence: 3, outcome: "in_flight" },
    ]);
  });
});
