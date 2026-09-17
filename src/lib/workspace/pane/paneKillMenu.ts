// 터미널/에이전트 pane 본문 컨텍스트 메뉴의 닫기 항목. legacy 런타임 은퇴
// (2026-08-16) 후에는 세션이 살아남는 뷰 닫기(X 버튼과 같은 가드) 한 갈래만
// 남았다 — 라벨·색·확인 여부가 실제 결과와 일치하도록 여기서 만든다.

import { t } from "@/lib/i18n";
import { closePaneWithPinGuard } from "@/lib/workspace/pane/paneClose";
import { panePinKey } from "@/lib/workspace/pane/panePin";

export interface PaneKillMenuProps {
  killLabel: string;
  killDestructive: boolean;
  onKill: () => void;
}

/** 세션이 살아남는 뷰 닫기 — X 버튼과 같은 가드(고정 보호)를 거친다. */
export function paneViewCloseMenu(input: {
  panelId: string;
  desktopId?: string;
  title?: string;
  params?: unknown;
  close: () => unknown | Promise<unknown>;
}): PaneKillMenuProps {
  return {
    killLabel: t("common.closePane"),
    killDestructive: false,
    onKill: () =>
      void closePaneWithPinGuard({
        id: input.panelId,
        pinKey: panePinKey(input.desktopId, input.panelId),
        title: input.title,
        params: input.params,
        close: input.close,
      }),
  };
}
