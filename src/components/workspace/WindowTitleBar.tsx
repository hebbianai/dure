import { PanelLeft } from "lucide-react";
import { PaneHistoryNav } from "@/components/workspace/PaneHistoryNav";
import { BackendSkewChip } from "@/components/workspace/BackendSkewChip";
import { PinpointButton } from "@/components/design/PinpointButton";
import { windowChromeDragHandler } from "@/components/workspace/SecondaryWindowShell";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import { useTrafficLightMetrics } from "@/lib/workspace/window/windows";
import { SIDEBAR_RAIL_WIDTH } from "@/lib/sidebar/windowSidebarState";
import {
  collapsedToggleLeavesRail,
  collapsedToggleWorkspaceInset,
  TOGGLE_TRAILING_INSET,
  collapsedToggleInset,
  trafficLightSpacerWidth,
} from "@/lib/workspace/window/windowShellShape";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";

/**
 * 사이드바 열의 chrome 줄 — 사이드바 **안쪽** 맨 위에 산다.
 *
 * 창 폭 전체를 가로지르던 한 줄을 열별로 쪼갠 것이다. 가로 바가 창을 위아래로
 * 나누면 사이드바 유리가 위에서 잘리는데, macOS 앱(Finder·Mail·Xcode)의
 * 사이드바는 창 최상단부터 바닥까지 끊기지 않는 하나의 열이고 신호등이 그 열
 * 안에 앉는다. 그 구조를 따른다.
 *
 * macOS 신호등은 tauri titleBarStyle=Overlay의 네이티브 버튼이라 그리지 않고
 * 82px 여백으로 자리만 비운다 (Figma 464:27438). 다른 플랫폼은 네이티브 창
 * 장식을 유지하고 작은 콘텐츠 여백만 쓴다. 전체화면에서는 macOS가 신호등을
 * 감추므로 그 자리를 접는다 (windowShellShape).
 */
export function SidebarTitleBar({ fullscreen = false }: { fullscreen?: boolean }) {
  const macPlatform = isMacPlatform();
  const sidebarOpen = useWindowSidebarStore((state) => state.open);
  const toggleSidebar = useWindowSidebarStore((state) => state.toggle);
  // 빈 영역 드래그로 창 이동, 더블클릭으로 최대화 (구 TopBar 동작) — 두
  // chrome 줄이 같은 핸들러를 가져야 창 위쪽 어디를 잡아도 똑같이 끌린다.
  const onMouseDown = windowChromeDragHandler();
  // 워드마크를 신호등 실측 끝에서 일정 간격 뒤에 붙인다.
  const trafficLightRight = useTrafficLightMetrics((state) => state.right);

  return (
    <div
      className={cn(
        "flex h-[var(--app-chrome-bar-height)] shrink-0 items-center justify-between text-sidebar-foreground select-none",
        // 접힘에서는 워드마크가 없어 이 간격이 토글을 오른쪽으로 밀기만 한다.
        sidebarOpen && "gap-2",
      )}
      // 오른쪽 여백은 접힘/펼침이 같다 — 시안 2156:23585는 두 경우 모두 16px
      // 아이콘을 컨테이너 오른쪽에서 14px에 둔다(300 폭에서 아이콘 끝 286).
      style={{ paddingRight: TOGGLE_TRAILING_INSET }}
      onMouseDown={onMouseDown}
    >
      <div className="flex min-w-0 items-center">
        <span
          className="shrink-0"
          style={{
            width: sidebarOpen
              ? trafficLightSpacerWidth(macPlatform, fullscreen, trafficLightRight)
              : collapsedToggleInset(macPlatform, fullscreen, trafficLightRight),
          }}
          aria-hidden="true"
        />
        {/* 신호등 바로 옆 [토글][뒤로][앞으로] — 소유자 참조 2026-09-01
            (브라우저·IDE에서 흔한 배열). 워드마크는 그 자리를 내주고 물러났다. */}
        {(sidebarOpen || !collapsedToggleLeavesRail(macPlatform, fullscreen)) && (
          <span className="flex shrink-0 items-center gap-0.5" data-nodrag>
            <IconButton
              title={sidebarOpen ? t("workspace.titleBar.collapseSidebar") : t("workspace.titleBar.openSidebar")}
              className="size-6 shrink-0 rounded-md hover:bg-glass-tint-hover [&_svg]:size-4"
              onClick={toggleSidebar}
            >
              <PanelLeft />
            </IconButton>
            <PaneHistoryNav />
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 워크스페이스 열의 chrome 줄 — 사이드바 오른쪽에서만 시작한다.
 *
 * 데스크탑 탭(2070:32171)과 앱 전역 액션이 여기 산다. 사이드바 열의
 * SidebarTitleBar와 같은 높이라 두 줄이 한 줄처럼 이어져 보이지만, 표면은
 * 각자의 열에 속한다 — 그래서 사이드바 유리가 위에서 잘리지 않는다.
 *
 * 이 줄에는 아래 경계선이 없다. 워크스페이스 쪽 경계는 pane 카드의 8px 여백과
 * 모서리가 맡는다 (App.tsx, 시안 2070:32418).
 */
export function WorkspaceTitleBar({
  children,
  fullscreen = false,
}: {
  children?: React.ReactNode;
  fullscreen?: boolean;
}) {
  const onMouseDown = windowChromeDragHandler();

  return (
    <div
      className="z-10 flex h-[var(--app-chrome-bar-height)] shrink-0 items-center text-sidebar-foreground select-none"
      onMouseDown={onMouseDown}
    >
      <CollapsedSidebarToggle fullscreen={fullscreen} />
      {children}
      <div className="ml-auto flex shrink-0 items-center gap-1 pr-3" data-nodrag>
        {/* Pane balancing is a Space's verb and lives in the Space tab's menu
            (DesktopBar); this cluster is for what spans the app. */}
        {/* Pinpoint는 pane이 아니라 앱 전역 모드라 창 chrome에 둔다 —
            PinpointButton 헤더 참조. */}
        <PinpointButton />
        <BackendSkewChip />
      </div>
    </div>
  );
}

/**
 * 사이드바가 접혔을 때의 토글 — 사이드바 레일이 아니라 이 줄에 산다.
 *
 * 레일은 52px이고 신호등이 그 위를 덮는다. 레일 안에 두면 글리프가 창 왼쪽
 * 22px, 즉 닫기 버튼 정중앙에 겹친다(2026-08-07 사용자 보고). 그래서 펼쳤을 때
 * 워드마크가 서는 바로 그 자리에 놓는다 — 접었다 폈을 때 토글과 워드마크가
 * 같은 x에서 교대한다.
 */
function CollapsedSidebarToggle({ fullscreen }: { fullscreen: boolean }) {
  const macPlatform = isMacPlatform();
  const sidebarOpen = useWindowSidebarStore((state) => state.open);
  const toggleSidebar = useWindowSidebarStore((state) => state.toggle);
  const trafficLightRight = useTrafficLightMetrics((state) => state.right);

  if (sidebarOpen || !collapsedToggleLeavesRail(macPlatform, fullscreen)) return null;
  return (
    <div
      className="shrink-0"
      style={{
        marginLeft: collapsedToggleWorkspaceInset(
          macPlatform,
          fullscreen,
          SIDEBAR_RAIL_WIDTH,
          trafficLightRight,
        ),
      }}
      data-nodrag
    >
      <span className="flex shrink-0 items-center gap-0.5">
        <IconButton
          title={t("workspace.titleBar.openSidebar")}
          className="size-6 shrink-0 rounded-md hover:bg-glass-tint-hover [&_svg]:size-4"
          onClick={toggleSidebar}
        >
          <PanelLeft />
        </IconButton>
        <PaneHistoryNav />
      </span>
    </div>
  );
}
