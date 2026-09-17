import { describe, expect, it } from "vitest";
import {
  type PaneFocusSchedulerActivity,
  WorkspacePaneFocusPerformanceTracker,
} from "./workspacePaneFocusPerformance";

function schedulerActivity(
  reveal: readonly [number, number, number],
  catchup: readonly [number, number, number],
  maintenance: readonly [number, number, number],
): PaneFocusSchedulerActivity {
  const lane = ([unitsRun, msSpent, starvationRescues]: readonly [
    number,
    number,
    number,
  ]) => ({ unitsRun, msSpent, starvationRescues });
  return {
    reveal: lane(reveal),
    catchup: lane(catchup),
    maintenance: lane(maintenance),
  };
}

function measureSchedulerActivity(
  start: PaneFocusSchedulerActivity,
  end: PaneFocusSchedulerActivity,
  sameScheduler = true,
): PaneFocusSchedulerActivity | null {
  const startScheduler = {};
  const readings = [
    { scheduler: startScheduler, activity: start },
    {
      scheduler: sameScheduler ? startScheduler : {},
      activity: end,
    },
  ];
  const tracker = new WorkspacePaneFocusPerformanceTracker(
    () => 0,
    () => {
      const reading = readings.shift();
      if (!reading) throw new Error("unexpected scheduler activity read");
      return reading;
    },
  );
  const sequence = tracker.begin("desktop", "term:a", true);
  tracker.markCommit(sequence);
  tracker.markFrame(sequence);
  return tracker.snapshot()[0]?.commitToFirstFrameSchedulerActivity ?? null;
}

describe("WorkspacePaneFocusPerformanceTracker", () => {
  it("ignores stale paint completions after a newer pane wins", () => {
    let now = 0;
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => now);
    const stale = tracker.begin("desktop", "file:a", false);
    now = 4;
    const current = tracker.begin("desktop", "file:b", false);
    now = 20;
    tracker.markPaint(stale);
    tracker.markPaint(current);

    expect(tracker.snapshot()).toMatchObject([
      { panelId: "file:a", paintMs: null, outcome: "superseded" },
      { panelId: "file:b", paintMs: 16, outcome: "complete" },
    ]);
  });

  it("derives terminal interactivity from paint and successful input focus", () => {
    let now = 100;
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => now);
    const sequence = tracker.begin("desktop", "term:a", true, 90);
    now = 114;
    tracker.markCommit(sequence);
    now = 115;
    tracker.markEventMicrotask(sequence);
    now = 115.5;
    tracker.markEventMessageTask(sequence);
    now = 116;
    tracker.markEventTask(sequence);
    now = 118;
    tracker.markFrame(sequence);
    tracker.markTerminalGeometry("desktop", "term:a", 7);
    tracker.markTerminalRoleCommit("desktop", "term:a", 2);
    tracker.markTerminalInputFocusCallStart("desktop", "term:a", 118);
    tracker.markTerminalInputFocusHandler("desktop", "term:a", {
      handlerStartedAt: 119,
      handlerEndedAt: 123,
      projectionMs: 1,
      intentDispatchMs: 2,
    });
    tracker.markTerminalInputFocus("desktop", "term:a", 6);
    now = 125;
    tracker.markPaint(sequence);

    expect(tracker.snapshot()[0]).toMatchObject({
      paintMs: 35,
      commitMs: 24,
      eventMicrotaskMs: 25,
		eventMessageTaskMs: 25.5,
      eventTaskMs: 26,
      firstFrameMs: 28,
      localGeometryMs: 7,
      localGeometryCount: 1,
      terminalRoleCommitMs: 28,
      terminalRoleEffectMs: 2,
      terminalInputFocusCommitMs: 28,
      terminalInputFocusCallMs: 6,
      terminalInputFocusPreHandlerMs: 1,
      terminalInputFocusHandlerMs: 4,
      terminalInputFocusPostHandlerMs: 1,
      terminalInputFocusProjectionMs: 1,
      terminalInputFocusIntentDispatchMs: 2,
      terminalInputFocusNativeRemainderMs: 2,
      interactiveMs: 35,
      outcome: "complete",
    });
  });

  it("attributes post-commit focus delay to the shared scheduler lanes", () => {
    expect(
      measureSchedulerActivity(
        schedulerActivity([3, 4.5, 1], [10, 20, 2], [1, 3, 0]),
        schedulerActivity([5, 9.5, 2], [14, 27.25, 4], [2, 5, 1]),
      ),
    ).toEqual({
      reveal: { unitsRun: 2, msSpent: 5, starvationRescues: 1 },
      catchup: { unitsRun: 4, msSpent: 7.25, starvationRescues: 2 },
      maintenance: { unitsRun: 1, msSpent: 2, starvationRescues: 1 },
    });
  });

  it("does not compare activity across scheduler generations", () => {
    expect(
      measureSchedulerActivity(
        schedulerActivity([1, 2, 0], [1, 2, 0], [1, 2, 0]),
        schedulerActivity([2, 3, 0], [2, 3, 0], [2, 3, 0]),
        false,
      ),
    ).toBeNull();
  });

  it("does not report a delta when scheduler counters reset", () => {
    expect(
      measureSchedulerActivity(
        schedulerActivity([5, 10, 1], [3, 6, 1], [2, 4, 1]),
        schedulerActivity([1, 2, 0], [4, 8, 1], [3, 6, 1]),
      ),
    ).toBeNull();
  });

  it("does not retain scheduler activity when a frame precedes commit", () => {
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => 0, () => {
      throw new Error("late commit must not read scheduler activity");
    });
    const sequence = tracker.begin("desktop", "term:a", true);
    tracker.markFrame(sequence);
    tracker.markCommit(sequence);

    expect(
      tracker.snapshot()[0]?.commitToFirstFrameSchedulerActivity,
    ).toBeNull();
  });

  it("leaves non-terminal focus samples outside scheduler attribution", () => {
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => 0, () => {
      throw new Error("non-terminal focus must not read scheduler activity");
    });
    const sequence = tracker.begin("desktop", "file:a", false);
    tracker.markCommit(sequence);
    tracker.markFrame(sequence);

    expect(
      tracker.snapshot()[0]?.commitToFirstFrameSchedulerActivity,
    ).toBeNull();
  });

  it("completes when delayed input focus follows paint", () => {
    let now = 10;
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => now);
    const sequence = tracker.begin("desktop", "term:a", true);
    now = 14;
    tracker.markPaint(sequence);
    now = 18;
    tracker.markTerminalInputFocusCallStart("desktop", "term:a", 16);
    tracker.markTerminalInputFocus("desktop", "term:a", 2);

    expect(tracker.snapshot()[0]).toMatchObject({
      paintMs: 4,
      terminalInputFocusCommitMs: 8,
      terminalInputFocusPreHandlerMs: null,
      terminalInputFocusPostHandlerMs: null,
      terminalInputFocusNativeRemainderMs: null,
      interactiveMs: 8,
      outcome: "complete",
    });
  });

  it("attributes focus-handler work only to the exact active terminal", () => {
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => 10);
    tracker.begin("desktop", "term:a", true);
    const timing = {
      handlerStartedAt: 11,
      handlerEndedAt: 17,
      projectionMs: 1,
      intentDispatchMs: 4,
    };

    tracker.markTerminalInputFocusCallStart("desktop", "term:a", 10);
    tracker.markTerminalInputFocusHandler("other", "term:a", timing);
    tracker.markTerminalInputFocusHandler("desktop", "term:b", timing);
    expect(tracker.snapshot()[0]).toMatchObject({
      terminalInputFocusPreHandlerMs: null,
      terminalInputFocusHandlerMs: null,
      terminalInputFocusPostHandlerMs: null,
      terminalInputFocusProjectionMs: null,
      terminalInputFocusIntentDispatchMs: null,
      terminalInputFocusNativeRemainderMs: null,
    });
    tracker.markTerminalInputFocusHandler("desktop", "term:a", timing);
    tracker.markTerminalInputFocus("desktop", "term:a", 9);

    expect(tracker.snapshot()[0]).toMatchObject({
      terminalInputFocusPreHandlerMs: 1,
      terminalInputFocusHandlerMs: 6,
      terminalInputFocusPostHandlerMs: 2,
      terminalInputFocusProjectionMs: 1,
      terminalInputFocusIntentDispatchMs: 4,
      terminalInputFocusNativeRemainderMs: 3,
    });
  });

  it("does not attach a later same-pane handler to an already measured call", () => {
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => 10);
    tracker.begin("desktop", "term:a", true);
    tracker.markTerminalInputFocusCallStart("desktop", "term:a", 10);
    tracker.markTerminalInputFocus("desktop", "term:a", 9);

    tracker.markTerminalInputFocusHandler("desktop", "term:a", {
      handlerStartedAt: 11,
      handlerEndedAt: 17,
      projectionMs: 1,
      intentDispatchMs: 4,
    });

    expect(tracker.snapshot()[0]).toMatchObject({
      terminalInputFocusPreHandlerMs: null,
      terminalInputFocusHandlerMs: null,
      terminalInputFocusPostHandlerMs: null,
      terminalInputFocusProjectionMs: null,
      terminalInputFocusIntentDispatchMs: null,
      terminalInputFocusNativeRemainderMs: null,
    });
  });

  it("discards an unsuccessful call before the retained request tries again", () => {
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => 24);
    const sequence = tracker.begin("desktop", "term:a", true);
    tracker.markTerminalInputFocusCallStart("desktop", "term:a", 10);
    tracker.markTerminalInputFocusHandler("desktop", "term:a", {
      handlerStartedAt: 11,
      handlerEndedAt: 13,
      projectionMs: 1,
      intentDispatchMs: 1,
    });
    tracker.cancelTerminalInputFocusCall(sequence, "desktop", "term:a");

    tracker.markTerminalInputFocusCallStart("desktop", "term:a", 20);
    tracker.markTerminalInputFocusHandler("desktop", "term:a", {
      handlerStartedAt: 21,
      handlerEndedAt: 23,
      projectionMs: 1,
      intentDispatchMs: 1,
    });
    tracker.markTerminalInputFocus("desktop", "term:a", 4);

    expect(tracker.snapshot()[0]).toMatchObject({
      terminalInputFocusCallMs: 4,
      terminalInputFocusPreHandlerMs: 1,
      terminalInputFocusHandlerMs: 2,
      terminalInputFocusPostHandlerMs: 1,
      terminalInputFocusNativeRemainderMs: 2,
    });
  });

  it("rejects handler timing that ends after the focus call returns", () => {
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => 20);
    tracker.begin("desktop", "term:a", true);
    tracker.markTerminalInputFocusCallStart("desktop", "term:a", 10);
    tracker.markTerminalInputFocusHandler("desktop", "term:a", {
      handlerStartedAt: 11,
      handlerEndedAt: 20,
      projectionMs: 1,
      intentDispatchMs: 1,
    });
    tracker.markTerminalInputFocus("desktop", "term:a", 9);

    expect(tracker.snapshot()[0]).toMatchObject({
      terminalInputFocusCallMs: 9,
      terminalInputFocusPreHandlerMs: null,
      terminalInputFocusHandlerMs: null,
      terminalInputFocusPostHandlerMs: null,
      terminalInputFocusProjectionMs: null,
      terminalInputFocusIntentDispatchMs: null,
      terminalInputFocusNativeRemainderMs: null,
    });
  });

  it("attributes local fit work only to the currently focused terminal", () => {
    const now = 0;
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => now);
    tracker.begin("desktop", "term:a", true);

    tracker.markTerminalGeometry("desktop", "term:b", 40);
    tracker.markTerminalGeometry("other", "term:a", 50);
    tracker.markTerminalGeometry("desktop", "term:a", 3);
    tracker.markTerminalGeometry("desktop", "term:a", 5);

    expect(tracker.snapshot()[0]).toMatchObject({
      localGeometryMs: 8,
      localGeometryCount: 2,
    });
  });

  it("classifies a focus that leaves the active workspace before paint", () => {
    const tracker = new WorkspacePaneFocusPerformanceTracker(() => 10);
    const sequence = tracker.begin("desktop", "term:a", true);
    tracker.abort(sequence);

    expect(tracker.snapshot()[0]).toMatchObject({
      panelId: "term:a",
      outcome: "aborted",
    });
  });
});
