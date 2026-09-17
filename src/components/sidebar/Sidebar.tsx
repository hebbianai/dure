import { LoadingStatus } from "@/components/common/PanelStatus";
import { FilesPane } from "@/components/files/FilesPane";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  refreshPluginViewCatalog,
  usePluginViewCatalog,
} from "@/components/plugins/usePluginViewCatalog";
import { ActivityRail } from "@/components/sidebar/ActivityRail";
import { SidebarTitleBar } from "@/components/workspace/WindowTitleBar";
import { SpacesPane } from "@/components/spaces/SpacesPane";
import type { PageId } from "@/components/settings/settingsNav";
import { onOpenSettings } from "@/lib/settings/settingsBus";
import {
  pluginSidebarContainerKey,
  selectPluginSidebarContainer,
} from "@/lib/plugins/pluginSidebarSelection";
import { SIDEBAR_RAIL_WIDTH } from "@/lib/sidebar/windowSidebarState";
import { useEffectiveSidebarTab } from "@/components/workspace/useInterfaceMode";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";

const LazySessionsPane = lazy(() =>
  import("@/components/sessions/SessionsPane").then((module) => ({
    default: module.SessionsPane,
  })),
);
const LazySearchPane = lazy(() =>
  import("@/components/search/SearchPane").then((module) => ({
    default: module.SearchPane,
  })),
);
const LazyDurePluginsPane = lazy(() =>
  import("@/components/sidebar/DurePluginsPane").then((module) => ({
    default: module.DurePluginsPane,
  })),
);
const LazyPluginSidebarContent = lazy(() =>
  import("@/components/plugins/PluginSidebarContent").then((module) => ({
    default: module.PluginSidebarContent,
  })),
);
const LazySshPane = lazy(() =>
  import("@/components/ssh/SshPane").then((module) => ({
    default: module.SshPane,
  })),
);
const LazySourceControlPane = lazy(() =>
  import("@/components/scm/SourceControlPane").then((module) => ({
    default: module.SourceControlPane,
  })),
);
const LazySettingsDialog = lazy(() =>
  import("@/components/settings/SettingsDialog").then((module) => ({
    default: module.SettingsDialog,
  })),
);

const LazyAutomationsPane = lazy(() =>
  import("@/components/automations/AutomationsPane").then((module) => ({
    default: module.AutomationsPane,
  })),
);

function SidebarSurfaceFallback() {
  // The tab panes fill this row by stretch (flex-1, no explicit height); a bare
  // LoadingStatus carries its own h-full, which does not resolve here, so it
  // collapsed to content height and sat at the top. Fill the same way the panes
  // do and centre the loader inside it — vertically as well as across.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
      <LoadingStatus className="h-auto" />
    </div>
  );
}

// ---------- sidebar ----------

export function Sidebar({ fullscreen = false }: { fullscreen?: boolean } = {}) {
  const toggleSidebar = useWindowSidebarStore((state) => state.toggle);
  const sidebarOpen = useWindowSidebarStore((state) => state.open);
  // Basic-mode downgrade shared with the rail — chip and panel agree.
  const sidebarTab = useEffectiveSidebarTab();
  const setSidebarTab = useWindowSidebarStore((state) => state.setTab);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 설정 청크 유휴 프리로드 — fallback 없는 lazy 모달이 첫 클릭에도 즉시 뜬다.
  useEffect(() => {
    const timer = window.setTimeout(
      () => void import("@/components/settings/SettingsDialog"),
      1_500,
    );
    return () => window.clearTimeout(timer);
  }, []);
  const [settingsPage, setSettingsPage] = useState<PageId | undefined>();
  const {
    containers: pluginViewContainers,
    loadState: pluginCatalogLoadState,
  } = usePluginViewCatalog();
  const activePluginContainerKey = useWindowSidebarStore(
    (state) => state.pluginSelection?.containerKey ?? null,
  );
  const selectPluginView = useWindowSidebarStore((state) => state.selectPluginView);
  const activePluginView = selectPluginSidebarContainer(
    pluginViewContainers,
    activePluginContainerKey,
  );
  const effectiveActivePluginContainerKey = activePluginView
    ? pluginSidebarContainerKey(activePluginView)
    : null;
  useEffect(() => {
    // Only a complete catalog can retire a removed navigation target.
    if (pluginCatalogLoadState !== "ready" ||
      activePluginContainerKey === effectiveActivePluginContainerKey) return;
    selectPluginView(null);
  }, [activePluginContainerKey, effectiveActivePluginContainerKey, pluginCatalogLoadState, selectPluginView]);
  // 다른 컴포넌트(사용량 배지 등)의 '설정 열기' 요청 — 지정 페이지로 연다.
  useEffect(
    () =>
      onOpenSettings((page) => {
        setSettingsPage(page as PageId | undefined);
        setSettingsOpen(true);
      }),
    [],
  );
  const sidebarWidth = useWindowSidebarStore((state) => state.width);
  const setSidebarWidth = useWindowSidebarStore((state) => state.setWidth);
  const dragging = useRef(false);
  const [resizing, setResizing] = useState(false);
  const [resizeHandleHovered, setResizeHandleHovered] = useState(false);

  useEffect(() => {
    if (!sidebarOpen) setResizeHandleHovered(false);
  }, [sidebarOpen]);

  // 우측 엣지 드래그로 사이드바 너비 조절.
  // 패널 최소 96px(레일 포함 148px) — 그보다 더 줄이면 패널을 아예 접는다.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const stop = () => {
      dragging.current = false;
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      // 히스테리시스: 최소 너비(aside 207px = 패널 155px)에서 버티다가,
      // 그보다 ~60px 더 끌어내려야(147px 미만) 접힌다.
      if (ev.clientX < 147) {
        stop();
        if (useWindowSidebarStore.getState().open) toggleSidebar();
        return;
      }
      setSidebarWidth(ev.clientX); // 148px 미만은 store에서 최소값으로 클램프
    };
    const onUp = () => stop();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <aside
      // 오른쪽 테두리는 없다. 시안(2070:32023)에서 사이드바와 워크스페이스를
      // 가르는 건 선이 아니라 카드의 8px 여백이다 — 카드가 이미 모서리와
      // 그림자로 자기 경계를 갖고 있어서, 선까지 그으면 8px 틈 안에 선이 하나
      // 더 생겨 두 겹으로 보인다. 레일 오른쪽 헤어라인(ActivityRail)은 그대로
      // 남는다 — 그건 사이드바 안쪽 구획이라 성격이 다르다.
      // overflow-y-hidden과 min-h-0을 함께 준다. CSS는 한 축이 visible이 아니면
      // 다른 축의 visible을 auto로 계산하므로, overflow-x-hidden만 주면 세로가
      // 조용히 스크롤 가능해진다. 게다가 flex 자식은 min-height:auto라 내용이
      // 높이를 넘길 수 있어, 안쪽 ScrollArea 말고 이 프레임까지 스크롤됐다 —
      // 스크롤바가 나란히 두 개 생기고 바깥 것을 끌면 빈 공간이 나왔다
      // (사용자 지적 2026-07-31, External Hmux sessions가 90개를 넘기며 드러남).
      // 스크롤은 안쪽 ScrollArea만 갖는다.
      // 배경을 칠하지 않는다 — 사이드바는 셸 유리면을 그대로 쓰는 열이다.
      // 여기에 backdrop-filter를 따로 걸지도 말 것: 셸이 이미 칠해 놓은 틴트를
      // 집어서 채도가 생 vibrancy가 아니라 틴트에 걸린다 (App.tsx 셸 루트 주석).
      className="sidebar-scroll-region relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-x-hidden overflow-y-hidden text-sidebar-foreground select-none"
      data-sidebar-resize-active={resizing || resizeHandleHovered ? "" : undefined}
      // 저장된 값이 예전 최소값(더 작음)일 수 있으므로 렌더 시에도 클램프.
      // 접힘 폭 = 레일 폭(SIDEBAR_RAIL_WIDTH, 테두리 포함) 그대로. 예전 51px은
      // 여기 있던 헤어라인 1px을 더한 값이었다.
      // contain: 사이드바 콘텐츠(체크포인트·세션 목록)는 실시간 갱신으로 자주
      // dirty해지고 시간과 함께 자란다 — 봉쇄가 없으면 데스크탑 전환 중 치수
      // 읽기가 사이드바 재레이아웃(가변 폰트 인라인 텍스트)까지 지불한다
      // (2026-08-04 노화 열화 프로파일). 폭은 명시값·높이는 flex라 size 봉쇄
      // 안전, 팝오버·드래그 고스트는 전부 portal(2026-08-03 감사).
      style={{
        width: sidebarOpen ? Math.max(207, sidebarWidth) : SIDEBAR_RAIL_WIDTH,
        contain: "strict",
      }}
    >
      {/* 신호등·워드마크·토글 줄은 사이드바 안쪽 맨 위에 산다 — 창 폭 전체를
          가로지르는 chrome 줄을 두면 사이드바 유리가 위에서 잘린다.
          macOS 앱의 사이드바는 창 최상단부터 바닥까지 하나의 열이다. */}
      <SidebarTitleBar fullscreen={fullscreen} />
      {/* 위와 같은 이유로 세로도 명시적으로 막는다 — 스크롤은 안쪽 ScrollArea만. */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-hidden">
      <ActivityRail
        pluginContainers={pluginViewContainers}
        activePluginContainerKey={effectiveActivePluginContainerKey}
        onOpenPluginContainer={(containerKey) => selectPluginView({ containerKey, viewId: null })}
        onOpenSettings={() => {
          setSettingsPage(undefined);
          setSettingsOpen(true);
        }}
      />
      <Suspense fallback={<SidebarSurfaceFallback />}>
        {sidebarOpen && sidebarTab === "spaces" && <SpacesPane />}
        {/* tab id "recovery"는 영속 상태라 유지한다 — 패널만 “세션”으로 승격
            (복구 가능 + 외부 세션 + 최근 세션, 2026-08-01). */}
        {sidebarOpen && sidebarTab === "recovery" && <LazySessionsPane />}
        {sidebarOpen && sidebarTab === "files" && <FilesPane />}
        {sidebarOpen && sidebarTab === "search" && <LazySearchPane />}
        {sidebarOpen && sidebarTab === "extension" && <LazyDurePluginsPane />}
        {sidebarOpen && sidebarTab === "plugin" && (
          <LazyPluginSidebarContent
            contribution={activePluginView}
            loadState={pluginCatalogLoadState}
            onOpenCatalog={() => setSidebarTab("extension")}
            onRetry={() => void refreshPluginViewCatalog()}
          />
        )}
        {sidebarOpen && sidebarTab === "ssh" && <LazySshPane />}
        {sidebarOpen && sidebarTab === "github" && <LazySourceControlPane />}
        {sidebarOpen && sidebarTab === "automations" && <LazyAutomationsPane />}
      </Suspense>
      </div>

      {/* 설정은 모달이라 사이드바 안에 fallback 상자를 그리면 안 된다 —
          청크 로드 동안 하단에 큰 “불러오는 중” 박스가 떴다 사라진다
          (2026-08-03 제보). 아래 유휴 프리로드가 첫 클릭 지연도 없앤다. */}
      {settingsOpen && (
        <Suspense fallback={null}>
          <LazySettingsDialog
            initialPage={settingsPage}
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      )}
      {/* 우측 엣지 리사이즈 핸들 (패널 열림 상태에서만) */}
      {sidebarOpen && (
        <div
          onMouseDown={startResize}
          onMouseEnter={() => setResizeHandleHovered(true)}
          onMouseLeave={() => setResizeHandleHovered(false)}
          onDoubleClick={() => setSidebarWidth(304)}
          className="sidebar-resize-handle absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize bg-transparent"
        />
      )}
    </aside>
  );
}
