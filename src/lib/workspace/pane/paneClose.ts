// pane 닫기 — 닫기 전에 지켜야 할 확인을 한 곳에서 거친다. 닫기 경로가 여럿이라
// (PaneChrome의 X, ⌘W, 컨텍스트 메뉴) 판단과 다이얼로그 카피를 여기 한 곳에 둔다.
// 확인은 고정된 pane 보호(설정으로 켜고 끔) 하나다 — legacy 런타임 은퇴
// (2026-08-16) 후 pane 닫기는 항상 뷰만 닫는다: Hmux 세션은 Host가 소유해
// 살아남고, 은퇴한 legacy pane은 소유한 세션이 없다.
// 판단 자체는 lib/panePin.ts의 순수 함수가 하고, 여기는 store·다이얼로그
// 배선이다.

import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  departHmuxPaneExplicitly,
  departRemoteHmuxPaneExplicitly,
  planExplicitHmuxPaneDeparture,
  planExplicitRemoteHmuxPaneDeparture,
} from "@/lib/hmux/hmuxPaneRetirement";
import { shouldConfirmPaneClose } from "@/lib/workspace/pane/panePin";
import { t } from "@/lib/i18n";
import type { HmuxPaneDepartureReceipt } from "@/lib/ipc";
import { isTerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { useStore, DEFAULT_UI_PREFS } from "@/store";

export interface ClosablePane {
  /** panel id (표시·로그용) */
  id: string;
  /** 고정 기록 키 — panePinKey(desktopId, paneId) */
  pinKey: string;
  title?: string;
  /** dockview panel params — Hmux 명시적 departure 계획에 쓴다. */
  params?: unknown;
  /** Runs only after the user has authorized this explicit close. */
  beforeClose?: () => Promise<unknown>;
  close: () => unknown | Promise<unknown>;
}

export async function prepareExplicitHmuxPaneClose(input: {
  desktopId: string;
  panelId: string;
  params?: unknown;
}): Promise<HmuxPaneDepartureReceipt | null> {
  // 타입 가드는 인자 식(params?.binding)을 좁힐 뿐 params 자체를 좁히지
  // 못한다 — 후보를 변수로 내려 가드가 그 변수를 좁히게 한다.
  const candidate = (input.params as { binding?: unknown } | undefined)?.binding;
  const binding = isTerminalPaneBindingV1(candidate) ? candidate : undefined;
  const identity = {
    windowLabel: getCurrentWindow().label,
    desktopId: input.desktopId,
    panelId: input.panelId,
    binding,
  };
  if (binding?.source === "ssh") {
    return departRemoteHmuxPaneExplicitly(
      planExplicitRemoteHmuxPaneDeparture(identity),
      useStore.getState().sshHosts,
    );
  }
  return departHmuxPaneExplicitly(planExplicitHmuxPaneDeparture(identity));
}

async function closeAuthorizedPane(pane: ClosablePane): Promise<void> {
  await pane.beforeClose?.().catch(() => {});
  await pane.close();
}

/**
 * 닫기 확인(고정 보호)을 거치고 pane을 닫는다. 실제로 닫았으면 true.
 * 세션 종료 확인은 없다 — pane 닫기는 언제나 뷰만 닫는다.
 */
export async function closePaneWithPinGuard(pane: ClosablePane): Promise<boolean> {
  const state = useStore.getState();
  const confirmEnabled =
    state.uiPrefs?.confirmClosePinnedTab ?? DEFAULT_UI_PREFS.confirmClosePinnedTab;
  const pinnedConfirm = shouldConfirmPaneClose({
    pinned: state.pinnedPanes,
    paneId: pane.pinKey,
    confirmEnabled,
  });
  if (!pinnedConfirm) {
    await closeAuthorizedPane(pane);
    return true;
  }
  const name = pane.title || pane.id;
  const ok = await confirmDialog(
    t("workspace.paneClose.pinnedConfirm", { name }),
    {
      title: t("workspace.paneClose.pinnedTitle"),
      kind: "warning",
    },
  );
  if (!ok) return false;
  await closeAuthorizedPane(pane);
  return true;
}
