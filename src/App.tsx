import { useEffect } from "react";
import { DesktopBar } from "@/components/workspace/DesktopBar";
import { LazyNativeSearchDialog } from "@/components/search/LazyNativeSearchDialog";
import { LazyQuickDispatchOverlay } from "@/components/agents/quickDispatch/LazyQuickDispatchOverlay";
import { LazyFeedbackDialog } from "@/components/feedback/LazyFeedbackDialog";
import { AgentUsageLimitHandoffHost } from "@/components/agents/chat/AgentUsageLimitHandoffHost";
import { AgentRemovalDialogHost } from "@/components/agents/AgentRemovalDialogHost";
import { SshRegistrationDialog } from "@/components/ssh/SshRegistrationDialog";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { BriefToasts, Toaster } from "@/components/Toaster";
import { WorkspaceTitleBar } from "@/components/workspace/WindowTitleBar";
import { WorkspaceDeck } from "@/components/workspace/WorkspaceDeck";
import { visibleActiveDesktopId } from "@/lib/workspace/desktop/activeDesktop";
import { installAgentAttentionWatch } from "@/lib/agents/agentAttentionWatch";
import { installAgentTracker } from "@/lib/agents/agentTracker";
import { detectInstalledProviders } from "@/lib/agents/agentInstalls";
import { installAutomaticManagedRehostService } from "@/lib/sessions/managed/automaticManagedRehostService";
import { installAutomaticManagedShellService } from "@/lib/sessions/managed/automaticManagedShellService";
import { startBackendCompatibilityWatch } from "@/lib/platform/backendCompatibilityStore";
import { resumeInterruptedQuickDispatchIntents } from "@/lib/agents/quickDispatch/quickDispatchRun";
import { resumeInterruptedSpawnSagas } from "@/lib/sessions/launch/spawnResume";
import { resumeInterruptedDelegateOnceIntents } from "@/lib/workflows/delegateOnceRuntime";
import { installDeferredCredentialSwitchWatch } from "@/lib/sessions/credentials/deferredCredentialSwitchRuntime";
import { installDesktopVisibilityLeasePublisher } from "@/lib/workspace/desktop/desktopVisibilityLeaseRuntime";
import { replayDesktopCloseIntents } from "@/lib/workspace/desktop/desktopCloseIntent";
import { replayPaneCloseIntents } from "@/lib/workspace/pane/paneCloseIntent";
import { startDiffReviewTargetRetention } from "@/lib/scm/review/diffReviewRetention";
import {
  useClosePaneShortcut,
  useTerminalFontShortcut,
} from "@/lib/workspace/window/windowShortcutHooks";
import { codeEditorModule } from "@/components/editor/codeEditorModule";
import { scheduleIdlePrefetch } from "@/lib/editor/editorChunkPrefetch";
import { installPaneShortcuts } from "@/lib/workspace/pane/paneShortcuts";
import { startFocusCtxBroadcast } from "@/lib/scm/focusCtxBroadcast";
import { startGitStatusPoller } from "@/lib/scm/status/gitStatusPoller";
import { returnPopoutPanels } from "@/lib/workspace/window/popout";
import { installHmuxControlPlaneCensusRuntime } from "@/lib/hmux/identity/hmuxControlPlaneCensusRuntime";
import { openSettingsPage } from "@/lib/settings/settingsBus";
import { DesignModeLayer } from "@/components/design/DesignModeLayer";
import { toggleDesignMode } from "@/lib/design/designModeRuntime";
import { initializeSshCredentialLifecycle } from "@/lib/ssh/sshCredentialLifecycle";
import { preloadTerminalFont } from "@/lib/terminal/renderer/terminalFontPreload";
import { useRootDarkClass } from "@/lib/theme/themePreference";
import { startUpdateNoticeRuntime } from "@/lib/updates/updateRuntime";
import { useAppLanguage } from "@/components/settings/useAppLanguage";
import { useProviderLaunchDefaultsProjection } from "@/components/settings/useProviderLaunchDefaultsProjection";
import { cn } from "@/lib/utils";
import { useDurableWindowClose } from "@/lib/workspace/window/useDurableWindowClose";
import { installDureClientViewWorkspaceSync } from "@/lib/workspace/clientViewWorkspaceSync";
import { startMainWindowGlobalServices } from "@/lib/workspace/mainWindowGlobalServices";
import { useNativeWindowTheme } from "@/lib/platform/windowAppearance";
import { useResolvedDark } from "@/lib/theme/themePreference";
import { shellChromeClass, useWindowShellShape } from "@/lib/workspace/window/windowShellShape";
import { useSidebarShortcut } from "@/lib/sidebar/useSidebarShortcut";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import {
  initialDesktopId,
  isMainWindow,
  rememberedMainDesktopId,
  rememberMainDesktopId,
  startWebviewKeyboardFocus,
  startWindowSync,
  useNativeShellGlass,
  useNativeTrafficLightDrop,
} from "@/lib/workspace/window/windows";
import { useStore } from "@/store";
import { matchesChord, shortcutChord } from "@/lib/settings/shortcutBindings";
import { useHubSessionFile } from "@/components/hub/useHubSessionFile";
import { useHubFileDiff } from "@/components/hub/useHubFileDiff";
import { useHubGitStatus } from "@/components/hub/useHubGitStatus";
import { useFleetHmuxCurrency } from "@/components/hub/useFleetHmuxCurrency";
import { useHubResume } from "@/components/hub/useHubResume";
import { useHubLaunchOffer } from "@/components/hub/useHubLaunchOffer";
import { useHubSidebarLayout } from "@/components/hub/useHubSidebarLayout";
import { useHubStartAgent } from "@/components/hub/useHubStartAgent";
import { hubPublishLaunchOffer, hubSetSidebarLayout } from "@/lib/ipc/system";

function useBackendCompatibility() {
  // 일회성 검사가 아니라 주기 감시 — dev에선 프론트만 리로드되어 skew가
  // 나중에 생기고, 그 상태의 연결 오류는 원인 불명으로 보인다 (bd 5hc).
  useEffect(() => (isMainWindow() ? startBackendCompatibilityWatch() : undefined), []);
}

function useHmuxControlPlaneCensus() {
  useEffect(() => installHmuxControlPlaneCensusRuntime(), []);
}

/** Global agent activity tracker: derives working / waiting / exited states
 *  shown across the UI from the Hmux Host's semantic runtime reports. The
 *  legacy output-sniffing/exists-reconcile tier retired with the PTY/SSH
 *  daemons (2026-08-16) — hmux lifecycle is owned by the control-plane census
 *  and hook reports, which land in sessionAgentRuntimeState. */
function useAgentTracker() {
  useEffect(() => installAgentTracker(), []);
}

/** Source-control hints run one worktree at a time, outside presentation work. */
function useGitPoller() {
  useEffect(() => (isMainWindow() ? startGitStatusPoller() : undefined), []);
}

/** Cmd/Ctrl+, → 설정 열기 (macOS 표준 관례). Sidebar가 settingsBus 요청을
 *  받아 다이얼로그를 연다. 캡처 단계 — 터미널이 키를 삼키기 전에 가로챈다. */
function useOpenSettingsShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 다른 전역 단축키와 같은 해석 계층을 거친다 — 그러지 않으면 설정에서
      // 조합을 받는 중에도 ⌘,가 발동해 다이얼로그가 다른 페이지로 넘어가고,
      // ⌘,에 다른 명령을 지정해도 충돌로 잡히지 않는다.
      if (!matchesChord(shortcutChord("open-settings", useStore.getState().shortcutOverrides), e)) {
        return;
      }
      e.preventDefault();
      openSettingsPage();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** Design Mode 토글 (⌥⇧D) — 요소를 클릭해 HTML·CSS를 캡처한다.
 *
 *  dev 빌드 전용이다. 대상이 Dure 자기 UI이므로 이 기능의 수혜자는 Dure를 고치는
 *  사람이고, 소스 위치(data-dure-src)도 dev 빌드에만 심긴다. 사용자 앱을 대상으로
 *  하는 프로덕션 기능은 별도 표면(webview 브라우저 창)이다 —
 *  src/lib/design/designModeCapture.ts 참조. */
function useDesignModeShortcut() {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return;
      // ⌥⇧D는 레이아웃에 따라 key가 'D'가 아닐 수 있어 code로 본다.
      if (e.code !== "KeyD") return;
      e.preventDefault();
      void toggleDesignMode();
    };
    // 캡처 단계 — 터미널(xterm)이 키를 먼저 삼키기 전에 가로챈다.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export default function App() {
  const spaces = useStore((s) => s.spaces);
  const activeSpaceId = useStore((s) => s.activeSpaceId);
  const activeVisible = visibleActiveDesktopId(spaces, activeSpaceId);
  const sidebarOpen = useWindowSidebarStore((state) => state.open);
  // 언어: 모듈 전역에 반영하고 루트 key 리마운트로 전체 UI에 전파.
  // bare-root 창들도 같은 훅을 써야 한다 — 창마다 i18n 전역이 별개다.
  const lang = useAppLanguage();

  useAgentTracker();
  useBackendCompatibility();
  useProviderLaunchDefaultsProjection();
  // 사이드바 묶음을 허브에게 알린다. 사이드바 컴포넌트가 아니라 여기 거는 이유는
  // 접어 둔 채로 세션을 옮긴 사람의 폰이 옛 묶음을 계속 보게 되기 때문이다.
  useHubSidebarLayout(hubSetSidebarLayout);
  useHubLaunchOffer(hubPublishLaunchOffer);
  useHubStartAgent();
  useHubGitStatus();
  useHubFileDiff();
  useHubSessionFile();
  useFleetHmuxCurrency();
  useHubResume();
  useHmuxControlPlaneCensus();
  useGitPoller();
  useTerminalFontShortcut();
  useClosePaneShortcut();
  useDesignModeShortcut();
  useOpenSettingsShortcut();
  useSidebarShortcut();
  useEffect(() => scheduleIdlePrefetch(codeEditorModule.preload, window), []);
  useEffect(() => {
    if (isMainWindow()) {
      replayPaneCloseIntents();
      replayDesktopCloseIntents();
    }
  }, []);
  // 커스텀 터미널 글꼴 선로드 — 첫 xterm 셀 측정이 폴백 메트릭으로 이뤄져
  // fonts.ready 재fit 때 폭이 스냅되는 것 방지 (x6r).
  useEffect(() => {
    preloadTerminalFont(useStore.getState().uiPrefs?.terminalFontFamily ?? "");
  }, []);
  // 소스 제어 별도 창의 follow 모드용 포커스 컨텍스트 방송 (slds).
  // 메인 창만 — popout 데스크탑 창도 App을 렌더하는데, 거기서도 방송하면
  // 마운트 시 초기 null이 방송을 덮어 SCM follow 창이 리셋된다(리뷰 지적).
  useEffect(() => {
    if (!isMainWindow()) return;
    return startFocusCtxBroadcast();
  }, []);
  // Every state-owning window drains its origin-wide writer transaction before
  // native close. Legacy desktop popouts first return their panes; a failed
  // return still leaves the durable desktop recoverable from Spaces.
  useDurableWindowClose({
    prepare: async () => {
      const id = initialDesktopId();
      if (
        id &&
        useStore.getState().spaces.find((space) => space.id === id)?.kind ===
          "popout"
      ) {
        await returnPopoutPanels(id).catch(() => {});
      }
    },
    onFailure: (error) =>
      console.error("[window] durable close transaction failed", error),
  });
  // 해석된 테마를 <html>의 .dark 클래스로 반영 — 포털 포함 창 전체가 이 한
  // 곳에서 테마를 받는다 (컴포넌트별 dark 클래스 재부여 금지).
  useRootDarkClass();
  // 유리 material은 창 외형을 따른다 — 시스템이 아니라 앱 테마에 맞춘다.
  useNativeWindowTheme();
  // 셸 모서리는 창 모드에서만 — 전체화면에서는 창 모서리라는 게 없다.
  const fullscreen = useWindowShellShape();
  // 셸 유리의 네이티브 속성 둘을 여기서 맞춘다 (windows.ts):
  //  - 모서리: CSS와 네이티브 effect가 각각 깎으므로, 전체화면에서 CSS만 떼면
  //    네이티브 반경이 남아 화면 네 귀퉁이가 파인다.
  //  - 외형: 창 NSAppearance가 effect 뷰까지 전파되지 않는 경우가 있다. 어긋나면
  //    다크 UI 뒤에 라이트 material이 깔려, 흰 글자가 밝은 면 위에 놓여 안 읽힌다.
  useNativeShellGlass(fullscreen, useResolvedDark());
  // 네이티브 신호등을 44px chrome 줄 중앙으로 내린다 — 기본 위치는 28px
  // 타이틀바 기준이라 우리 줄에서는 8px 위로 치우친다.
  useNativeTrafficLightDrop(fullscreen);
  // 설치된 에이전트 CLI 훑기 — 메뉴에 어떤 에이전트를 띄울지 정한다.
  useEffect(() => {
    void detectInstalledProviders()
      .then(useStore.getState().setInstalledAgents)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!isMainWindow()) return;
    void initializeSshCredentialLifecycle().catch((error) => {
      // Preserve Host references when the registry or Keychain is unavailable.
      // A later launch retries reconciliation and legacy migration.
      console.error("[ssh credential lifecycle]", error);
    });
  }, []);
  useEffect(() => startWindowSync(), []);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void installDureClientViewWorkspaceSync()
      .then((installed) => {
        if (disposed) installed();
        else stop = installed;
      })
      .catch((error) => console.error("[dure client view sync]", error));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  // pane 분할·포커스 이동 단축키 — 카탈로그·오버라이드는 lib/paneShortcuts.
  useEffect(() => installPaneShortcuts(), []);
  useEffect(() => startDiffReviewTargetRetention(), []);
  // 새 창은 웹뷰가 키보드 first responder가 아닌 채로 뜬다 → 입력 자체가 안 됨.
  useEffect(() => startWebviewKeyboardFocus(), []);
  useEffect(() => {
    // 보조 창은 URL로 지정된 데스크탑을 우선하고, 메인 창은 마지막 선택을
    // 복원한다. activeDesktopId 자체는 비영속으로 유지해 창끼리 간섭하지 않는다.
    const explicit = initialDesktopId();
    const mainWindow = explicit === null;
    const state = useStore.getState();
    const candidate = explicit ?? rememberedMainDesktopId();
    const target =
      state.spaces.find((space) => space.id === candidate)?.id ?? state.spaces[0]?.id;
    if (target && target !== state.activeSpaceId) state.setActiveSpace(target);
    if (mainWindow && target) rememberMainDesktopId(target);

    if (!mainWindow) return;
    return useStore.subscribe((next, previous) => {
      if (next.activeSpaceId !== previous.activeSpaceId) {
        rememberMainDesktopId(next.activeSpaceId);
      }
    });
  }, []);
  // 각 workspace 창이 화면에 보이는 desktop을 짧은 lease로 게시한다. 자동
  // rehost는 live 창 하나라도 fresh lease가 없으면 fail-closed로 멈춘다.
  useEffect(() => installDesktopVisibilityLeasePublisher(), []);
  // Durable spawn/delegation intents resume once per boot in the main window,
  // after the CLI server is listening so completion events keep normal wiring.
  useEffect(() => {
    if (!isMainWindow()) return;
    void resumeInterruptedSpawnSagas();
    void resumeInterruptedDelegateOnceIntents();
    void resumeInterruptedQuickDispatchIntents();
  }, []);
  // The main window projects app and agent-tooling updates without duplicating
  // installation authority in auxiliary windows.
  useEffect(() => {
    if (!isMainWindow()) return;
    return startUpdateNoticeRuntime();
  }, []);
  // attention watcher — 해석 표시 상태·에피소드의 단일 생산자.
  // 모든 창에서 돈다 (dot/unread는 창별 스토어).
  useEffect(() => installAgentAttentionWatch(), []);
  // turn 완료 뒤 credential 교체는 durable intent를 소비하는 메인 창 한 곳만
  // 실행한다. 보조 WebView는 rehost sync receipt만 적용한다.
  useEffect(() => {
    if (!isMainWindow()) return;
    return installDeferredCredentialSwitchWatch();
  }, []);
  // 구형 managed Host는 exact idle/off-screen generation만 메인 창 한 곳에서
  // journal-first로 점진 교체한다. credential switch와 visible pane은 제외된다.
  useEffect(() => {
    if (!isMainWindow()) return;
    return installAutomaticManagedRehostService();
  }, []);
  // Dure가 만든 구형 standalone 일반 shell은 off-screen + idle 상태에서만
  // managed local-shell로 승격한다. 외부/imported standalone은 건드리지 않는다.
  useEffect(() => {
    if (!isMainWindow()) return;
    return installAutomaticManagedShellService();
  }, []);
  // 전역 서비스(스케줄러·레지스트리)는 메인 창에서만 실행한다.
  useEffect(() => {
    if (!isMainWindow()) return;
    return startMainWindowGlobalServices();
  }, []);
  // 각 창은 독립된 bounded warm set을 유지한다. 최근 Dockview와 터미널 연결을
  // 살려 재전환을 즉시 처리하고, 아직 방문하지 않은 인접 화면만 idle에 준비한다.
  // 창 최상단 한 줄이 chrome 전용이다 — 워드마크·사이드바 토글에 이어 데스크탑
  // 탭까지 그 줄이 담고(2070:32171), 워크스페이스는 그 아래에서 시작한다.
  return (
    <div
      key={lang}
      className={cn(
        // 셸 = 유일한 유리면. 흐림·색은 전부 창 뒤 NSVisualEffectView가 만들고,
        // CSS는 그 위에 얇은 틴트만 얹는다.
        //
        // 예전에 여기 backdrop-filter(.glass-vibrancy)로 채도를 올렸는데 걷어냈다.
        // CSS 명세상 backdrop-filter의 backdrop root는 **문서 안쪽**이라 창 밖
        // 네이티브 뷰는 샘플링 대상이 아니다 — 없는 것을 필터링하고 있었다.
        // 되살리지 말 것: 효과가 없을 뿐 아니라 전체 화면 요소를 합성 레이어로
        // 올려 투명 창의 punch-through를 위협한다.
        //
        // 알파를 0으로 두면 안 된다. 사이드바 글자의 대비 하한이 통째로 사라져
        // 뒤 바탕화면 위젯이 그대로 얼룩으로 올라온다(2026-08-01 사용자 보고).
        // 50/55에서 40/45로 낮춘 건 material 외형을 뷰에 직접 박은 뒤다
        // (2026-08-02, shell_corner.rs). 그전에는 다크 UI 뒤에 라이트 material이
        // 깔려 있어서, 알파를 낮출수록 밝은 면이 더 들어와 오히려 씻겼다.
        // 외형이 맞으면 material이 휘도를 눌러 주므로 낮춘 만큼 뒤가 비친다.
        //
        // 라이트 알파 10. 실측(2026-08-02, 균일한 회색 바탕화면 226 위):
        // 알파 24에서 셸이 228로 바탕과 같은 값이라 패널이 바탕에 묻혔다 —
        // 같은 조건의 네이티브 앱은 237로 바탕보다 밝은 별개 면으로 읽힌다.
        // 역산하면 material 출력이 233이고 틴트(#d5d5d5=213)가 그보다 어두워
        // 얹을수록 233에서 멀어진다. 그래서 알파를 최소로 남긴다 — 밝기도
        // material에 맡기고, 덤으로 투과가 90%까지 열린다.
        //
        // 이전 값 40 → 24의 근거는 아래와 같다. 라이트에서도 "전혀 안 비친다"는
        // 보고가 나왔는데, 구조는 다크와 같다: 실효 투과율이 (1-a) x T_material
        // 이므로 40%를 얹으면 material이 통과시킨 것의 60%만 남는다. 다만
        // 다크와 달리 라이트는 밝기가 이미 맞았으므로(2026-08-01 실측: 우리 236,
        // 네이티브 239) 틴트를 어둡게 바꿀 이유가 없고 알파만 내리면 된다.
        //
        // 다크 알파는 밝기 목표에서 역산한다. 틴트가 이미 거의 검정이라 더
        // 어둡게 할 수단이 없고, 남는 손잡이가 알파뿐이기 때문이다. 흰 바탕화면
        // (237) 위 실측(2026-08-02): 셸 109 → material 출력 173. 목표는 같은
        // 조건의 네이티브 앱 사이드바 98이고, 173 - 160a = 목표이므로
        // a=0.47이면 98, a=0.50이면 93이다. 한 단 더 어두운 쪽을 골랐다.
        //
        // 여기서 알파를 올리면 뒤 변동도 (1-a)만큼 깎인다. 그럼에도 올릴 수
        // 있는 건 투과가 이미 네이티브보다 넉넉해서다 — 같은 조건에서 변동폭이
        // 우리 69, 네이티브 37이었다. 그 여유를 밝기로 바꾸는 교환이다.
        //
        // 아래는 8까지 내렸던 시절의 계산이다. 목표는 네이티브 앱의 21%인데
        // 알파 a에서 실효 투과율은 (1-a) x T_material이고, 우리가 실측한 material
        // 최고치가 menu의 21.5%다 — a가 조금만 있어도 21%에 못 닿는다. 즉 어둡게
        // 만드는 일은 틴트가 아니라 material(다크: hudWindow)이 져야 하고, 틴트는
        // 대비 하한을 지킬 만큼만 남긴다. 그 이전 값들의 근거는 아래와 같다. 배경이 크게 다른 두
        // 지점(165 / 30)에서 셸이 얼마나 따라 움직이는지 재면:
        //   네이티브 앱     81 → 53  변동 28  = 투과 21%
        //   우리            71 → 55  변동 16  = 투과 12%
        // material 자체의 투과율은 21.5%로 이미 같았다 — 그 위에 45% 불투명
        // 틴트를 칠해 절반으로 깎고 있었다. 즉 범인은 material이 아니라 알파다.
        // 알파를 못 내리고 있던 이유(menu가 밝은 면을 깔아 어둡게 만드는 일을
        // 틴트가 전부 져야 했다)는 다크 material을 underWindowBackground로
        // 바꾸면서 사라졌다.
        // 네이티브 사이드바가 어떤 배경화면 위에서도 읽히는 것은 material 자체가
        // 상당한 불투명도를 갖기 때문이고, 유리로 읽히는 근거는 투명도가 아니라
        // 색이 부드럽게 배어 나오는 쪽이다.
        // Alpha lives in --shell-tint-alpha (index.css defaults light 80% /
        // dark 50% — dark is the measured value above, light was raised from
        // 10% on 2026-09-08 so the shell holds still behind a dark window,
        // see shellOpacity.ts; the Settings sliders that overrode it were
        // pulled 2026-09-10). resolveTheme derives its chroma gain from the
        // same numbers, so tint and gain cannot drift apart.
        "relative flex h-screen w-screen flex-col overflow-hidden bg-glass-base/(--shell-tint-alpha) text-foreground",
        // 모서리·엣지 링·그림자는 창 모드 전용 (windowShellShape).
        shellChromeClass(fullscreen),
      )}
    >
            {/* 창 최상단 한 줄이 데스크탑 탭까지 담는다 (2070:32171). */}
      {/* chrome 줄을 열별로 쪼갠다 — 창 폭 전체를 가로지르는 한 줄이 없어야
          사이드바 유리가 창 최상단부터 바닥까지 끊기지 않는다 (WindowTitleBar). */}
      <div className="flex min-h-0 flex-1">
        {/* 아이콘 레일은 항상 고정 — 접힘 여부는 Sidebar 내부에서 패널만 숨긴다.
            신호등·워드마크·토글 줄은 Sidebar 안쪽 맨 위에 산다. */}
        <Sidebar fullscreen={fullscreen} />
        <div
          className="relative flex min-w-0 flex-1 flex-col"
          // The pane card's inset from the sidebar edge: 2px beside the open
          // sidebar (its edge is already the resize boundary), 4px beside the
          // collapsed icon rail. Published as a var because the desktop tab
          // strip on the chrome line above starts from the same edge, so the
          // first tab's text lands on the pane header's glyph column
          // (desktopTabStyle, owner request 2026-09-09).
          style={{ ["--workspace-inset" as string]: sidebarOpen ? "2px" : "4px" }}
        >
          <WorkspaceTitleBar fullscreen={fullscreen}>
            <DesktopBar />
          </WorkspaceTitleBar>
          {/* relative 필수 — 없으면 위 틴트 레이어(absolute) 아래 깔려 씻긴다.
              왼쪽 여백은 위 래퍼의 --workspace-inset(열림 2px / 접힘 4px). */}
          <div
            // 이 열은 배경을 따로 칠하지 않는다 — 사이드바·여백·chrome이 셸의
            // 한 유리면을 공유하고, 그 위에 불투명 pane 카드가 뜬다. 여기만
            // 회색 틴트를 얹으면 사이드바보다 어두운 프레임이 생겨 유리가 두
            // 조각으로 잘린다 (레퍼런스는 반대로 콘텐츠 쪽이 더 밝다).
            className="relative flex min-h-0 flex-1 flex-col pt-0.5 pr-2 pb-2 pl-(--workspace-inset)"
          >
            <main className="relative min-h-0 flex-1">
              <WorkspaceDeck spaces={spaces} activeSpaceId={activeVisible} />
              {/* Brief toasts centre on the workspace, not the window. */}
              <BriefToasts className="absolute inset-x-0 bottom-4" />
            </main>
          </div>
        </div>
      </div>
      {isMainWindow() && <AgentUsageLimitHandoffHost />}
      <AgentRemovalDialogHost />
      <SshRegistrationDialog />
      <LazyNativeSearchDialog />
      <LazyQuickDispatchOverlay />
      <LazyFeedbackDialog />
      <Toaster brief={false} />
      {/* dev 게이트를 두지 않는다 — 내 앱을 열어 짚는 경로(B단계)는 프로덕션
          기능이고 그 캡처도 이 카드로 돌아온다. 우리 UI를 짚는 ⌥⇧D만
          useDesignModeShortcut에서 dev로 막는다. */}
      <DesignModeLayer />
    </div>
  );
}
