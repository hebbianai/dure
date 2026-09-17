import { chatInputLatency } from "@/lib/agents/chat/chatInputLatency";
import {
  noteDesktopSwitchSettled,
  noteDesktopSwitchStart,
} from "@/lib/scheduling/interactionSignals";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import {
  TerminalAttachPerformanceTracker,
  type TerminalAttachTimingEvent,
} from "@/lib/terminal/terminalAttachPerformance";
import { TerminalRecoveryPerformanceTracker } from "@/lib/terminal/terminalRecoveryPerformance";
import {
  type TerminalInputFocusHandlerTiming,
  WorkspacePaneFocusPerformanceTracker,
} from "@/lib/workspace/performance/workspacePaneFocusPerformance";
import { StructuredTerminalPresentationPerformanceTracker } from "./structuredTerminalPresentationPerformance";
import {
  type AgentReadyTiming,
  WorkspaceLifecyclePerformanceTracker,
} from "./workspaceLifecyclePerformance";
import { DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES } from "./terminalResourceBudget";
import type {
  TerminalResourceRegistration,
  WorkspaceCacheDecisionSnapshot,
  WorkspacePerformanceSnapshot,
  WorkspaceRendererBackend,
  WorkspaceTerminalRuntime,
  WorkspaceTransitionCacheState,
  WorkspaceTransitionSample,
  WorkspaceVisitKind,
} from "./workspacePerformanceTypes";

export type * from "./workspacePerformanceTypes";

interface TerminalResource {
  id: string;
  desktopId: string;
  panelId?: string;
  runtime: WorkspaceTerminalRuntime;
  renderer: WorkspaceRendererBackend;
  gpuViewportBytes?: number;
  modelBytes?: number;
  visible: boolean;
  readVisibility?: () => boolean;
  presentationRequestedAt?: number;
  lastAttachLatencyMs?: number;
}

interface ExpectedTerminalResource {
  id: string;
  desktopId: string;
  panelId: string;
  visible: boolean;
  readVisibility?: () => boolean;
}

interface TransitionProgress {
  sample: WorkspaceTransitionSample;
  expectedTerminalIds: Set<string>;
  terminalPaintMs: Map<string, number>;
  terminalStableMs: Map<string, number>;
  visibleSetSealed: boolean;
}

// The largest built-in pressure journey emits 90 transitions before its final
// report (initial + first visits + revisits + measured focus activations).
// Retain that one complete bounded journey without introducing a QA-only
// evidence buffer.
const MAX_TRANSITIONS = 96;
/**
 * A transition sample only accepts paint marks this long after it began. A
 * switch whose desktop never paints a terminal (no terminal pane, slow attach)
 * would otherwise stay "active" indefinitely and attribute a much later,
 * unrelated first paint (e.g. a terminal opened minutes later) as a huge
 * firstTerminalPaintMs/remountCostMs outlier in the regression-gate stats.
 */
const MAX_TRANSITION_CAPTURE_MS = 10_000;

/**
 * Window-local performance registry. It records timings and renderer resources,
 * but deliberately has no authority over panes, transports, or sessions.
 */
export class WorkspacePerformanceTracker {
  private readonly now: () => number;
  private readonly mounted = new Map<string, number>();
  private readonly terminals = new Map<string, TerminalResource>();
  /**
   * Visible pane identities registered before their expensive xterm surface
   * exists. They keep all-pane transition metrics honest without counting a
   * deferred surface against the renderer/model cache budget.
   */
  private readonly expectedTerminals = new Map<string, ExpectedTerminalResource>();
  private readonly terminalPresentations = new StructuredTerminalPresentationPerformanceTracker();
  private readonly terminalAttaches: TerminalAttachPerformanceTracker;
  private readonly terminalRecovery: TerminalRecoveryPerformanceTracker;
  private readonly terminalResourceListeners = new Set<() => void>();
  private readonly transitions: WorkspaceTransitionSample[] = [];
  private activeTransition: TransitionProgress | undefined;
  private readonly paneFocus: WorkspacePaneFocusPerformanceTracker;
  private readonly lifecycle: WorkspaceLifecyclePerformanceTracker;
  private remountStartedAt: number | undefined;
  private workspaceCacheDecision: WorkspaceCacheDecisionSnapshot | undefined;
  private nextSequence = 1;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.terminalAttaches = new TerminalAttachPerformanceTracker(now);
    this.terminalRecovery = new TerminalRecoveryPerformanceTracker(now);
    if (import.meta.env.MODE === "perf") this.terminalRecovery.startDetailCapture();
    this.paneFocus = new WorkspacePaneFocusPerformanceTracker(now);
    this.lifecycle = new WorkspaceLifecyclePerformanceTracker(now);
  }

  recordWorkspaceCacheDecision(decision: WorkspaceCacheDecisionSnapshot) {
    this.workspaceCacheDecision = {
      budget: { ...decision.budget },
      occupancy: {
        total: { ...decision.occupancy.total },
        warm: { ...decision.occupancy.warm },
        frozen: { ...decision.occupancy.frozen },
      },
    };
  }

  beginTransition(
    desktopId: string,
    cacheStateOrWarm: WorkspaceTransitionCacheState | boolean,
    requestedAt?: number,
    visitKind: WorkspaceVisitKind = "revisit",
  ) {
    const now = this.now();
    const cacheState =
      typeof cacheStateOrWarm === "boolean"
        ? cacheStateOrWarm
          ? "renderer"
          : "cold"
        : cacheStateOrWarm;
    const sample: WorkspaceTransitionSample = {
      sequence: this.nextSequence++,
      desktopId,
      visitKind,
      cacheState,
      warm: cacheState !== "cold",
      startedAt: Math.min(now, requestedAt ?? now),
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
    };
    this.activeTransition = {
      sample,
      expectedTerminalIds: new Set(),
      terminalPaintMs: new Map(),
      terminalStableMs: new Map(),
      visibleSetSealed: false,
    };
    this.remountStartedAt = undefined;
    this.transitions.push(sample);
    if (this.transitions.length > MAX_TRANSITIONS) {
      // Keep the one boot sample for long-running-app diagnostics. Evict the
      // oldest non-initial transition instead of losing startup evidence.
      const removable = this.transitions.findIndex(
        (transition) => transition.visitKind !== "initial",
      );
      this.transitions.splice(Math.max(0, removable), 1);
    }
    // 전환 수명주기를 이미 기록하는 지점이라 여기서 전역 스케줄러에 신호만
    // 전파한다 — pane·transport에 대한 authority 없음은 유지된다.
    if (visitKind !== "initial") noteDesktopSwitchStart();
  }

  markWorkspaceCommit(desktopId: string) {
    return this.markWorkspaceMilestone(desktopId, "workspaceCommitMs")?.sequence;
  }

  markWorkspaceCommitMicrotask(sequence: number) {
    this.markWorkspaceCommitCheckpoint(sequence, "workspaceCommitMicrotaskMs");
  }

  markWorkspaceCommitMessageTask(sequence: number) {
    this.markWorkspaceCommitCheckpoint(sequence, "workspaceCommitMessageTaskMs");
  }

  markWorkspaceFirstFrame(desktopId: string) {
    this.markWorkspaceMilestone(desktopId, "workspaceFirstFrameMs");
  }

  markWorkspacePaint(desktopId: string) {
    if (
      this.markWorkspaceMilestone(desktopId, "workspacePaintMs") &&
      this.activeTransition?.sample.visitKind !== "initial"
    ) {
      noteDesktopSwitchSettled();
    }
  }

  private markWorkspaceMilestone(
    desktopId: string,
    field: "workspaceCommitMs" | "workspaceFirstFrameMs" | "workspacePaintMs",
  ) {
    const sample = this.activeTransition?.sample;
    if (!sample || sample.desktopId !== desktopId || sample[field] !== null) {
      return undefined;
    }
    sample[field] = Math.max(0, this.now() - sample.startedAt);
    return sample;
  }

  private markWorkspaceCommitCheckpoint(
    sequence: number,
    field: "workspaceCommitMicrotaskMs" | "workspaceCommitMessageTaskMs",
  ) {
    const sample = this.activeTransition?.sample;
    if (
      !sample ||
      sample.sequence !== sequence ||
      sample.workspaceCommitMs === null ||
      sample[field] !== null
    ) {
      return;
    }
    sample[field] = Math.max(0, this.now() - sample.startedAt);
  }

  sealVisibleTerminals(desktopId: string) {
    const progress = this.activeTransition;
    if (!progress || progress.sample.desktopId !== desktopId || progress.visibleSetSealed) return;
    progress.expectedTerminalIds = new Set(
      [...this.terminals.values(), ...this.expectedTerminals.values()]
        .filter((terminal) => terminal.desktopId === desktopId)
        .filter((terminal) => {
          try {
            return terminal.readVisibility?.() ?? terminal.visible;
          } catch {
            return terminal.visible;
          }
        })
        .map((terminal) => terminal.id),
    );
    progress.visibleSetSealed = true;
    progress.sample.expectedTerminalPanes = progress.expectedTerminalIds.size;
    this.updateTerminalCompletion(progress);
  }

  registerExpectedTerminal(input: ExpectedTerminalResource) {
    const resource = { ...input };
    this.expectedTerminals.set(resource.id, resource);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.expectedTerminals.get(resource.id) === resource) {
          this.expectedTerminals.delete(resource.id);
        }
      },
    };
  }

  hasExpectedTerminalPanels(desktopId: string, panelIds: readonly string[]) {
    if (panelIds.length === 0) return true;
    const registeredPanelIds = new Set(
      [...this.expectedTerminals.values(), ...this.terminals.values()]
        .filter((terminal) => terminal.desktopId === desktopId)
        .flatMap((terminal) =>
          terminal.panelId === undefined ? [] : [terminal.panelId],
        ),
    );
    return panelIds.every((panelId) => registeredPanelIds.has(panelId));
  }

  currentTransitionSequence(desktopId: string | undefined) {
    const progress = this.activeTransition;
    if (
      !desktopId ||
      !progress ||
      progress.sample.desktopId !== desktopId ||
      this.now() - progress.sample.startedAt > MAX_TRANSITION_CAPTURE_MS
    ) {
      return undefined;
    }
    return progress.sample.sequence;
  }

  captureTerminalPaint(terminalId: string, desktopId: string | undefined) {
    const transitionSequence = this.currentTransitionSequence(desktopId);
    return () =>
      this.markTerminalPaintForTransition(terminalId, transitionSequence);
  }

  captureTerminalStable(terminalId: string, desktopId: string | undefined) {
    const transitionSequence = this.currentTransitionSequence(desktopId);
    return () => this.markTerminalStable(terminalId, transitionSequence);
  }

  mountWorkspace(desktopId: string) {
    const sample = this.activeTransition?.sample;
    if (
      sample &&
      sample.visitKind !== "initial" &&
      !sample.warm &&
      sample.desktopId === desktopId &&
      sample.remountCostMs === null &&
      this.remountStartedAt === undefined
    ) {
      this.remountStartedAt = this.now();
    }
    this.mounted.set(desktopId, (this.mounted.get(desktopId) ?? 0) + 1);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const remaining = (this.mounted.get(desktopId) ?? 1) - 1;
      if (remaining > 0) this.mounted.set(desktopId, remaining);
      else this.mounted.delete(desktopId);
    };
  }

  registerTerminal(
    input: Omit<TerminalResource, "presentationRequestedAt" | "visible"> & {
      visible?: boolean;
    },
  ): TerminalResourceRegistration {
    const resource: TerminalResource = { ...input, visible: input.visible ?? false };
    const presentation = this.terminalPresentations.registerSurface(resource.id);
    this.terminals.set(resource.id, resource);
    this.notifyTerminalResourcesChanged();
    this.updateTransitionVisibility(resource);
    let disposed = false;
    return {
      updateRenderer: (renderer) => {
        if (!disposed && this.terminals.get(resource.id) === resource) {
          if (resource.renderer !== renderer) {
            resource.renderer = renderer;
            this.notifyTerminalResourcesChanged();
          }
        }
      },
      updateGpuViewportBytes: (bytes) => {
        if (!disposed && this.terminals.get(resource.id) === resource) {
          const next = Number.isFinite(bytes)
            ? Math.max(0, Math.ceil(bytes))
            : Number.MAX_SAFE_INTEGER;
          if (resource.gpuViewportBytes !== next) {
            resource.gpuViewportBytes = next;
            this.notifyTerminalResourcesChanged();
          }
        }
      },
      updateModelBytes: (bytes) => {
        if (!disposed && this.terminals.get(resource.id) === resource) {
          const next = Number.isFinite(bytes)
            ? Math.max(0, Math.ceil(bytes))
            : Number.MAX_SAFE_INTEGER;
          if (resource.modelBytes !== next) {
            resource.modelBytes = next;
            this.notifyTerminalResourcesChanged();
          }
        }
      },
      updateVisibility: (visible) => {
        if (disposed || this.terminals.get(resource.id) !== resource) return;
        resource.visible = visible;
        this.updateTransitionVisibility(resource);
      },
      recordProjection: presentation.record,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        presentation.dispose();
        if (this.terminals.get(resource.id) === resource) {
          this.terminals.delete(resource.id);
          this.notifyTerminalResourcesChanged();
        }
      },
    };
  }

  onTerminalResourcesChanged(listener: () => void) {
    this.terminalResourceListeners.add(listener);
    return () => {
      this.terminalResourceListeners.delete(listener);
    };
  }

  /** O(n) live WebGL count from the in-memory registry — no layout reads,
   *  cheap enough for resource-change request time (the severe-overshoot
   *  lane bypass). Full snapshots stay reconcile-time-only. */
  liveWebglContextCount(): number {
    let count = 0;
    for (const terminal of this.terminals.values()) {
      if (terminal.renderer === "webgl") count += 1;
    }
    return count;
  }

  private notifyTerminalResourcesChanged() {
    for (const listener of this.terminalResourceListeners) listener();
  }

  markTerminalPresentationRequested(terminalId: string) {
    const resource = this.terminals.get(terminalId);
    if (resource) resource.presentationRequestedAt = this.now();
    this.terminalAttaches.markPresentationRequested(terminalId);
  }

  markTerminalAttachPhase(
    terminalId: string,
    event: TerminalAttachTimingEvent,
    desktopId?: string,
  ) {
    if (event.phase === "recovery") {
      this.terminalRecovery.record(event.correlationId, event.event);
      return undefined;
    }
    const resource = this.terminals.get(terminalId);
    const transitionDesktopId = resource?.desktopId ?? desktopId;
    return this.terminalAttaches.markPhase(
      terminalId,
      this.currentTransitionSequence(transitionDesktopId),
      event,
    );
  }

	markTerminalAttachSynchronized(terminalId: string, hidden = false) {
		this.terminalAttaches.markSynchronized(terminalId, hidden);
	}

  startTerminalRecoveryDetailCapture() {
    return this.terminalRecovery.startDetailCapture();
  }

	markTerminalAttachHidden(terminalId: string) {
		this.terminalAttaches.markHidden(terminalId);
	}

  markTerminalPaint(terminalId: string) {
    this.markTerminalPaintForTransition(
      terminalId,
      this.currentTransitionSequence(this.terminals.get(terminalId)?.desktopId),
    );
  }

  markTerminalInteractive(terminalId: string) {
    const resource = this.terminals.get(terminalId);
    const progress = this.activeTransition;
    const sample = progress?.sample;
    if (
      !resource ||
      !progress ||
      !sample ||
      sample.desktopId !== resource.desktopId ||
      sample.firstInteractivePaneMs !== null ||
      (progress.visibleSetSealed &&
        !progress.expectedTerminalIds.has(terminalId))
    ) {
      return;
    }
    if (this.now() - sample.startedAt > MAX_TRANSITION_CAPTURE_MS) {
      this.activeTransition = undefined;
      this.remountStartedAt = undefined;
      return;
    }
    sample.firstInteractivePaneMs = Math.max(0, this.now() - sample.startedAt);
    sample.firstInteractiveTerminalId = terminalId;
  }

  beginPaneFocus(
    desktopId: string,
    panelId: string,
    terminal: boolean,
    requestedAt?: number,
  ): number {
    return this.paneFocus.begin(desktopId, panelId, terminal, requestedAt);
  }

  markPaneFocusPaint(sequence: number): void {
    this.paneFocus.markPaint(sequence);
  }

  markPaneFocusFrame(sequence: number): void {
    this.paneFocus.markFrame(sequence);
  }

  markPaneFocusCommit(sequence: number): void {
    this.paneFocus.markCommit(sequence);
  }

  markPaneFocusEventMicrotask(sequence: number): void {
    this.paneFocus.markEventMicrotask(sequence);
  }

  markPaneFocusEventMessageTask(sequence: number): void {
    this.paneFocus.markEventMessageTask(sequence);
  }

  markPaneFocusEventTask(sequence: number): void {
    this.paneFocus.markEventTask(sequence);
  }

  markTerminalFocusGeometry(
    desktopId: string | undefined,
    panelId: string | undefined,
    durationMs: number,
  ): void {
    this.paneFocus.markTerminalGeometry(desktopId, panelId, durationMs);
  }

  markTerminalFocusRoleCommit(
    desktopId: string | undefined,
    panelId: string | undefined,
    effectMs: number,
  ): void {
    this.paneFocus.markTerminalRoleCommit(desktopId, panelId, effectMs);
  }

  markTerminalInputFocus(
    desktopId: string | undefined,
    panelId: string | undefined,
    durationMs: number,
  ): void {
    this.paneFocus.markTerminalInputFocus(desktopId, panelId, durationMs);
  }

  markTerminalInputFocusCallStart(
    desktopId: string | undefined,
    panelId: string | undefined,
    startedAt: number,
  ): void {
    this.paneFocus.markTerminalInputFocusCallStart(
      desktopId,
      panelId,
      startedAt,
    );
  }

  cancelTerminalInputFocusCall(
    sequence: number,
    desktopId: string | undefined,
    panelId: string | undefined,
  ): void {
    this.paneFocus.cancelTerminalInputFocusCall(
      sequence,
      desktopId,
      panelId,
    );
  }

  markTerminalInputFocusHandler(
    desktopId: string | undefined,
    panelId: string | undefined,
    timing: TerminalInputFocusHandlerTiming,
  ): void {
    this.paneFocus.markTerminalInputFocusHandler(desktopId, panelId, timing);
  }

  abortPaneFocus(sequence: number): void {
    this.paneFocus.abort(sequence);
  }

  markTerminalPaintForTransition(terminalId: string, transitionSequence?: number) {
    const resource = this.terminals.get(terminalId);
    if (!resource) return;
    this.terminalAttaches.markPaint(terminalId);
    const progress = this.activeTransition;
    const sample = progress?.sample;
    if (
      !progress ||
      !sample ||
      sample.desktopId !== resource.desktopId ||
      transitionSequence === undefined ||
      transitionSequence !== sample.sequence ||
      (progress.visibleSetSealed && !progress.expectedTerminalIds.has(terminalId))
    ) {
      return;
    }
    // 이번 present 사이클에서 실측된 attach 지연만 신선한 값으로 취급한다 —
    // 과거 사이클의 잔존값이 remount 분해에 섞이면 안 된다.
    let freshAttachLatencyMs: number | undefined;
    if (resource.presentationRequestedAt !== undefined) {
      freshAttachLatencyMs = Math.max(
        0,
        this.now() - resource.presentationRequestedAt,
      );
      resource.lastAttachLatencyMs = freshAttachLatencyMs;
    }
    resource.presentationRequestedAt = undefined;
    if (this.now() - sample.startedAt > MAX_TRANSITION_CAPTURE_MS) {
      this.activeTransition = undefined;
      this.remountStartedAt = undefined;
      return;
    }
    const elapsed = Math.max(0, this.now() - sample.startedAt);
    if (!progress.terminalPaintMs.has(terminalId)) {
      progress.terminalPaintMs.set(terminalId, elapsed);
    }
    if (sample.firstTerminalPaintMs === null) {
      sample.firstTerminalPaintMs = elapsed;
      if (!sample.warm && this.remountStartedAt !== undefined) {
        sample.remountCostMs = Math.max(0, this.now() - this.remountStartedAt);
        sample.remountAttachMs = freshAttachLatencyMs ?? null;
        this.remountStartedAt = undefined;
      }
    }
    this.updateTerminalCompletion(progress);
  }

  markTerminalStable(terminalId: string, transitionSequence: number | undefined) {
    const resource = this.terminals.get(terminalId);
    if (resource) this.terminalAttaches.markStable(terminalId);
    const progress = this.activeTransition;
    if (
      !resource ||
      !progress ||
      transitionSequence === undefined ||
      progress.sample.sequence !== transitionSequence ||
      progress.sample.desktopId !== resource.desktopId ||
      (progress.visibleSetSealed && !progress.expectedTerminalIds.has(terminalId))
    ) {
      return;
    }
    if (this.now() - progress.sample.startedAt > MAX_TRANSITION_CAPTURE_MS) {
      this.activeTransition = undefined;
      this.remountStartedAt = undefined;
      return;
    }
    if (!progress.terminalStableMs.has(terminalId)) {
      progress.terminalStableMs.set(
        terminalId,
        Math.max(0, this.now() - progress.sample.startedAt),
      );
    }
    this.updateTerminalCompletion(progress);
  }

  private updateTransitionVisibility(resource: TerminalResource) {
    const progress = this.activeTransition;
    if (
      !progress ||
      progress.visibleSetSealed ||
      progress.sample.desktopId !== resource.desktopId
    ) {
      return;
    }
    if (resource.visible) progress.expectedTerminalIds.add(resource.id);
    else progress.expectedTerminalIds.delete(resource.id);
  }

  private updateTerminalCompletion(progress: TransitionProgress) {
    const { sample, expectedTerminalIds } = progress;
    const painted = Array.from(expectedTerminalIds, (id) => ({
      id,
      elapsed: progress.terminalPaintMs.get(id),
    })).filter((entry): entry is { id: string; elapsed: number } => entry.elapsed !== undefined);
    const stable = Array.from(expectedTerminalIds, (id) => ({
      id,
      elapsed: progress.terminalStableMs.get(id),
    })).filter((entry): entry is { id: string; elapsed: number } => entry.elapsed !== undefined);
    sample.paintedTerminalPanes = painted.length;
    sample.stableTerminalPanes = stable.length;
    sample.terminalPaintRanksMs = painted
      .map((entry) => entry.elapsed)
      .sort((left, right) => left - right);
    sample.terminalStableRanksMs = stable
      .map((entry) => entry.elapsed)
      .sort((left, right) => left - right);
    if (!progress.visibleSetSealed || expectedTerminalIds.size === 0) return;
    if (painted.length === expectedTerminalIds.size) {
      sample.allTerminalPaintMs = Math.max(...painted.map((entry) => entry.elapsed));
    }
    if (stable.length > 0 && sample.firstTerminalStableMs === null) {
      sample.firstTerminalStableMs = Math.min(...stable.map((entry) => entry.elapsed));
    }
    if (stable.length === expectedTerminalIds.size) {
      const slowest = stable.reduce((current, entry) =>
        entry.elapsed >= current.elapsed ? entry : current,
      );
      sample.allTerminalStableMs = slowest.elapsed;
      sample.slowestTerminalId = slowest.id;
    }
  }

  beginPaneOpen(paneId: string, kind: string) {
    this.lifecycle.beginPaneOpen(paneId, kind);
  }

  markPaneReady(paneId: string) {
    this.lifecycle.markPaneReady(paneId);
  }

  cancelPaneOpen(paneId: string) {
    this.lifecycle.cancelPaneOpen(paneId);
  }

  agentSpawnWarm(provider: string): boolean {
    return this.lifecycle.agentSpawnWarm(provider);
  }

  recordAgentReady(provider: string, timing: AgentReadyTiming) {
    this.lifecycle.recordAgentReady(provider, timing);
  }

  snapshot(): WorkspacePerformanceSnapshot {
    const workspaceIds = new Set(this.mounted.keys());
    for (const terminal of this.terminals.values()) workspaceIds.add(terminal.desktopId);

    const workspaces = Array.from(workspaceIds, (desktopId) => {
      const terminals = Array.from(this.terminals.values()).filter(
        (terminal) => terminal.desktopId === desktopId,
      );
      return {
        desktopId,
        mounted: this.mounted.has(desktopId),
        terminalSurfaces: terminals.length,
        visibleTerminalSurfaces: terminals.filter(
          (terminal) => terminal.visible,
        ).length,
        terminalGpuViewportBytes: terminals.reduce(
          (total, terminal) =>
            total +
            (terminal.gpuViewportBytes ?? DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES),
          0,
        ),
        terminalModelBytes: terminals.reduce(
          (total, terminal) => total + (terminal.modelBytes ?? 0),
          0,
        ),
        webglContexts: terminals.filter((terminal) => terminal.renderer === "webgl").length,
        hmuxObservers: terminals.filter((terminal) => terminal.runtime === "hmux").length,
        maxTerminalAttachMs:
          terminals.reduce<number | null>(
            (latest, terminal) =>
              terminal.lastAttachLatencyMs === undefined
                ? latest
                : Math.max(latest ?? 0, terminal.lastAttachLatencyMs),
            null,
          ),
      };
    });

    const backgroundTerminalCount = Array.from(this.terminals.values()).filter(
      (terminal) => !terminal.visible,
    ).length;
    const attachSnapshot = this.terminalAttaches.snapshot();
    const lifecycleSnapshot = this.lifecycle.snapshot();
    return {
      transitions: this.transitions.map((sample) => ({ ...sample })),
      paneFocus: this.paneFocus.snapshot(),
      terminalAttaches: attachSnapshot.samples,
      terminalAttachIntegrity: attachSnapshot.integrity,
      terminalRecovery: this.terminalRecovery.snapshot(),
      paneOpens: lifecycleSnapshot.paneOpens,
      agentReady: lifecycleSnapshot.agentReady,
      workspaces,
      workspaceCache: this.workspaceCacheDecision
        ? {
            budget: { ...this.workspaceCacheDecision.budget },
            occupancy: {
              total: { ...this.workspaceCacheDecision.occupancy.total },
              warm: { ...this.workspaceCacheDecision.occupancy.warm },
              frozen: { ...this.workspaceCacheDecision.occupancy.frozen },
            },
            backgroundPresentation: {
              terminalSurfaces: backgroundTerminalCount,
              recentWriterSurfaces: null,
              bufferedBytes: null,
              maxRecentWriteLatencyMs: null,
            },
          }
        : undefined,
      totals: {
        mountedWorkspaces: workspaces.filter((workspace) => workspace.mounted).length,
        terminalSurfaces: workspaces.reduce(
          (total, workspace) => total + workspace.terminalSurfaces,
          0,
        ),
        terminalGpuViewportBytes: workspaces.reduce(
          (total, workspace) =>
            total + (workspace.terminalGpuViewportBytes ?? 0),
          0,
        ),
        terminalModelBytes: workspaces.reduce(
          (total, workspace) => total + (workspace.terminalModelBytes ?? 0),
          0,
        ),
        webglContexts: workspaces.reduce(
          (total, workspace) => total + workspace.webglContexts,
          0,
        ),
        hmuxObservers: workspaces.reduce(
          (total, workspace) => total + workspace.hmuxObservers,
          0,
        ),
      },
      render: null,
      terminalPresentation: this.terminalPresentations.snapshot(),
    };
  }
}

export const workspacePerformance = new WorkspacePerformanceTracker();

export function getWorkspacePerformanceSnapshot() {
  return {
    ...workspacePerformance.snapshot(),
    chatInput: chatInputLatency.snapshot(),
    terminalInput: terminalInputLatency.snapshot(),
  };
}
