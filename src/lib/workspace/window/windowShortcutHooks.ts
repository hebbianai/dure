// 창 단위 키보드 단축키 훅 — App 루트뿐 아니라 popout 등 bare 창 루트도 같은
// 훅을 마운트한다. 창(웹뷰)마다 keydown 리스너가 별개라, App에만 설치하면
// 분리된 창에서는 설정에 "활성"이라 표시된 단축키가 전부 죽는다
// (2026-08-01 UX 검수). 로직은 App.tsx에서 그대로 옮겨 왔다.

import { useEffect } from "react";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { closePaneWithPinGuard } from "@/lib/workspace/pane/paneClose";
import { closePanelById } from "@/lib/workspace/pane/paneCloseCoordinator";
import { panePinKey } from "@/lib/workspace/pane/panePin";
import { matchesChord, shortcutChord } from "@/lib/settings/shortcutBindings";
import { shouldYieldToTerminal } from "@/lib/settings/shortcutPriority";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@/lib/terminal/renderer/terminalFont";
import { useStore } from "@/store";

/** Cmd/Ctrl +/-/0 로 터미널 폰트 크기 조절 (모든 로컬·SSH 터미널 공통) */
export function useTerminalFontShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 수정 키 사전 필터를 두지 않는다 — 재지정한 조합이 ⌘를 안 쓸 수도 있어서,
      // 어떤 조합인지는 전적으로 shortcutChord/matchesChord가 정한다. 기본값은
      // 카탈로그(⌘+ / ⌘− / ⌘0) 그대로라 재지정 전에는 동작이 바뀌지 않는다.
      const set = useStore.getState().setTerminalFontSize;
      const overrides = useStore.getState().shortcutOverrides;
      if (matchesChord(shortcutChord("font-inc", overrides), e)) {
        e.preventDefault();
        set((n) => n + 1);
      } else if (matchesChord(shortcutChord("font-dec", overrides), e)) {
        e.preventDefault();
        set((n) => n - 1);
      } else if (matchesChord(shortcutChord("font-reset", overrides), e)) {
        e.preventDefault();
        set(DEFAULT_TERMINAL_FONT_SIZE);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** Ctrl/Cmd+W → 활성 pane(패널) 닫기. 명시적 Hmux departure receipt를 먼저
 *  받은 뒤 Dockview를 제거하고, Workspace는 view detach/legacy cleanup만 한다.
 *
 *  targetDesktopId: popout 창처럼 이 창이 항상 한 데스크탑만 그릴 때 넘긴다 —
 *  activeSpaceId는 메인 창 기준이라, 그대로 쓰면 이 창의 ⌘W가 다른 창의
 *  pane을 persisted 경로로 닫아버릴 수 있다. */
export function useClosePaneShortcut(targetDesktopId?: string) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesChord(shortcutChord("close-pane", useStore.getState().shortcutOverrides), e)) {
        return;
      }
      // 설정: 'Terminal 먼저'면 터미널 포커스 중 Cmd+W를 터미널로 넘긴다
      if (shouldYieldToTerminal()) return;
      const desktopId = targetDesktopId ?? useStore.getState().activeSpaceId;
      const api = getDockview(desktopId);
      const active = api?.activePanel;
      if (!active) return;
      e.preventDefault();
      // 고정·세션 종료 확인을 거친다 (설정 › 일반 › 탐색). X 버튼과 같은 경로.
      void closePaneWithPinGuard({
        id: active.api.id,
        pinKey: panePinKey(desktopId, active.api.id),
        title: active.api.title,
        params: active.params,
        close: () => closePanelById(active.api.id, desktopId),
      });
    };
    // 캡처 단계 — 터미널(xterm)이 키를 먼저 삼키기 전에 가로챈다.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [targetDesktopId]);
}
