import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TerminalQaBufferState } from "@/components/terminal/TerminalView";
import { hmuxDiagnosticWebviewIdentity } from "@/lib/hmux/identity/hmuxConnectionDiagnostics";
import { reportWindowFocusQa } from "@/lib/ipc/windowFocusQa";
import { listenWhenReady as listen } from "@/lib/platform/tauriBridge";
import {
  TerminalResizeFrameIntegrity,
  type TerminalResizeFrameIntegritySnapshot,
} from "@/lib/terminal/qa/terminalResizeFrameIntegrity";
import { MAX_GRID_ROWS } from "@/lib/terminal/protocol/terminalStateGridValidation";
import type {
  TerminalQaInputReceipt,
  TerminalWindowFocusControlState,
  TerminalWindowFocusProbe,
  TerminalWindowFocusProbeSurface,
} from "@/lib/terminal/terminalWindowFocusProbe";
import { exactProjectionMarkerEvidence } from "./hmuxProjectionMarkerEvidence";

const ACTION_EVENT = "qa:hmux-window-focus-action";
const RESIZE_BASELINE_EVENT = "qa:hmux-window-focus-resize-baseline";
const SMOKE_REPORT_INTERVAL_MS = 75;
const SOAK_REPORT_INTERVAL_MS = 500;
const ACTION_TIMEOUT_MS = 5_000;

type WindowRole = "a" | "b";
type WindowFocusProfile =
  | "smoke"
  | "background"
  | "soak"
  | "scrollback"
  | "large_view"
  | "external_input";

type WindowActionKind =
  | "focus"
  | "marker"
  | "external_input"
  | "release_control"
  | "scroll_rows";

export interface WindowContext {
  proof: string;
  role: WindowRole;
  sessionId: string;
  workspaceId: string;
  profile: WindowFocusProfile;
  resizeRenderProvider?: string;
  resizeRenderScreenModel?: "alternate" | "normal";
  scrollbackMarker?: string;
  scrollbackSoftWrapMarker?: string;
}

interface WindowAction {
  proof: string;
  role: WindowRole;
  actionId: number;
  kind: WindowActionKind;
  marker?: string;
  rows?: number;
}

interface WindowInputReceipt extends TerminalQaInputReceipt {
  observationAtHostReceipt: {
    snapshotCollapses: number;
    scrollbackRows: number;
    atBottom: boolean;
    concealed: boolean;
    historyHydrating: boolean;
    visibleScrollbackMarker?: string;
    visibleFrameCount: number;
    visibleFrameViolations: number;
  };
}

interface ResizeBaseline {
  proof: string;
}

interface WindowReport {
  proof: string;
  role: WindowRole;
  webviewInstanceId: string;
  webviewStartedAt: string;
  webviewUptimeMs: number;
  mounted: boolean;
  latestSurfaceAttachmentId?: string;
  latestRetiredSurfaceAttachmentId?: string;
  listening: boolean;
  synchronized: boolean;
  synchronizationCount: number;
  hydrating: boolean;
  documentFocused: boolean;
  terminalInputFocused: boolean;
  controlState: TerminalWindowFocusControlState;
  transportMarkers: Record<string, boolean>;
  markerWriteReceipts: Record<string, WindowInputReceipt>;
  markerCounts: Record<string, number>;
  firstSeenFocused: Record<string, boolean>;
  firstSeenAtMs: Record<string, number>;
  firstPaintAtMs: Record<string, number>;
  receivedActionId?: number;
  completedActionId?: number;
  heartbeatCount: number;
  maxHeartbeatLagMs: number;
  renderMetrics?: ReturnType<TerminalWindowFocusProbeSurface["renderMetrics"]>;
  bufferState?: TerminalQaBufferState;
  firstPresentedBufferState?: TerminalQaBufferState;
  presentedCount: number;
  visibleFrameCount: number;
  visibleFrameViolations: number;
  resizeRenderIntegrity?: TerminalResizeFrameIntegritySnapshot;
  concealmentObserved: boolean;
  largeViewReturnPreparationCount: number;
  errors: string[];
}

export class WindowFocusReporter implements TerminalWindowFocusProbe {
  private surface: TerminalWindowFocusProbeSurface | undefined;
  private listening = false;
  private synchronized = false;
  private synchronizationCount = 0;
  private hydrating = true;
  private latestSurfaceAttachmentId: string | undefined;
  private latestRetiredSurfaceAttachmentId: string | undefined;
  private controlState: TerminalWindowFocusControlState = "viewing";
  private receivedActionId: number | undefined;
  private completedActionId: number | undefined;
  private readonly markerWriteReceipts: Record<string, WindowInputReceipt> = {};
  private readonly firstSeenFocused: Record<string, boolean> = {};
  private readonly firstSeenAtMs: Record<string, number> = {};
  private readonly firstPaintAtMs: Record<string, number> = {};
  private readonly errors: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private unlisten: UnlistenFn | undefined;
  private unlistenResizeBaseline: UnlistenFn | undefined;
  private disposed = false;
  private lastReport = "";
  private reportChain: Promise<unknown> = Promise.resolve();
  private heartbeatCount = 0;
  private maxHeartbeatLagMs = 0;
  private nextHeartbeatAt = 0;
  private firstPresentedBufferState: TerminalQaBufferState | undefined;
  private presentedCount = 0;
  private visibleFrameCount = 0;
  private visibleFrameViolations = 0;
  private readonly resizeRenderIntegrity:
    | TerminalResizeFrameIntegrity
    | undefined;
  private concealmentObserved = false;
  private largeViewReturnPreparationCount = 0;
  private paintFrame: number | undefined;
  private resizeIntegrityFrame: number | undefined;

  constructor(private readonly context: WindowContext) {
    this.resizeRenderIntegrity =
      context.profile === "large_view" &&
      context.resizeRenderProvider &&
      context.resizeRenderScreenModel
        ? new TerminalResizeFrameIntegrity({
            provider: context.resizeRenderProvider,
            buffer: context.resizeRenderScreenModel,
          })
        : undefined;
  }

  async start() {
    this.unlisten = await listen<WindowAction>(ACTION_EVENT, ({ payload }) => {
      if (
        payload.proof !== this.context.proof ||
        payload.role !== this.context.role ||
        ![
          "focus",
          "marker",
          "external_input",
          "release_control",
          "scroll_rows",
        ].includes(payload.kind) ||
        ((payload.kind === "marker" || payload.kind === "external_input") !==
          (payload.marker !== undefined)) ||
        (payload.marker !== undefined &&
          !/^HMUX_WINDOW_QA_[A-F0-9]{12}_[ABS]_\d{4}$/.test(payload.marker)) ||
        ((payload.kind === "scroll_rows") !== (payload.rows !== undefined)) ||
        (payload.rows !== undefined &&
          (!Number.isSafeInteger(payload.rows) ||
            payload.rows === 0 ||
            Math.abs(payload.rows) > MAX_GRID_ROWS))
      ) {
        return;
      }
      if (payload.kind !== "external_input" && payload.kind !== "release_control") {
        this.receivedActionId = payload.actionId;
        this.report(true);
      }
      void this.runAction(payload);
    });
    this.unlistenResizeBaseline = await listen<ResizeBaseline>(
      RESIZE_BASELINE_EVENT,
      ({ payload }) => {
        if (
          payload.proof !== this.context.proof ||
          this.context.profile !== "large_view"
        ) {
          return;
        }
        this.resizeRenderIntegrity?.reset();
        // report() immediately samples the already-settled provider frame as
        // the baseline. Subsequent visible resize transitions remain strict.
        this.report(true);
        this.sampleResizeIntegrityFrames();
      },
    );
    this.listening = true;
    if (this.disposed) {
      this.unlisten();
      this.unlisten = undefined;
      this.unlistenResizeBaseline();
      this.unlistenResizeBaseline = undefined;
      return;
    }
    const interval =
      this.context.profile === "soak"
        ? SOAK_REPORT_INTERVAL_MS
        : SMOKE_REPORT_INTERVAL_MS;
    this.nextHeartbeatAt = performance.now() + interval;
    this.timer = setInterval(() => {
      const now = performance.now();
      this.heartbeatCount += 1;
      this.maxHeartbeatLagMs = Math.max(
        this.maxHeartbeatLagMs,
        Math.max(0, now - this.nextHeartbeatAt),
      );
      this.nextHeartbeatAt = now + interval;
      this.report();
    }, interval);
    this.report(true);
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.paintFrame !== undefined) cancelAnimationFrame(this.paintFrame);
    this.paintFrame = undefined;
    if (this.resizeIntegrityFrame !== undefined) {
      cancelAnimationFrame(this.resizeIntegrityFrame);
    }
    this.resizeIntegrityFrame = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
    this.unlistenResizeBaseline?.();
    this.unlistenResizeBaseline = undefined;
  }

  connect(surface: TerminalWindowFocusProbeSurface) {
    this.retireAttachmentProjection();
    this.surface = surface;
    this.report(true);
    return () => {
      if (this.surface === surface) {
        this.surface = undefined;
        this.retireAttachmentProjection();
      }
      this.report(true);
    };
  }

  onSurfaceAttachmentStarted(attachmentId: string) {
    this.latestSurfaceAttachmentId = attachmentId;
    this.latestRetiredSurfaceAttachmentId = undefined;
    this.hydrating = true;
    this.retireAttachmentProjection();
    this.report(true);
  }

  onSurfaceRetirement(attachmentId: string, retirement: Promise<void>) {
    void retirement.then(
      () => {
        if (this.latestSurfaceAttachmentId !== attachmentId) return;
        this.latestRetiredSurfaceAttachmentId = attachmentId;
        this.report(true);
      },
      (error) => this.onError(error),
    );
  }

  onHydrationChange(hydrating: boolean) {
    this.hydrating = hydrating;
    if (hydrating) this.retireAttachmentProjection();
    this.report(true);
  }

  onSynchronized() {
    this.synchronized = true;
    this.synchronizationCount += 1;
    this.report(true);
  }

  onPresented(state: TerminalQaBufferState) {
    this.sampleConcealment(state);
    this.presentedCount += 1;
    this.firstPresentedBufferState ??= state;
    this.sampleVisibleFrame(state);
    this.resizeRenderIntegrity?.observe(state);
    this.report(true);
    if (this.paintFrame !== undefined) return;
    this.paintFrame = requestAnimationFrame(() => {
      this.paintFrame = undefined;
      if (this.disposed) return;
      const markerCounts = this.surface?.markerCounts() ?? {};
      for (const marker of Object.keys(markerCounts)) {
        this.firstPaintAtMs[marker] ??= Date.now();
      }
      this.report(true);
    });
  }

  onLargeViewReturnPrepared() {
    this.largeViewReturnPreparationCount += 1;
    this.report(true);
  }

  onError(error: unknown) {
    const message = String(error).slice(0, 512);
    if (!this.errors.includes(message) && this.errors.length < 16) {
      this.errors.push(message);
    }
    this.report(true);
  }

  private async runAction(action: WindowAction) {
    try {
      if (action.kind === "release_control") {
        const surface = await waitForValue(() => this.surface, "terminal surface");
        await surface.releaseKeyboardControl();
        if (this.surface !== surface) {
          throw new Error("terminal surface changed during controller release");
        }
        this.controlState = "viewing";
        this.report(true);
        return;
      }
      if (action.kind === "scroll_rows") {
        const surface = await waitForValue(() => this.surface, "terminal surface");
        const rows = action.rows;
        if (rows === undefined) throw new Error("viewport scroll action is missing rows");
        const before = surface.bufferState();
        if (surface.scrollRows(rows) === undefined) {
          throw new Error("structured terminal viewport scroll is not ready");
        }
        await waitUntil(() => {
          const current = surface.bufferState();
          return rows > 0
            ? current.viewportY > before.viewportY && !current.atBottom
            : current.viewportY < before.viewportY || current.atBottom;
        }, "Host viewport scroll projection");
        this.completedActionId = action.actionId;
        this.report(true);
        return;
      }
      const surface = await this.focusForAction();
      if (action.kind === "external_input") {
        await this.runExternalInput(action, surface);
        return;
      }
      if (
        this.context.profile === "scrollback" &&
        this.context.role === "a" &&
        action.marker === undefined
      ) {
        // Match a Dockview sash drag: the app window remains focused while
        // The structured input surface releases keyboard control before its dimensions
        // change. Directly exercise that boundary because focusing a generic
        // DOM element makes WKWebView report the whole document as unfocused.
        await surface.releaseKeyboardControl();
        if (this.surface !== surface) {
          throw new Error("terminal surface changed during keyboard blur");
        }
        if (!document.hasFocus()) {
          throw new Error("terminal window lost focus during keyboard blur");
        }
        this.controlState = "viewing";
        this.report(true);
      }
      if (action.marker) {
        const input =
          this.context.profile === "large_view" || this.context.profile === "smoke"
            ? `${action.marker}\n`
            : undefined;
        const receipt = await surface.writeMarker(action.marker, input);
        this.markerWriteReceipts[action.marker] = this.observeHostReceipt(
          surface,
          receipt,
        );
      }
      this.completedActionId = action.actionId;
      this.report(true);
    } catch (error) {
      this.onError(error);
    }
  }

  private async runExternalInput(
    action: WindowAction,
    surface: TerminalWindowFocusProbeSurface,
  ) {
    const marker = action.marker;
    if (!marker) throw new Error("terminal text handoff action is missing its marker");
    const terminalInput = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="structured-terminal-presentation"] textarea',
    );
    const searchInput = document.querySelector<HTMLInputElement>(
      '[data-qa-hmux-session-search="true"]',
    );
    if (!terminalInput || !searchInput) {
      throw new Error("terminal text handoff surfaces are missing");
    }
    const terminalOwnedBeforeHandoff =
      terminalInput.ownerDocument.activeElement === terminalInput;
    if (!terminalOwnedBeforeHandoff) {
      throw new Error("terminal did not own keyboard input before the handoff");
    }
    const escaped = [...marker]
      .map(
        (character) =>
          `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
      )
      .join("");
    const command = `printf '${escaped}\\n'\r`;
    searchInput.focus();
    await waitUntil(
      () => searchInput.ownerDocument.activeElement === searchInput,
      "Sessions search keyboard ownership",
    );
    dispatchTextInput(terminalInput, command);
    dispatchTextInput(terminalInput, "");
    // receivedActionId is the durable observation that both delayed events ran
    // after Sessions search became the exact keyboard owner. Keep completion
    // pending while native QA proves the Host canonical snapshot stayed empty.
    this.receivedActionId = action.actionId;
    this.report(true);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const markerCountWhileSearchOwned = surface.markerCounts()[marker] ?? 0;
    const projectionMarkerCountWhileSearchOwned =
      surface.projectionMarkerCounts?.()[marker] ?? 0;
    const protocolErrorVisibleWhileSearchOwned =
      document.body.textContent?.includes("text input is empty or oversized") ??
      false;
    if (
      markerCountWhileSearchOwned !== 0 ||
      projectionMarkerCountWhileSearchOwned !== 0 ||
      protocolErrorVisibleWhileSearchOwned
    ) {
      throw new Error(
        `delayed terminal text crossed Sessions search ownership: ${JSON.stringify({
          markerCountWhileSearchOwned,
          projectionMarkerCountWhileSearchOwned,
          protocolErrorVisibleWhileSearchOwned,
        })}`,
      );
    }

    terminalInput.focus();
    await waitUntil(
      () => terminalInput.ownerDocument.activeElement === terminalInput,
      "terminal keyboard ownership after Sessions search",
    );
    dispatchTextInput(terminalInput, command);
    await waitUntil(
      () =>
        (surface.markerCounts()[marker] ?? 0) === 1 &&
        (surface.projectionMarkerCounts?.()[marker] ?? 0) === 1,
      "terminal marker after keyboard ownership returns",
    );
    if (terminalInput.ownerDocument.activeElement !== terminalInput) {
      throw new Error("terminal did not regain keyboard ownership");
    }
    this.completedActionId = action.actionId;
    this.report(true);
  }
  private async focusForAction() {
    const deadline = performance.now() + ACTION_TIMEOUT_MS;
    let lastError: unknown;
    while (performance.now() < deadline) {
      try {
        await settleBefore(
          getCurrentWindow().setFocus(),
          deadline,
          "target window focus request",
        );
        await waitUntil(() => document.hasFocus(), "target window focus", deadline);
        const surface = await waitForValue(() => this.surface, "terminal surface", deadline);
        await surface.focus();
        if (this.surface !== surface) {
          throw new Error("terminal surface changed during focus");
        }
        if (!document.hasFocus()) {
          throw new Error("terminal window lost focus during controller acquisition");
        }
        this.controlState = "controlling";
        this.report(true);
        return surface;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error(
      `timed out stabilizing Hmux window focus${
        lastError === undefined ? "" : `: ${String(lastError)}`
      }`,
    );
  }

  private observeHostReceipt(
    surface: TerminalWindowFocusProbeSurface,
    receipt: TerminalQaInputReceipt,
  ): WindowInputReceipt {
    const renderMetrics = surface.renderMetrics();
    const bufferState = surface.bufferState(
      this.context.scrollbackSoftWrapMarker,
    );
    return {
      ...receipt,
      observationAtHostReceipt: {
        snapshotCollapses: renderMetrics.snapshotCollapses,
        scrollbackRows: bufferState.scrollbackRows,
        atBottom: bufferState.atBottom,
        concealed: bufferState.concealed,
        historyHydrating: this.hydrating,
        ...(bufferState.visibleScrollbackMarker
          ? { visibleScrollbackMarker: bufferState.visibleScrollbackMarker }
          : {}),
        visibleFrameCount: this.visibleFrameCount,
        visibleFrameViolations: this.visibleFrameViolations,
      },
    };
  }

  private report(force = false) {
    if (this.disposed) return;
    const webviewIdentity = hmuxDiagnosticWebviewIdentity();
    const terminalInput = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="structured-terminal-presentation"] textarea',
    );
    const markerCounts = this.surface?.markerCounts() ?? {};
    const projectionMarkerCounts =
      this.surface?.projectionMarkerCounts?.() ?? {};
    const bufferState = this.surface?.bufferState(
      this.context.scrollbackSoftWrapMarker,
    );
    this.sampleConcealment(bufferState);
    if (bufferState) this.sampleVisibleFrame(bufferState);
    if (bufferState) this.resizeRenderIntegrity?.observe(bufferState);
    for (const marker of Object.keys(markerCounts)) {
      if (!(marker in this.firstSeenFocused)) {
        this.firstSeenFocused[marker] = document.hasFocus();
        this.firstSeenAtMs[marker] = Date.now();
      }
    }
    const report: WindowReport = {
      proof: this.context.proof,
      role: this.context.role,
      webviewInstanceId: webviewIdentity.instanceId,
      webviewStartedAt: webviewIdentity.startedAt,
      webviewUptimeMs: webviewIdentity.uptimeMs,
      mounted: this.surface !== undefined,
      latestSurfaceAttachmentId: this.latestSurfaceAttachmentId,
      latestRetiredSurfaceAttachmentId: this.latestRetiredSurfaceAttachmentId,
      listening: this.listening,
      synchronized: this.synchronized,
      synchronizationCount: this.synchronizationCount,
      hydrating: this.hydrating,
      documentFocused: document.hasFocus(),
      terminalInputFocused:
        document.hasFocus() && document.activeElement === terminalInput,
      controlState: this.controlState,
      // Hidden WKWebViews suspend paint frames. Keep received complete
      // projections observable without turning background transport progress
      // into background DOM work; true still means the projection contains the
      // issued marker exactly once, while markerCounts remains paint-owned.
      transportMarkers: exactProjectionMarkerEvidence(projectionMarkerCounts),
      markerWriteReceipts: { ...this.markerWriteReceipts },
      markerCounts,
      firstSeenFocused: { ...this.firstSeenFocused },
      firstSeenAtMs: { ...this.firstSeenAtMs },
      firstPaintAtMs: { ...this.firstPaintAtMs },
      receivedActionId: this.receivedActionId,
      completedActionId: this.completedActionId,
      heartbeatCount: this.heartbeatCount,
      maxHeartbeatLagMs: Math.ceil(this.maxHeartbeatLagMs),
      renderMetrics: this.surface?.renderMetrics(),
      bufferState,
      firstPresentedBufferState: this.firstPresentedBufferState,
      presentedCount: this.presentedCount,
      visibleFrameCount: this.visibleFrameCount,
      visibleFrameViolations: this.visibleFrameViolations,
      resizeRenderIntegrity: this.resizeRenderIntegrity?.snapshot(),
      concealmentObserved: this.concealmentObserved,
      largeViewReturnPreparationCount: this.largeViewReturnPreparationCount,
      errors: [...this.errors],
    };
    const serialized = JSON.stringify(report);
    if (!force && serialized === this.lastReport) return;
    this.lastReport = serialized;
    this.reportChain = this.reportChain
      .then(() => reportWindowFocusQa(report))
      .catch((error) => {
        console.error(`[hmux window focus QA report] ${String(error)}`);
      });
  }

  private sampleResizeIntegrityFrames() {
    if (!this.resizeRenderIntegrity) return;
    if (this.resizeIntegrityFrame !== undefined) {
      cancelAnimationFrame(this.resizeIntegrityFrame);
    }
    const deadline = performance.now() + 750;
    const sample = () => {
      this.resizeIntegrityFrame = undefined;
      if (this.disposed) return;
      const state = this.surface?.bufferState();
      if (state) this.resizeRenderIntegrity?.observe(state);
      if (performance.now() < deadline) {
        this.resizeIntegrityFrame = requestAnimationFrame(sample);
      } else {
        this.report(true);
      }
    };
    this.resizeIntegrityFrame = requestAnimationFrame(sample);
  }

  private sampleVisibleFrame(state: TerminalQaBufferState) {
    if (
      this.context.profile !== "scrollback" ||
      !this.synchronized ||
      state.concealed
    ) {
      return;
    }
    this.visibleFrameCount += 1;
    const consistentViewportPosition = state.atBottom
      ? state.viewportY === 0
      : state.viewportY > 0 && state.scrollbackRows >= state.viewportY;
    if (state.bufferLength === 0 || !consistentViewportPosition) {
      this.visibleFrameViolations += 1;
    }
  }

  private sampleConcealment(state: TerminalQaBufferState | undefined) {
    if (state?.concealed) this.concealmentObserved = true;
  }

  private retireAttachmentProjection() {
    this.synchronized = false;
    this.controlState = "viewing";
  }
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  deadline = performance.now() + ACTION_TIMEOUT_MS,
) {
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function dispatchTextInput(input: HTMLTextAreaElement, text: string) {
  input.value = text;
  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: text,
      inputType: "insertText",
    }),
  );
}

async function settleBefore<T>(
  promise: Promise<T>,
  deadline: number,
  description: string,
): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error(`timed out waiting for ${description}`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out waiting for ${description}`)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForValue<T>(
  read: () => T | undefined,
  description: string,
  deadline?: number,
): Promise<T> {
  let value: T | undefined;
  await waitUntil(() => {
    value = read();
    return value !== undefined;
  }, description, deadline);
  return value as T;
}
