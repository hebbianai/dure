import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DockviewReact,
  themeAbyss,
  type DockviewReadyEvent,
  type IDockviewPanel,
  type IDockviewPanelProps,
} from "dockview-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readDragTypes } from "@/lib/platform/productDragPayload";
import { ChatDraftMoveNotice } from "@/components/workspace/ChatDraftMoveNotice";
import { BriefToasts } from "@/components/Toaster";
import { PaneChrome } from "@/components/workspace/PaneChrome";
import { DesktopWatermark } from "@/components/workspace/DesktopWatermark";
import { PaneLauncher } from "@/components/workspace/PaneLauncher";
import {
  markOnboardingDismissed,
  maybeAutoOpenOnboarding,
} from "@/lib/onboarding/onboardingEntry";
import { syncOnboardingPaneHeaders } from "@/lib/onboarding/onboardingPaneHeader";
import {
  useWorkspaceRuntimeActive,
  WorkspaceRuntimeProvider,
} from "@/components/workspace/WorkspaceRuntimeContext";
import {
  desktopConstructionPending,
  subscribeDesktopConstruction,
} from "@/lib/workspace/desktop/desktopConstructionLedger";
import {
  FROZEN_CONSTRUCTION_SETTLE_MS,
  frozenDesktopSkipsRendering,
} from "@/lib/workspace/desktop/frozenDesktopPresentation";
import { AgentPanel } from "@/components/panels/AgentPanel";
import { TerminalPanel } from "@/components/panels/TerminalPanel";
import { SshPanel } from "@/components/panels/SshPanel";
import {
  LazyBrowserPanelLoader,
  LazyMobileSimulatorPanelLoader,
  LazyDiffPanelLoader,
  LazyFileViewerPanelLoader,
  LazyGitPanelLoader,
  LazyGitHubIssuePanelLoader,
  LazyGitHubWorkspacePanelLoader,
  LazyMockupPanelLoader,
  LazyOnboardingPanelLoader,
  LazyTokenInspectorPanelLoader,
} from "@/components/workspace/LazyWorkspacePanels";
import {
  openDesktopInitialTerminal,
  ungroupStackedLayout,
} from "@/lib/workspace/dock";
import { getDragState, setDragState } from "@/lib/workspace/pane/paneDragState";
import { applyPendingPanelFocus } from "@/lib/workspace/dock/panelFocusHandoff";
import {
  isDockviewProjectionOnly,
  registerDockview,
  unregisterDockview,
  movingPanels,
} from "@/lib/workspace/dock/dockRegistry";
import { installInteriorBoundaryDrop } from "@/lib/workspace/pane/paneInsertionDrop";
import {
  installPaneCardCorners,
  type PaneCardCornersHandle,
} from "@/lib/workspace/pane/paneCardCorners";
import { armPaneTearOut } from "@/lib/workspace/pane/paneTearOut";
import {
  createPaneTransferPayload,
  PANE_TRANSFER_MIME,
  serializePaneTransferPayload,
} from "@/lib/workspace/pane/paneWindowTransfer";
import { installPaneWindowDropTarget } from "@/lib/workspace/pane/paneWindowTransferRuntime";
import { handleSidebarDrop } from "@/lib/sidebar/sidebarDropHandler";
import { installPaneDragBehaviors } from "@/lib/workspace/pane/paneDragBehaviors";
import { recordPaneFocus } from "@/lib/workspace/pane/paneFocusHistory";
import { DEFAULT_UI_PREFS, useStore } from "@/store";
import { panePinKey, unpinPane } from "@/lib/workspace/pane/panePin";
import { t } from "@/lib/i18n";
import { DOCKVIEW_DROP_TUNING } from "@/lib/workspace/dock/dockviewDropTuning";
import { observeDockviewContainer } from "@/lib/workspace/dock/dockviewContainerResize";
import { migrateTerminalBindingsInLayout } from "@/lib/terminal/terminalBinding";
import {
  rehydrateDurableStore,
  subscribeDurableStoreLayoutProjection,
} from "@/lib/persistence/durableStoreRehydration";
import { recoverCurrentDurableProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import {
  onLayoutPush,
  projectPushedLayout,
} from "@/lib/workspace/layout/layoutPushChannel";
import { slimGitHubIssueLayout } from "@/lib/github/githubIssuePane";
import { pruneEmptyDockviewGroups } from "@/lib/workspace/layout/layoutLifecycle";
import { installWorkspaceLayoutPersistence } from "@/lib/workspace/layout/workspaceLayoutPersistence";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import { WorkspacePaneFocusIntent } from "@/lib/workspace/performance/workspacePaneFocusIntent";
import { schedulePostPaint } from "@/lib/scheduling/postPaint";
import { markWorkspacePainted } from "@/lib/workspace/boot/workspaceBootState";
import { browserMessageTasks } from "@/lib/scheduling/messageTask";
import { LatestScheduledValue } from "@/lib/scheduling/latestScheduledValue";
import { focusContextForPane, type FocusContext } from "@/lib/workspace/focusContext";
import { shouldCreateDefaultInitialTerminalFromState, shouldOpenPendingInitialTerminal } from "@/lib/workspace/workspaceInitialTerminal";
import {
  isTerminalPresentationPanel,
  terminalPresentationSetReady,
  TerminalPresentationRoleStore,
} from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import {
  getTerminalExecutionLocation,
  getTerminalExecutionLocationRevision,
  subscribeTerminalExecutionLocations,
} from "@/lib/terminal/terminalExecutionLocationStore";

// 분할된 창 사이 간격 — 시안 2070:32418은 spacing/0-5(2px)로 가른다. 선 하나가
// 아니라 뒤 sheet 표면이 2px 드러나는 방식이라, pane마다 테두리를 그리지 않아도
// 경계가 읽힌다. 이제 설정(외관 > 분할 패널 > 구분선 두께)이 이 값을 정하고,
// 기본값은 그 시안 값 그대로다. 테마 객체는 값이 실제로 바뀔 때만 새로
// 만든다 — 매 렌더 새 객체를 넘기면 dockview가 테마를 다시 적용한다.
const DEFAULT_PANE_THEME = { ...themeAbyss, gap: DEFAULT_UI_PREFS.splitterSize };

/** Activate even panes whose content cannot focus (empty selectors, failed
 * connections). Capture runs before content can stop propagation; leave an
 * already-active pane mounted so WebKit can deliver the click. */
/** The pane's own toast column, mounted only while the pane can be seen: a
 * background tab in a group and a pane on a warm or frozen desktop stay
 * mounted while hidden, and a column there would claim the pane's toasts
 * into a place nobody is looking (landing review 2026-09-13). Unmounted, the
 * claim is released and those toasts fall back to the workspace column. */
function PaneToastColumn({ api }: { api: IDockviewPanelProps["api"] }) {
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    setVisible(api.isVisible);
    const subscription = api.onDidVisibilityChange(({ isVisible }) =>
      setVisible(isVisible),
    );
    return () => subscription.dispose();
  }, [api]);
  const desktopActive = useWorkspaceRuntimeActive();
  if (!visible || !desktopActive) return null;
  return (
    <BriefToasts paneId={api.id} className="absolute inset-x-0 bottom-4" />
  );
}

export function activateOnPointerDown<P extends IDockviewPanelProps>(
  Component: React.FunctionComponent<P>,
): React.FunctionComponent<P> {
  const Activatable = (props: P) => (
    <div
      className="relative h-full min-h-0 min-w-0"
      onPointerDownCapture={() => {
        // The clicked pane is already visible. Reopening it detaches its DOM
        // during pointerdown, cancelling WebKit's click and outside dismissal.
        if (!props.api.isActive) props.api.group.api.setActive();
      }}
    >
      <Component {...props} />
      {/* The pane's own toast column: a report made in this pane lands at
          this pane's bottom edge, not the workspace's. */}
      <PaneToastColumn api={props.api} />
    </div>
  );
  Activatable.displayName = `Activatable(${Component.displayName ?? Component.name ?? "Pane"})`;
  return Activatable;
}

const components = {
  launcher: activateOnPointerDown(PaneLauncher),
  agent: activateOnPointerDown(AgentPanel),
  terminal: activateOnPointerDown(TerminalPanel),
  ssh: activateOnPointerDown(SshPanel),
  fileviewer: activateOnPointerDown(LazyFileViewerPanelLoader),
  browser: activateOnPointerDown(LazyBrowserPanelLoader),
  mobileSimulator: activateOnPointerDown(LazyMobileSimulatorPanelLoader),
  git: activateOnPointerDown(LazyGitPanelLoader),
  github: activateOnPointerDown(LazyGitHubWorkspacePanelLoader),
  githubissue: activateOnPointerDown(LazyGitHubIssuePanelLoader),
  diff: activateOnPointerDown(LazyDiffPanelLoader),
  mockup: activateOnPointerDown(LazyMockupPanelLoader),
  tokeninspector: activateOnPointerDown(LazyTokenInspectorPanelLoader),
  onboarding: activateOnPointerDown(LazyOnboardingPanelLoader),
};

// 앱 종료/리로드 중에는 패널 dispose가 연쇄로 발생하는데, 이때 세션을
// 죽이면 "재시작해도 세션 유지"가 깨진다 — 명시적 닫기만 정리 대상.
let appUnloading = false;
window.addEventListener("beforeunload", () => {
  appUnloading = true;
});


function deriveFocusCtx(panel: IDockviewPanel | undefined): FocusContext | null {
  return focusContextForPane(
    panel ? dockPanelReference(panel) : undefined,
    useStore.getState(),
    getTerminalExecutionLocation,
    t("common.terminal"),
  );
}

function openAndPersistInitialTerminal(
  desktopId: string,
  api: DockviewReadyEvent["api"],
) {
  // Hmux creation is asynchronous. Its eventual pane addition commits the
  // current Dockview and layout together; persisting this still-empty layout
  // here can otherwise race that addition and immediately remove the pane.
  openDesktopInitialTerminal(desktopId, api);
}

export const Workspace = memo(function Workspace({
  desktopId,
  active,
  frozen = false,
}: {
  desktopId: string;
  active: boolean;
  /** Mounted-but-frozen shell tier: hidden, no paint, non-terminal state preserved. */
  frozen?: boolean;
}) {
  // 외관 > 분할 패널. 저장된 프리퍼런스에 아직 이 필드가 없을 수 있어(구버전
  // persist) 기본값으로 메운다.
  const splitterSize = useStore(
    (state) => state.uiPrefs.splitterSize ?? DEFAULT_UI_PREFS.splitterSize,
  );
  const paneTheme = useMemo(
    () =>
      splitterSize === DEFAULT_PANE_THEME.gap
        ? DEFAULT_PANE_THEME
        : { ...themeAbyss, gap: splitterSize },
    [splitterSize],
  );
  const executionLocationRevision = useSyncExternalStore(
    subscribeTerminalExecutionLocations,
    getTerminalExecutionLocationRevision,
    getTerminalExecutionLocationRevision,
  );
  // frozen 강등(content-visibility) 게이트 — 조건·근거는
  // frozenDesktopPresentation 헤더 참고. mountSettled는 초기 dockview
  // 배치·ledger 등록 창만 덮고, construction 자체는 원장이 책임진다.
  const [mountSettled, setMountSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setMountSettled(true),
      FROZEN_CONSTRUCTION_SETTLE_MS,
    );
    return () => clearTimeout(timer);
  }, []);
  const subscribeConstruction = useCallback(
    (listener: () => void) => subscribeDesktopConstruction(desktopId, listener),
    [desktopId],
  );
  const readConstructionPending = useCallback(
    () => desktopConstructionPending(desktopId),
    [desktopId],
  );
  const constructionPending = useSyncExternalStore(
    subscribeConstruction,
    readConstructionPending,
    readConstructionPending,
  );
  const dockviewApi = useRef<DockviewReadyEvent["api"]>(undefined);
  const workspaceElement = useRef<HTMLDivElement>(null);
  const dockviewElement = useRef<HTMLDivElement>(null);
  const initialTerminalPending = useRef(false);
  const workspaceDisposing = useRef(false);
  const activeRef = useRef(active);
  const applyingExternalLayout = useRef(false);
  const externalApplyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const persistedLayoutSignature = useRef("");
  const cardCorners = useRef<PaneCardCornersHandle | undefined>(undefined);
  const presentationRoleStoreRef =
    useRef<TerminalPresentationRoleStore | null>(null);
  presentationRoleStoreRef.current ??= new TerminalPresentationRoleStore();
  const presentationRoleStore = presentationRoleStoreRef.current;
  const foregroundPanelIdRef = useRef<string | null | undefined>(undefined);
  activeRef.current = active;
  const focusContextPublisherRef = useRef<LatestScheduledValue<FocusContext | null>>(null);
  focusContextPublisherRef.current ??= new LatestScheduledValue<FocusContext | null>({
    schedule: (publish) => {
      const tasks = browserMessageTasks();
      const handle = tasks.request(publish);
      return () => tasks.cancel(handle);
    },
    publish: (focusContext) => {
      if (!activeRef.current || workspaceDisposing.current) return;
      useStore.getState().setFocusCtx(focusContext);
    },
  });
  const focusContextPublisher = focusContextPublisherRef.current;

  const publishActiveFocusContext = useCallback(() => {
    if (!activeRef.current || workspaceDisposing.current) return;
    const panel = dockviewApi.current?.activePanel;
    const context = deriveFocusCtx(panel);
    if (context || panel?.api.component === "agent") {
      focusContextPublisher.request(context);
    } else {
      focusContextPublisher.cancel();
    }
  }, [focusContextPublisher]);

  useEffect(() => {
    const api = dockviewApi.current;
    if (!api) return;
    let parameters: { dispose(): void } | undefined;
    const observeActivePane = () => {
      parameters?.dispose();
      parameters = api.activePanel?.api.onDidParametersChange(publishActiveFocusContext);
      publishActiveFocusContext();
    };
    const selection = api.onDidActivePanelChange(observeActivePane);
    observeActivePane();
    return () => {
      parameters?.dispose();
      selection.dispose();
    };
  }, [desktopId, publishActiveFocusContext]);

  const updateForegroundPanel = useCallback(
    (panel: IDockviewPanel | undefined) => {
      const panelId =
        panel && isTerminalPresentationPanel(panel) ? panel.id : null;
      foregroundPanelIdRef.current = panelId;
      presentationRoleStore.configure({
        active: activeRef.current,
        foregroundPanelId: panelId,
      });
    },
    [presentationRoleStore],
  );

  const persistDockviewLayout = useCallback((api: DockviewReadyEvent["api"]) => {
    try {
      const nextLayout = slimGitHubIssueLayout(pruneEmptyDockviewGroups(api.toJSON()));
      const signature = JSON.stringify(nextLayout);
      if (signature === persistedLayoutSignature.current) return true;
      persistedLayoutSignature.current = signature;
      useStore.getState().saveLayout(desktopId, nextLayout);
      return true;
    } catch {
      return false;
    }
  }, [desktopId]);

  const commitLayout = useCallback(() => {
    const api = dockviewApi.current;
    if (
      !api ||
      workspaceDisposing.current ||
      applyingExternalLayout.current ||
      !activeRef.current ||
      !document.hasFocus()
    ) {
      return false;
    }
    return persistDockviewLayout(api);
  }, [persistDockviewLayout]);

  const captureResizeLayoutCommit = useCallback(() => {
    const api = dockviewApi.current;
    if (
      !api ||
      workspaceDisposing.current ||
      applyingExternalLayout.current ||
      !activeRef.current ||
      !document.hasFocus()
    ) {
      return undefined;
    }
    return () => persistDockviewLayout(api);
  }, [persistDockviewLayout]);

  useLayoutEffect(() => {
    workspaceDisposing.current = false;
    return () => {
      // Set this before Dockview's passive cleanup can emit panel/layout events.
      workspaceDisposing.current = true;
    };
  }, [desktopId]);

  useLayoutEffect(() => {
    if (!active) focusContextPublisher.cancel();
    const panel = dockviewApi.current?.activePanel ?? undefined;
    if (panel) {
      updateForegroundPanel(panel);
      return;
    }
    presentationRoleStore.configure({
      active,
      foregroundPanelId: foregroundPanelIdRef.current,
    });
  }, [
    active,
    focusContextPublisher,
    presentationRoleStore,
    updateForegroundPanel,
  ]);

  useEffect(() => {
    // Dockview can survive a React refresh while Workspace effects reconnect.
    // Keep every external binding with its cleanup; onReady only runs when
    // Dockview is created and must not replay saved layout or session creation.
    const api = dockviewApi.current;
    if (!api) return;
    // Initial terminal creation needs registration in onReady. Renew that same
    // registration here after an effect cleanup without recreating the pane.
    registerDockview(desktopId, api);
    const stopContainerResize = dockviewElement.current
      ? observeDockviewContainer(dockviewElement.current, api)
      : undefined;
    const container = workspaceElement.current;
    const stopBoundaryDrop = container
      ? installInteriorBoundaryDrop({
        api,
        container,
        dropNewPane: (nativeEvent, group) => handleSidebarDrop({ nativeEvent, group, position: "center" }, desktopId, workspaceElement.current),
        draggedPanelId: () => {
          const drag = getDragState();
          return drag && drag.fromDesktopId === desktopId ? drag.panelId : null;
        },
      })
      : undefined;

    // Only groups touching the card's outer edge receive rounded corners.
    const corners = container
      ? installPaneCardCorners({
        container,
        onLayoutChange: (listener) => api.onDidLayoutChange(listener),
      })
      : undefined;
    cardCorners.current = corners;

    const stopDragBehaviors = installPaneDragBehaviors(
      api,
      () => workspaceElement.current,
    );
    const stopLayoutPersistence = installWorkspaceLayoutPersistence({
      document,
      onLayoutChange: (listener) => api.onDidLayoutChange(listener),
      onWillMutateLayout: (listener) => api.onWillMutateLayout(listener),
      onDidMutateLayout: (listener) => api.onDidMutateLayout(listener),
      commitOrdinary: () => {
        if (!isDockviewProjectionOnly(api)) commitLayout();
      },
      captureResizeCommit: captureResizeLayoutCommit,
    });

    const applyExternalLayout = (): boolean => {
      // The writer already has the authoritative live Dockview. Reconcile
      // background copies before they can later overwrite it with stale data.
      // Focus filtering for ordinary storage events and forced correlated
      // commands is owned by subscribeDurableStoreLayoutProjection.
      const state = useStore.getState();
      const storedLayout = state.layouts[desktopId];
      const nextLayout = slimGitHubIssueLayout(pruneEmptyDockviewGroups(storedLayout));
      if (!nextLayout) return true;
      if (nextLayout !== storedLayout) {
        state.saveLayout(desktopId, nextLayout);
      }
      const signature = JSON.stringify(nextLayout);
      if (signature === persistedLayoutSignature.current) return true;
      const migrated = migrateTerminalBindingsInLayout(
        ungroupStackedLayout(nextLayout),
        state.agents,
        state.projects,
      );
      applyingExternalLayout.current = true;
      clearTimeout(externalApplyTimer.current);
      let projected = true;
      try {
        api.fromJSON(
          migrated as Parameters<typeof api.fromJSON>[0],
          { reuseExistingPanels: true },
        );
        persistedLayoutSignature.current = signature;
        initialTerminalPending.current = false;
      } catch (error) {
        projected = false;
        console.error(`[workspace sync:${desktopId}]`, error);
      }
      // Keep the session-teardown and autosave guards through the current
      // task in case a renderer callback is delivered just after fromJSON.
      externalApplyTimer.current = setTimeout(() => {
        applyingExternalLayout.current = false;
      }, 0);
      return projected;
    };
    const stopDurableProjection = subscribeDurableStoreLayoutProjection(
      desktopId,
      applyExternalLayout,
    );
    // 크로스-창 pane 이동의 명시적 push — storage 이벤트가 rehydrate보다
    // 먼저 오므로 여기서 직접 재수화한 뒤 강제 반영한다.
    const stopLayoutPush = onLayoutPush((notice) => {
      if (!notice.desktopIds.includes(desktopId)) return;
      void projectPushedLayout(
        rehydrateDurableStore,
        applyExternalLayout,
        recoverCurrentDurableProjection,
      );
    });
    const unmountPerformance = workspacePerformance.mountWorkspace(desktopId);
    return () => {
      clearTimeout(externalApplyTimer.current);
      applyingExternalLayout.current = false;
      stopContainerResize?.();
      stopLayoutPersistence();
      stopDurableProjection();
      stopLayoutPush();
      stopBoundaryDrop?.();
      corners?.dispose();
      cardCorners.current = undefined;
      stopDragBehaviors();
      unregisterDockview(desktopId, api);
      // StrictMode replays effect cleanup without recreating component refs.
      presentationRoleStore.configure({
        active: false,
        foregroundPanelId: null,
      });
      focusContextPublisher.cancel();
      unmountPerformance();
    };
  }, [captureResizeLayoutCommit, commitLayout, desktopId, focusContextPublisher, presentationRoleStore]);

  const onReady = useMemo(
    () => (event: DockviewReadyEvent) => {
      dockviewApi.current = event.api;
      registerDockview(desktopId, event.api);

      const storedLayout = useStore.getState().layouts[desktopId];
      // Legacy issue panes persisted their transcript; strip it on the way in
      // and save, so the store shrinks without waiting for a layout change.
      const layout = slimGitHubIssueLayout(pruneEmptyDockviewGroups(storedLayout));
      persistedLayoutSignature.current = layout ? JSON.stringify(layout) : "";
      if (layout) {
        if (layout !== storedLayout) {
          useStore.getState().saveLayout(desktopId, layout);
        }
        // 한 그룹에 쌓인 패널을 각각 별도 pane으로 분리(그리드). 변환 실패 시 원본으로.
        const state = useStore.getState();
        const migrated = migrateTerminalBindingsInLayout(
          ungroupStackedLayout(layout),
          state.agents,
          state.projects,
        );
        try {
          event.api.fromJSON(migrated as Parameters<typeof event.api.fromJSON>[0]);
        } catch {
          try {
            event.api.fromJSON(layout as Parameters<typeof event.api.fromJSON>[0]);
          } catch {
            /* stale layout — start clean */
          }
        }
      } else {
		// idle prewarm은 세션을 만들지 않는다. 첫 실행도 import 확인 전에는
		// 터미널 세션을 만들지 않는다.
		initialTerminalPending.current = !activeRef.current;
		const state = useStore.getState();
		if (activeRef.current && shouldCreateDefaultInitialTerminalFromState(state)) {
          openAndPersistInitialTerminal(desktopId, event.api);
          persistedLayoutSignature.current = JSON.stringify(event.api.toJSON());
        }
      }

      // 첫 실행 가이드 — 폴더가 하나도 없을 때만, 활성 데스크탑에서 한 번.
      // 백그라운드 데스크탑에 조용히 열어두면 사용자가 못 본 채로 닫힘 표시가
      // 남을 수 있어 활성일 때만 띄운다.
      if (activeRef.current) maybeAutoOpenOnboarding(desktopId);

      // 자기 자신 위 드롭 오버레이 억제 — 한 그룹=한 pane 불변식에서 자기
      // 그룹으로의 split/드롭은 결과가 원위치라 제안 자체가 소음이다
      // (사용자 피드백 2026-07-29). 외부(사이드바·파일) 드래그는 getData()가
      // 없어 기존 동작 유지. 루트 가장자리 존(kind 'edge')은 건드리지 않는다.
      event.api.onWillShowOverlay((e) => {
        if (e.kind !== "content" && e.kind !== "tab" && e.kind !== "header_space") return;
        const data = e.getData();
        if (!data) return;
        if (e.group && data.groupId === e.group.id) e.preventDefault();
      });

      // A group is a pane in HebbianIDE. Reject center/tab drops so dragging
      // can rearrange and split panes without violating the one-panel invariant.
      const lockPaneGroup = (group: (typeof event.api.groups)[number]) => {
        group.api.locked = true;
      };
      event.api.groups.forEach(lockPaneGroup);
      event.api.onDidAddGroup(lockPaneGroup);

      // Same-slot content replacement emits a layout change, not add/remove.
      // Project the current content into the group-owned header in either case.
      const syncGuideHeaders = () => syncOnboardingPaneHeaders(event.api.groups);
      syncGuideHeaders();
      event.api.onDidLayoutChange(syncGuideHeaders);

      // 다른 데스크탑에서 이 데스크탑의 스페이스를 클릭해 넘어온 경우, 레이아웃
      // 복원 후 그 패널을 전면으로 (그룹에 겹쳐 있어도 setActive로 앞으로).
      applyPendingPanelFocus(desktopId);

      // 외부(사이드바) 드래그만 받아들여 드롭 오버레이·onDidDrop을 활성화한다.
      // OS 파일 드래그(dataTransfer에 "Files")는 Tauri가 drop을 가로채 dockview의
      // drop 이벤트가 안 오므로, 수락하면 드롭 오버레이가 안 지워지고 남는다 → 제외.
      event.api.onUnhandledDragOver((e) => {
        if ("dataTransfer" in e.nativeEvent && readDragTypes(e.nativeEvent).includes("Files")) return;
        e.accept();
      });

      // Selection history and presentation priority remain view-owned.
      const updateActivePanel = (
        panel: IDockviewPanel | undefined,
      ) => {
        recordPaneFocus(event.api, panel?.id);
        updateForegroundPanel(panel);
      };
      const paneFocusIntent = new WorkspacePaneFocusIntent(
        event.api.panels.map((panel) => panel.id),
        event.api.activePanel?.id,
      );
      event.api.onDidAddPanel((panel) => paneFocusIntent.noteAdded(panel.id));
      event.api.onDidActivePanelChange(() => {
        const panel = event.api.activePanel ?? undefined;
        let focusSequence: number | undefined;
        if (
          activeRef.current &&
          panel &&
          paneFocusIntent.shouldMeasure(panel.id) &&
          !isTerminalPresentationPanel(panel)
        ) {
          const measuredSequence = workspacePerformance.beginPaneFocus(
            desktopId,
            panel.id,
            false,
          );
          focusSequence = measuredSequence;
          globalThis.queueMicrotask(() =>
            workspacePerformance.markPaneFocusEventMicrotask(measuredSequence),
          );
          browserMessageTasks().request(() =>
            workspacePerformance.markPaneFocusEventMessageTask(measuredSequence),
          );
          window.setTimeout(
            () => workspacePerformance.markPaneFocusEventTask(measuredSequence),
            0,
          );
          schedulePostPaint(
            window,
            () => {
              if (
                !workspaceDisposing.current &&
                activeRef.current &&
                event.api.activePanel?.id === panel.id
              ) {
                workspacePerformance.markPaneFocusPaint(measuredSequence);
              } else {
                workspacePerformance.abortPaneFocus(measuredSequence);
              }
            },
            {
              onFrame: () =>
                workspacePerformance.markPaneFocusFrame(measuredSequence),
            },
          );
        }
        updateActivePanel(panel);
        if (focusSequence !== undefined) {
          workspacePerformance.markPaneFocusCommit(focusSequence);
        }
      });
      updateActivePanel(event.api.activePanel ?? undefined);

      // 탭을 하단 데스크탑 탭 위로 드래그하면 그 데스크탑으로 이동시키기
      // 위해, 드래그 시작 시 어떤 패널이 잡혔는지 기록한다.
      event.api.onWillDragPanel((e) => {
        const panelId = (e.panel as { id: string }).id;
        // The target window reads the source definition from durable state.
        // Snapshot synchronously before the pointer can leave this WebView.
        commitLayout();
        const transfer = createPaneTransferPayload({
          panelId,
          fromDesktopId: desktopId,
          sourceWindowLabel: getCurrentWindow().label,
        });
        // dockview는 드래그 시작 유지용으로 빈 text/plain을 싣는데, macOS
        // Finder가 이를 수락해 데스크탑에 'clipping' 파일을 만들고 dropEffect가
        // copy가 되어 tear-out 판정까지 막는다 — 텍스트 flavor를 커스텀
        // 타입으로 교체한다 (드래그 시작용 데이터는 유지돼야 한다).
        const nativeEvent = (e as { nativeEvent?: Event }).nativeEvent;
        const dataTransfer =
          nativeEvent instanceof DragEvent ? nativeEvent.dataTransfer : null;
        if (dataTransfer) {
          dataTransfer.clearData("text/plain");
          dataTransfer.setData(
            PANE_TRANSFER_MIME,
            serializePaneTransferPayload(transfer),
          );
        }
        setDragState({ panelId, fromDesktopId: desktopId });
        // 앱의 모든 창 밖에서 끝나는 드래그는 별도 창으로 분리 (tear-out).
        armPaneTearOut(transfer);
      });

      // Dockview 제거는 뷰 이벤트다. Hmux 세션은 Host가 소유해 뷰와 무관하게
      // 살아남고, 은퇴한 legacy pane은 소유한 세션이 없다 — 어느 쪽도 여기서
      // 세션을 종료하지 않는다 (legacy 런타임 은퇴, 2026-08-16).
      event.api.onDidRemovePanel((e) => {
        const pid = e.id;
        paneFocusIntent.noteRemoved(pid);
        // 정말 사라진 pane의 고정만 거둔다. 데스크탑 간 이동·레이아웃 재적용도
        // 같은 이벤트로 오는데, 거기서 지우면 옮길 때마다 고정이 풀린다.
        if (
          !movingPanels.has(pid) &&
          !applyingExternalLayout.current &&
          !workspaceDisposing.current &&
          !appUnloading
        ) {
          useStore.setState((s) => {
            const next = unpinPane(s.pinnedPanes, panePinKey(desktopId, pid));
            return next === s.pinnedPanes ? {} : { pinnedPanes: next as Record<string, boolean> };
          });
        }
        // 가이드를 닫은 것은 사용자의 결정이다 — 다시 자동으로 띄우지 않는다.
        // 데스크탑 이동 중 재생성은 닫기가 아니다.
        if (e.api.component === "onboarding" && !movingPanels.has(pid)) {
          markOnboardingDismissed();
        }
      });
    },
    [
      commitLayout,
      desktopId,
      updateForegroundPanel,
    ],
  );

  useEffect(
    () =>
      installPaneWindowDropTarget({
        desktopId,
        isActive: () => activeRef.current,
        api: () => dockviewApi.current,
        element: () => workspaceElement.current,
      }),
    [desktopId],
  );

  // 다른 데스크탑의 pane을 클릭해 넘어온 경우 그 pane을 앞으로 가져온다.
  // onReady는 최초 마운트에서만 오므로, warm으로 남아 있던 데스크탑에는 이
  // 경로가 유일하다 (lib/dock.ts applyPendingPanelFocus).
  useEffect(() => {
    if (!active) return;
    applyPendingPanelFocus(desktopId);
    // 숨은 데스크탑은 content-visibility로 자손 레이아웃이 없어 pane 모서리를
    // 측정할 수 없다. 그 사이 다른 창이 layout을 밀어넣었을 수 있고, 다시
    // 보이는 순간에는 layout 이벤트도 컨테이너 리사이즈도 오지 않는다 —
    // 여기서 한 번 다시 재어야 표시가 낡은 분할에 머물지 않는다.
    cardCorners.current?.refresh();
  }, [active, desktopId]);

  useEffect(() => {
    if (!active) return;
    const api = dockviewApi.current;
	if (initialTerminalPending.current && api) {
		initialTerminalPending.current = false;
		const state = useStore.getState();
		const createInitial = shouldCreateDefaultInitialTerminalFromState(state);
      // 백그라운드 mount 뒤 pane 이동이 먼저 커밋될 수 있다. 그 사이 채워진
      // live/persisted layout을 다시 확인해 기본 터미널 중복 생성을 막는다.
		if (
			createInitial && shouldOpenPendingInitialTerminal({
				livePanelCount: api.panels.length,
				persistedLayout: state.layouts[desktopId],
			})
      ) {
        openAndPersistInitialTerminal(desktopId, api);
        persistedLayoutSignature.current = JSON.stringify(api.toJSON());
		}
		if (!createInitial) maybeAutoOpenOnboarding(desktopId);
    }
    const panel = api?.activePanel;
    updateForegroundPanel(panel ?? undefined);
    publishActiveFocusContext();
  }, [
    active,
    desktopId,
    executionLocationRevision,
    publishActiveFocusContext,
    updateForegroundPanel,
  ]);

  useLayoutEffect(() => {
    if (!active) return;
    let readinessFrame: number | undefined;
    const readinessDeadline = performance.now() + 2_000;
    const sealWhenPanelsRegistered = () => {
      const api = dockviewApi.current;
      if (
        api &&
        terminalPresentationSetReady(
          api.panels,
          (panelIds) =>
            workspacePerformance.hasExpectedTerminalPanels(desktopId, panelIds),
          performance.now() >= readinessDeadline,
        )
      ) {
        workspacePerformance.sealVisibleTerminals(desktopId);
        return;
      }
      readinessFrame = requestAnimationFrame(sealWhenPanelsRegistered);
    };
    const firstFrame = requestAnimationFrame(() => {
      workspacePerformance.markWorkspaceFirstFrame(desktopId);
    });
    const cancelPaint = schedulePostPaint(window, () => {
      workspacePerformance.markWorkspacePaint(desktopId);
      // The same post-paint moment tells the boot splash it can leave.
      markWorkspacePainted();
      readinessFrame = requestAnimationFrame(sealWhenPanelsRegistered);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelPaint();
      if (readinessFrame !== undefined) cancelAnimationFrame(readinessFrame);
    };
  }, [active, desktopId]);

  // 사이드바 드롭(파일/터미널/에이전트/SSH/Spaces 이동) — lib/sidebarDropHandler.
  const onDidDrop = useMemo(
    () => (event: { nativeEvent: DragEvent; position: string; group?: unknown }) =>
      handleSidebarDrop(event, desktopId, workspaceElement.current),
    [desktopId],
  );

  return (
    <WorkspaceRuntimeProvider
      desktopId={desktopId}
      active={active}
      frozen={frozen}
      presentationRoleStore={presentationRoleStore}
      commitLayout={commitLayout}
    >
      {/* Inactive workspaces move off-screen so Dockview and non-terminal pane
          state remain mounted. Warm shells also keep their structured terminal
          attachments (Hmux observer, replica, painted rows) so activation is a
          repaint rather than an attach round trip; TerminalView releases them
          only for the frozen tier. Frozen shells additionally use
          visibility:hidden. After construction settles every inactive shell
          uses content-visibility to leave style/layout/paint work; retained
          terminals never publish canonical geometry from that skipped state
          (StructuredTerminalView gates it on the active desktop) and blur their
          input on deactivation. Active always wins over the one-frame-later
          tier reconciliation. Engines without content-visibility keep frozen
          shells on visibility:hidden and warm shells laid out off-screen.

          contain: 마운트된 데스크탑들은 같은 부모의 형제라, 한 데스크탑 안의
          DOM 변경이 조상으로 전파되면 이어지는 치수 읽기가 다른 데스크탑까지
          전부 재레이아웃했다(2026-08-03 전환 중 sample: 레이아웃 1회
          100-470ms). strict 봉쇄로 dirty가 데스크탑 경계를 넘지 않는다.
          absolute inset-0라 size 봉쇄 안전, fixed 자손은 전부 portal 사용.

          pointer-events를 토글하지 않는 이유: 상속 속성이라 컨테이너에서
          바꾸면 떠나는 쪽·오는 쪽 두 서브트리 전체의 스타일이 무효화돼,
          전환 중 치수 읽기마다 130-180ms 재계산이 남았다
          (containment 이후에도 스타일 무효화는 봉쇄되지 않는다 — 2026-08-03
          sample). -200vw 이동만으로 좌표 기반 히트테스트가 이미 불가능하고,
          contain이 fixed 자손의 뷰포트 탈출도 막으므로 토글 없이 안전하다.
          키보드 포커스는 pointer-events와 무관하게 전환 로직이 옮긴다. */}
      <div
        ref={workspaceElement}
        id={`desktop-panel-${desktopId}`}
        // 시안 2070:32418 "Main Container": 워크스페이스 전체가 radius 12px의
        // 카드 한 장이고, 그 안에서 pane들이 2px 간격으로 나뉜다.
        //
        // 라운드와 그림자가 여기(dockview 바깥)에 붙는 게 핵심이다. pane마다
        // 그림자를 주려던 예전 시도는 dockview가 각 그룹을 overflow 걸린 래퍼에
        // 넣어 통째로 잘렸다. 바깥에 한 번 붙이면 잘릴 조상이 없고, 코너 pane의
        // 둥근 모서리도 이 클리핑이 알아서 만들어 준다 — 시안에서도 바깥 네
        // 모서리만 둥글고 안쪽은 각지다.
        // 라운드 값은 --glass-radius-pane 하나가 출처다 — pane 포커스 링의 바깥
        // 모서리(index.css의 data-pane-card-corners)가 이 클리핑과 정확히
        // 겹쳐야 잘리지 않는다.
        //
        // The outline is an inset ring inside the clipping boundary so the
        // active pane can replace it without producing a double border. The
        // 1px padding is both the card's edge and the focus ring's room: the
        // design specifies a 1px card outline (GLASS.md §3), and the ring is
        // one 1px layer that lands exactly in it, so a focused pane turns that
        // edge into the ring instead of adding a second line. It briefly ran at
        // 2.5px to fit a ring plus a gap-colour seam; the seam is now the card
        // edge itself, which is this padding. Card-corner group radii subtract
        // the same 1px to stay concentric (index.css).
        // 라이트에서는 이 패딩이 sheet 색이라 선으로 읽히지 않는다.
        className="pane-card-surface absolute inset-0 overflow-hidden rounded-[var(--glass-radius-pane)] p-px bg-transparent"
        style={{
          transform: active ? "none" : "translateX(-200vw)",
          visibility: frozen && !active ? "hidden" : undefined,
          contentVisibility: frozenDesktopSkipsRendering({
            frozen,
            active,
            mountSettled,
            constructionPending,
          })
            ? "hidden"
            : undefined,
          contain: "strict",
          // Half of this is each group's seam shadow (index.css .dv-groupview).
          ["--pane-gap" as string]: `${splitterSize}px`,
        }}
        aria-hidden={!active}
        aria-labelledby={`desktop-tab-${desktopId}`}
        role="tabpanel"
      >
        <DockviewReact
          ref={dockviewElement}
          disableAutoResizing
          components={components as Record<string, React.FunctionComponent<IDockviewPanelProps>>}
          onReady={onReady}
          onDidDrop={onDidDrop as never}
          {...DOCKVIEW_DROP_TUNING}
          theme={paneTheme}
          singleTabMode="fullwidth"
          watermarkComponent={DesktopWatermark}
          defaultTabComponent={PaneChrome}
        />
        <ChatDraftMoveNotice desktopId={desktopId} />
      </div>
    </WorkspaceRuntimeProvider>
  );
});
