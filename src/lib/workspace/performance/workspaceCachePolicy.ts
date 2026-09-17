import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import {
  DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES,
  PREWARM_TERMINAL_MODEL_BYTES,
  TERMINAL_MODEL_FALLBACK_BUDGET_BYTES,
} from "./terminalResourceBudget";
import type {
  WorkspaceCacheBudget,
  WorkspaceCacheDecisionSnapshot,
  WorkspacePerformanceSnapshot,
} from "./workspacePerformanceTypes";

export type { WorkspaceCacheBudget } from "./workspacePerformanceTypes";

export interface WorkspaceHardwareProfile {
  logicalCores?: number;
  deviceMemoryGb?: number;
  physicalMemoryBytes?: number;
}

export interface WorkspaceCacheSelection {
  current: readonly string[];
  valid: readonly string[];
  active?: string;
  /** Exact desktop left by the latest real activation, never a prewarm guess. */
  protectedRetainId?: string;
  /** Ordered from lower to higher warm-cache priority. */
  warmCandidates?: readonly string[];
  /** Speculative shell prewarm candidates, admitted after current workspaces. */
  retainCandidates?: readonly string[];
  /** Terminal surfaces projected for the workspace's next activation. */
  terminalSurfaces: Readonly<Record<string, number>>;
  /** Dockview-visible terminal panes on the next activation, including frozen
   * shells and pending attachments. Hidden tabs do not count. Without a mounted
   * layout, conservatively price the full serialized terminal count. */
  visibleTerminalSurfaces?: Readonly<Record<string, number>>;
  /** Measured or estimated WebGL backing-store cost of the next activation. */
  terminalGpuViewportBytes?: Readonly<Record<string, number>>;
  /** Measured or estimated terminal-model cost of the next activation. */
  terminalModelBytes?: Readonly<Record<string, number>>;
  budget: WorkspaceCacheBudget;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
// 데스크탑을 많이 쓰는 사용자(에이전트당 1개꼴)의 무작위 ⌘ 점프는 warm 집합
// 밖이면 전부 콜드 리마운트다 — 9개 데스크탑 랜덤 점프 스트레스에서 상한 5는
// cold 71%를 만들었다. workspace 수 자체는 싼 자원(숨김 데스크탑은 그리지
// 않음)이고 진짜 가드는 활성 renderer와 parked terminal-model 예산이므로,
// 각각의 surface 캡이 지켜지는 한도 안에서 넉넉히 둔다.
const HARD_MAX_WORKSPACES = 12;
// WKWebView의 페이지 단위 context ceiling에 닿지 않도록 여유를 남기면서,
// 실사용 heavy(10 panes) ↔ main(3 panes) 왕복은 둘 다 resident로 둔다.
// 12에서는 단 한 surface 초과 때문에 이전 데스크탑 전체를 frozen으로 내려
// 매 전환마다 WebGL addon을 다시 만드는 경계 진동이 발생했다.
const HARD_MAX_TERMINAL_SURFACES = 14;
// The measured HebbianIDE(595 MiB) + hebbian-agents(190 MiB) pair exceeds the
// conservative 768 MiB terminal-model estimate by only 17 MiB. Permit a small,
// explicit overdraft for the exact immediate-return pair instead of raising the
// global cache ceiling (which would retain unrelated spaces too).
const IMMEDIATE_RETURN_MODEL_OVERDRAFT_BYTES = 64 * MIB;
const TERMINAL_MODEL_BUDGET_16_GIB = 1 * GIB;
const TERMINAL_MODEL_BUDGET_32_GIB = 1.5 * GIB;
const TERMINAL_MODEL_BUDGET_48_GIB = 2 * GIB;
const TERMINAL_MODEL_BUDGET_64_GIB = 2.5 * GIB;
const PRESSURE_WRITE_LATENCY_MS = 80;
const SEVERE_WRITE_LATENCY_MS = 250;
const PRESSURE_BUFFERED_BYTES = MIB / 2;
const SEVERE_BUFFERED_BYTES = 2 * MIB;
/** 이 초과폭부터 활성-하나 붕괴 — 그 아래는 등급 축소(deriveWorkspaceCacheBudget). */
const SEVERE_CONTEXT_OVERSHOOT = 4;

/** Any overshoot past the hard cap already sits ~2 contexts from WKWebView's
 *  silent kill ceiling, and the catchup lane pauses during sustained
 *  interaction (up to the 10s starvation cap) — so ceiling enforcement must
 *  bypass the lane as soon as the cap is exceeded (bead 9390 deferred item).
 *  Live evidence showed a "severe" (+4) gate never fires: browser kills flip
 *  killed panes to "dom" before any decision reads the count, pinning it at
 *  13-14 through an entire kill storm (2026-08-06, 126 failures logged).
 *  Request-time predicate: static hard constant only; the graded budget
 *  stays reconcile-time-only. */
export function exceedsContextHardCap(liveWebglContexts: number): boolean {
	return liveWebglContexts > HARD_MAX_TERMINAL_SURFACES;
}

function modelByteCost(input: WorkspaceCacheSelection, id: string) {
  const surfaces = Math.max(0, Math.floor(input.terminalSurfaces[id] ?? 0));
  const measured = input.terminalModelBytes?.[id];
  // 미측정 = 미마운트(프리웜 후보). 만재 추정(DEFAULT)으로 계상하면 대형
  // 데스크탑이 admission에서 영영 거부돼 프리웜 교착이 된다 — 실체에 맞는
  // 프리웜 가격으로 계상하고, 마운트 후에는 측정값(표시 전 프리웜 클램프,
  // 표시 후 실가격)이 이어받는다.
  const bytes =
    measured === undefined
      ? surfaces * PREWARM_TERMINAL_MODEL_BYTES
      : Number.isFinite(measured)
        ? measured
        : Number.MAX_SAFE_INTEGER;
  return Math.max(
    0,
    Math.ceil(bytes),
  );
}

/** warm 티어 표면 청구 — 보이는 pane만(파킹 pane 제외), 폴백은 전체. */
function warmSurfaceCost(input: WorkspaceCacheSelection, id: string) {
  const full = Math.max(0, Math.floor(input.terminalSurfaces[id] ?? 0));
  const visible = input.visibleTerminalSurfaces?.[id];
  if (visible === undefined) return full;
  return Math.min(full, Math.max(0, Math.floor(visible)));
}

function gpuViewportByteCost(input: WorkspaceCacheSelection, id: string) {
  const surfaces = Math.max(0, Math.floor(input.terminalSurfaces[id] ?? 0));
  const measured = input.terminalGpuViewportBytes?.[id];
  const bytes =
    measured === undefined
      ? surfaces * DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES
      : Number.isFinite(measured)
        ? measured
        : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.ceil(bytes));
}

function rendererGpuViewportByteBudget(surfaceBudget: number) {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(1, surfaceBudget) * DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES,
  );
}

function retainedTerminalModelBudget(hardware: WorkspaceHardwareProfile) {
  const memoryBytes =
    hardware.physicalMemoryBytes ??
    (hardware.deviceMemoryGb === undefined
      ? undefined
      : hardware.deviceMemoryGb * GIB);
  if (memoryBytes === undefined || !Number.isFinite(memoryBytes)) {
    return TERMINAL_MODEL_FALLBACK_BUDGET_BYTES;
  }
  if (memoryBytes >= 64 * GIB) return TERMINAL_MODEL_BUDGET_64_GIB;
  if (memoryBytes >= 48 * GIB) return TERMINAL_MODEL_BUDGET_48_GIB;
  if (memoryBytes >= 32 * GIB) return TERMINAL_MODEL_BUDGET_32_GIB;
  if (memoryBytes >= 16 * GIB) return TERMINAL_MODEL_BUDGET_16_GIB;
  return TERMINAL_MODEL_FALLBACK_BUDGET_BYTES;
}

function previousActiveWorkspace(
  input: WorkspaceCacheSelection,
  valid: ReadonlySet<string>,
  active: string | undefined,
) {
  if (
    input.protectedRetainId &&
    valid.has(input.protectedRetainId) &&
    input.protectedRetainId !== active
  ) {
    return input.protectedRetainId;
  }
  return [...input.current]
    .reverse()
    .find((id) => valid.has(id) && id !== active);
}

function protectsImmediateModelReturn(
  input: WorkspaceCacheSelection,
  id: string,
  bytes: number,
  combinedBytes: number,
) {
  const retainedByteBudget = input.budget.retainedTerminalModelBytes;
  return (
    id === input.protectedRetainId &&
    input.budget.retainedWorkspaces >= 2 &&
    bytes <= retainedByteBudget &&
    combinedBytes <=
      retainedByteBudget + IMMEDIATE_RETURN_MODEL_OVERDRAFT_BYTES
  );
}

function median(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function transitionLatency(
  transition: WorkspacePerformanceSnapshot["transitions"][number],
) {
  return transition.firstTerminalPaintMs ?? transition.workspacePaintMs;
}

export function readWorkspaceHardwareProfile(): WorkspaceHardwareProfile {
  if (typeof navigator === "undefined") return {};
  const deviceNavigator = navigator as Navigator & { deviceMemory?: number };
  return {
    logicalCores: navigator.hardwareConcurrency || undefined,
    deviceMemoryGb: deviceNavigator.deviceMemory,
  };
}

export function deriveWorkspaceCacheBudget(
  hardware: WorkspaceHardwareProfile,
  performance: WorkspacePerformanceSnapshot,
  activeSpaceId?: string,
  contextLossStormActive = false,
): WorkspaceCacheBudget {
  const effectiveMemoryGb =
    hardware.physicalMemoryBytes === undefined
      ? hardware.deviceMemoryGb
      : hardware.physicalMemoryBytes / GIB;
  const lowResource =
    (hardware.logicalCores !== undefined && hardware.logicalCores <= 4) ||
    (effectiveMemoryGb !== undefined && effectiveMemoryGb <= 4);
  // WebKit(Tauri WKWebView)은 navigator.deviceMemory를 지원하지 않는다 —
  // 메모리 미상은 결격 사유가 아니라 "코어 수로 판정"으로 처리해야 한다.
  // 이걸 0으로 접으면 실기기에서 고사양 머신이 전부 balanced로 강등되어,
  // 터미널 많은 데스크탑 두 개가 surface 예산(7)에서 서로를 evict하고
  // A↔B 왕복마다 pane이 initial attach부터 다시 시작한다.
  const highResource =
    (hardware.logicalCores ?? 0) >= 12 &&
    (effectiveMemoryGb === undefined || effectiveMemoryGb >= 12);

  const baseline: WorkspaceCacheBudget = lowResource
      ? {
          maxWorkspaces: 2,
          maxTerminalSurfaces: 4,
          retainedWorkspaces: 2,
          retainedTerminalModelBytes: retainedTerminalModelBudget(hardware),
          reason: "low-resource",
        }
      : highResource
      ? {
          maxWorkspaces: 6,
          maxTerminalSurfaces: HARD_MAX_TERMINAL_SURFACES,
          retainedWorkspaces: HARD_MAX_WORKSPACES,
          retainedTerminalModelBytes: retainedTerminalModelBudget(hardware),
          reason: "high-resource",
        }
      : {
          maxWorkspaces: 4,
          maxTerminalSurfaces: 7,
          retainedWorkspaces: 4,
          retainedTerminalModelBytes: retainedTerminalModelBudget(hardware),
          reason: "balanced",
        };
  let budget = baseline;

  // A lone busy background pane must not collapse the whole cache: only the
  // desktop the user is looking at, or genuinely widespread pressure (most
  // surfaces struggling at once), shrinks the warm budget. Idle hidden
  // surfaces draw nothing, so their panes' backlog is not a render cost here.
  // Unavailable pressure cannot justify evicting a retained Workspace shell.
  const surfaces = performance.render?.perSurface ?? [];
  const activeSurfaces =
    activeSpaceId === undefined
      ? surfaces
      : surfaces.filter((surface) => surface.desktopId === activeSpaceId);
  const activeMaxWriteLatencyMs = activeSurfaces.reduce(
    (latency, surface) => Math.max(latency, surface.writeLatencyMs),
    0,
  );
  const activeBufferedBytes = activeSurfaces.reduce(
    (total, surface) => total + surface.bufferedBytes,
    0,
  );
  const pressuredSurfaces = surfaces.filter(
    (surface) =>
      surface.writeLatencyMs >= PRESSURE_WRITE_LATENCY_MS ||
      surface.bufferedBytes >= PRESSURE_BUFFERED_BYTES,
  ).length;
  const widespreadPressure =
    pressuredSurfaces >= 2 && pressuredSurfaces * 2 >= surfaces.length;

  // 활성 하나만 남기는 붕괴는 렌더러 컨텍스트가 실제로 상한을 넘었을 때만
  // 정당하다. 그 경우에만 렌더러를 버리는 것이 원인을 직접 줄인다.
  //
  // 쓰기 지연·버퍼는 xterm write 처리량의 문제라, 숨은 데스크탑의 WebGL을
  // 버려도 backlog는 한 바이트도 줄지 않는다. 실측(qa.log 2026-08-02): 활성
  // 데스크탑의 터미널 하나가 285KB를 버퍼링하는 동안 예산이 severe로 접히면서
  // 다른 데스크탑 렌더러 5개가 파괴됐고, 복귀 때 pane당 ~85ms를 다시 냈다.
  // 그동안 pane은 DOM 렌더러로 그려지는데 셀 폭이 달라(7.73px 대 7.5px)
  // 격자가 눈에 띄게 흔들린다. 그래서 쓰기 압력은 성장만 멈춘다.
  // 초과폭에 비례해 대응한다 — 1-2개 초과(전환 중 승격·지연 회수의 일시
  // 상태)에 활성 하나만 남기는 절벽은 과잉이다. 실측(2026-08-03): 16>14가
  // 붕괴를 영구 latch해 warm 티어가 활성 1개로 고정됐고, A↔B 즉시 복귀
  // 예외까지 꺼져 모든 전환이 model 티어(median 2800ms, renderer 262ms)로
  // 떨어졌다. 등급 축소도 이웃을 파킹해 컨텍스트를 단조 감소시키므로
  // fail-closed 방향은 유지된다. 큰 초과(≥4)는 WKWebView 무음 컨텍스트
  // 킬 위험이 실재하므로 기존 붕괴를 그대로 밟는다(2026-08-02 감사).
  // An active kill storm is proof the PAGE ceiling is exceeded even while
  // the registry count reads <= 14 (kills flip panes to "dom" before any
  // reader sees them; 2026-08-06 live data). Grade it as one overshoot step
  // so the warm tier actually shrinks demand — without this, the storm-edge
  // urgent reconcile computed sameTiers and only retry suppression remained,
  // oscillating storm -> cooldown -> re-promotion -> re-kill.
  const contextOvershoot = Math.max(
    0,
    performance.totals.webglContexts - HARD_MAX_TERMINAL_SURFACES,
    contextLossStormActive ? 1 : 0,
  );
  const overRendererBudget = contextOvershoot > 0;
  const severeContextOvershoot = contextOvershoot >= SEVERE_CONTEXT_OVERSHOOT;
  const severeWritePressure =
    activeBufferedBytes >= SEVERE_BUFFERED_BYTES ||
    activeMaxWriteLatencyMs >= SEVERE_WRITE_LATENCY_MS;
  const pressure =
    severeWritePressure ||
    overRendererBudget ||
    activeBufferedBytes >= PRESSURE_BUFFERED_BYTES ||
    activeMaxWriteLatencyMs >= PRESSURE_WRITE_LATENCY_MS ||
    widespreadPressure;
  if (pressure) {
    const severePressure = severeContextOvershoot;
    const maxWorkspaces = severePressure ? 1 : Math.max(2, budget.maxWorkspaces - 1);
    const maxTerminalSurfaces = severePressure
      ? Math.max(1, Math.min(4, budget.maxTerminalSurfaces))
      : overRendererBudget
        ? Math.max(4, budget.maxTerminalSurfaces - contextOvershoot * 2)
        : Math.max(3, budget.maxTerminalSurfaces - 2);
    // Context pressure shrinks the shell set selected for fast activation. A
    // hidden shell already owns no terminal subtree, so this never tears down a
    // renderer, model, observer, PTY, or Host.
    return {
      maxWorkspaces,
      maxTerminalSurfaces,
      retainedWorkspaces: budget.retainedWorkspaces,
      retainedTerminalModelBytes: budget.retainedTerminalModelBytes,
      reason: severePressure ? "severe-pressure" : "pressure",
    };
  }

  if (!lowResource && !highResource) {
    const completed = performance.transitions
      .map((transition) => ({
        warm: transition.warm,
        latency: transitionLatency(transition),
      }))
      .filter(
        (sample): sample is { warm: boolean; latency: number } =>
          sample.latency !== null,
      );
    const warm = completed.filter((sample) => sample.warm).map((sample) => sample.latency);
    const cold = completed.filter((sample) => !sample.warm).map((sample) => sample.latency);
    const warmMedian = warm.length >= 3 ? median(warm.slice(-8)) : null;
    const coldMedian = cold.length >= 3 ? median(cold.slice(-8)) : null;
    if (
      warmMedian !== null &&
      coldMedian !== null &&
      coldMedian >= 120 &&
      warmMedian <= coldMedian * 0.7
    ) {
      const maxWorkspaces = Math.min(HARD_MAX_WORKSPACES, budget.maxWorkspaces + 1);
      const maxTerminalSurfaces = Math.min(
        HARD_MAX_TERMINAL_SURFACES,
        budget.maxTerminalSurfaces + 2,
      );
      budget = {
        maxWorkspaces,
        maxTerminalSurfaces,
        retainedWorkspaces: Math.max(budget.retainedWorkspaces, maxWorkspaces),
        retainedTerminalModelBytes: budget.retainedTerminalModelBytes,
        reason: "observed-benefit",
      };
    }
  }

  return budget;
}

export function estimateTerminalSurfaces(layout: unknown) {
  return panelsFromLayout(layout).filter(
    (panel) =>
      panel.component === "terminal" || panel.component === "agent",
  ).length;
}

/**
 * Select an LRU warm-shell set under workspace and projected activation costs.
 * The active workspace is always retained even when it alone exceeds a budget.
 */
export function selectWorkspaceCache(input: WorkspaceCacheSelection): string[] {
  const valid = new Set(input.valid);
  const active = input.active && valid.has(input.active) ? input.active : undefined;
  const recency = input.current.filter((id) => valid.has(id) && id !== active);
  // `current` is LRU-ordered and every reconciliation moves the then-active
  // desktop to its tail. On the next activation, its newest non-active entry
  // is therefore the desktop the user just left — the most likely immediate
  // return target. Frequency/prewarm hints may promote older entries, but must
  // not demote this real visit and turn an A→B→A bounce into a cold remount.
  const previousActive = previousActiveWorkspace(input, valid, active);

  for (const id of input.warmCandidates ?? []) {
    if (!valid.has(id) || id === active) continue;
    const previous = recency.indexOf(id);
    if (previous >= 0) recency.splice(previous, 1);
    recency.push(id);
  }
  if (previousActive) {
    const previous = recency.indexOf(previousActive);
    if (previous >= 0) recency.splice(previous, 1);
    recency.push(previousActive);
  }
  if (active) recency.push(active);

  const selected = new Set<string>();
  let surfaces = 0;
  let gpuViewportBytes = 0;
  const byteBudget = rendererGpuViewportByteBudget(
    input.budget.maxTerminalSurfaces,
  );
  for (let index = recency.length - 1; index >= 0; index -= 1) {
    const id = recency[index];
    const cost = warmSurfaceCost(input, id);
    const bytes = gpuViewportByteCost(input, id);
    if (id === active) {
      selected.add(id);
      surfaces += cost;
      gpuViewportBytes += bytes;
      continue;
    }
    // A→B→A 복귀 대상은 표면 수 상한에서 한 번의 예외를 받는다. 모델 tier가
    // 이미 같은 예외를 갖는데(protectsImmediateModelReturn) 렌더러에는 없어서,
    // 표면이 많은 두 데스크탑을 오갈 때마다 직전 데스크탑의 WebGL이 파괴되고
    // 복귀 시 재생성됐다. 재생성은 pane당 ~85ms이고, 그 사이 pane은 DOM
    // 렌더러로 그려지는데 셀 폭이 WebGL과 달라(7.73px 대 7.5px) 격자와 여백이
    // 눈에 띄게 흔들린다. GPU 바이트 예산은 그대로 지키므로 실제 메모리
    // 상한은 달라지지 않고, 압력 예산 아래에서는 예외를 쓰지 않는다.
    // 일반 pressure에서는 예외를 유지한다. 실측(qa.log 2026-08-02): 터미널이
    // 출력할 때마다 write latency로 pressure에 들락거렸고, 그때마다 직전
    // 데스크탑의 WebGL이 파괴/재생성되며 전환이 깜빡였다. 숨은 렌더러를 버려도
    // 활성 표면의 write latency는 줄지 않는다. severe에서는 예외를 포기한다.
    const immediateReturn =
      id === previousActive &&
      selected.has(active ?? "") &&
      input.budget.reason !== "severe-pressure";
    if (selected.size >= Math.max(1, input.budget.maxWorkspaces)) continue;
    // immediateReturn은 "직전 활성 왕복은 깜빡이지 않게" 공정성 캡만
    // 우회한다 — surface 수의 절대 상한은 넘지 못한다. 상한은 WKWebView의
    // 페이지 단위 WebGL context ceiling 여유분이라, 넘으면 브라우저가
    // 임의(LRU) 컨텍스트를 조용히 죽여 다른 pane이 DOM 렌더러로 떨어진다
    // (2026-08-02 렉 감사: 10-pane 데스크탑 2개 왕복이 ~20 context 승인).
    if (surfaces + cost > Math.max(1, input.budget.maxTerminalSurfaces)) {
      if (!immediateReturn) continue;
      if (surfaces + cost > HARD_MAX_TERMINAL_SURFACES) continue;
    }
    if (gpuViewportBytes + bytes > byteBudget) continue;
    selected.add(id);
    surfaces += cost;
    gpuViewportBytes += bytes;
  }

  return recency.filter((id) => selected.has(id));
}

export interface WorkspaceCacheTiers {
  /** Mounted spaces in recency order (includes every warm and frozen id). */
  mounted: readonly string[];
  /** Shells selected for the fastest activation path. */
  warm: readonly string[];
  /**
   * Mounted but hidden shells outside the warm tier. Their terminal presentation
   * is already unmounted; only Dockview and non-terminal pane state remain.
   */
  frozen: readonly string[];
}

/** Content-free projection of the cache authority's applied decision. */
export function describeWorkspaceCacheDecision(
  input: WorkspaceCacheSelection,
  tiers: WorkspaceCacheTiers,
): WorkspaceCacheDecisionSnapshot {
  const occupancy = (ids: readonly string[]) => ({
    workspaces: ids.length,
    projectedTerminalSurfaces: ids.reduce(
      (total, id) =>
        total + Math.max(0, Math.floor(input.terminalSurfaces[id] ?? 0)),
      0,
    ),
    projectedTerminalModelBytes: ids.reduce(
      (total, id) => total + modelByteCost(input, id),
      0,
    ),
  });
  return {
    budget: { ...input.budget },
    occupancy: {
      total: occupancy(tiers.mounted),
      warm: occupancy(tiers.warm),
      frozen: occupancy(tiers.frozen),
    },
  };
}

/**
 * Prewarm is speculative and must never trade an already-mounted workspace for
 * its candidate. Only real user activation may cross the discard boundary.
 * Accept a prewarm result solely when it is a strict mounted-set expansion.
 */
export function acceptWorkspacePrewarmTiers(
  current: WorkspaceCacheTiers,
  candidate: WorkspaceCacheTiers,
): WorkspaceCacheTiers {
  if (candidate.mounted.length <= current.mounted.length) return current;
  const candidateMounted = new Set(candidate.mounted);
  if (!current.mounted.every((id) => candidateMounted.has(id))) return current;
  // Speculation may consume spare shell capacity, but it must not demote an
  // existing warm shell. A later real activation may rebalance the tier.
  const candidateWarm = new Set(candidate.warm);
  return current.warm.every((id) => candidateWarm.has(id)) ? candidate : current;
}

/**
 * Two-tier selection: the warm tier follows the (possibly pressure-shrunk)
 * budget; the frozen tier then retains already-mounted spaces in the
 * capacity the retained caps leave after the warm tier's usage. Explicit
 * retainCandidates may then mount as frozen, but only after every admissible
 * current workspace, so speculative prewarm cannot evict live state.
 */
export function selectWorkspaceCacheTiers(
  input: WorkspaceCacheSelection,
): WorkspaceCacheTiers {
  const rendererWarm = selectWorkspaceCache(input);
  // Admit warm-shell candidates first, then apply the retained-shell cap using
  // the projected model cost. Hidden shells do not own terminal surfaces, so
  // charging their pane count here only creates a second, proxy budget.
  const retainedWarm = new Set<string>();
  let retainedWarmModelBytes = 0;
  for (let index = rendererWarm.length - 1; index >= 0; index -= 1) {
    const id = rendererWarm[index];
    const bytes = modelByteCost(input, id);
    const combinedBytes = retainedWarmModelBytes + bytes;
    const active = id === input.active;
    if (!active) {
      if (retainedWarm.size >= Math.max(1, input.budget.retainedWorkspaces)) {
        continue;
      }
      if (
        combinedBytes > input.budget.retainedTerminalModelBytes &&
        !protectsImmediateModelReturn(
          input,
          id,
          bytes,
          combinedBytes,
        )
      ) {
        continue;
      }
    }
    retainedWarm.add(id);
    retainedWarmModelBytes = combinedBytes;
  }
  const warm = rendererWarm.filter((id) => retainedWarm.has(id));
  const warmSet = new Set(warm);
  const valid = new Set(input.valid);
  const retainedByteBudget = input.budget.retainedTerminalModelBytes;
  const protectedPrevious =
    input.protectedRetainId &&
    valid.has(input.protectedRetainId) &&
    input.protectedRetainId !== input.active
      ? input.protectedRetainId
      : undefined;

  let workspaces = warm.length;
  let modelBytes = warm.reduce(
    (total, id) => total + modelByteCost(input, id),
    0,
  );
  const frozenSet = new Set<string>();
  // The real A→B→A return target gets one bounded exception from the combined
  // retention total. A heavy active B may otherwise consume just enough of the
  // byte cap to discard A even though each desktop is individually admissible.
  // Count A normally after admission so older/speculative spaces cannot pile
  // onto the exception; the workspace and byte limits remain authoritative.
  if (
    protectedPrevious &&
    !warmSet.has(protectedPrevious) &&
    input.budget.retainedWorkspaces >= 2
  ) {
    const bytes = modelByteCost(input, protectedPrevious);
    if (
      protectsImmediateModelReturn(
        input,
        protectedPrevious,
        bytes,
        modelBytes + bytes,
      )
    ) {
      frozenSet.add(protectedPrevious);
      workspaces += 1;
      modelBytes += bytes;
    }
  }
  for (let index = input.current.length - 1; index >= 0; index -= 1) {
    const id = input.current[index];
    if (!valid.has(id) || warmSet.has(id) || frozenSet.has(id)) continue;
    if (workspaces >= Math.max(1, input.budget.retainedWorkspaces)) continue;
    const bytes = modelByteCost(input, id);
    if (modelBytes + bytes > retainedByteBudget) continue;
    frozenSet.add(id);
    workspaces += 1;
    modelBytes += bytes;
  }

  const newlyRetained: string[] = [];
  for (const id of input.retainCandidates ?? []) {
    if (
      !valid.has(id) ||
      warmSet.has(id) ||
      frozenSet.has(id) ||
      input.current.includes(id)
    ) {
      continue;
    }
    if (workspaces >= Math.max(1, input.budget.retainedWorkspaces)) continue;
    const bytes = modelByteCost(input, id);
    if (modelBytes + bytes > retainedByteBudget) continue;
    frozenSet.add(id);
    newlyRetained.push(id);
    workspaces += 1;
    modelBytes += bytes;
  }

  const mounted = input.current.filter((id) => warmSet.has(id) || frozenSet.has(id));
  mounted.push(...newlyRetained);
  // `warm` is already ordered by the reconciled recency list: warm candidates
  // move forward and the active desktop is newest. Reapply that ordering even
  // when those ids were mounted before, otherwise the two-tier wrapper would
  // silently preserve stale input order and later freeze/discard a recently
  // visited desktop.
  for (const id of warm) {
    const previous = mounted.indexOf(id);
    if (previous >= 0) mounted.splice(previous, 1);
    mounted.push(id);
  }
  return {
    mounted,
    warm,
    frozen: mounted.filter((id) => frozenSet.has(id)),
  };
}
