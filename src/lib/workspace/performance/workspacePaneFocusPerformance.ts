import {
  getFrameBudgetScheduler,
  type SchedulerLane,
} from "@/lib/scheduling/frameBudgetScheduler";

interface PaneFocusSchedulerLaneActivity {
  readonly unitsRun: number;
  readonly msSpent: number;
  readonly starvationRescues: number;
}

export interface TerminalInputFocusHandlerStages {
  readonly projectionMs: number;
  readonly intentDispatchMs: number | null;
}

export interface TerminalInputFocusHandlerTiming
  extends TerminalInputFocusHandlerStages {
  readonly handlerStartedAt: number;
  readonly handlerEndedAt: number;
}

export interface PaneFocusSample {
  sequence: number;
  desktopId: string;
  panelId: string;
  terminal: boolean;
  startedAt: number;
  commitMs: number | null;
  eventMicrotaskMs: number | null;
  eventMessageTaskMs: number | null;
  eventTaskMs: number | null;
  firstFrameMs: number | null;
  /** Shared scheduler work completed after focus commit and before its frame. */
  commitToFirstFrameSchedulerActivity: PaneFocusSchedulerActivity | null;
  /** Synchronous xterm box measurement + fit work during this focus handoff. */
  localGeometryMs: number;
  localGeometryCount: number;
  terminalRoleCommitMs: number | null;
  terminalRoleEffectMs: number;
  terminalInputFocusCommitMs: number | null;
  terminalInputFocusCallMs: number;
  /** Focus-call time before the existing textarea onFocus body begins. */
  terminalInputFocusPreHandlerMs: number | null;
  terminalInputFocusHandlerMs: number | null;
  /** Focus-call time after the existing textarea onFocus body ends. */
  terminalInputFocusPostHandlerMs: number | null;
  terminalInputFocusProjectionMs: number | null;
  terminalInputFocusIntentDispatchMs: number | null;
  /** Legacy aggregate of pre/post handler time; not exclusively browser-native. */
  terminalInputFocusNativeRemainderMs: number | null;
  paintMs: number | null;
  interactiveMs: number | null;
  outcome: "pending" | "complete" | "superseded" | "aborted";
}

const MAX_SAMPLES = 96;
const SCHEDULER_LANES = [
  "reveal",
  "catchup",
  "maintenance",
] as const satisfies readonly SchedulerLane[];
type PaneFocusSchedulerLane = (typeof SCHEDULER_LANES)[number];

export type PaneFocusSchedulerActivity = Readonly<
  Record<PaneFocusSchedulerLane, PaneFocusSchedulerLaneActivity>
>;

interface PaneFocusSchedulerActivityReading {
  readonly scheduler: object;
  readonly activity: PaneFocusSchedulerActivity;
}

/** Window-local active-pane paint and terminal-ready timing. */
export class WorkspacePaneFocusPerformanceTracker {
  private readonly samples: PaneFocusSample[] = [];
  private active: PaneFocusSample | undefined;
  private schedulerActivityAtCommit:
    | {
        readonly sequence: number;
        readonly reading: PaneFocusSchedulerActivityReading;
      }
    | undefined;
  private terminalInputFocusCall:
    | {
        readonly sequence: number;
        readonly startedAt: number;
        handlerEndedAt: number | null;
      }
    | undefined;
  private nextSequence = 1;

  constructor(
    private readonly now: () => number,
    private readonly readSchedulerActivity: () => PaneFocusSchedulerActivityReading =
      readPaneFocusSchedulerActivity,
  ) {}

  begin(
    desktopId: string,
    panelId: string,
    terminal: boolean,
    requestedAt?: number,
  ): number {
    const now = this.now();
    if (this.active) this.active.outcome = "superseded";
    this.schedulerActivityAtCommit = undefined;
    this.terminalInputFocusCall = undefined;
    const sample: PaneFocusSample = {
      sequence: this.nextSequence++,
      desktopId,
      panelId,
      terminal,
      startedAt: Math.min(now, requestedAt ?? now),
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
      outcome: "pending",
    };
    this.active = sample;
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    return sample.sequence;
  }

  markCommit(sequence: number): void {
    const sample = this.active;
    if (!sample || sample.sequence !== sequence || sample.commitMs !== null) return;
    sample.commitMs = Math.max(0, this.now() - sample.startedAt);
    if (sample.terminal && sample.firstFrameMs === null) {
      this.schedulerActivityAtCommit = {
        sequence,
        reading: this.readSchedulerActivity(),
      };
    }
  }

  markEventMicrotask(sequence: number): void {
    const sample = this.active;
    if (!sample || sample.sequence !== sequence || sample.eventMicrotaskMs !== null) return;
    sample.eventMicrotaskMs = Math.max(0, this.now() - sample.startedAt);
  }

  markEventTask(sequence: number): void {
    const sample = this.active;
    if (!sample || sample.sequence !== sequence || sample.eventTaskMs !== null) return;
    sample.eventTaskMs = Math.max(0, this.now() - sample.startedAt);
  }

  markEventMessageTask(sequence: number): void {
    const sample = this.active;
    if (
      !sample ||
      sample.sequence !== sequence ||
      sample.eventMessageTaskMs !== null
    ) {
      return;
    }
    sample.eventMessageTaskMs = Math.max(0, this.now() - sample.startedAt);
  }

  markFrame(sequence: number): void {
    const sample = this.active;
    if (!sample || sample.sequence !== sequence || sample.firstFrameMs !== null) return;
    sample.firstFrameMs = Math.max(0, this.now() - sample.startedAt);
    const start = this.schedulerActivityAtCommit;
    if (start?.sequence === sequence) {
      const end = this.readSchedulerActivity();
      if (start.reading.scheduler === end.scheduler) {
        sample.commitToFirstFrameSchedulerActivity =
          paneFocusSchedulerActivityDelta(
            start.reading.activity,
            end.activity,
          );
      }
      this.schedulerActivityAtCommit = undefined;
    }
  }

  markTerminalGeometry(
    desktopId: string | undefined,
    panelId: string | undefined,
    durationMs: number,
  ): void {
    const sample = this.active;
    if (
      !sample?.terminal ||
      !desktopId ||
      !panelId ||
      sample.desktopId !== desktopId ||
      sample.panelId !== panelId ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      return;
    }
    sample.localGeometryMs += durationMs;
    sample.localGeometryCount += 1;
  }

  markTerminalRoleCommit(
    desktopId: string | undefined,
    panelId: string | undefined,
    effectMs: number,
  ): void {
    const sample = this.active;
    if (
      !sample?.terminal ||
      !desktopId ||
      !panelId ||
      sample.desktopId !== desktopId ||
      sample.panelId !== panelId ||
      sample.terminalRoleCommitMs !== null
    ) {
      return;
    }
    sample.terminalRoleCommitMs = Math.max(0, this.now() - sample.startedAt);
    sample.terminalRoleEffectMs = Math.max(0, effectMs);
  }

  markTerminalInputFocus(
    desktopId: string | undefined,
    panelId: string | undefined,
    durationMs: number,
  ): void {
    const sample = this.active;
    const focusCall = this.terminalInputFocusCall;
    if (
      !sample?.terminal ||
      !focusCall ||
      focusCall.sequence !== sample.sequence ||
      !desktopId ||
      !panelId ||
      sample.desktopId !== desktopId ||
      sample.panelId !== panelId ||
      sample.terminalInputFocusCommitMs !== null ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      return;
    }
    sample.terminalInputFocusCommitMs = Math.max(0, this.now() - sample.startedAt);
    sample.terminalInputFocusCallMs = durationMs;
    if (
      sample.terminalInputFocusPreHandlerMs !== null &&
      sample.terminalInputFocusHandlerMs !== null &&
      focusCall.handlerEndedAt !== null
    ) {
      const postHandlerMs =
        durationMs - (focusCall.handlerEndedAt - focusCall.startedAt);
      if (postHandlerMs >= 0) {
        sample.terminalInputFocusPostHandlerMs = postHandlerMs;
        sample.terminalInputFocusNativeRemainderMs =
          sample.terminalInputFocusPreHandlerMs + postHandlerMs;
      } else {
        this.clearTerminalInputFocusHandler(sample);
      }
    }
    this.terminalInputFocusCall = undefined;
    this.releaseIfComplete(sample);
  }

  markTerminalInputFocusCallStart(
    desktopId: string | undefined,
    panelId: string | undefined,
    startedAt: number,
  ): void {
    const sample = this.active;
    if (
      !sample?.terminal ||
      !desktopId ||
      !panelId ||
      sample.desktopId !== desktopId ||
      sample.panelId !== panelId ||
      sample.terminalInputFocusCommitMs !== null ||
      this.terminalInputFocusCall !== undefined ||
      !Number.isFinite(startedAt) ||
      startedAt < 0
    ) {
      return;
    }
    this.terminalInputFocusCall = {
      sequence: sample.sequence,
      startedAt,
      handlerEndedAt: null,
    };
  }

  cancelTerminalInputFocusCall(
    sequence: number,
    desktopId: string | undefined,
    panelId: string | undefined,
  ): void {
    const sample = this.active;
    if (
      !sample?.terminal ||
      sample.sequence !== sequence ||
      this.terminalInputFocusCall?.sequence !== sequence ||
      !desktopId ||
      !panelId ||
      sample.desktopId !== desktopId ||
      sample.panelId !== panelId
    ) {
      return;
    }
    this.clearTerminalInputFocusHandler(sample);
    this.terminalInputFocusCall = undefined;
  }

  markTerminalInputFocusHandler(
    desktopId: string | undefined,
    panelId: string | undefined,
    timing: TerminalInputFocusHandlerTiming,
  ): void {
    const sample = this.active;
    const focusCall = this.terminalInputFocusCall;
    if (
      !sample?.terminal ||
      !focusCall ||
      focusCall.sequence !== sample.sequence ||
      !desktopId ||
      !panelId ||
      sample.desktopId !== desktopId ||
      sample.panelId !== panelId ||
      sample.terminalInputFocusCommitMs !== null ||
      sample.terminalInputFocusHandlerMs !== null ||
      timing.handlerStartedAt < focusCall.startedAt ||
      !validFocusHandlerTiming(timing)
    ) {
      return;
    }
    sample.terminalInputFocusPreHandlerMs =
      timing.handlerStartedAt - focusCall.startedAt;
    sample.terminalInputFocusHandlerMs =
      timing.handlerEndedAt - timing.handlerStartedAt;
    sample.terminalInputFocusProjectionMs = timing.projectionMs;
    sample.terminalInputFocusIntentDispatchMs = timing.intentDispatchMs;
    focusCall.handlerEndedAt = timing.handlerEndedAt;
  }

  markPaint(sequence: number): void {
    const sample = this.active;
    if (!sample || sample.sequence !== sequence || sample.paintMs !== null) return;
    sample.paintMs = Math.max(0, this.now() - sample.startedAt);
    this.releaseIfComplete(sample);
  }

  abort(sequence: number): void {
    const sample = this.active;
    if (!sample || sample.sequence !== sequence) return;
    sample.outcome = "aborted";
    this.release(sample);
  }

  snapshot(): readonly PaneFocusSample[] {
    return this.samples.map((sample) => ({
      ...sample,
      commitToFirstFrameSchedulerActivity:
        sample.commitToFirstFrameSchedulerActivity === null
          ? null
          : clonePaneFocusSchedulerActivity(
              sample.commitToFirstFrameSchedulerActivity,
            ),
    }));
  }

  private releaseIfComplete(sample: PaneFocusSample): void {
    if (!sample.terminal) {
      sample.outcome = "complete";
      this.release(sample);
      return;
    }
    if (
      sample.paintMs === null ||
      sample.terminalInputFocusCommitMs === null
    ) {
      return;
    }
    sample.interactiveMs = Math.max(
      sample.paintMs,
      sample.terminalInputFocusCommitMs,
    );
    sample.outcome = "complete";
    this.release(sample);
  }

  private release(sample: PaneFocusSample): void {
    if (this.active === sample) this.active = undefined;
    if (this.terminalInputFocusCall?.sequence === sample.sequence) {
      this.terminalInputFocusCall = undefined;
    }
    if (this.schedulerActivityAtCommit?.sequence === sample.sequence) {
      this.schedulerActivityAtCommit = undefined;
    }
  }

  private clearTerminalInputFocusHandler(sample: PaneFocusSample): void {
    sample.terminalInputFocusPreHandlerMs = null;
    sample.terminalInputFocusHandlerMs = null;
    sample.terminalInputFocusPostHandlerMs = null;
    sample.terminalInputFocusProjectionMs = null;
    sample.terminalInputFocusIntentDispatchMs = null;
    sample.terminalInputFocusNativeRemainderMs = null;
  }
}

function validFocusHandlerTiming(
  timing: TerminalInputFocusHandlerTiming,
): boolean {
  const handlerMs = timing.handlerEndedAt - timing.handlerStartedAt;
  return (
    Number.isFinite(timing.handlerStartedAt) &&
    Number.isFinite(timing.handlerEndedAt) &&
    handlerMs >= 0 &&
    Number.isFinite(timing.projectionMs) &&
    timing.projectionMs >= 0 &&
    timing.projectionMs <= handlerMs &&
    (timing.intentDispatchMs === null ||
      (Number.isFinite(timing.intentDispatchMs) &&
        timing.intentDispatchMs >= 0 &&
        timing.projectionMs + timing.intentDispatchMs <= handlerMs))
  );
}

function readPaneFocusSchedulerActivity(): PaneFocusSchedulerActivityReading {
  const scheduler = getFrameBudgetScheduler();
  const telemetry = scheduler.getTelemetry();
  return {
    scheduler,
    activity: Object.fromEntries(
      SCHEDULER_LANES.map((lane) => {
        const source = telemetry[lane];
        return [
          lane,
          {
            unitsRun: source.unitsRun,
            msSpent: source.msSpent,
            starvationRescues: source.starvationRescues,
          },
        ];
      }),
    ) as Record<PaneFocusSchedulerLane, PaneFocusSchedulerLaneActivity>,
  };
}

function paneFocusSchedulerActivityDelta(
  start: PaneFocusSchedulerActivity,
  end: PaneFocusSchedulerActivity,
): PaneFocusSchedulerActivity | null {
  const delta = {} as Record<
    PaneFocusSchedulerLane,
    PaneFocusSchedulerLaneActivity
  >;
  for (const lane of SCHEDULER_LANES) {
    const from = start[lane];
    const to = end[lane];
    if (
      to.unitsRun < from.unitsRun ||
      to.msSpent < from.msSpent ||
      to.starvationRescues < from.starvationRescues
    ) {
      return null;
    }
    delta[lane] = {
      unitsRun: to.unitsRun - from.unitsRun,
      msSpent: to.msSpent - from.msSpent,
      starvationRescues: to.starvationRescues - from.starvationRescues,
    };
  }
  return delta;
}

function clonePaneFocusSchedulerActivity(
  source: PaneFocusSchedulerActivity,
): PaneFocusSchedulerActivity {
  return Object.fromEntries(
    SCHEDULER_LANES.map((lane) => [lane, { ...source[lane] }]),
  ) as Record<PaneFocusSchedulerLane, PaneFocusSchedulerLaneActivity>;
}
