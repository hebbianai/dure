import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import {
  prepareAgentRemoval,
  executeAgentRemoval,
} from "@/lib/agents/resourceLifecycle";
import { agentRemovalRegistrationIdentity } from "@/lib/agents/agentRemovalRegistration";
import { isAgentPaneMounted } from "@/lib/workspace/layout/agentPaneLocations";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { RotateCcw, Trash2 } from "lucide-react";
import { HiddenFilePaneRows } from "@/components/spaces/HiddenFilePaneRows";
import {
  movePanelsToDesktop,
  openAgentPanel,
  openInheritedTerminalOn,
  withDesktopDockview,
} from "@/lib/workspace/dock";
import { useRepositoryQuickAdd } from "@/components/spaces/useRepositoryQuickAdd";
import { useLocationAdd } from "@/components/spaces/useLocationAdd";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openAgentDiffWindow } from "@/lib/workspace/window/windows";
import { useUnopenedAgentVisibilityStore } from "@/lib/spaces/unopenedAgentVisibilityStore";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
  beginSpacesRowDrag,
  endSpacesRowDrag,
  type SpacesDragItem,
  writeSpacesPaneDragData,
} from "@/lib/spaces/spacesDrag";
import { setPaneDragImage } from "@/lib/workspace/pane/paneDragImage";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  SectionHeaderRow,
  SidebarHairline,
} from "@/components/sidebar/SidebarItems";
import { IconButton } from "@/components/ui/icon-button";
import { SpacesAddLocationMenu } from "@/components/spaces/SpacesAddLocationMenu";
import { SpacesViewOptionsMenu } from "@/components/spaces/SpacesViewOptionsMenu";
import { SpacesPaneHeader } from "@/components/spaces/SpacesPaneHeader";
import { SpacesPinnedBand } from "@/components/spaces/SpacesPinnedBand";
import { SpacesEmptyState } from "@/components/spaces/SpacesEmptyState";
import { SpacesDesktopSection } from "@/components/spaces/SpacesDesktopSection";
import { SpacesFacetList } from "@/components/spaces/SpacesFacetList";
import { SpacesRepositoryGroup } from "@/components/spaces/SpacesRepositoryGroup";
import {
  dropKeyInRepository,
  SpacesRepositorySection,
} from "@/components/spaces/SpacesRepositorySection";
import {
  FOLD_REVEAL_CLASS,
  useFoldMotion,
} from "@/components/spaces/useFoldMotion";
import { SpacesUnopenedRepositoryGroup } from "@/components/spaces/SpacesUnopenedRepositoryGroup";
import { useSpacesGroups } from "@/components/spaces/useSpacesGroups";
import { DetectedWorktreeSessionsSection } from "@/components/spaces/DetectedWorktreeSessionsSection";
import { DesktopAddMenuButton } from "@/components/spaces/DesktopAddMenuButton";
import { WorktreeAgentDialog } from "@/components/agents/WorktreeAgentDialog";
import { LocationManagerDialog } from "@/components/spaces/LocationManagerDialog";
import { openAgentRemovalDialog } from "@/lib/agents/agentRemovalDialog";
import {
  useSpacesPaneState,
  useUnopenedAgentsState,
} from "@/components/spaces/useSpacesPaneState";
import type { Provider } from "@/types";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import { useSidebarScrollMemory } from "@/components/sidebar/useSidebarScrollMemory";
import { useDiffReviewCapabilities } from "@/components/scm/useDiffReviewCapabilities";
import { localStandaloneDiffCwd } from "@/lib/scm/review/diffReviewCapability";
import {
  detectedWorktreeSessionCount,
  selectDetectedWorktreeSessions,
  type DetectedWorktreeSession,
} from "@/lib/spaces/detectedWorktreeSessions";
import {
  useSpaces,
  type SpaceRow,
  usePinnedProjectIds,
} from "@/components/spaces/useSpaces";
import { useRecentSessionHistory } from "@/components/sessions/useRecentSessionHistory";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { useSpacesSelection } from "@/components/spaces/useSpacesSelection";
import { useSpacesCollapsedGroups } from "@/lib/spaces/spacesCollapsedGroupsStore";
import {
  normalizeSpacesQuery,
} from "@/lib/spaces/spacesSearch";
import { useSpacesPaneUi } from "@/lib/spaces/spacesPaneUiStore";
import { groupSpacesByRepository } from "@/lib/spaces/spaceRepositoryGroups";
import {
  UNOPENED_SECTION_FOLD_KEY,
  unopenedFoldKey,
  unopenedRepositoryRow,
} from "@/lib/spaces/unopenedAgentGroups";
import {
  indexUnopenedAgentConversations,
} from "@/lib/spaces/unopenedAgentPresentation";
import {
  EMPTY_SPACES_FILTERS,
  hasActiveSpacesFilters,
} from "@/lib/spaces/spacesViewOptions";
import {
  spacesFieldsPresent,
  spacesFilterChoices,
} from "@/lib/spaces/spacesViewProjection";
import { spacesEmptyStateKind } from "@/lib/spaces/spacesEmptyState";
import { unopenedAgentRows } from "@/lib/spaces/unopenedAgentRows";

export function SpacesPane() {
  const {
    agents,
    desktops,
    projects,
    pinnedPanes,
    detected,
    activeDesktopId,
    setActiveDesktop,
    sshHosts,
    readActiveDesktopId,
    readAgents,
    adoptAgent,
    spacesViewOptions,
    setSpacesViewOptions,
    focusedRowKey,
  } = useSpacesPaneState();
  const recentSessionHistory = useRecentSessionHistory(sshHosts);
  const unopenedConversationIndex = useMemo(
    () => indexUnopenedAgentConversations(recentSessionHistory.entries),
    [recentSessionHistory.entries],
  );
  const spaces = useSpaces();
  const filtersActive = hasActiveSpacesFilters(spacesViewOptions.filters);
  const fieldsPresent = useMemo(() => spacesFieldsPresent(spaces), [spaces]);
  const filterChoices = useMemo(
    () => spacesFilterChoices(spaces, spacesViewOptions.filters),
    [spaces, spacesViewOptions.filters],
  );
  const standaloneDiffCwds = useMemo(
    () =>
      spaces.flatMap((space) => {
        const cwd = localStandaloneDiffCwd(space);
        return cwd ? [cwd] : [];
      }),
    [spaces],
  );
  const {
    capabilities: diffCapabilities,
    probe: probeDiffCapability,
  } = useDiffReviewCapabilities(standaloneDiffCwds);
  // 검색어는 탭 왕복에 살아남는 모듈 스토어 소유(spacesPaneUiStore).
  const query = useSpacesPaneUi((state) => state.query);
  const setQuery = useSpacesPaneUi((state) => state.setQuery);
  const [locationManagerOpen, setLocationManagerOpen] = useState(false);
  const { pickLocalFolder } = useLocationAdd();
  // 열린 행과 열리지 않은 행 모두 pane 수명 밖의 resource-aware 대화상자를 쓴다.
  const requestAgentRemoval = useCallback((agent: (typeof agents)[number]) => {
    openAgentRemovalDialog(agent);
  }, []);
  // 워크트리 에이전트 생성 — 데스크탑 '+'에서 host(로컬/원격)·시작 위치와 함께 연다.
  const [worktreeAgentTarget, setWorktreeAgentTarget] = useState<{
    desktopId: string;
    host?: { id: string; name: string };
    initialPath?: string;
    initialProvider?: Provider;
  } | null>(null);
  const normalizedQuery = normalizeSpacesQuery(query);
  const openAgentIds = useMemo(
    () =>
      new Set(
        spaces.flatMap((space) => (space.kind === "agent" && space.agentId ? [space.agentId] : [])),
      ),
    [spaces],
  );
  const hiddenPaneIds = useHiddenPanes((state) => state.hidden);
  const { candidates, activity, displayStates, episodes, acks } =
    useUnopenedAgentsState(agents, openAgentIds, hiddenPaneIds);
  const hiddenUnopenedAgents = useUnopenedAgentVisibilityStore(
    (state) => state.hidden,
  );
  // visible과 숨김 수를 한 파생으로 계산한다 — 감지 워크트리 섹션과 같은
  // 문법: 검색으로 걸러진 목록을 기준으로 "숨김 n"을 센다.
  const { visible: unopenedAgents, hiddenCount: unopenedHiddenCount } = useMemo(
    () =>
      unopenedAgentRows({
        candidates,
        projects,
        conversationIndex: unopenedConversationIndex,
        activity,
        displayStates,
        episodes,
        acks,
        normalizedQuery,
        hidden: hiddenUnopenedAgents,
      }),
    [
      candidates,
      hiddenUnopenedAgents,
      projects,
      activity,
      displayStates,
      episodes,
      acks,
      normalizedQuery,
      unopenedConversationIndex,
    ],
  );
  const clearingUnopenedRef = useRef(false);
  const [clearingUnopened, setClearingUnopened] = useState(false);
  const [clearUnopenedError, setClearUnopenedError] = useState("");
  const clearUnopenedAgents = async () => {
    if (clearingUnopenedRef.current) return;
    clearingUnopenedRef.current = true;
    setClearingUnopened(true);
    setClearUnopenedError("");
    const results = await Promise.allSettled(
      candidates.map(async (agent) => {
        if (isAgentPaneMounted(agent.id, dockviewRegistry)) return;
        const operation = await prepareAgentRemoval(agent.id, {
          deleteWorktree: false,
          expectedIdentity: agentRemovalRegistrationIdentity(agent),
        });
        if (isAgentPaneMounted(agent.id, dockviewRegistry)) return;
        await executeAgentRemoval(operation);
      }),
    );
    setClearUnopenedError(
      results.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${agentDisplayName(candidates[index])}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
          : [],
      ).join("\n"),
    );
    clearingUnopenedRef.current = false;
    setClearingUnopened(false);
  };
  const detectedWorktreeSessions = useMemo(
    () =>
      selectDetectedWorktreeSessions({
        projects,
        detected,
        agents,
        query: normalizedQuery,
      }),
    [projects, detected, agents, normalizedQuery],
  );
  // The hook owns the repository, desktop, and runtime-facet hierarchies,
  // including popout nesting, row bucketing, visible folds, and trailing
  // hidden-file desktops. The pane only renders the shape it returns.
  // The focused pane's row stays visible under a folded repository (the
  // groups draw it themselves); the hierarchy needs its key so the selection
  // order includes that one row.
  const focusedVisibleKey = useMemo(
    () =>
      focusedRowKey &&
      spaces.some(
        (space) =>
          space.key === focusedRowKey && space.desktopId === activeDesktopId,
      )
        ? focusedRowKey
        : null,
    [spaces, focusedRowKey, activeDesktopId],
  );
  const pinnedProjectIds = usePinnedProjectIds();
  const hierarchy = useSpacesGroups({
    spaces,
    desktops,
    projects,
    pinnedProjectIds,
    pinnedPanes,
    groupBy: spacesViewOptions.groupBy,
    orderBy: spacesViewOptions.orderBy,
    filters: spacesViewOptions.filters,
    normalizedQuery,
    focusedRowKey: focusedVisibleKey,
  });
  // The unopened queue is grouped by repository too — through the same
  // grouping as the open list — but folds on its own keys, and the whole
  // section folds as one (사용자 요청 2026-09-03).
  const unopenedGroups = useMemo(
    () => groupSpacesByRepository(unopenedAgents.map(unopenedRepositoryRow)),
    [unopenedAgents],
  );
  const unopenedFold = useFoldMotion(UNOPENED_SECTION_FOLD_KEY);
  const foldKeys = useMemo(
    () => [
      ...hierarchy.collapsibleGroupKeys,
      ...(unopenedGroups.length > 0 ? [UNOPENED_SECTION_FOLD_KEY] : []),
      ...unopenedGroups.map((group) => unopenedFoldKey(group.key)),
    ],
    [hierarchy.collapsibleGroupKeys, unopenedGroups],
  );
  const visibleFoldKeys = useMemo(
    () => [
      ...hierarchy.visibleCollapsibleGroupKeys,
      ...(unopenedGroups.length > 0 ? [UNOPENED_SECTION_FOLD_KEY] : []),
      ...(unopenedFold.collapsed
        ? []
        : unopenedGroups.map((group) => unopenedFoldKey(group.key))),
    ],
    [hierarchy.visibleCollapsibleGroupKeys, unopenedGroups, unopenedFold.collapsed],
  );
  const collapsedGroups = useSpacesCollapsedGroups((state) => state.collapsed);
  const setCollapsedGroups = useSpacesCollapsedGroups(
    (state) => state.setCollapsed,
  );
  const canExpandAll = foldKeys.some((key) => collapsedGroups[key]);
  const canCollapseAll = visibleFoldKeys.some((key) => !collapsedGroups[key]);
  const hasScrollableSpacesContent =
    hierarchy.groups.length > 0 ||
    ("hiddenFileDesktops" in hierarchy &&
      hierarchy.hiddenFileDesktops.length > 0) ||
    ("trailingRepositories" in hierarchy &&
      hierarchy.trailingRepositories.length > 0);
  const expandAllGroups = useCallback(
    () => setCollapsedGroups(foldKeys, false),
    [foldKeys, setCollapsedGroups],
  );
  const collapseAllGroups = useCallback(
    () => setCollapsedGroups(visibleFoldKeys, true),
    [visibleFoldKeys, setCollapsedGroups],
  );

  // 다중선택·우클릭 메뉴 액션 — useSpacesSelection으로 추출(라쳇 헤드룸 확보).
  const {
    selected,
    clearSelection,
    contextMenuKey,
    conversionBusyKeys,
    selectedPromotionSummary,
    killConfirm,
    confirmKill,
    cancelKillConfirm,
    onSpaceClick,
    onContextMenuOpenChange,
    menuHandlers,
    forkRegisteredAgent,
    resolveDragItems,
  } = useSpacesSelection({
    spaces,
    selectionOrder: hierarchy.selectionOrder,
    diffCapabilities,
    probeDiffCapability,
    onRequestAgentRemoval: requestAgentRemoval,
  });
  // Identity only changes alongside killConfirm itself, so the group memo
  // holds in the steady state (no confirm armed).
  const onKillConfirm = useCallback(() => void confirmKill(), [confirmKill]);

  // 핸들러 정체성 규약(useSpacesSelection과 동일): memo된 저장소 그룹이 행
  // 내용 변화 아닌 핸들러 재바인딩으로 깨지지 않게 정체성을 고정하고, 최신
  // 행 목록은 커밋 직후 갱신되는 ref로 읽는다.
  const rowsRef = useRef<readonly SpaceRow[]>(spaces);
  // The list comes back where it was scrolled when the tab returns, as the
  // Files tree does; a grouping is its own list, and a search is none.
  const listRef = useRef<HTMLDivElement>(null);
  useSidebarScrollMemory(
    listRef,
    normalizedQuery ? null : `spaces:${spacesViewOptions.groupBy}`,
    true,
  );
  useLayoutEffect(() => {
    rowsRef.current = spaces;
  });

  // Hidden rows share the Agent opener's identity and anchor restoration.
  const onSpaceRowClick = useCallback(
    (event: Parameters<typeof onSpaceClick>[0], key: string, desktopId: string) => {
      const space = rowsRef.current.find((candidate) => candidate.key === key);
      if (space?.hidden && space.agentId) {
        const agentId = space.agentId;
        const agent = readAgents().find((candidate) => candidate.id === agentId);
        if (agent) {
          withDesktopDockview(desktopId, () => {
            openAgentPanel(desktopId, agent);
          });
          return;
        }
      }
      onSpaceClick(event, key, desktopId);
    },
    [onSpaceClick, readAgents],
  );
  const openUnopenedAgent = useCallback(
    (agent: (typeof agents)[number]) => {
      clearSelection();
      openAgentPanel(readActiveDesktopId(), agent);
    },
    [],
  );
  // 전용 워크트리 삭제 선택이 필요해 네이티브 confirm 대신 커스텀 다이얼로그.
  const killUnopenedAgent = requestAgentRemoval;
  // 지금 보이는 에피소드 시퀀스를 관측치로 기록한다 — 다음 에피소드가 행을
  // 자동으로 되살린다(unopenedAgentVisibility의 계약).
  const hideUnopenedAgent = useCallback((agent: (typeof agents)[number]) => {
    useUnopenedAgentVisibilityStore.getState().hide({
      id: agent.id,
      episode: useAgentAttention.getState().episodes[agent.id] ?? 0,
    });
  }, []);
  const viewUnopenedAgentDiff = useCallback((agent: (typeof agents)[number]) => {
    // 열린 pane의 diff와 같은 동작 — 좌측 패널에서 여는 diff는 창이다.
    void openAgentDiffWindow(agent.id, agentDisplayName(agent));
  }, []);
  const forkUnopenedAgent = useCallback(
    (agent: (typeof agents)[number], provider: Provider) => {
      forkRegisteredAgent(
        agent.id,
        readActiveDesktopId(),
        provider,
      );
    },
    [forkRegisteredAgent],
  );
  const adoptDetectedWorktree = useCallback(
    async (candidate: DetectedWorktreeSession, provider: Provider) => {
      const desktopId = readActiveDesktopId();
      const agent = await adoptAgent({
        projectId: candidate.projectId,
        provider,
        worktreePath: candidate.worktree.path,
        branch: candidate.worktree.branch,
        resume:
          detectedWorktreeSessionCount(candidate.worktree, provider) > 0,
      });
      openAgentPanel(desktopId, agent);
    },
    [],
  );
  // 데스크탑 '+'의 agent 항목 — ⋮ "새 에이전트 시작"과 같은 다이얼로그.
  const onAddAgent = useCallback((desktopId: string) => {
    setWorktreeAgentTarget({ desktopId });
  }, []);
  const onAddTerminal = useCallback((desktopId: string) => {
    withDesktopDockview(desktopId, (api) => openInheritedTerminalOn(api));
  }, []);

  // Repository head-row quick add — the cluster hook owns the wiring; the
  // dialog target stays here because the pane renders it.
  const {
    onAddRepositoryTerminal,
    onAddRepositoryAgent,
    onAddRepositoryAgentWithOptions,
  } = useRepositoryQuickAdd(setWorktreeAgentTarget);

  // ── 행 드래그 → 데스크탑 헤더/패널 영역으로 pane 이동 ──
  // The highlight is keyed by section, not desktop: under project-first the
  // same space appears under several repositories and only the hovered
  // section should light up.
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const onRowDragStart = useCallback((event: ReactDragEvent, key: string) => {
    const items = resolveDragItems(key);
    beginSpacesRowDrag(items);
    const draggedSpace = rowsRef.current.find((space) => space.key === key);
    setPaneDragImage(event.dataTransfer, {
      title: draggedSpace?.title ?? key,
      count: items.length,
    });
    // 한 pane은 Dockview pane drag와 동일한 MIME/현재 drag identity도 함께
    // 싣는다. 이 둘이 있어야 같은 데스크탑의 안쪽 경계 삽입과 다른 창의
    // target-first drop이 Spaces에서 시작해도 같은 경로를 탄다.
    writeSpacesPaneDragData(
      event.dataTransfer,
      items,
      getCurrentWindow().label,
    );
  }, [resolveDragItems]);
  const onRowDragEnd = useCallback(() => {
    endSpacesRowDrag();
    setDropTargetKey(null);
  }, []);
  const onActivateDesktop = useCallback(
    (desktopId: string) => {
      clearSelection();
      setActiveDesktop(desktopId);
    },
    [clearSelection, setActiveDesktop],
  );
  const onDragLeaveSection = useCallback((sectionKey: string) => {
    setDropTargetKey((prev) => (prev === sectionKey ? null : prev));
  }, []);
  const onDropOnDesktop = useCallback((desktopId: string, droppedItems: readonly SpacesDragItem[]) => {
    setDropTargetKey(null);
    endSpacesRowDrag();
    const items = droppedItems.filter(
      (item) => item.fromDesktopId !== desktopId,
    );
    if (items.length === 0) return; // 같은 데스크탑 드롭 등 — 선택도 유지
    void movePanelsToDesktop(items, desktopId);
    clearSelection();
  }, [clearSelection]);

  const activeDesktop = desktops.find((desktop) => desktop.id === activeDesktopId);
  const canCloseDesktop =
    desktops.filter((desktop) => desktop.kind !== "popout").length > 1;

  // Every repository section — pinned band or body — gets the same wiring;
  // only group, order, attention and drop target differ per section.
  const repositorySectionProps = {
    visibleFields: spacesViewOptions.visibleFields,
    groupBy: spacesViewOptions.groupBy,
    showSpaces: spacesViewOptions.showSpaces,
    canCloseDesktop,
    projects,
    sshHosts,
    onActivateDesktop,
    onAddAgent,
    onAddTerminal,
    onDragEnterSection: setDropTargetKey,
    onDragLeaveSection,
    onDropOnDesktop,
    diffCapabilities,
    selected,
    contextMenuKey,
    conversionBusyKeys,
    selectedPromotionEligible: selectedPromotionSummary.eligible,
    selectedPromotionDeferred: selectedPromotionSummary.deferred,
    onSpaceClick: onSpaceRowClick,
    onContextMenuOpenChange,
    onRowDragStart,
    onRowDragEnd,
    menuHandlers,
    killConfirm,
    onKillConfirm,
    onKillCancel: cancelKillConfirm,
    onAddRepositoryTerminal,
    onAddRepositoryAgent,
    onAddRepositoryAgentWithOptions,
  };
  // A retained desktop is not content. Search/filter recovery takes precedence
  // over the first-use welcome, and unopened/hidden/detected rows still count.
  const emptyKind =
    (normalizedQuery || filtersActive
      ? hierarchy.visibleRowCount === 0
      : spaces.length === 0) &&
    unopenedAgents.length === 0 &&
    unopenedHiddenCount === 0 &&
    detectedWorktreeSessions.length === 0
      ? spacesEmptyStateKind({
          query: normalizedQuery,
          filtersActive,
          hasLocations: projects.length > 0,
        })
      : null;
  const emptyState = emptyKind && (
    <SpacesEmptyState
      kind={emptyKind}
      query={normalizedQuery}
      filtersActive={filtersActive}
      onClearQuery={() => setQuery("")}
      onResetFilters={() =>
        setSpacesViewOptions({
          ...spacesViewOptions,
          filters: EMPTY_SPACES_FILTERS,
        })
      }
      onAddFolder={() => void pickLocalFolder()}
      desktopId={activeDesktop?.id}
    />
  );
  return (
    // 2386:41103 "project"는 10px을 지정하지만 12px을 쓴다 — 사이드바 탭들은
    // 한 컨테이너의 형제라, 이 패널만 10px이면 탭을 옮길 때 헤더가 2px 튄다.
    // 시안 한 장의 2px보다 탭 전환의 정지 상태가 우선이다.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5">
      {emptyKind !== "no_locations" && (
        <SpacesPaneHeader
          query={query}
          onQueryChange={setQuery}
          actions={
            <>
              <SpacesViewOptionsMenu
                value={spacesViewOptions}
                onChange={setSpacesViewOptions}
                filterChoices={filterChoices}
                fieldsPresent={fieldsPresent}
                canExpandAll={canExpandAll}
                canCollapseAll={canCollapseAll}
                onExpandAll={expandAllGroups}
                onCollapseAll={collapseAllGroups}
              />
              {/* Add a project: recent folders, the folder picker, remote hosts,
                  and the location manager behind one folder-plus (owner request
                  2026-09-03 — the list leads with repositories, so adding one
                  belongs in its header). */}
              <SpacesAddLocationMenu
                onManageLocations={() => setLocationManagerOpen(true)}
              />
              {/* 항상 보이는 추가 메뉴 — 활성 데스크탑에 agent 또는 terminal을 연다.
                  그룹 헤더의 hover '+'와 같은 메뉴다(발견 가능성 보완). */}
              {activeDesktop && (
                <DesktopAddMenuButton
                  desktop={activeDesktop}
                  onAddAgent={onAddAgent}
                  onAddTerminal={onAddTerminal}
                  triggerClassName=""
                />
              )}
            </>
          }
        />
      )}

      {/* data-spaces-list: the root whose sections glide together when a
          repository folds (useFoldMotion). */}
      {emptyKind === "no_locations" ? emptyState : (
        <SidebarScrollArea
          ref={listRef}
          edgeFade
          className="min-h-0 flex-1"
          // 8px before the first row, the same gap the File tab's first group
          // label carries (mt-2 there). It lives on the viewport rather than on
          // each section because the list leads with whichever section comes
          // first — a facet header, a space heading, a repository — and only
          // one of them should own the offset. 12px after the last, as the
          // Files tree's viewport has (owner call 2026-09-14: the two tabs
          // scroll alike).
          viewportClassName="pt-2 pb-3"
          data-spaces-list
        >
          <SpacesPinnedBand
            pinnedRows={hierarchy.pinnedRows}
            pinnedGroups={hierarchy.pinnedGroups}
            attentionByRepository={hierarchy.attentionByRepository}
            dropTargetKey={dropTargetKey}
            emptyLabel={
              normalizedQuery || filtersActive
                ? t("spaces.empty.noMatches")
                : undefined
            }
            repositoryBindings={repositorySectionProps}
          />
          {hierarchy.groupBy === "space" ? (
            hierarchy.groups.map(({ desktop, repositoryGroups, attentionCount }) => (
              <SpacesDesktopSection
                key={desktop.id}
                desktop={desktop}
                level="group"
                sectionKey={desktop.id}
                attentionCount={attentionCount}
                canClose={canCloseDesktop}
                isDropTarget={dropTargetKey === desktop.id}
                onActivate={onActivateDesktop}
                onAddAgent={onAddAgent}
                onAddTerminal={onAddTerminal}
                onDragEnterSection={setDropTargetKey}
                onDragLeaveSection={onDragLeaveSection}
                onDropOnDesktop={onDropOnDesktop}
              >
                {/* 행이 rounded-md 호버 배경을 갖게 되면서 오른쪽에도 여백이 필요하다
                    (53:391의 Sidebar nested item은 좌우 12px) */}
                <div className="@container/space-open-rows mx-2">
                  {/* A space with nothing open in it says so, the one quiet line an
                      empty repository draws (SpacesRepositorySection), on the inner
                      tier's 24px column. Open with nothing under it, the heading read as
                      a gap in the list (owner report 2026-09-14). */}
                  {repositoryGroups.length === 0 && (
                    <p className="pl-4 pt-1.5 pb-1.5 font-mono text-meta text-muted-foreground">
                      {t("spaces.repository.noSessions")}
                    </p>
                  )}
                  {repositoryGroups.map((repository, repositoryIndex) => (
                    <SpacesRepositoryGroup
                      key={repository.key}
                      group={repository}
                      desktopId={desktop.id}
                      isFirst={repositoryIndex === 0}
                      projects={projects}
                      sshHosts={sshHosts}
                      visibleFields={spacesViewOptions.visibleFields}
                      groupBy={spacesViewOptions.groupBy}
                      showSpaces={spacesViewOptions.showSpaces}
                      diffCapabilities={diffCapabilities}
                      selected={selected}
                      contextMenuKey={contextMenuKey}
                      conversionBusyKeys={conversionBusyKeys}
                      selectedPromotionEligible={selectedPromotionSummary.eligible}
                      selectedPromotionDeferred={selectedPromotionSummary.deferred}
                      onSpaceClick={onSpaceRowClick}
                      onContextMenuOpenChange={onContextMenuOpenChange}
                      onRowDragStart={onRowDragStart}
                      onRowDragEnd={onRowDragEnd}
                      menuHandlers={menuHandlers}
                      killConfirm={killConfirm}
                      onKillConfirm={onKillConfirm}
                      onKillCancel={cancelKillConfirm}
                      onAddRepositoryTerminal={onAddRepositoryTerminal}
                      onAddRepositoryAgent={onAddRepositoryAgent}
                      onAddRepositoryAgentWithOptions={
                        onAddRepositoryAgentWithOptions
                      }
                    />
                  ))}
                  {/* Hidden file panes take the session rows' rhythm: rows
                      touch, 6px under the heading (owner call 2026-09-14). */}
                  <div className="flex flex-col pt-1.5">
                    <HiddenFilePaneRows desktopId={desktop.id} />
                  </div>
                </div>
              </SpacesDesktopSection>
            ))
          ) : hierarchy.groupBy === "repository" ? (
            <>
              {hierarchy.groups.map((group, index) => (
                <SpacesRepositorySection
                  key={group.key}
                  group={group}
                  isFirst={index === 0}
                  attentionCount={hierarchy.attentionByRepository.get(group.key) ?? 0}
                  dropTargetKey={
                    dropKeyInRepository(dropTargetKey, group.key) ? dropTargetKey : null
                  }
                  {...repositorySectionProps}
                />
              ))}
              {hierarchy.hiddenFileDesktops.map((desktop) => (
                <SpacesDesktopSection
                  key={desktop.id}
                  desktop={desktop}
                  level="group"
                  sectionKey={desktop.id}
                  attentionCount={0}
                  canClose={canCloseDesktop}
                  isDropTarget={dropTargetKey === desktop.id}
                  onActivate={onActivateDesktop}
                  onAddAgent={onAddAgent}
                  onAddTerminal={onAddTerminal}
                  onDragEnterSection={setDropTargetKey}
                  onDragLeaveSection={onDragLeaveSection}
                  onDropOnDesktop={onDropOnDesktop}
                >
                  <div className="mx-2 flex flex-col pt-1.5">
                    <HiddenFilePaneRows desktopId={desktop.id} />
                  </div>
                </SpacesDesktopSection>
              ))}
            </>
          ) : (
            <SpacesFacetList
              hierarchy={hierarchy}
              dropTargetKey={dropTargetKey}
              repositoryBindings={repositorySectionProps}
            />
          )}

          {hierarchy.groupBy === "space" && hierarchy.trailingRepositories.map((repository, index) => (
            <SpacesRepositorySection
              key={repository.key}
              group={repository}
              isFirst={index === 0}
              attentionCount={0}
              dropTargetKey={null}
              {...repositorySectionProps}
            />
          ))}

          {(unopenedAgents.length > 0 || unopenedHiddenCount > 0 ||
            clearingUnopened || clearUnopenedError) && (
            <section
              ref={unopenedFold.sectionRef}
              aria-labelledby="unopened-agents-heading"
            >
              {/* A rule, not a gap: what is above are sessions that are open
                  and what follows are agents that are not — a change of kind,
                  which is what a rule marks (owner rule 2026-09-08). Still
                  nothing when there is nothing above: search can filter every
                  open space away, and a rule at the top of the scroll area
                  divides nothing. */}
              {hasScrollableSpacesContent && <SidebarHairline />}
              {/* 2391:43540 "Sidebar/Label" — 데스크탑 그룹 라벨과 같은 층의
                  제목이라 13px medium을 유지하고, 라벨도 같은 16px 열에 둔다:
                  접기 셰브런은 끝에 선다(앞에 서면 이 제목 하나만 열에서 밀려
                  난다 — 사용자 제보 2026-09-03). 카탈로그의 섹션 머리행: 라벨이
                  곧 접기 토글이고, 개수 뒤에 "숨김 n", 우측에 전체 복원
                  (RotateCcw). 개별 복원 대신 새 attention 에피소드가 행을 자동으로
                  되살린다. */}
              <SectionHeaderRow
                as="h3"
                id="unopened-agents-heading"
                // The marker Pinned takes at the other end of the tab, and the
                // one the Files tab uses: a 32px box, 11px medium at 70%, on
                // the rows' own 16px column (mx-2 over its px-2). It was 13px
                // in a 24px box — the size a repository name takes inside the
                // list below it, so the band's marker and the first row under
                // it read as one weight, and the tab's two bands wore two
                // faces (owner call 2026-09-14). Clear and the fold chevron
                // still sit in the taller box; the count went with the other
                // folded counts (owner call 2026-09-15).
                size="label"
                className="mx-2"
                weight="medium"
                chevron="trailing"
                label={t("spaces.pane.unopenedAgents")}
                expanded={!unopenedFold.collapsed}
                onToggle={unopenedFold.onToggle}
                // Terminate every unopened agent: a trash glyph that shows while
                // the marker is hovered, the way a repository row's rail does,
                // and keeps its slot so nothing shifts. It was a 13px "Clear"
                // text button, the loudest thing on the row and a click away
                // from a list you had not looked at; the glyph says what it
                // does — this ends the agents, it does not hide them — and the
                // long form stays as the tooltip. Hiding one agent moved into
                // the row's details card beside Resume (owner call 2026-09-14).
                actions={
                  <>
                    <IconButton
                      title={t("spaces.pane.clearUnopened")}
                      className="invisible group-hover/label:visible group-focus-within/label:visible"
                      disabled={clearingUnopened || candidates.length === 0}
                      aria-busy={clearingUnopened}
                      onClick={() => void clearUnopenedAgents()}
                    >
                      <Trash2 />
                    </IconButton>
                    {unopenedHiddenCount > 0 && (
                      <IconButton
                        title={t("spaces.pane.restoreHiddenAgents")}
                        onClick={() =>
                          useUnopenedAgentVisibilityStore.getState().restoreAll()
                        }
                      >
                        <RotateCcw />
                      </IconButton>
                    )}
                  </>
                }
              />
              {clearUnopenedError && (
                <p role="alert" className="mx-4 whitespace-pre-line text-xs text-destructive">
                  {clearUnopenedError}
                </p>
              )}
              {/* 열린 목록과 같은 저장소 접기 셸, 같은 12px 열 — 저장소마다 접히고
                  섹션 전체도 접힌다. 접힘 키는 섹션의 이름공간 아래라 열린 목록의
                  같은 저장소와 따로 논다. */}
              {!unopenedFold.collapsed && (
                <div className={cn("@container/space-open-rows mx-2", FOLD_REVEAL_CLASS)}>
                  {unopenedGroups.map((group, index) => (
                    <SpacesUnopenedRepositoryGroup
                      key={group.key}
                      group={group}
                      level={hierarchy.groupBy === "repository" ? "group" : "sub"}
                      isFirst={index === 0}
                      sectionHeadingId="unopened-agents-heading"
                      projects={projects}
                      sshHosts={sshHosts}
                      onOpen={openUnopenedAgent}
                      onViewDiff={viewUnopenedAgentDiff}
                      onFork={forkUnopenedAgent}
                      onHide={hideUnopenedAgent}
                      onKill={killUnopenedAgent}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 얇은 “최근” 섹션은 여기서 걷었다(사용자 결정 2026-08-11) — 시안
              2386:41391에 없는 섹션이고, Spaces는 ‘지금 열려 있는 것’만 담는다.
              과거 대화는 세션 패널(레일의 ‘세션’ 탭)이 그대로 갖고 있다.
              RecentWorkSection 자체는 SessionsPane이 계속 쓰므로 지우지 않는다. */}
          <DetectedWorktreeSessionsSection
            sessions={detectedWorktreeSessions}
            searchActive={normalizedQuery.length > 0}
            onAdopt={adoptDetectedWorktree}
          />

          {emptyState}
        </SidebarScrollArea>
      )}

      <LocationManagerDialog
        open={locationManagerOpen}
        onOpenChange={setLocationManagerOpen}
      />

      {worktreeAgentTarget && (
        <WorktreeAgentDialog
          desktopId={worktreeAgentTarget.desktopId}
          host={worktreeAgentTarget.host}
          initialPath={worktreeAgentTarget.initialPath}
          initialProvider={worktreeAgentTarget.initialProvider}
          onClose={() => setWorktreeAgentTarget(null)}
        />
      )}
    </div>
  );
}
