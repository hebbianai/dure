// ?popout=<desktopId>로 열린 pane 분리 경량 창 — diff/소스 제어 창과 같은
// bare-root: 사이드바·데스크탑 바·상태 바 없이 그 popout 데스크탑의 pane들만
// 렌더한다(사용자 요청: "다른 desktop 여는 것처럼 무거울 필요 없다").
// Workspace를 그대로 쓰므로 pane drag&drop(재분리 포함)은 동작한다.
// 창 닫기 = pane 원위치 복귀 — App.tsx의 구 popout(?desktop) 핸들러와 같은 계약.
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Undo2 } from "lucide-react";
import { useStore } from "@/store";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Titled } from "@/components/ui/tooltip";
import { Workspace } from "@/components/workspace/Workspace";
import {
  SecondaryWindowShell,
  useSecondaryWindowBoot,
  windowChromeDragHandler,
} from "@/components/workspace/SecondaryWindowShell";
import { installPaneShortcuts } from "@/lib/workspace/pane/paneShortcuts";
import { returnPopoutPanels } from "@/lib/workspace/window/popout";
import {
  useClosePaneShortcut,
  useTerminalFontShortcut,
} from "@/lib/workspace/window/windowShortcutHooks";
import { preloadTerminalFont } from "@/lib/terminal/renderer/terminalFontPreload";
import { installDesktopVisibilityLeasePublisher } from "@/lib/workspace/desktop/desktopVisibilityLeaseRuntime";
import { t } from "@/lib/i18n";
import { PopoutResizeHandles } from "@/components/workspace/PopoutResizeHandles";
import { useDurableWindowClose } from "@/lib/workspace/window/useDurableWindowClose";
import { shellChromeClass, useWindowShellShape } from "@/lib/workspace/window/windowShellShape";
import { cn } from "@/lib/utils";

export function PopoutWindowRoot({ desktopId }: { desktopId: string }) {
  const fullscreen = useWindowShellShape();
  const desktop = useStore((s) => s.spaces.find((d) => d.id === desktopId));
  // Shared secondary-window boot (dark class, language, keyboard focus,
  // store sync, native title following the desktop name).
  const lang = useSecondaryWindowBoot(desktop?.name ?? t("workspace.popout.detachedPane"));
  // Popout도 on-screen desktop 소유자다. 메인 창의 자동 Host rehost가 이
  // desktop을 off-screen으로 오인하지 않도록 동일한 lease를 게시한다.
  useEffect(
    () => installDesktopVisibilityLeasePublisher(desktopId),
    [desktopId],
  );
  // 커스텀 터미널 글꼴 선로드 — 없으면 첫 xterm 셀 측정이 폴백 메트릭으로
  // 이뤄져 fit이 창 크기와 어긋난다(x6r과 같은 부류, App과 동일 처치).
  useEffect(() => {
    preloadTerminalFont(useStore.getState().uiPrefs?.terminalFontFamily ?? "");
  }, []);
  // activeSpaceId는 창별 비영속 상태다. 이 창에서 전역 기본값을 읽는 명령과
  // 메뉴가 popout 데스크탑을 대상으로 삼게 맞춘다. TerminalView 표시 권한은
  // Workspace의 explicit active prop이 별도로 소유한다.
  useEffect(() => {
    const state = useStore.getState();
    if (state.activeSpaceId !== desktopId) state.setActiveSpace(desktopId);
  }, [desktopId]);
  // 이 창에도 pane 단축키를 단다 — 창마다 keydown 리스너가 별개라 App에만
  // 설치하면 분리 창에서는 ⌘W·⌘D·⌥⌘화살표·폰트 조절이 전부 죽는다.
  // 대상 데스크탑을 명시해 다른 창의 pane을 조작하는 사고를 막는다.
  useTerminalFontShortcut();
  useClosePaneShortcut(desktopId);
  useEffect(() => installPaneShortcuts(desktopId), [desktopId]);

  // Return panes, converge this WebView's durable projection, then close.
  useDurableWindowClose({
    prepare: async () => {
      await returnPopoutPanels(desktopId).catch(() => {});
    },
    onFailure: (error) =>
      console.error("[popout] durable close transaction failed", error),
  });

  // 상단 드래그 스트립 — 신호등(overlay) 자리 82px 비움. 드래그는 네이티브
  // drag-region 속성 + JS startDragging 이중화(속성은 자식 요소엔 적용되지
  // 않아 JS 폴백이 제목 글자 위 드래그를 받는다). desktop이 사라진 뒤에도
  // 헤더는 유지 — 창을 옮기고 닫을 수단이 없어지면 안 된다(사용자 피드백).
  const header = (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center gap-2 pr-2 pl-[82px]"
      onMouseDown={windowChromeDragHandler()}
    >
      <span className="pointer-events-none min-w-0 flex-1 truncate text-xs font-medium">
        {desktop?.name ?? t("workspace.popout.detachedPane")}
      </span>
      <Titled title={t("workspace.popout.returnHint")}>
        <button
          type="button"
          className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void getCurrentWindow().close()}
        >
          <Undo2 className="size-3.5" />
          {t("workspace.popout.returnAction")}
        </button>
      </Titled>
    </header>
  );

  return (
    <SecondaryWindowShell
      key={lang}
      // The window is one pane card: the pane surface it already wore, now
      // with the shell's 12px corners and shadow like the other secondary
      // windows — it showed square corners over the rounded native material
      // (owner report 2026-09-10).
      className={cn(
        "popout-window overflow-hidden bg-glass-pane",
        shellChromeClass(fullscreen),
      )}
    >
      <PopoutResizeHandles />
      {header}
      {/* Workspace 루트는 absolute inset-0(데스크 전환 설계) — relative 앵커가
          없으면 뷰포트에 붙어 헤더를 덮고 터미널 fit도 창 전체 기준으로 어긋난다
          (사용자 실측: pane 상단 바가 창 이동 바를 가림). */}
      <div className="relative min-h-0 flex-1">
        {desktop ? (
          <Workspace desktopId={desktopId} active />
        ) : (
          <PanelStatus size="xs">{t("workspace.popout.noDetachedDesktop")}</PanelStatus>
        )}
      </div>
    </SecondaryWindowShell>
  );
}
