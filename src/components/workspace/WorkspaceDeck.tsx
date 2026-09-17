import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Workspace } from "@/components/workspace/Workspace";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { onDesktopPrewarmRequest } from "@/lib/workspace/desktop/desktopPrewarm";
import {
  consumeDesktopTransitionIntent,
  markDesktopTransitionIntent,
} from "@/lib/workspace/desktop/desktopTransitionIntent";
import { frequentDesktopIds } from "@/lib/workspace/desktop/desktopVisitFrequency";
import {
  acceptWorkspacePrewarmTiers,
  describeWorkspaceCacheDecision,
  deriveWorkspaceCacheBudget,
  estimateTerminalSurfaces,
  readWorkspaceHardwareProfile,
  exceedsContextHardCap,
  selectWorkspaceCacheTiers,
  type WorkspaceCacheSelection,
  type WorkspaceCacheTiers,
  type WorkspaceHardwareProfile,
} from "@/lib/workspace/performance/workspaceCachePolicy";
import {
  mergeWorkspaceHardwareProfiles,
  readSystemHardwareProfile,
} from "@/lib/workspace/performance/workspaceHardwareProfile";
import {
  getWorkspacePerformanceSnapshot,
  workspacePerformance,
} from "@/lib/workspace/performance/workspacePerformance";
import {
  type MergedTierReconcileIntent,
  resolveMergedTierReconcile,
  type TierReconcileIntent,
  TierReconcileScheduler,
} from "@/lib/workspace/performance/tierReconcileScheduler";
import {
  DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES,
  DEFAULT_TERMINAL_MODEL_BYTES,
} from "@/lib/workspace/performance/terminalResourceBudget";
import { browserMessageTasks } from "@/lib/scheduling/messageTask";
import { useStore } from "@/store";
import type { Space } from "@/types";

const stopDesktopTransitionIntentObserver = useStore.subscribe((state, previous) => {
  if (state.activeSpaceId !== previous.activeSpaceId) {
    markDesktopTransitionIntent(state.activeSpaceId);
  }
});
if (import.meta.hot) {
  import.meta.hot.dispose(stopDesktopTransitionIntentObserver);
}

function reconcileDesktopTiers(
  current: readonly string[],
  spaces: readonly Space[],
  activeSpaceId: string | undefined,
  hardwareProfile: WorkspaceHardwareProfile,
  protectedRetainId?: string,
  warmCandidates: readonly string[] = [],
  retainCandidates: readonly string[] = [],
  protectedWarmCandidates: readonly string[] = [],
  captureDecision?: (selection: WorkspaceCacheSelection) => void,
) {
  const performance = getWorkspacePerformanceSnapshot();
  // The legacy xterm WebGL renderer (and its context-loss storm signal) is
  // retired; the structured renderer never trips the storm parameter.
  const budget = deriveWorkspaceCacheBudget(
    hardwareProfile,
    performance,
    activeSpaceId,
  );
  const layouts = useStore.getState().layouts;
  // Admission prices the next activation, not currently attached renderers.
  // Frozen shells retain Dockview while releasing those renderers; charging
  // zero after release would repeatedly thaw and freeze the same desktop.
  const mountedTerminalPanels = new Map(
    spaces.flatMap((desktop) => {
      const dockview = getDockview(desktop.id);
      if (!dockview) return [];
      return [[
        desktop.id,
        dockview.panels.filter((panel) =>
          panel.api.component === "agent" || panel.api.component === "terminal",
        ),
      ] as const];
    }),
  );
  const liveSurfaces = new Map(
    performance.workspaces.map((workspace) => [
      workspace.desktopId,
      workspace.terminalSurfaces,
    ]),
  );
  const liveModelBytes = new Map(
    performance.workspaces.map((workspace) => [
      workspace.desktopId,
      workspace.terminalModelBytes ??
        workspace.terminalSurfaces * DEFAULT_TERMINAL_MODEL_BYTES,
    ]),
  );
  const liveGpuViewportBytes = new Map(
    performance.workspaces.map((workspace) => [
      workspace.desktopId,
      workspace.terminalGpuViewportBytes ??
        workspace.terminalSurfaces * DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES,
    ]),
  );
  const terminalSurfaces = Object.fromEntries(
    spaces.map((desktop) => [
      desktop.id,
      mountedTerminalPanels.get(desktop.id)?.length ??
        estimateTerminalSurfaces(layouts[desktop.id]),
    ]),
  );
  const visibleTerminalSurfaces = Object.fromEntries(
    [...mountedTerminalPanels].map(([desktopId, panels]) => [
      desktopId,
      panels.filter((panel) => panel.api.isVisible).length,
    ]),
  );
  const terminalModelBytes = Object.fromEntries(
    spaces.map((desktop) => {
      const liveCount = liveSurfaces.get(desktop.id) ?? 0;
      const surfaceCount = terminalSurfaces[desktop.id] ?? 0;
      return [
        desktop.id,
        (liveModelBytes.get(desktop.id) ?? 0) +
          Math.max(0, surfaceCount - liveCount) *
            DEFAULT_TERMINAL_MODEL_BYTES,
      ];
    }),
  );
  const terminalGpuViewportBytes = Object.fromEntries(
    spaces.map((desktop) => {
      const liveCount = liveSurfaces.get(desktop.id) ?? 0;
      const surfaceCount = terminalSurfaces[desktop.id] ?? 0;
      return [
        desktop.id,
        (liveGpuViewportBytes.get(desktop.id) ?? 0) +
          Math.max(0, surfaceCount - liveCount) *
            DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES,
      ];
    }),
  );
  // 자주 돌아가는 데스크탑(전환 이력의 감쇠 방문 점수 상위)을 warm 후보로
  // 승격해, ⌘ 점프 위주 사용에서도 단골 데스크탑이 warm에 남게 한다.
  // The selector consumes hints from low→high priority, while visit frequency
  // is ranked high→low. Reverse once at the boundary so the most frequent
  // desktop is selected first when byte/surface capacity is tight.
  const frequent = frequentDesktopIds(performance.transitions, {
    exclude: activeSpaceId ? [activeSpaceId] : [],
  }).reverse();
  const selection = {
    current,
    valid: spaces.map((desktop) => desktop.id),
    active: activeSpaceId,
    protectedRetainId,
    // Speculative neighbors are useful only in spare capacity. Measured visit
    // frequency comes last because candidates are ordered low→high priority:
    // an idle/neighbor hint must not park the renderer for the desktop the
    // user is actually alternating with.
    warmCandidates: [
      ...warmCandidates,
      ...frequent,
      ...protectedWarmCandidates,
    ],
    retainCandidates,
    terminalSurfaces,
    visibleTerminalSurfaces,
    terminalGpuViewportBytes,
    terminalModelBytes,
    budget,
  };
  const tiers = selectWorkspaceCacheTiers(selection);
  if (captureDecision) captureDecision(selection);
  else {
    // Replace-only telemetry projects the cache authority's applied decision;
    // it never participates in selection or terminal/session lifetime.
    workspacePerformance.recordWorkspaceCacheDecision(
      describeWorkspaceCacheDecision(selection, tiers),
    );
  }
  return tiers;
}

function sameIds(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sameTiers(a: WorkspaceCacheTiers, b: WorkspaceCacheTiers) {
  return sameIds(a.mounted, b.mounted) && sameIds(a.frozen, b.frozen);
}

/**
 * Keep a measured, bounded two-tier cache of workspace shells mounted. Warm and
 * frozen shells preserve Dockview and non-terminal pane state; warm shells also
 * retain their terminal presentations, while TerminalView releases them for
 * frozen shells. Terminal costs below are conservative activation projections,
 * not retained renderer/model accounting. This policy itself has no
 * session-lifecycle capability.
 */
function useDesktopTiers(spaces: Space[], activeSpaceId: string | undefined) {
  const browserHardwareProfile = useRef(readWorkspaceHardwareProfile());
  const [hardwareProfile, setHardwareProfile] = useState<WorkspaceHardwareProfile>(
    browserHardwareProfile.current,
  );
  const hardwareProfileRef = useRef(hardwareProfile);
  hardwareProfileRef.current = hardwareProfile;
  const [tiers, setTiers] = useState<WorkspaceCacheTiers>(() =>
    activeSpaceId
      ? { mounted: [activeSpaceId], warm: [activeSpaceId], frozen: [] }
      : { mounted: [], warm: [], frozen: [] },
  );
  const tiersRef = useRef<WorkspaceCacheTiers>(tiers);
  tiersRef.current = tiers;
  const previousActiveRef = useRef<string | undefined>(undefined);
  const visitedDesktopIdsRef = useRef(new Set<string>());
  const protectedRetainRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void readSystemHardwareProfile()
      .then((nativeProfile) => {
        if (cancelled) return;
        setHardwareProfile(
          mergeWorkspaceHardwareProfiles(
            browserHardwareProfile.current,
            nativeProfile,
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    if (!activeSpaceId || previousActiveRef.current === activeSpaceId) return;
    const previousActive = previousActiveRef.current;
    const visitKind =
      previousActive === undefined
        ? "initial"
        : visitedDesktopIdsRef.current.has(activeSpaceId)
          ? "revisit"
          : "first_visit";
    const requestedAt = consumeDesktopTransitionIntent(activeSpaceId);
    protectedRetainRef.current = previousActive;
    workspacePerformance.beginTransition(
      activeSpaceId,
      visitKind === "initial"
        ? "cold"
        : tiersRef.current.warm.includes(activeSpaceId)
          ? "renderer"
          : tiersRef.current.mounted.includes(activeSpaceId)
            ? "model"
            : "cold",
      visitKind === "initial" ? (requestedAt ?? 0) : requestedAt,
      visitKind,
    );
    const transitionSequence =
      workspacePerformance.markWorkspaceCommit(activeSpaceId);
    if (transitionSequence !== undefined) {
      globalThis.queueMicrotask(() =>
        workspacePerformance.markWorkspaceCommitMicrotask(transitionSequence),
      );
      browserMessageTasks().request(() =>
        workspacePerformance.markWorkspaceCommitMessageTask(transitionSequence),
      );
    }
    visitedDesktopIdsRef.current.add(activeSpaceId);
    previousActiveRef.current = activeSpaceId;
  }, [activeSpaceId]);

  useEffect(() => {
    setTiers((current) => {
      const next = reconcileDesktopTiers(
        current.mounted,
        spaces,
        activeSpaceId,
        hardwareProfile,
        protectedRetainRef.current,
      );
      return sameTiers(next, current) ? current : next;
    });
  }, [activeSpaceId, spaces, hardwareProfile]);

  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;
  const activeIdRef = useRef(activeSpaceId);
  activeIdRef.current = activeSpaceId;

  // 지연 가능한 트리거 3종(리소스 변화·hover 프리웜·이웃 웜)은 하나의
  // 코얼레서로 병합돼 catchup 레인 슬라이스당 최대 1회만 재조정을 실행한다.
  // 적용은 2단(압력 raw 패스 → 후보 accept 패스)으로 각 트리거의 기존 승인
  // 의미론을 병합 후에도 유지한다 — 분기 자체는 lib에서 테스트로 고정.
  const runCoalescedReconcile = (intent: MergedTierReconcileIntent) => {
    setTiers((current) => {
      let latestSelection: WorkspaceCacheSelection | undefined;
      const next = resolveMergedTierReconcile({
        current,
        intent,
        reconcile: (base, warm, retain, protectedWarm) =>
          reconcileDesktopTiers(
            base.mounted,
            spacesRef.current,
            activeIdRef.current,
            hardwareProfileRef.current,
            protectedRetainRef.current,
            warm,
            retain,
            protectedWarm,
            (selection) => {
              latestSelection = selection;
            },
          ),
        accept: acceptWorkspacePrewarmTiers,
        same: sameTiers,
      });
      if (latestSelection) {
        workspacePerformance.recordWorkspaceCacheDecision(
          describeWorkspaceCacheDecision(latestSelection, next),
        );
      }
      return next;
    });
  };
  const runCoalescedReconcileRef = useRef(runCoalescedReconcile);
  runCoalescedReconcileRef.current = runCoalescedReconcile;
  const reconcileSchedulerRef = useRef<TierReconcileScheduler | undefined>(
    undefined,
  );
  // 인스턴스가 아니라 안정 함수를 노출한다 — StrictMode 이중 마운트에서
  // cleanup이 dispose한 인스턴스를 캡처된 참조가 재사용하면 이후 요청이
  // 영구 무시된다. 요청 경로가 필요 시 재생성하므로 dispose 후에도 산다.
  const requestReconcile = useRef((intent: TierReconcileIntent, urgent = false) => {
    if (!reconcileSchedulerRef.current) {
      reconcileSchedulerRef.current = new TierReconcileScheduler((merged) =>
        runCoalescedReconcileRef.current(merged),
      );
    }
    reconcileSchedulerRef.current.request(intent, urgent);
  }).current;
  useEffect(
    () => () => {
      reconcileSchedulerRef.current?.dispose();
      reconcileSchedulerRef.current = undefined;
    },
    [],
  );

  // Terminal geometry and scrollback measurements refine each shell's projected
  // activation cost. Re-run the same LRU selection as estimates improve.
  // 집행이 catchup 레인으로 옮겨져 압력 반응은 유휴 시
  // 다음 프레임, 지속 상호작용 중엔 기아 상한(10s)까지 늦을 수 있다 —
  // 상호작용 프레임을 지키는 의도된 트레이드오프. Exception: severe context
  // overshoot (WKWebView silent-kill zone) bypasses the paused lane and runs
  // the merged reconcile immediately — the bead 9390 deferred item.
  useEffect(() => {
    // Rising-edge trigger: one urgent kernel run per crossing into the
    // reclaim zone (hard-cap overshoot). A per-notification bypass would run
    // the full reconcile kernel up to 2×batch times inside one activation rAF
    // (review 2026-08-06), and an irreducible overshoot on the
    // always-admitted active desktop would re-run it on every notification
    // with sameTiers as the only outcome. While the zone persists, later
    // notifications ride the lane (10s starvation cap); dropping out re-arms.
    // (The legacy WebGL context-loss storm signal was retired with its
    // renderer.)
    let reclaimActive = false;
    return workspacePerformance.onTerminalResourcesChanged(() => {
      const reclaim = exceedsContextHardCap(
        workspacePerformance.liveWebglContextCount(),
      );
      const urgent = reclaim && !reclaimActive;
      reclaimActive = reclaim;
      requestReconcile({ resourceChange: true }, urgent);
    });
  }, [requestReconcile]);

  // Never construct xterm surfaces for every unseen workspace merely because
  // the WebView became idle. Live 41-surface traces showed those hidden mounts
  // monopolizing the main thread for 0.45–1.28s each long after boot. Prewarm
  // is therefore demand-shaped: an explicit hover or an adjacent destination
  // may warm, while previously visited views remain protected by the cache.
  // hover-intent preload: 탭 위 포인터는 수백 ms 뒤 클릭의 강한 예고다.
  // 그 시간에 콜드 마운트를 앞당겨 전환 시점에는 warm이 되게 한다.
  useEffect(
    () =>
      onDesktopPrewarmRequest((desktopId) => {
        if (tiersRef.current.mounted.includes(desktopId)) return;
        requestReconcile({
          warmCandidates: [desktopId],
          retainCandidates: [desktopId],
        });
      }),
    [requestReconcile],
  );

  // 이웃 웜: 종전의 별도 idle 타이머(250/800ms) 대신 레인이 실행 프레임을
  // 고른다 — 전환 상호작용이 끝난 뒤에 자연히 실행된다.
  useEffect(() => {
    if (!activeSpaceId || spaces.length < 2) return;
    const activeIndex = spaces.findIndex((space) => space.id === activeSpaceId);
    if (activeIndex < 0) return;

    const candidates = [
      spaces[activeIndex + 1]?.id,
      spaces[activeIndex - 1]?.id,
    ].filter((id): id is string => Boolean(id));
    if (candidates.length === 0) return;

    requestReconcile({
      warmCandidates: candidates,
      retainCandidates: candidates,
    });
  }, [activeSpaceId, spaces, requestReconcile]);

  if (activeSpaceId && !tiers.mounted.includes(activeSpaceId)) {
    return reconcileDesktopTiers(
      tiers.mounted,
      spaces,
      activeSpaceId,
      hardwareProfile,
      protectedRetainRef.current,
    );
  }
  return tiers;
}

export function WorkspaceDeck({
  spaces,
  activeSpaceId,
}: {
  spaces: Space[];
  activeSpaceId: string | undefined;
}) {
  const tiers = useDesktopTiers(spaces, activeSpaceId);

  return (
    <>
      {spaces
        .filter((desktop) => tiers.mounted.includes(desktop.id))
        .map((desktop) => (
          <Workspace
            key={desktop.id}
            desktopId={desktop.id}
            active={desktop.id === activeSpaceId}
            frozen={tiers.frozen.includes(desktop.id)}
          />
        ))}
    </>
  );
}
