// Spaces 행의 다중선택·컨텍스트 메뉴 액션 훅 — SpacesPane에서 추출.
//
// 왜 추출인가: SpacesPane이 898줄로 god-file 라쳇 상한(900)에 붙어 있어, 다음
// Spaces 작업이 몇 줄만 더해도 게이트에 걸린다. 이 블록(선택 상태 + 클릭/시프트
// 범위 선택 + 우클릭 메뉴 핸들러 + 일괄 managed 전환)은 렌더와 독립적인 가장 큰
// 응집 단위라 통째로 옮겼다. 동작 변화 없음 — 코드 이동만.
//
// 핸들러 정체성 규약(원본 주석 유지): 행 memo가 깨지지 않게 핸들러는 정체성을
// 고정하고 최신 상태는 ref로 읽는다. 렌더 중 대입은 중단된 렌더의 값이 남는
// concurrent 함정이라 커밋 직후(paint 전) 갱신한다.
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  ask,
  message as messageDialog,
} from "@tauri-apps/plugin-dialog";
import { movePanelsToDesktop, openAgentPanel } from "@/lib/workspace/dock";
import { openSessionDiffPanel } from "@/lib/workspace/dock/openScmPanel";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { killPanels } from "@/lib/workspace/pane/paneCloseCoordinator";
import { openAgentDiffWindow } from "@/lib/workspace/window/windows";
import { t } from "@/lib/i18n";
import { showErrorToast } from "@/lib/toast";
import { useStore } from "@/store";
import {
  restartProviderRow,
  switchProviderRowAccount,
} from "@/lib/terminal/terminalProviderRestart";
import type { Agent, Provider } from "@/types";
import { localStandaloneDiffCwd } from "@/lib/scm/review/diffReviewCapability";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { forkAgent } from "@/lib/agents/fork";
import { hmuxManagedPromotionAvailability } from "@/lib/hmux/conversion/hmuxManagedPromotionEligibility";
import { runHmuxSessionConversionBatch } from "@/lib/hmux/conversion/hmuxSessionConversionBatch";
import { resolveSpacesDragItems } from "@/lib/spaces/spacesDrag";
import {
  planSpacesRemoval,
  spacesRemovalConfirmMessage,
} from "@/lib/spaces/spacesRemovalAction";
import type { SpaceMenuHandlers } from "@/components/spaces/SpacesRows";
import type { SpaceRow } from "@/components/spaces/useSpaces";
import type { useDiffReviewCapabilities } from "@/components/scm/useDiffReviewCapabilities";
import { sessionRuntimeDisplayState } from "@/lib/sessions/runtime/sessionRuntimeDisplayState";

type DiffReview = ReturnType<typeof useDiffReviewCapabilities>;

function currentManagedPromotion(space: SpaceRow) {
  const state = useStore.getState();
  const runtime = state.sessionAgentRuntimeState[space.sessionId];
  return hmuxManagedPromotionAvailability(
    {
      kind: space.kind,
      hostId: space.hostId,
      runtime: space.hmuxRuntime,
      workspaceId: space.hmuxWorkspaceId,
      provider: space.provider,
      executionLocationKnown: space.executionLocationKnown,
      displayState: sessionRuntimeDisplayState(runtime),
      cwd: state.sessionCwd[space.sessionId] || space.cwd,
    },
    state.projects,
  );
}

/** 행 액션이 스토어·IPC에 닿는 통로. 모듈 상수라 참조가 고정된다. */
const rowActionDeps = {
  requestAgentRestart: (id: string) => useStore.getState().requestAgentRestart(id),
  switchAgentCredential: async (
    id: string,
    accountId: string | null,
    sourcePanelId: string,
  ) => {
    const { requestAgentCredentialTransition } = await import(
      "@/lib/agents/agentCredentialTransition"
    );
    await requestAgentCredentialTransition({
      agentId: id,
      targetCredentialId: accountId,
      sourcePanelId,
    });
  },
  setActiveAccount: (provider: Provider, accountId?: string) =>
    useStore.getState().setActiveAccount(provider, accountId),
};

export function useSpacesSelection({
  spaces,
  selectionOrder,
  diffCapabilities,
  probeDiffCapability,
  onRequestAgentRemoval,
}: {
  spaces: readonly SpaceRow[];
  /** Keys of the rows on screen, in visual order (useSpacesGroups) — rows
   *  behind a fold or a search are not in it. */
  selectionOrder: readonly string[];
  diffCapabilities: DiffReview["capabilities"];
  probeDiffCapability: DiffReview["probe"];
  onRequestAgentRemoval: (agent: Agent) => void;
}) {
  const addSpace = useStore((state) => state.addSpace);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [contextMenuKey, setContextMenuKey] = useState<string | null>(null);
  const [conversionBusyKeys, setConversionBusyKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  /** In-place kill confirmation (SOUL §6): the context-menu action arms this
   *  and the anchor row swaps to an InlineConfirmRow. Items are resolved at
   *  arm time so the confirmed action kills exactly what was asked about. */
  const [killConfirm, setKillConfirm] = useState<{
    readonly anchorKey: string;
    readonly question: string;
    readonly items: readonly { panelId: string; desktopId: string }[];
    readonly busy: boolean;
  } | null>(null);
  const conversionInFlight = useRef(new Set<string>());
  const forkInFlight = useRef(new Set<string>());
  const lastClicked = useRef<string | null>(null);
  // Shift ranges walk the rows in the order they are drawn.
  const flatKeys = selectionOrder;
  const selectedPromotionSummary = useMemo(() => {
    let eligible = 0;
    let deferred = 0;
    for (const space of spaces) {
      if (!selected.has(space.key) || space.managedPromotion === "hidden")
        continue;
      if (space.managedPromotion === "eligible") eligible += 1;
      else deferred += 1;
    }
    return { eligible, deferred };
  }, [selected, spaces]);

  const stateRef = useRef({ spaces, flatKeys, selected, diffCapabilities });
  useLayoutEffect(() => {
    stateRef.current = { spaces, flatKeys, selected, diffCapabilities };
  });

  const clearSelection = useCallback(() => setSelected(new Set()), []);
  // Rows that leave the screen (folded away, filtered out, closed) leave the
  // selection with them: a bulk action acts on what the person can see.
  useLayoutEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(flatKeys);
      const next = new Set([...prev].filter((key) => visible.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [flatKeys]);

  const onSpaceClick = useCallback((event: MouseEvent, key: string, desktopId: string) => {
    const { flatKeys: keys } = stateRef.current;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      lastClicked.current = key;
      return;
    }
    if (event.shiftKey && lastClicked.current) {
      event.preventDefault();
      const a = keys.indexOf(lastClicked.current);
      const b = keys.indexOf(key);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(keys.slice(lo, hi + 1)));
      }
      return;
    }
    // 일반 클릭: 네비게이트 + 선택 초기화
    setSelected(new Set());
    lastClicked.current = key;
    navigateToPanel(desktopId, key);
  }, []);

  const onContextMenuOpenChange = useCallback(
    (key: string, open: boolean) => {
      setContextMenuKey(open ? key : null);
      if (!open) return;
      const space = stateRef.current.spaces.find((candidate) => candidate.key === key);
      if (!space) return;
      const cwd = localStandaloneDiffCwd(space);
      if (cwd) void probeDiffCapability(cwd);
    },
    [probeDiffCapability],
  );

  // 우클릭 대상: 우클릭한 항목이 선택 안에 있으면 선택 전체, 아니면 그 하나
  const targetSpacesFor = (key: string) => {
    const { spaces: all, selected: sel } = stateRef.current;
    const keys = sel.has(key) ? sel : new Set([key]);
    return all.filter((space) => keys.has(space.key));
  };

  const targetsFor = (key: string) => {
    return targetSpacesFor(key).map((space) => ({
      panelId: space.key,
      fromDesktopId: space.desktopId,
    }));
  };

  /** 드래그 시작 시 함께 움직일 항목 — 선택 규칙은 우클릭 대상과 동일하다. */
  const resolveDragItems = useCallback((key: string) => {
    const { spaces: all, selected: sel } = stateRef.current;
    return resolveSpacesDragItems(all, sel, key);
  }, []);

  const forkRegisteredAgent = useCallback(
    (agentId: string, desktopId: string, provider: Provider) => {
      if (forkInFlight.current.has(agentId)) return;
      forkInFlight.current.add(agentId);
      void forkAgent(agentId, provider)
        .then((forked) => openAgentPanel(desktopId, forked))
        .catch((error) =>
          messageDialog(t("common.forkFailed", { e: String(error) }), {
            kind: "error",
          }),
        )
        .finally(() => forkInFlight.current.delete(agentId));
    },
    [],
  );

  const menuHandlers = useMemo<SpaceMenuHandlers>(
    () => ({
      onViewDiff: (key) => {
        const space = stateRef.current.spaces.find((candidate) => candidate.key === key);
        if (!space) return;
        if (space.agentId) {
          const agent = useStore.getState().agents.find((a) => a.id === space.agentId);
          // 별도 창으로 연다(사용자 요청). diff는 코드를 읽는 화면이라 작업 중인
          // 데스크탑에 pane을 하나 더 끼우면 보던 배치가 좁아진다.
          if (agent) void openAgentDiffWindow(agent.id, agentDisplayName(agent));
          return;
        }
        const cwd = localStandaloneDiffCwd(space);
        if (
          cwd &&
          space.sessionId &&
          stateRef.current.diffCapabilities.get(cwd)?.status === "available"
        ) {
          openSessionDiffPanel(
            space.desktopId,
            space.sessionId,
            cwd,
            space.title,
          );
        }
      },
      onRestart: (key) => {
        const space = stateRef.current.spaces.find((c) => c.key === key);
        if (space) void restartProviderRow(space, rowActionDeps).catch(() => {});
      },
      onFork: (key, provider) => {
        const space = stateRef.current.spaces.find((candidate) => candidate.key === key);
        if (space?.agentId) {
          forkRegisteredAgent(space.agentId, space.desktopId, provider);
        }
      },
      onPromoteManaged: async (key) => {
        const { spaces: currentSpaces, selected: currentSelection } =
          stateRef.current;
        const targetKeys = currentSelection.has(key)
          ? currentSelection
          : new Set([key]);
        const candidates = currentSpaces.filter(
          (space) =>
            targetKeys.has(space.key) &&
            currentManagedPromotion(space) !== "hidden",
        );
        const eligible = candidates.filter(
          (space) =>
            currentManagedPromotion(space) === "eligible" &&
            Boolean(space.sessionId && space.hmuxWorkspaceId) &&
            !conversionInFlight.current.has(space.key),
        );
        if (eligible.length === 0) {
          return;
        }
        const busyKeys = eligible.map((space) => space.key);
        for (const busyKey of busyKeys) {
          conversionInFlight.current.add(busyKey);
        }
        setConversionBusyKeys((current) => {
          const next = new Set(current);
          for (const busyKey of busyKeys) next.add(busyKey);
          return next;
        });
        try {
          const result = await runHmuxSessionConversionBatch(
            eligible.map((space) => ({
              key: space.key,
              request: {
                sourceSessionId: space.sessionId,
                sourceWorkspaceId: space.hmuxWorkspaceId,
                sourceSessionName: space.hmuxSessionName,
                panelId: space.key,
                target: "managed",
              },
            })),
            candidates.length - eligible.length,
            ({ title, message }) =>
              ask(message, { title, kind: "warning" }),
          );
          if (result.failures.length > 0) {
            await messageDialog(
              t("spaces.managed.convertPartialFailure", {
                converted: result.converted.length,
                failed: result.failures.length,
                error: String(result.failures[0]?.error),
              }),
              { title: t("common.hmuxSwitch.title"), kind: "warning" },
            );
          }
          if (result.accepted) setSelected(new Set());
        } catch (error) {
          await messageDialog(
            t("common.hmuxSwitch.failed", { error: String(error) }),
            { title: t("common.hmuxSwitch.title"), kind: "error" },
          );
        } finally {
          for (const busyKey of busyKeys) {
            conversionInFlight.current.delete(busyKey);
          }
          setConversionBusyKeys((current) => {
            const next = new Set(current);
            for (const busyKey of busyKeys) next.delete(busyKey);
            return next;
          });
        }
      },
      onSwitchAccount: (key, accountId) => {
        const space = stateRef.current.spaces.find((c) => c.key === key);
        if (space) {
          void switchProviderRowAccount(space, accountId, rowActionDeps).catch(
            (error) =>
              showErrorToast(
                `${t("agents.account.switchFailed")}: ${String(error)}`,
              ),
          );
        }
      },
      onMoveToDesktop: async (key, desktopId) => {
        // 드래그 드롭과 같은 의미: 이미 대상에 있는 항목은 거르고, 이동 후
        // 선택만 비운다 — 대상 데스크탑을 활성화하지는 않는다(드롭과 동일).
        const items = targetsFor(key).filter(
          (item) => item.fromDesktopId !== desktopId,
        );
        if (items.length === 0) return;
        await movePanelsToDesktop(items, desktopId);
        setSelected(new Set());
      },
      onMoveToNewDesktop: async (key) => {
        // 대상이 비어 있는 채 먼저 mount되면 Workspace가 기본 터미널을
        // 생성한다. persisted move를 먼저 커밋한 뒤 활성화해 그 race를 막는다.
        const targetDesktopId = addSpace({ activate: false });
        const receipt = await movePanelsToDesktop(
          targetsFor(key),
          targetDesktopId,
        );
        if (receipt.movedPanelIds.length > 0) {
          useStore.getState().setActiveSpace(targetDesktopId);
        } else if (!receipt.error) {
          // 이 액션이 만든 아직 비활성·빈 데스크탑만 되돌린다.
          useStore.getState().removeSpace(targetDesktopId);
        }
        setSelected(new Set());
      },
      onKill: async (key) => {
        const intent = planSpacesRemoval(
          targetSpacesFor(key).map((space) => ({
            panelId: space.key,
            desktopId: space.desktopId,
            kind: space.kind,
            agentId: space.agentId,
          })),
        );
        if (intent.kind === "agent-dialog") {
          const agent = useStore
            .getState()
            .agents.find((candidate) => candidate.id === intent.agentId);
          if (agent) {
            onRequestAgentRemoval(agent);
            return;
          }
        }
        // 등록이 이미 사라진 에이전트 행의 폴백 — 남을 등록·워크트리가
        // 없으므로 일반 세션 종료(agent 주석 없는 확인 문구)로 취급한다.
        const sessions =
          intent.kind === "sessions"
            ? intent
            : { kind: "sessions" as const, items: intent.items, agentCount: 0 };
        // 같은 라벨이 행 종류에 따라 파괴 범위가 다르다 — 등록 에이전트가
        // 섞여 있으면 pane만 닫히고 등록·워크트리는 남는다는 사실을 확인
        // 문구가 직접 말한다(문구 조립은 spacesRemovalAction이 소유).
        // 확인 자체는 팝업이 아니라 우클릭한 행이 제자리에서 받는다(SOUL §6).
        setKillConfirm({
          anchorKey: key,
          question: spacesRemovalConfirmMessage(sessions),
          items: [...sessions.items],
          busy: false,
        });
      },
    }),
    // targetsFor는 stateRef만 읽는다 — addSpace(zustand 액션)은 정체성 고정.
    [addSpace, forkRegisteredAgent, onRequestAgentRemoval],
  );

  const cancelKillConfirm = useCallback(() => setKillConfirm(null), []);
  const confirmKill = useCallback(async () => {
    if (!killConfirm || killConfirm.busy) return;
    setKillConfirm({ ...killConfirm, busy: true });
    try {
      // 부분 실패(다른 pane의 hydration이 pane_changed를 던지는 등)를 삼키면
      // 확인까지 받은 종료가 조용히 무시된다 — 실패 수를 반드시 알린다.
      const receipt = await killPanels(killConfirm.items);
      if (receipt.failed.length > 0) {
        showErrorToast(
          t("spaces.kill.failedRetry", {
            n: receipt.failed.length,
          }),
        );
      }
      setSelected(new Set());
    } finally {
      setKillConfirm(null);
    }
  }, [killConfirm]);

  return {
    selected,
    clearSelection,
    contextMenuKey,
    conversionBusyKeys,
    selectedPromotionSummary,
    killConfirm,
    confirmKill,
    cancelKillConfirm,
    onSpaceClick,
    onContextMenuOpenChange,
    menuHandlers,
    forkRegisteredAgent,
    resolveDragItems,
  };
}
