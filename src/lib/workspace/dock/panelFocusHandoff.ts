import type { DockviewApi } from "dockview-react";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { restorePanePreservingLayout } from "@/lib/workspace/pane/paneVisibility";
import {
  beginPaneContentFocus,
  cancelPaneContentFocus,
  settlePaneContentFocus,
} from "@/lib/workspace/pane/paneContentFocusHandoff";
import { useStore } from "@/store";

/**
 * 데스크탑 사이의 pane 포커스 인계.
 *
 * 사이드바 스페이스·검색 결과를 클릭하면 그 pane을 앞으로 가져와야 한다. 그
 * pane이 다른 데스크탑에 있으면 먼저 데스크탑을 전환해야 하고, 전환 직후에는
 * 대상 Workspace가 아직 화면에 없을 수 있다. 그래서 대기표를 남기고, 그
 * Workspace가 화면에 올라올 때 소비한다.
 */

const pendingPanelFocus = new Map<string, string>(); // desktopId → panelKey

/** 대기표가 살아 있는 시간. 전환이 정착할 시간을 주고 그 뒤에는 버린다 —
 *  남아 있으면 나중의 무관한 전환에서 되살아나 포커스를 훔친다. */
const PENDING_FOCUS_TTL_MS = 5000;

export function focusPanelContent(
  api: DockviewApi,
  panelKey: string,
): boolean {
  const panel = api.getPanel(panelKey);
  if (!panel) return false;
  const request = beginPaneContentFocus(panel.api);
  try {
    if (!restorePanePreservingLayout(api, panelKey)) {
      cancelPaneContentFocus(panel.api, request);
      return false;
    }
    api.focus();
    settlePaneContentFocus(panel.api, request);
  } catch (error) {
    cancelPaneContentFocus(panel.api, request);
    throw error;
  }
  return true;
}

// peek(삭제 안 함) — StrictMode 이중 마운트가 모두 적용해야 하며 setActive는 멱등.
export function peekPendingPanelFocus(desktopId: string): string | undefined {
  return pendingPanelFocus.get(desktopId);
}

/**
 * 대기 중인 pane을 앞으로 가져온다. 적용했으면 true.
 *
 * 두 곳에서 부른다: dockview `onReady`(최초 마운트)와 데스크탑이 활성화되는
 * 시점(Workspace의 active 효과). 후자가 없으면 안 된다 — 앱은 최근 데스크탑을
 * mount된 채(warm) 들고 있어서 재전환에는 `onReady`가 다시 오지 않고, 그러면
 * 대기표가 소비되지 않아 그 데스크탑에서 직전에 활성이던 pane이 그대로 남는다
 * (사용자 보고 2026-07-30: 다른 데스크탑의 에이전트를 클릭했는데 엉뚱한
 * 터미널이 포커스).
 */
export function applyPendingPanelFocus(desktopId: string): boolean {
  const panelKey = pendingPanelFocus.get(desktopId);
  if (!panelKey) return false;
  const api = dockviewRegistry.get(desktopId);
  return api ? focusPanelContent(api, panelKey) : false;
}

/**
 * 패널을 앞으로 가져오고 그 exact group의 focus transaction을 시작한다(같은
 * 그룹에 겹쳐 있어도 setActive로 전면). 다른 데스크탑이면 전환하고, 그
 * Workspace가 화면에 올라올 때
 * `applyPendingPanelFocus`가 대기표를 읽어 포커스한다.
 *
 * 같은/다른 데스크탑 판단은 스토어의 activeSpaceId로 한다 — registry에 stale
 * (dispose된) api가 남아 있어도 오판하지 않도록.
 */
export function navigateToPanel(desktopId: string, panelKey: string): void {
  if (desktopId === useStore.getState().activeSpaceId) {
    const api = dockviewRegistry.get(desktopId);
    if (api) focusPanelContent(api, panelKey);
    return;
  }
  pendingPanelFocus.set(desktopId, panelKey);
  setTimeout(() => pendingPanelFocus.delete(desktopId), PENDING_FOCUS_TTL_MS);
  useStore.getState().setActiveSpace(desktopId);
}
