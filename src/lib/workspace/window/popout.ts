import { withAgentChatDraftMoves } from "@/lib/agents/chat/agentChatDraftMoveCoordinator";
import { popoutWindowLabel } from "./windowLabel";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { planDesktopPaneMove } from "@/lib/workspace/desktop/desktopPaneMove";
import { enqueuePaneMove } from "@/lib/workspace/pane/paneMoveQueue";
import { agentForChatPane, prepareAgentChatDraftTarget, revalidateAgentChatDraftTarget } from "@/lib/agents/chat/agentChatDraftInput";
import {
  extractPanelIdsFromLayout,
  removePanelIdsFromLayout,
  panelsFromLayout,
  isSerializedDockviewLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { composeReturnLayout } from "@/lib/workspace/window/popoutReturnLayout";
import { publishLayoutPush } from "@/lib/workspace/layout/layoutPushChannel";
import { openPopoutWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";

/** popout 데스크탑 이름 — pane 제목을 그대로 쓰되 데스크탑 바에 들어갈 길이로 자른다 */
function popoutDesktopName(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
}

/** Stage an empty destination and observe native creation before retiring any
 * source pane. Revalidate the source after the await and preserve its current
 * selected groups through the same layout commit used by ordinary moves. */
export async function popOutPanels(
  fromDesktopId: string,
  panelIds: readonly string[],
): Promise<string | null> {
  const from = getDockview(fromDesktopId);
  if (!from || panelIds.length === 0) return null;
  const ids = new Set(panelIds);
  const selected = [...ids].map((id) => from.getPanel(id));
  if (selected.some((panel) => !panel)) return null;
  const draftTargets = [...ids].flatMap((panelId) => {
    const owner = { desktopId: fromDesktopId, panelId };
    const agent = agentForChatPane(owner);
    return agent ? [{ owner, target: prepareAgentChatDraftTarget(agent) }] : [];
  });

  const layout = from.toJSON();
  const target = extractPanelIdsFromLayout(layout, ids);
  if (!target) return null;

  const name =
    panelIds.length === 1 ? popoutDesktopName(from.getPanel(panelIds[0])?.title) : undefined;
  const newDesktopId = useStore.getState().addSpace({
    name,
    activate: false,
    kind: "popout",
    originSpaceId: fromDesktopId,
    initialLayout: removePanelIdsFromLayout(target, ids),
    // 닫을 때 원래 슬롯 복원용 — 분리 직전의 원본 레이아웃(pane 포함).
    returnLayout: layout,
  });

  const stagedDestinationIsEmpty = () => {
    const state = useStore.getState();
    const space = state.spaces.find((candidate) => candidate.id === newDesktopId);
    const stagedLayout = state.layouts[newDesktopId];
    return space?.kind === "popout" && space.originSpaceId === fromDesktopId &&
      isSerializedDockviewLayout(stagedLayout) && panelsFromLayout(stagedLayout).length === 0;
  };
  const compensateEmptyDestination = () => {
    const pendingDraft = Object.values(useStore.getState().chatDraftMoves).some((move) =>
      move.role === "source" && move.transfer.destination.desktopId === newDesktopId);
    if (stagedDestinationIsEmpty() && !pendingDraft) useStore.getState().removeSpace(newDesktopId);
    return null;
  };
  try {
    if (!(await openPopoutWindow(newDesktopId, name))) return compensateEmptyDestination();
    const { commitDesktopPaneMove } = await import("@/lib/workspace/dock");
    return await enqueuePaneMove(async () => {
      if (getDockview(fromDesktopId) !== from ||
          !useStore.getState().spaces.some((space) => space.id === fromDesktopId) ||
          selected.some((panel) => !panel || from.getPanel(panel.id) !== panel) ||
          !stagedDestinationIsEmpty()) return compensateEmptyDestination();
      for (const { owner, target } of draftTargets) revalidateAgentChatDraftTarget(target, owner);
      await withAgentChatDraftMoves(
        [...ids].map((panelId) => ({ panelId, fromDesktopId })), newDesktopId, () => {
          if (getDockview(fromDesktopId) !== from || selected.some((panel) => !panel || from.getPanel(panel.id) !== panel) || !stagedDestinationIsEmpty())
            throw new Error("The popout layout changed while transferring drafts.");
      const currentLayout = from.toJSON();
      const currentTarget = extractPanelIdsFromLayout(currentLayout, ids);
      if (!currentTarget) throw new Error("The selected popout groups changed.");
      const plan = planDesktopPaneMove({
        ...useStore.getState().layouts,
        [fromDesktopId]: currentLayout,
        [newDesktopId]: currentTarget,
      }, [...ids].map((panelId) => ({ panelId, fromDesktopId })), newDesktopId);
      if (plan.error || plan.movedPanelIds.length !== ids.size) throw new Error("The selected popout panes changed.");
      return commitDesktopPaneMove({
        ...plan,
        updates: { ...plan.updates, [newDesktopId]: currentTarget },
        touchedDesktopIds: [...new Set([...plan.touchedDesktopIds, newDesktopId])],
      }, newDesktopId);
        }, { newWindowLabel: popoutWindowLabel(newDesktopId) },
      );
      return newDesktopId;
    });
  } catch (error) {
    console.error(`[pane popout:${fromDesktopId}]`, error);
    return compensateEmptyDestination();
  }
}

/** popout 데스크탑의 pane 전부를 원래 데스크탑으로 되돌린다 — tear-out의
 *  역방향(사용자 요청: "다시 돌려놓기"). 원본이 사라졌으면 첫 일반 데스크탑.
 *  전부 이동하면 popout 데스크탑을 제거하고, 이 창이 그 데스크탑을 띄운
 *  popout 창이면 창도 닫는다. 이동은 persisted-layout 경유라 대상 데스크탑이
 *  다른 창(메인)에 있어도 창 간 동기화로 반영된다. */
export async function returnPopoutPanels(popoutDesktopId: string): Promise<boolean> {
  const state = useStore.getState();
  const desktop = state.spaces.find((d) => d.id === popoutDesktopId);
  if (desktop?.kind !== "popout") return false;
  const originAlive =
    desktop.originSpaceId &&
    state.spaces.some((d) => d.id === desktop.originSpaceId && d.kind !== "popout");
  const targetId = originAlive
    ? (desktop.originSpaceId as string)
    : state.spaces.find((d) => d.kind !== "popout")?.id;
  if (!targetId || targetId === popoutDesktopId) return false;

  const api = getDockview(popoutDesktopId);
  const panelIds = api?.panels.map((panel) => panel.id) ?? [];
  if (panelIds.length === 0) return false;
  const { movePanelsToDesktop } = await import("@/lib/workspace/dock");
  const receipt = await movePanelsToDesktop(
    panelIds.map((panelId) => ({ panelId, fromDesktopId: popoutDesktopId })),
    targetId,
  );
  if (receipt.movedPanelIds.length !== panelIds.length) return false;

  // 원래 슬롯 복원(사용자 요청): 원본 pane 집합이 분리 시점과 같으면 append
  // 대신 분리 직전 지오메트리를 되살린다. 패널 params는 항상 현재 값을 쓴다
  // (분리 중 세션 재시작 등으로 갱신된 저널을 스냅샷으로 되감지 않기 위함 —
  // 상세는 composeReturnLayout 주석). 집합이 달라졌으면 append 결과 유지.
  if (targetId === desktop.originSpaceId && desktop.returnLayout !== undefined) {
    const composed = composeReturnLayout(
      desktop.returnLayout,
      useStore.getState().layouts[targetId],
    );
    if (composed !== null) {
      useStore.getState().saveLayout(targetId, composed);
      publishLayoutPush([targetId]);
    }
  }

  useStore.getState().removeSpace(popoutDesktopId);
  const { initialDesktopId, initialPopoutDesktopId } = await import("@/lib/workspace/window/windows");
  // 구(?desktop)·신(?popout) 창 문법 모두 자기 창 판정에 포함 — 컨텍스트 메뉴의
  // "원래 위치로 되돌리기"가 창을 좀비로 남기지 않게 (리뷰 지적).
  if (
    initialDesktopId() === popoutDesktopId ||
    initialPopoutDesktopId() === popoutDesktopId
  ) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close().catch(() => {});
  }
  return true;
}
