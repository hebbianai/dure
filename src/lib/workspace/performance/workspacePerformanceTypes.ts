import type { ChatInputLatencySnapshot } from "@/lib/agents/chat/chatInputLatency";
import type { TerminalInputLatencySnapshot } from "@/lib/terminal/interaction/terminalInputLatency";
import type {
  TerminalAttachIntegrity,
  TerminalAttachSegmentSample,
} from "@/lib/terminal/terminalAttachPerformance";
import type { TerminalRecoveryPerformanceSnapshot } from "@/lib/terminal/terminalRecoveryPerformance";
import type {
	StructuredTerminalPresentationSnapshot,
	TerminalPresentationRole,
} from "./structuredTerminalPresentationPerformance";
import type { PaneFocusSample } from "./workspacePaneFocusPerformance";

export type WorkspaceTerminalRuntime = "legacy" | "hmux";
export type WorkspaceRendererBackend = "dom" | "webgl";
export type WorkspaceTransitionCacheState = "renderer" | "model" | "cold";
export type WorkspaceVisitKind = "initial" | "first_visit" | "revisit";
export type { PaneFocusSample } from "./workspacePaneFocusPerformance";

export interface TerminalResourceRegistration {
	updateRenderer(renderer: WorkspaceRendererBackend): void;
	updateGpuViewportBytes(bytes: number): void;
	updateModelBytes(bytes: number): void;
	updateVisibility(visible: boolean): void;
	recordProjection(
		role: TerminalPresentationRole,
		timing: {
			readonly projectionStartedAt: number;
			readonly projectionCommittedAt: number;
		},
	): void;
	dispose(): void;
}

export interface WorkspaceCacheBudget {
  maxWorkspaces: number;
  maxTerminalSurfaces: number;
  /**
   * Shell-retention caps. Model bytes are a conservative activation projection;
   * hidden TerminalView subtrees retain no renderer, model, or observer.
   * Crossing either cap discards the whole Workspace/Dockview shell.
   */
  retainedWorkspaces: number;
  retainedTerminalModelBytes: number;
  /**
   * `pressure`는 활성 표면이 잠깐 바쁜 상태이고, `severe-pressure`는 그 위의
   * 단계다. 둘을 구분하는 이유: 일반 pressure에서 숨은 데스크탑의 WebGL을
   * 버려도 활성 터미널의 write latency는 줄지 않는다. 그 상태가 초 단위로
   * 들락거리면 복귀 대상 렌더러만 반복해서 파괴/재생성된다(pane당 ~85ms).
   */
  reason:
    | "low-resource"
    | "balanced"
    | "high-resource"
    | "observed-benefit"
    | "pressure"
    | "severe-pressure";
}

export interface WorkspaceCacheTierOccupancy {
  workspaces: number;
  projectedTerminalSurfaces: number;
  projectedTerminalModelBytes: number;
}

export interface WorkspaceCacheDecisionSnapshot {
  budget: WorkspaceCacheBudget;
  occupancy: {
    total: WorkspaceCacheTierOccupancy;
    warm: WorkspaceCacheTierOccupancy;
    frozen: WorkspaceCacheTierOccupancy;
  };
}

export interface WorkspaceCacheDiagnostics
  extends WorkspaceCacheDecisionSnapshot {
  /** Inactive terminal presentations, which should converge to zero. */
  backgroundPresentation: {
    terminalSurfaces: number;
    /** Unavailable after the legacy renderer retired; never a measured zero. */
    recentWriterSurfaces: number | null;
    bufferedBytes: number | null;
    maxRecentWriteLatencyMs: number | null;
  };
}

export interface WorkspaceTransitionSample {
  sequence: number;
  desktopId: string;
  /** initial=WebView boot, first_visit=first selection this boot, revisit=return. */
  visitKind?: WorkspaceVisitKind;
  /** Compatibility label for a retained Workspace-shell tier or cold remount. */
  cacheState: WorkspaceTransitionCacheState;
  /** Backward-compatible retained/unmounted split. model and renderer are retained. */
  warm: boolean;
  startedAt: number;
  /** Selection intent → React layout commit for the destination Workspace. */
  workspaceCommitMs: number | null;
  /** Selection intent → the microtask checkpoint after the commit. */
  workspaceCommitMicrotaskMs: number | null;
  /** Selection intent → the shared browser message-task checkpoint. */
  workspaceCommitMessageTaskMs: number | null;
  /** Selection intent → the first browser animation frame after that commit. */
  workspaceFirstFrameMs: number | null;
  workspacePaintMs: number | null;
  /** Selected terminal has controller input permission and a committed paint. */
  firstInteractivePaneMs: number | null;
  firstInteractiveTerminalId: string | null;
  firstTerminalPaintMs: number | null;
  allTerminalPaintMs: number | null;
  firstTerminalStableMs: number | null;
  allTerminalStableMs: number | null;
  /** Content-free visible-pane milestones sorted from first to last. */
  terminalPaintRanksMs: readonly number[];
  terminalStableRanksMs: readonly number[];
  expectedTerminalPanes: number | null;
  paintedTerminalPanes: number;
  stableTerminalPanes: number;
  slowestTerminalId: string | null;
  /** Cold Workspace remount → first terminal paint. Warm transitions stay null. */
  remountCostMs: number | null;
  /** Attach/hydration portion of `remountCostMs`. */
  remountAttachMs: number | null;
}

export interface WorkspaceResourceSnapshot {
  desktopId: string;
  mounted: boolean;
  terminalSurfaces: number;
  /** Dockview-visible pane count used by warm-tier admission accounting. */
  visibleTerminalSurfaces: number;
  terminalGpuViewportBytes?: number;
  terminalModelBytes?: number;
  webglContexts: number;
  hmuxObservers: number;
  maxTerminalAttachMs: number | null;
}

export interface PaneOpenSample {
  sequence: number;
  paneId: string;
  kind: string;
  warm: boolean;
  startedAt: number;
  openMs: number | null;
}

export interface AgentReadySample {
  sequence: number;
  provider: string;
  warm: boolean;
  ok: boolean;
  totalMs: number;
  preflightMs: number;
  createMs: number;
}

export interface WorkspaceSurfaceRenderPressure {
  id: string;
  desktopId: string;
  writeLatencyMs: number;
  bufferedBytes: number;
}

export interface WorkspacePerformanceSnapshot {
  terminalRecovery?: TerminalRecoveryPerformanceSnapshot;
  transitions: readonly WorkspaceTransitionSample[];
  paneFocus?: readonly PaneFocusSample[];
  terminalAttaches: readonly TerminalAttachSegmentSample[];
  terminalAttachIntegrity: TerminalAttachIntegrity;
  paneOpens: readonly PaneOpenSample[];
  agentReady: readonly AgentReadySample[];
  workspaces: readonly WorkspaceResourceSnapshot[];
  workspaceCache?: WorkspaceCacheDiagnostics;
  totals: {
    mountedWorkspaces: number;
    terminalSurfaces: number;
    terminalGpuViewportBytes?: number;
    terminalModelBytes?: number;
    webglContexts: number;
    hmuxObservers: number;
  };
  /** Null when legacy byte/write pressure is not measured by this renderer. */
  render: {
    bufferedBytes: number;
    peakBufferedBytes: number;
    maxRecentWriteLatencyMs: number;
    perSurface: readonly WorkspaceSurfaceRenderPressure[];
  } | null;
	/** Every authoritative structured DOM commit, including no-input paints. */
	terminalPresentation: StructuredTerminalPresentationSnapshot;
  /** Focused Hmux input samples. Input bytes are never retained. */
  terminalInput?: TerminalInputLatencySnapshot;
  /** Structured Chat draft input through the renderer commit and paint. */
  chatInput?: ChatInputLatencySnapshot;
}
