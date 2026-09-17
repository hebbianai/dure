import { describe, expect, it } from "vitest";
import {
  acceptWorkspacePrewarmTiers,
  describeWorkspaceCacheDecision,
  deriveWorkspaceCacheBudget,
  estimateTerminalSurfaces,
  exceedsContextHardCap,
  selectWorkspaceCache,
  selectWorkspaceCacheTiers,
  type WorkspaceCacheBudget,
  type WorkspaceCacheTiers,
} from "@/lib/workspace/performance/workspaceCachePolicy";
import {
  DEFAULT_TERMINAL_MODEL_BYTES,
	PREWARM_TERMINAL_MODEL_BYTES,
  TERMINAL_MODEL_FALLBACK_BUDGET_BYTES,
} from "@/lib/workspace/performance/terminalResourceBudget";
import type {
  WorkspacePerformanceSnapshot,
  WorkspaceSurfaceRenderPressure,
  WorkspaceTransitionSample,
} from "@/lib/workspace/performance/workspacePerformance";
import { emptyStructuredTerminalPresentationSnapshot } from "@/lib/workspace/performance/structuredTerminalPresentationPerformance";

function performanceSnapshot(
  overrides: Partial<WorkspacePerformanceSnapshot> = {},
): WorkspacePerformanceSnapshot {
  return {
    transitions: [],
    terminalAttaches: [],
    terminalAttachIntegrity: {
      duplicatePhaseEvents: 0,
      missingPredecessorEvents: 0,
    },
    paneOpens: [],
    agentReady: [],
    workspaces: [],
    totals: {
      mountedWorkspaces: 0,
      terminalSurfaces: 0,
      webglContexts: 0,
      hmuxObservers: 0,
    },
    render: {
      bufferedBytes: 0,
      peakBufferedBytes: 0,
      maxRecentWriteLatencyMs: 0,
      perSurface: [],
    },
    terminalPresentation: emptyStructuredTerminalPresentationSnapshot(),
    ...overrides,
  };
}

function surface(
  overrides: Partial<WorkspaceSurfaceRenderPressure> = {},
): WorkspaceSurfaceRenderPressure {
  return {
    id: "surface-1",
    desktopId: "desktop-1",
    writeLatencyMs: 0,
    bufferedBytes: 0,
    ...overrides,
  };
}

function renderWith(perSurface: readonly WorkspaceSurfaceRenderPressure[]) {
  return {
    bufferedBytes: perSurface.reduce((total, s) => total + s.bufferedBytes, 0),
    peakBufferedBytes: 0,
    maxRecentWriteLatencyMs: perSurface.reduce(
      (max, s) => Math.max(max, s.writeLatencyMs),
      0,
    ),
    perSurface,
  };
}

const GIB = 1024 ** 3;
const MIB = 1024 * 1024;

/** Registry totals sitting exactly at the 14-surface renderer cap. */
function totalsAtCap(
  overrides: Partial<WorkspacePerformanceSnapshot["totals"]> = {},
): WorkspacePerformanceSnapshot["totals"] {
  return {
    mountedWorkspaces: 4,
    terminalSurfaces: 14,
    webglContexts: 14,
    hmuxObservers: 4,
    ...overrides,
  };
}

/** Caps in order: [maxWorkspaces, maxTerminalSurfaces, retainedWorkspaces]. */
function cacheBudget(
  reason: WorkspaceCacheBudget["reason"],
  caps: readonly [number, number, number],
  retainedTerminalModelBytes = TERMINAL_MODEL_FALLBACK_BUDGET_BYTES,
): WorkspaceCacheBudget {
  const [maxWorkspaces, maxTerminalSurfaces, retainedWorkspaces] = caps;
  return {
    maxWorkspaces,
    maxTerminalSurfaces,
    retainedWorkspaces,
    retainedTerminalModelBytes,
    reason,
  };
}

/** A→B return trip: a six-pane previous desktop beside the fresh active one. */
function returnTripSelection(input: {
  budget: WorkspaceCacheBudget;
  activeSurfaces?: number;
  previousGpuViewportBytes?: number;
}) {
  return {
    current: ["previous"],
    valid: ["previous", "active"],
    active: "active",
    terminalSurfaces: { previous: 6, active: input.activeSurfaces ?? 4 },
    terminalGpuViewportBytes: {
      previous: input.previousGpuViewportBytes ?? 20 * MIB,
      active: 22 * MIB,
    },
    budget: input.budget,
  };
}

/** Tier snapshot in declaration order: mounted, warm, frozen. */
function cacheTiers(
  mounted: readonly string[],
  warm: readonly string[],
  frozen: readonly string[],
): WorkspaceCacheTiers {
  return { mounted, warm, frozen };
}

function transitions(warm: boolean, values: readonly number[]): WorkspaceTransitionSample[] {
  return values.map((value, index) => ({
    sequence: index + 1,
    desktopId: `desktop-${warm ? "warm" : "cold"}-${index}`,
    cacheState: warm ? "renderer" : "cold",
    warm,
    startedAt: 0,
    workspaceCommitMs: null,
    workspaceCommitMicrotaskMs: null,
    workspaceCommitMessageTaskMs: null,
    workspaceFirstFrameMs: null,
    workspacePaintMs: value,
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
  }));
}

/** Repeated cold-vs-warm paint samples proving a measured warm-cache benefit. */
const WARM_BENEFIT_TRANSITIONS = [
  ...transitions(false, [310, 280, 330]),
  ...transitions(true, [70, 65, 80]),
];

describe("exceedsContextHardCap", () => {
  it("hard cap(14) 경계에서 갈린다 — 초과는 곧 kill zone ~2 이내", () => {
    // At the cap: within budget, an urgent kernel has nothing to demote.
    expect(exceedsContextHardCap(14)).toBe(false);
    // One past the cap: graded shrink has work — bypass the paused lane.
    expect(exceedsContextHardCap(15)).toBe(true);
    expect(exceedsContextHardCap(0)).toBe(false);
    expect(exceedsContextHardCap(30)).toBe(true);
  });
});

describe("deriveWorkspaceCacheBudget", () => {
  it("does not infer render pressure from unavailable measurements", () => {
    expect(
      deriveWorkspaceCacheBudget(
        { logicalCores: 16, deviceMemoryGb: 16 },
        performanceSnapshot({ render: null }),
      ),
    ).toMatchObject({
      maxWorkspaces: 6,
      maxTerminalSurfaces: 14,
      reason: "high-resource",
    });
  });

  it("uses conservative and high-resource baselines", () => {
    expect(
      deriveWorkspaceCacheBudget(
        { logicalCores: 4, deviceMemoryGb: 4 },
        performanceSnapshot(),
      ),
    ).toMatchObject({
      maxWorkspaces: 2,
      maxTerminalSurfaces: 4,
      reason: "low-resource",
    });
    expect(
      deriveWorkspaceCacheBudget(
        { logicalCores: 16, deviceMemoryGb: 16 },
        performanceSnapshot(),
      ),
    ).toMatchObject({
      maxWorkspaces: 6,
      maxTerminalSurfaces: 14,
      reason: "high-resource",
    });
    // WebKit은 deviceMemory를 노출하지 않는다 — 메모리 미상 + 다코어는
    // 고사양으로 판정되어야 실기기에서 예산이 강등되지 않는다.
    expect(
      deriveWorkspaceCacheBudget({ logicalCores: 16 }, performanceSnapshot()),
    ).toMatchObject({
      maxWorkspaces: 6,
      retainedTerminalModelBytes: TERMINAL_MODEL_FALLBACK_BUDGET_BYTES,
      reason: "high-resource",
    });
  });

  it("scales only frozen terminal models with physical RAM", () => {
    const cases = [
      [8, 0.75],
      [16, 1],
      [32, 1.5],
      [48, 2],
      [64, 2.5],
      [96, 2.5],
    ] as const;
    for (const [physicalMemoryGiB, expectedBudgetGiB] of cases) {
      const budget = deriveWorkspaceCacheBudget(
        {
          logicalCores: 16,
          physicalMemoryBytes: physicalMemoryGiB * GIB,
        },
        performanceSnapshot(),
      );
      expect(budget.retainedTerminalModelBytes).toBe(expectedBudgetGiB * GIB);
      expect(budget.maxTerminalSurfaces).toBeLessThanOrEqual(14);
    }
  });

  it("prefers native physical RAM over a privacy-capped browser hint", () => {
    expect(
      deriveWorkspaceCacheBudget(
        {
          logicalCores: 16,
          deviceMemoryGb: 4,
          physicalMemoryBytes: 48 * GIB,
        },
        performanceSnapshot(),
      ),
    ).toMatchObject({
      maxTerminalSurfaces: 14,
      retainedTerminalModelBytes: 2 * GIB,
      reason: "high-resource",
    });
  });

  it("uses a 48 GiB model budget while accounting warm renderers by viewport", () => {
    const surfaces = { hebbian: 10, gate: 5, hft: 5, agents: 3 };
    const budget = deriveWorkspaceCacheBudget(
      {
        logicalCores: 16,
        physicalMemoryBytes: 48 * GIB,
      },
      performanceSnapshot(),
      "agents",
    );
    const tiers = selectWorkspaceCacheTiers({
      current: ["hebbian", "gate", "hft"],
      valid: ["hebbian", "gate", "hft", "agents"],
      active: "agents",
      terminalSurfaces: surfaces,
      terminalModelBytes: {
        hebbian: 600 * MIB,
        gate: 500 * MIB,
        hft: 500 * MIB,
        agents: 200 * MIB,
      },
      budget,
    });

    expect(tiers).toEqual(
      cacheTiers(
        ["hebbian", "gate", "hft", "agents"],
        ["gate", "hft", "agents"],
        ["hebbian"],
      ),
    );
    const rendererSurfaces = tiers.warm.reduce(
      (total, id) => total + surfaces[id as keyof typeof surfaces],
      0,
    );
    expect(rendererSurfaces).toBeLessThanOrEqual(14);
  });

  it("shrinks but does not collapse the warm tier under active write pressure", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16, deviceMemoryGb: 16 },
      performanceSnapshot({
        render: renderWith([
          surface({ desktopId: "desktop-1", writeLatencyMs: 300, bufferedBytes: 2 * 1024 * 1024 }),
        ]),
      }),
      "desktop-1",
    );
    // 쓰기 압력은 성장을 멈출 뿐 이미 살아 있는 렌더러를 뺏지 않는다. 숨은
    // 데스크탑의 WebGL을 버려도 활성 표면의 write backlog는 줄지 않는데, 복귀
    // 때 pane당 ~85ms와 DOM 렌더러의 다른 셀 폭을 그대로 물어야 한다
    // (실측: qa.log 2026-08-02).
    expect(budget).toEqual(cacheBudget("pressure", [5, 12, 12], 1 * GIB));
  });

  it("ignores a lone busy background pane — the active desktop's budget survives", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16, deviceMemoryGb: 16 },
      performanceSnapshot({
        render: renderWith([
          surface({
            id: "bg",
            desktopId: "desktop-2",
            writeLatencyMs: 400,
            bufferedBytes: 3 * 1024 * 1024,
          }),
          surface({ id: "fg", desktopId: "desktop-1", writeLatencyMs: 12 }),
          surface({ id: "fg2", desktopId: "desktop-1" }),
        ]),
      }),
      "desktop-1",
    );
    expect(budget).toEqual(cacheBudget("high-resource", [6, 14, 12], 1 * GIB));
  });

  it("uses the full bounded renderer budget without treating capacity as pressure", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16, deviceMemoryGb: 16 },
      performanceSnapshot({ totals: totalsAtCap() }),
      "desktop-1",
    );
    expect(budget).toEqual(cacheBudget("high-resource", [6, 14, 12], 1 * GIB));
  });

  it("kill 폭풍은 카운트가 상한 이하여도 초과 1단계로 계상된다", () => {
    // Kills flip panes to "dom" before any reader sees them, pinning the
    // registry count at 13-14 through a storm (2026-08-06 live data) — the
    // storm flag substitutes the invisible page-ceiling overshoot so the
    // warm tier actually sheds demand.
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16, deviceMemoryGb: 16 },
      performanceSnapshot({ totals: totalsAtCap({ webglContexts: 13 }) }),
      "desktop-1",
      true,
    );
    expect(budget).toMatchObject({
      maxWorkspaces: 5,
      maxTerminalSurfaces: 12,
      reason: "pressure",
    });
  });

  it("작은 컨텍스트 초과는 등급 축소 — 활성-하나 절벽 금지", () => {
    // 초과 1(15>14)이 활성 하나만 남기면 warm 티어 붕괴가 latch돼 모든
    // 전환이 model 티어로 떨어진다(2026-08-03 실측 median 2800ms). 초과폭
    // ×2만큼 표면 예산을 줄여 이웃 파킹으로 단조 감소시킨다.
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16, deviceMemoryGb: 16 },
      performanceSnapshot({
        totals: totalsAtCap({ terminalSurfaces: 15, webglContexts: 15 }),
      }),
      "desktop-1",
    );
    expect(budget).toEqual(cacheBudget("pressure", [5, 12, 12], 1 * GIB));
  });

  it("큰 컨텍스트 초과(≥4)는 기존 활성-하나 붕괴 유지 — WKWebView 무음 킬 방어", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16, deviceMemoryGb: 16 },
      performanceSnapshot({
        totals: totalsAtCap({ terminalSurfaces: 18, webglContexts: 18 }),
      }),
      "desktop-1",
    );
    expect(budget).toEqual(cacheBudget("severe-pressure", [1, 4, 12], 1 * GIB));
  });

  it("still shrinks when pressure is widespread across surfaces", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16, deviceMemoryGb: 16 },
      performanceSnapshot({
        render: renderWith([
          surface({ id: "bg1", desktopId: "desktop-2", writeLatencyMs: 120 }),
          surface({ id: "bg2", desktopId: "desktop-3", writeLatencyMs: 150 }),
          surface({ id: "fg", desktopId: "desktop-1" }),
        ]),
      }),
      "desktop-1",
    );
    expect(budget).toEqual(cacheBudget("pressure", [5, 12, 12], 1 * GIB));
  });

  it("grows only after repeated measured warm-cache benefit", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 8, deviceMemoryGb: 8 },
      performanceSnapshot({ transitions: WARM_BENEFIT_TRANSITIONS }),
    );
    expect(budget).toEqual(cacheBudget("observed-benefit", [5, 9, 5]));
  });

  it("keeps the high-resource baseline stable at the renderer cap", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16, deviceMemoryGb: 16 },
      performanceSnapshot({
        transitions: WARM_BENEFIT_TRANSITIONS,
        totals: totalsAtCap(),
      }),
    );
    expect(budget).toEqual(cacheBudget("high-resource", [6, 14, 12], 1 * GIB));
  });

  it("discards parked models that exceed the byte budget even without extra WebGL", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16 },
      performanceSnapshot({
        totals: totalsAtCap({ mountedWorkspaces: 1, hmuxObservers: 7 }),
      }),
      "b",
    );

    expect(
      selectWorkspaceCacheTiers({
        current: ["a"],
        valid: ["a", "b"],
        active: "b",
        terminalSurfaces: { a: 10, b: 10 },
        // 프리웜 가격 도입 후 상한은 측정값이 지배한다 — 방문 후 실가격.
        terminalModelBytes: { a: 500 * MIB, b: 400 * MIB },
        budget,
      }),
    ).toEqual(cacheTiers(["b"], ["b"], []));
  });

  it("keeps the live ten-pane desktop warm beside a three-pane active desktop", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16 },
      performanceSnapshot(),
      "main",
    );

    expect(
      selectWorkspaceCacheTiers({
        current: ["other", "main", "hebbian"],
        valid: ["other", "main", "hebbian"],
        active: "main",
        terminalSurfaces: { other: 1, main: 3, hebbian: 10 },
        budget,
      }),
    ).toEqual(
      cacheTiers(["other", "hebbian", "main"], ["other", "hebbian", "main"], []),
    );
  });
});

describe("selectWorkspaceCache", () => {
  it("does not charge large scrollback models to the warm renderer budget", () => {
    const input = {
      current: ["previous"],
      valid: ["previous", "active"],
      active: "active",
      terminalSurfaces: { previous: 1, active: 1 },
      terminalModelBytes: { previous: 700 * MIB, active: 500 * MIB },
      terminalGpuViewportBytes: { previous: 8 * MIB, active: 8 * MIB },
      budget: cacheBudget("high-resource", [2, 2, 2], 2048 * MIB),
    };

    expect(selectWorkspaceCache(input)).toEqual(["previous", "active"]);
  });

  it("immediateReturn도 절대 surface 상한(14)은 넘지 못한다 — context ceiling 보호", () => {
    // 10-pane 데스크탑 2개의 A→B→A 왕복이 ~20 컨텍스트로 승인되면 WKWebView가
    // LRU 컨텍스트를 조용히 죽여 다른 pane이 DOM 렌더러로 떨어진다
    // (2026-08-02 렉 감사). 공정성 캡 우회는 유지하되 절대 상한은 지킨다.
    const input = {
      current: ["previous", "active"],
      valid: ["previous", "active"],
      active: "active",
      protectedRetainId: "previous",
      terminalSurfaces: { previous: 10, active: 10 },
      terminalModelBytes: { previous: 100 * MIB, active: 100 * MIB },
      terminalGpuViewportBytes: { previous: 40 * MIB, active: 40 * MIB },
      budget: cacheBudget("high-resource", [12, 14, 12], 2048 * MIB),
    };
    // 활성(10) + 직전(10) = 20 > 14 — 직전은 immediateReturn이어도 탈락.
    expect(selectWorkspaceCache(input)).toEqual(["active"]);
  });

  it("rejects an inactive renderer whose measured GPU viewport exceeds the budget", () => {
    const input = {
      current: ["oversized"],
      valid: ["oversized", "active"],
      active: "active",
      terminalSurfaces: { oversized: 1, active: 1 },
      terminalModelBytes: { oversized: MIB, active: MIB },
      terminalGpuViewportBytes: { oversized: 512 * MIB, active: 8 * MIB },
      budget: cacheBudget("high-resource", [2, 2, 2], 2048 * MIB),
    };

    expect(selectWorkspaceCache(input)).toEqual(["active"]);
  });

  it("always retains the active workspace even above surface and byte budgets", () => {
    expect(
      selectWorkspaceCache({
        current: ["a", "b", "c"],
        valid: ["a", "b", "c"],
        active: "c",
        terminalSurfaces: { a: 1, b: 1, c: 6 },
        terminalModelBytes: {
          a: DEFAULT_TERMINAL_MODEL_BYTES,
          b: DEFAULT_TERMINAL_MODEL_BYTES,
          c: TERMINAL_MODEL_FALLBACK_BUDGET_BYTES * 2,
        },
        budget: cacheBudget("low-resource", [2, 4, 2]),
      }),
    ).toEqual(["c"]);
  });

  it("treats a non-finite inactive GPU viewport estimate as over budget", () => {
    expect(
      selectWorkspaceCache({
        current: ["stale", "active"],
        valid: ["stale", "active"],
        active: "active",
        terminalSurfaces: { stale: 1, active: 1 },
        terminalGpuViewportBytes: { stale: Number.NaN, active: 1024 },
        budget: cacheBudget("balanced", [2, 2, 2]),
      }),
    ).toEqual(["active"]);
  });

  it("keeps the most recent candidates within both budgets", () => {
    expect(
      selectWorkspaceCache({
        current: ["a", "b"],
        valid: ["a", "b", "c", "d"],
        active: "d",
        warmCandidates: ["b", "c"],
        terminalSurfaces: { a: 1, b: 3, c: 1, d: 2 },
        budget: cacheBudget("balanced", [3, 4, 3]),
      }),
    ).toEqual(["a", "c", "d"]);
  });

  it("keeps the immediate return target's renderer when only the surface cap rejects it", () => {
    // 실측(2026-08-02): balanced 예산의 maxTerminalSurfaces는 7인데 사용자가
    // 오가는 두 데스크탑이 6+4=10이라 직전 데스크탑의 WebGL이 왕복마다
    // 파괴/재생성됐다(pane당 ~85ms + 그 사이 DOM 렌더러의 다른 셀 폭).
    // GPU 바이트 예산(112MiB)은 42MiB로 여유가 있었다 — 표면 수만 걸렸다.
    expect(
      selectWorkspaceCache(
        returnTripSelection({
          budget: cacheBudget("balanced", [4, 7, 4], 1024 * MIB),
        }),
      ),
    ).toEqual(["previous", "active"]);
  });

  it("still refuses the return target when its GPU viewport exceeds the byte budget", () => {
    // 예외는 표면 수에만 준다 — 실제 GPU 메모리 상한은 그대로다.
    expect(
      selectWorkspaceCache(
        returnTripSelection({
          previousGpuViewportBytes: 512 * MIB,
          budget: cacheBudget("balanced", [4, 7, 4], 1024 * MIB),
        }),
      ),
    ).toEqual(["active"]);
  });

  it("drops the return-target exception only under severe render pressure", () => {
    expect(
      selectWorkspaceCache(
        returnTripSelection({
          budget: cacheBudget("severe-pressure", [4, 7, 4], 1024 * MIB),
        }),
      ),
    ).toEqual(["active"]);
  });

  it("keeps the return target through ordinary render pressure", () => {
    // 실측(qa.log 2026-08-02): 터미널이 출력할 때마다 write latency로 일반
    // pressure에 들락거렸다. 숨은 렌더러를 버려도 활성 표면의 latency는 줄지
    // 않는데, 그 진동이 그대로 파괴/재생성(pane당 ~85ms)이 됐다.
    expect(
      selectWorkspaceCache(
        returnTripSelection({
          activeSurfaces: 5,
          budget: cacheBudget("pressure", [3, 5, 4], 1024 * MIB),
        }),
      ),
    ).toEqual(["previous", "active"]);
  });
});

describe("selectWorkspaceCacheTiers", () => {
  /** Ten-pane hebbian left behind as agents becomes active — protected return. */
  const hebbianAgentsReturn = {
    current: ["hebbian"],
    valid: ["hebbian", "agents"],
    active: "agents",
    protectedRetainId: "hebbian",
    terminalSurfaces: { hebbian: 10, agents: 3 },
    terminalModelBytes: { hebbian: 595 * MIB, agents: 190 * MIB },
  };

  it("retains all structured workspace shells when the byte and workspace budgets admit them", () => {
    const workspaces = Array.from({ length: 10 }, (_, index) =>
      `workspace-${index + 1}`,
    );
    const active = workspaces[workspaces.length - 1]!;
    const terminalSurfaces = Object.fromEntries(
      workspaces.map((workspace) => [workspace, 5]),
    );
    const terminalModelBytes = Object.fromEntries(
      workspaces.map((workspace) => [workspace, 5 * 40 * MIB]),
    );

    expect(
      selectWorkspaceCacheTiers({
        current: workspaces.slice(0, -1),
        valid: workspaces,
        active,
        terminalSurfaces,
        terminalModelBytes,
        budget: cacheBudget("high-resource", [6, 14, 12], 2 * GIB),
      }).mounted,
    ).toEqual(workspaces);
  });

  it("protects one individually bounded previous desktop when the pair exceeds retention", () => {
    expect(
      selectWorkspaceCacheTiers({
        ...hebbianAgentsReturn,
        budget: cacheBudget("high-resource", [6, 14, 12]),
      }),
    ).toEqual(cacheTiers(["hebbian", "agents"], ["hebbian", "agents"], []));
  });

  it("demotes the protected previous desktop only when renderer pressure shrinks the tier", () => {
    expect(
      selectWorkspaceCacheTiers({
        ...hebbianAgentsReturn,
        budget: cacheBudget("pressure", [1, 4, 12]),
      }),
    ).toEqual(cacheTiers(["hebbian", "agents"], ["agents"], ["hebbian"]));
  });

  it("does not let immediate-return protection exceed its bounded byte overdraft", () => {
    expect(
      selectWorkspaceCacheTiers({
        current: ["previous"],
        valid: ["previous", "active"],
        active: "active",
        protectedRetainId: "previous",
        terminalSurfaces: { previous: 10, active: 3 },
        terminalModelBytes: { previous: 650 * MIB, active: 190 * MIB },
        budget: cacheBudget("high-resource", [6, 14, 12]),
      }),
    ).toEqual(cacheTiers(["active"], ["active"], []));
  });

  it("keeps the immediately previous desktop warm ahead of frequency hints", () => {
    expect(
      selectWorkspaceCacheTiers({
        // `previous` is last because it was active before this transition.
        current: ["frequent", "next", "previous"],
        valid: ["frequent", "next", "previous"],
        active: "next",
        // A frequency hint may reorder candidates, but must not demote the
        // actual return target behind a speculative/frequency-only desktop.
        warmCandidates: ["previous", "frequent"],
        terminalSurfaces: { frequent: 1, next: 1, previous: 9 },
        terminalModelBytes: {
          frequent: 100 * MIB,
          next: 50 * MIB,
          previous: 500 * MIB,
        },
        terminalGpuViewportBytes: {
          frequent: 64 * MIB,
          next: 16 * MIB,
          previous: 160 * MIB,
        },
        budget: cacheBudget("high-resource", [3, 14, 12]),
      }),
    ).toEqual(
      cacheTiers(
        ["frequent", "previous", "next"],
        ["previous", "next"],
        ["frequent"],
      ),
    );
  });

  it("demotes pressure-evicted spaces to frozen instead of unmounting them", () => {
    expect(
      selectWorkspaceCacheTiers({
        current: ["a", "b", "c"],
        valid: ["a", "b", "c"],
        active: "c",
        terminalSurfaces: { a: 1, b: 1, c: 1 },
        budget: cacheBudget("pressure", [1, 4, 3]),
      }),
    ).toEqual(cacheTiers(["a", "b", "c"], ["c"], ["a", "b"]));
  });

  it("unmounts only past the retained caps (discard tier)", () => {
    expect(
      selectWorkspaceCacheTiers({
        current: ["a", "b", "c", "d"],
        valid: ["a", "b", "c", "d"],
        active: "d",
        terminalSurfaces: { a: 1, b: 1, c: 1, d: 1 },
        budget: cacheBudget("pressure", [1, 4, 2]),
      }),
    ).toEqual(cacheTiers(["c", "d"], ["d"], ["c"]));
  });

  it("moves an already-mounted active desktop to the newest LRU position", () => {
    expect(
      selectWorkspaceCacheTiers({
        current: ["a", "b", "c"],
        valid: ["a", "b", "c"],
        active: "a",
        terminalSurfaces: { a: 1, b: 1, c: 1 },
        budget: cacheBudget("pressure", [2, 2, 3]),
      }),
    ).toEqual(cacheTiers(["b", "c", "a"], ["c", "a"], ["b"]));
  });

  it("never mounts prewarm candidates into the frozen tier", () => {
    expect(
      selectWorkspaceCacheTiers({
        current: [],
        valid: ["a", "b"],
        active: "a",
        warmCandidates: ["b"],
        terminalSurfaces: { a: 1, b: 1 },
        budget: cacheBudget("pressure", [1, 4, 3]),
      }),
    ).toEqual(cacheTiers(["a"], ["a"], []));
  });

  it("refuses a frozen prewarm that would cross the model byte ceiling", () => {
    expect(
      selectWorkspaceCacheTiers({
        current: ["heavy", "active"],
        valid: ["heavy", "active", "next"],
        active: "active",
        warmCandidates: ["next"],
        retainCandidates: ["next"],
        terminalSurfaces: { heavy: 9, active: 3, next: 10 },
        // 마운트된 둘의 측정 무게가 프리웜 후보(미측정=프리웜 가격 80MiB)를
        // 밀어낸다 — 바이트 실링은 방문 후 실체를 지키는 캡이다.
        terminalModelBytes: { heavy: 500 * MIB, active: 250 * MIB },
        budget: cacheBudget("high-resource", [2, 12, 4]),
      }),
    ).toEqual(cacheTiers(["heavy", "active"], ["heavy", "active"], []));
  });

  it("retains frozen shells beyond the active renderer surface budget", () => {
    // Warm admits only the renderable five-surface set. The inactive four-pane
    // shell owns no terminal subtree, so it stays mounted in the frozen tier.
    expect(
      selectWorkspaceCacheTiers({
        current: ["a", "b"],
        valid: ["a", "b", "c", "z"],
        active: "z",
        warmCandidates: ["c"],
        terminalSurfaces: { a: 4, b: 1, c: 3, z: 1 },
        budget: cacheBudget("balanced", [3, 5, 4]),
      }),
    ).toEqual(
      cacheTiers(["a", "c", "b", "z"], ["c", "b", "z"], ["a"]),
    );
  });

  it("accepts speculative prewarm as expansion without evicting a frozen shell", () => {
    const current = cacheTiers(["heavy", "active"], ["active"], ["heavy"]);
    const candidate = selectWorkspaceCacheTiers({
      current: current.mounted,
      valid: ["heavy", "active", "prewarm"],
      active: "active",
      warmCandidates: ["prewarm"],
      terminalSurfaces: { heavy: 10, active: 3, prewarm: 8 },
      budget: cacheBudget("balanced", [2, 12, 3]),
    });

    expect(candidate).toEqual(
      cacheTiers(
        ["heavy", "prewarm", "active"],
        ["prewarm", "active"],
        ["heavy"],
      ),
    );
    expect(acceptWorkspacePrewarmTiers(current, candidate)).toBe(candidate);
  });

  it("accepts a speculative prewarm only as a strict mounted-set expansion", () => {
    const current = cacheTiers(["heavy", "active"], ["active"], ["heavy"]);
    const expanded = cacheTiers(
      ["heavy", "prewarm", "active"],
      ["prewarm", "active"],
      ["heavy"],
    );
    const swappingGrowth = cacheTiers(
      ["old", "prewarm", "active"],
      ["prewarm", "active"],
      ["old"],
    );

    expect(acceptWorkspacePrewarmTiers(current, expanded)).toBe(expanded);
    expect(acceptWorkspacePrewarmTiers(current, swappingGrowth)).toBe(current);
  });

  it("does not let speculative prewarm evict an existing warm renderer", () => {
    const current = cacheTiers(
      ["previous", "active"],
      ["previous", "active"],
      [],
    );
    const rendererSwap = cacheTiers(
      ["previous", "small", "active"],
      ["small", "active"],
      ["previous"],
    );

    expect(acceptWorkspacePrewarmTiers(current, rendererSwap)).toBe(current);
  });

  it("startup 프리웜은 프리웜 가격으로 전량 승인되고 retained 캡은 유계다", () => {
    const budget = deriveWorkspaceCacheBudget(
      { logicalCores: 16 },
      performanceSnapshot(),
      "hebbian",
    );
    const costs = {
      main: 3,
      gate: 5,
      hft: 6,
      agents: 4,
      hebbian: 9,
      gesto: 1,
      mutee: 2,
      workspace: 2,
    };
    let tiers: WorkspaceCacheTiers = cacheTiers(["hebbian"], ["hebbian"], []);
    for (const id of Object.keys(costs)) {
      if (id === "hebbian") continue;
      const candidate = selectWorkspaceCacheTiers({
        current: tiers.mounted,
        valid: Object.keys(costs),
        active: "hebbian",
        // Startup prewarm must preserve the existing warm pair even when
        // measured frequent candidates would otherwise rebalance it.
        warmCandidates: ["agents", "hft", ...tiers.warm],
        retainCandidates: [id],
        terminalSurfaces: costs,
        budget,
      });
      tiers = acceptWorkspacePrewarmTiers(tiers, candidate);
    }

    const retainedSurfaces = tiers.mounted.reduce(
      (total, id) => total + costs[id as keyof typeof costs],
      0,
    );
    expect(tiers.mounted).toContain("hebbian");
    // 프리웜 가격(8MiB/pane)에선 32-surface 전량이 예산 안이다 — 승인 자체가
    // 목적이고(첫 방문 하이드레이션), 유계성은 retained 캡과 프리웜 가격
    // 합으로 보장된다. 방문 후에는 실가격 재계상이 discard를 결정한다.
    expect(tiers.mounted.length).toBe(8);
    expect(retainedSurfaces * PREWARM_TERMINAL_MODEL_BYTES).toBeLessThanOrEqual(
      TERMINAL_MODEL_FALLBACK_BUDGET_BYTES,
    );
    // 프리웜 가격에선 소형(gesto, 1-surface)까지 warm에 들어온다 — 즉시
    // 전환 커버리지 확대. surface 캡이 여전히 대형 무제한 편입을 막는다.
    expect(tiers.warm).toEqual(["gesto", "agents", "hebbian"]);
  });
});

describe("workspace cache diagnostics", () => {
  it("projects the applied budget and shell tiers without claiming retained terminals", () => {
    const budget = cacheBudget("high-resource", [6, 14, 12], 2 * GIB);
    const input = {
      current: ["frozen", "warm"],
      valid: ["frozen", "warm"],
      active: "warm",
      terminalSurfaces: { frozen: 5, warm: 3 },
      terminalModelBytes: { frozen: 500, warm: 300 },
      budget,
    };

    expect(
      describeWorkspaceCacheDecision(
        input,
        cacheTiers(["frozen", "warm"], ["warm"], ["frozen"]),
      ),
    ).toEqual({
      budget,
      occupancy: {
        total: {
          workspaces: 2,
          projectedTerminalSurfaces: 8,
          projectedTerminalModelBytes: 800,
        },
        warm: {
          workspaces: 1,
          projectedTerminalSurfaces: 3,
          projectedTerminalModelBytes: 300,
        },
        frozen: {
          workspaces: 1,
          projectedTerminalSurfaces: 5,
          projectedTerminalModelBytes: 500,
        },
      },
    });
  });
});

describe("estimateTerminalSurfaces", () => {
  it("counts terminal-bearing panes without treating file panes as terminal resources", () => {
    expect(
      estimateTerminalSurfaces({
        panels: {
          "term:1": { contentComponent: "terminal", params: {} },
          "ssh:2": { contentComponent: "terminal", params: {} },
          "agent:3": { contentComponent: "agent", params: {} },
          "file:4": { contentComponent: "fileviewer", params: {} },
        },
      }),
    ).toBe(3);
  });
  it("prices current pane content independently of historical ID prefixes", () => {
    expect(
      estimateTerminalSurfaces({
        panels: {
          opaque: { contentComponent: "terminal" },
          "launcher:old": { contentComponent: "agent" },
          "term:old": { contentComponent: "launcher" },
          "agent:old": { contentComponent: "fileviewer" },
          "ssh:unknown": {},
          "ssh:retired": { contentComponent: "ssh" },
        },
      }),
    ).toBe(2);
  });
});
