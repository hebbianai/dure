import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import {
  MoreVertical,
  PanelsTopLeft,
  Pin,
  PinOff,
  ShieldCheck,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TriangleAlert,
  X,} from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { Titled } from "@/components/ui/tooltip";
import { PaneChromeIcon } from "@/components/workspace/PaneChromeIcon";
import {
  useWorkspaceDurableLayoutCommit,
  useWorkspaceRuntimeDesktopId,
} from "@/components/workspace/WorkspaceRuntimeContext";
import { useConversationTitle } from "@/components/agents/chat/useConversationTitle";
import { t } from "@/lib/i18n";
import { fileTargetFromPane } from "@/lib/files/fileTarget";
import { AgentActivityGlyph } from "@/components/agents/AgentActivityGlyph";
import { IconButton } from "@/components/ui/icon-button";
import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { StatusDot } from "@/components/ui/status-dot";
import { openAgentPanel } from "@/lib/workspace/dock";
import { focusPanelContent } from "@/lib/workspace/dock/panelFocusHandoff";
import { closePanelById } from "@/lib/workspace/pane/paneCloseCoordinator";
import { paneSplitActions } from "@/lib/workspace/pane/paneSplitActions";
import { WorktreeAgentDialog } from "@/components/agents/WorktreeAgentDialog";
import { AgentPermissionModeDialog } from "@/components/agents/AgentPermissionModeDialog";
import { openAgentRemovalDialog } from "@/lib/agents/agentRemovalDialog";
import { closePaneWithPinGuard } from "@/lib/workspace/pane/paneClose";
import { dockFloatingPaneToGrid } from "@/lib/workspace/pane/paneDropCoordinator";
import { panePinKey } from "@/lib/workspace/pane/panePin";
import { usePaneHideAndHistoryActions } from "@/components/workspace/PaneHideAndHistoryItems";
import { cn } from "@/lib/utils";
import {
  cwdName,
  paneTitleFromObservedTitle,
  paneTitleTooltip,
  resolveAgentPaneTitle,
} from "@/lib/workspace/pane/paneTitle";
import { copyTextToClipboard } from "@/lib/platform/clipboardWrite";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import { hmuxPaneConversationId } from "@/lib/terminal/terminalBinding";
import { paneHealthChip } from "@/lib/workspace/pane/paneHealthChip";
import {
  hmuxPaneSessionLabel,
  paneHealthChipTitle,
} from "@/lib/workspace/pane/paneHealthDetail";
import { PROVIDERS, type Agent } from "@/types";
import { useAgentDisplayState } from "@/components/agents/useAgentDisplayState";
import { usePaneSessionConversion } from "@/components/workspace/usePaneSessionConversion";
import {
  hmuxManagedPromotionAvailability,
  hmuxManagedPromotionLabel,
} from "@/lib/hmux/conversion/hmuxManagedPromotionEligibility";
import {
  getSpacesPaneHover,
  spacesPaneHoverKey,
  subscribeSpacesPaneHover,
} from "@/lib/spaces/spacesPaneHover";
import {
  useTerminalExecutionLocation,
  useTerminalExecutionLocationObservation,
} from "@/lib/terminal/terminalExecutionLocationStore";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { createPaneTranscriptCopyAction } from "@/lib/agents/chat/agentTranscriptClipboard";
import { usePaneRenameControls } from "@/components/workspace/PaneRenameControls";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { usePaneQuickCommands } from "@/components/workspace/usePaneQuickCommands";
import { QuickCommandDialog } from "@/components/workspace/QuickCommandDialog";
import { ErrorText } from "@/components/ui/error-text";
import { PaneHmuxWindowActions } from "@/components/workspace/PaneHmuxWindowActions";
import { PaneInfoDialog } from "@/components/workspace/PaneInfoDialog";
import { planAgentWorktreeRemoval } from "@/lib/scm/worktrees/worktreeRemoval";
import { useManagedCredentialSwitchHealthState } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import {
  PaneActionContextMenu,
  PaneActionDropdown,
} from "@/components/workspace/PaneActionMenu";
import { buildPaneActionMenuSections } from "@/components/workspace/PaneActionMenuSections";
import { usePanePermissionModeActions } from "@/components/workspace/usePanePermissionModeActions";
import { usePaneRehostAction } from "@/components/workspace/usePaneRehostAction";
import { requestDelegateTaskDialog } from "@/lib/workspace/pane/paneMenuSignals";
import { syncSpacesPaneHoverGroup } from "@/lib/workspace/dockviewGroupPresentation";
import { useDockviewGroupActive } from "@/components/workspace/useDockviewGroupActive";
import { useDockviewPaneFloating } from "@/components/workspace/useDockviewPaneFloating";
import { usePaneExternalWorkspaceOpen } from "@/components/workspace/usePaneExternalWorkspaceOpen";
import {
  buildPaneInfoModel,
  resolvePaneInfoExecutionLocation,
} from "@/lib/workspace/pane/paneInfo";
import { sessionKindExecutionProfile } from "@/lib/terminal/sessionKindExecutionProfile";
import {
  type PaneParams,
  usePaneChromeState,
} from "@/components/workspace/usePaneChromeState";
import { sessionRuntimeDisplayState } from "@/lib/sessions/runtime/sessionRuntimeDisplayState";

/** The agent's glyph slot — AgentActivityGlyph: the provider logo, the
 * loader while it works, and every other display state as the corner badge.
 * The header draws no separate dot after the label any more (owner decision
 * 2026-09-03: it spent room on what the slot already says). */
function PaneAgentIcon({ agent }: { agent: Agent }) {
  const { state, unread } = useAgentDisplayState(agent);
  return (
    <AgentActivityGlyph
      provider={agent.provider}
      activity={state}
      unread={unread}
      className="text-inherit"
    />
  );
}

/** One DockView group is one pane. This native header is the pane's drag surface,
 * not a second navigation layer; pane-specific controls stay in the content. */
export function PaneChrome(props: IDockviewPanelHeaderProps) {
  // 기본 모드 간소화(2026-08-31): 세션 분리 창(Expand)과 managed 승격 방패는
  // 멀티윈도우·런타임 오케스트레이션 표면이라 pro에서만 그린다.
  const interfaceMode = useInterfaceMode();
  const isGroupActive = useDockviewGroupActive(props.api);
  const floating = useDockviewPaneFloating(props.api);
  const desktopId = useWorkspaceRuntimeDesktopId();
  const commitWorkspaceLayout = useWorkspaceDurableLayoutCommit();
  const id = props.api.id;
  const component = props.api.component;
  const paneRuntimeId = hmuxPaneHealthId(desktopId, props.api.id);
  const quickCommands = usePaneQuickCommands(paneRuntimeId);
  const spacesPaneHover = useSyncExternalStore(
    subscribeSpacesPaneHover,
    getSpacesPaneHover,
    getSpacesPaneHover,
  );
  const isSpacesPaneHovered =
    spacesPaneHover === spacesPaneHoverKey(desktopId ?? "detached", props.api.id);
  const params = props.params as PaneParams | undefined;
  const paneParamsRef = useRef<PaneParams>(params ?? {});
  paneParamsRef.current = params ?? {};
  const [paneMenuOpen, setPaneMenuOpen] = useState(false);
  // Whether the header has folded its split buttons (the @min-[320px]
  // container query on their span). Read once, when the ⋯ menu opens — the
  // CSS decides, this only asks the DOM what it did — so no width is mirrored
  // into React state on every sash move (the 2026-08-12 concern).
  const splitButtons = useRef<HTMLSpanElement>(null);
  const [headerFolded, setHeaderFolded] = useState(false);
  const [paneContextMenuOpen, setPaneContextMenuOpen] = useState(false);
  // 고정 — 설정 › 일반 › 탐색 › 고정된 탭을 닫기 전에 확인이 켜져 있으면
  // 이 pane의 닫기 경로(여기 X 버튼과 ⌘W)가 확인을 한 번 거친다.
  const pinKey = panePinKey(desktopId, props.api.id);
  const {
    agent,
    projects,
    sshHosts,
    desktopKind,
    project,
    gitError,
    sshState,
    liveCwd,
    terminalTitle,
    sessionProvider,
    sessionAgentRuntimeState,
    agentLiveCwd,
    sshHost,
    agentSshHost,
    hmuxSessionMetadata,
    hmuxHealth,
    getHmuxHealthSnapshot,
    pinned,
    togglePanePin,
    allAgents,
    sessionId,
    hmuxBinding,
  } = usePaneChromeState({
    params,
    panelId: id,
    component,
    desktopId,
    paneRuntimeId,
    pinKey,
    includeSwitchCandidates: paneMenuOpen || paneContextMenuOpen,
  });
  const executionLocation = useTerminalExecutionLocation(sessionId ?? "");
  const executionLocationObserved = useTerminalExecutionLocationObservation(
    sessionId ?? "",
  );
  const nestedSsh =
    component === "terminal" && executionLocation.kind === "ssh"
      ? executionLocation
      : undefined;
  const paneActionParams: PaneParams | undefined = component === "agent"
    ? {
        agentId: agent?.id,
        ...(hmuxBinding ? { binding: hmuxBinding } : {}),
      }
    : params;
  const paneActionBinding = component === "agent" ? hmuxBinding : paneActionParams?.binding;
  const removableWorktree = agent
    ? planAgentWorktreeRemoval(agent, project)
    : null;
  const agentLabel = agent ? agentDisplayName(agent) : undefined;

  // 분할 — 터미널 우클릭·탭 우클릭·⌘D와 같은 결정 함수(paneSplitTargetForPanel):
  // 원격 pane은 같은 SSH 호스트로, cwd는 런타임이 추적한 실제 폴더를 물려받는다.
  const splitActions = paneSplitActions({
    desktopId,
    panelId: props.api.id,
    component,
    params,
  });

  // 이 pane을 다른 에이전트 pane으로 교체 — "닫기 → 에이전트 추가"를 같은
  // 자리에서 한 번에(사용자 요청 2026-08-01). 같은 그룹에 새 pane을 먼저
  // 얹고(within) 이 pane을 닫아 그리드 슬롯을 보존한다. 고정 확인은 기존
  // 닫기 경로(closePaneWithPinGuard)를 그대로 지난다.
  // The state hook exposes the Agent fleet only while either action surface is
  // open, so background conversation updates cannot make every mounted pane
  // header rebuild and sort this candidate projection.
  const switchCandidates = useMemo(
    () =>
      allAgents
        .filter((candidate) => candidate.id !== agent?.id)
        .map((candidate) => ({
          agent: candidate,
          projectName:
            projects.find((entry) => entry.id === candidate.projectId)?.name ??
            "?",
        }))
        .sort((a, b) =>
          `${a.projectName}/${agentDisplayName(a.agent)}`.localeCompare(
            `${b.projectName}/${agentDisplayName(b.agent)}`,
          ),
        ),
    [agent?.id, allAgents, projects],
  );
  const switchToAgent = (target: Agent) => {
    if (!desktopId) return;
    setPaneMenuOpen(false);
    // 메뉴가 완전히 닫힌 뒤에 pane을 치운다 — 같은 프레임에 앵커(트리거)가
    // 사라지면 popper가 좌측상단으로 튄다(새 에이전트·숨기기와 동일 패턴).
    window.setTimeout(() => {
      void closePaneWithPinGuard({
        id: props.api.id,
        pinKey,
        title: props.api.title,
        // params가 없으면 fail-closed로 legacy 취급돼 hmux pane 교체에도
        // 세션 종료 경고가 떴다(2026-08-01 랜딩 리뷰 발견 #3).
        params: paneActionParams,
        close: () => {
          openAgentPanel(desktopId, target, {
            referencePanel: props.api.id,
            direction: "within",
          });
          closePanelById(props.api.id, desktopId);
        },
      });
    }, 0);
  };
  // "새 에이전트 시작"은 add agent 다이얼로그 전체 흐름(위치·워크트리·계정
  // 선택)을 그대로 쓰되, 생성된 pane을 이 자리에 얹고 이 pane을 닫는다 —
  // close→add agent와 동일(사용자 요청 2026-08-01).
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  // ⋮ 메뉴는 controlled — X 버튼이 드래그 보호용 stopPropagation을 하면서
  // Radix 외부클릭 해제가 막히고, dockview가 탭을 캐시해 컴포넌트도 살아
  // 남아 pane이 닫혀도 메뉴가 화면에 남았다(Pinpoint 제보 2026-08-01).
  // pane을 닫는 경로에서 명시적으로 닫는다.
  const externalWorkspaceOpen = usePaneExternalWorkspaceOpen({
    menuOpen: paneMenuOpen,
    panelId: props.api.id,
    spaceId: desktopId,
  });
  const [paneInfoOpen, setPaneInfoOpen] = useState(false);
  // 반응형 top bar는 CSS container query가 소유한다. Dockview sash가 움직일
  // 때 exact width를 React state로 복제하면 pane마다 전체 chrome을 다시 그린다.
  const barElement = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = barElement.current;
    if (!element) return;
    return syncSpacesPaneHoverGroup(element, isSpacesPaneHovered);
  }, [isSpacesPaneHovered]);
  const [permissionModeOpen, setPermissionModeOpen] = useState(false);
  const {
    executePermissionMode,
    permissionModeAvailable,
    permissionModeBusy,
  } = usePanePermissionModeActions({
    agent,
    binding: hmuxBinding,
    paneId: props.api.id,
  });
  const rehostActions = usePaneRehostAction({
    agent,
    api: props.api,
    commitWorkspaceLayout,
    hmuxBinding,
    paneParamsRef,
  });

  const [title, setTitle] = useState(props.api.title ?? props.api.id);
  useEffect(() => {
    const d = props.api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [props.api]);

  // hmux binding pane은 스토어에 게시된 attach 메타데이터를 읽는다. binding
  // 없는 legacy term pane의 projection 공유 경로는 legacy 렌더러와 함께
  // 은퇴했다 (2026-08-16).
  const displayedHmuxMetadata = hmuxSessionMetadata;
  const hmuxSessionName = displayedHmuxMetadata?.sessionName;
  const hmuxSessionId =
    hmuxBinding?.sessionId ?? displayedHmuxMetadata?.sessionId;
  const showsHmux = Boolean(hmuxBinding);
  // 정체성 배지는 평소엔 어떤 pane에서도 그리지 않는다 — 세션 정보는 헤더
  // 라벨·hover title이 이미 말해 주고, connecting/recovering은 일시 상태라
  // 별도 오류 배지로 키우지 않는다. 하드 문제(error/stale)일 때만 드러낸다. 처음엔 managed
  // pane만 이렇게 접었는데, standalone 배지도 같은 이유로 소음이라는 지적이
  // 있었다(Pinpoint 제보 2026-07-31).
  const displayedHmuxLabel = hmuxPaneSessionLabel(hmuxSessionName, hmuxSessionId);
  const terminalProvider =
    component === "terminal" || component === "ssh" ? sessionProvider : null;
  const managedPromotion = hmuxManagedPromotionAvailability(
    {
      kind: nestedSsh
        ? "ssh"
        : component === "terminal"
          ? "term"
          : component === "ssh"
            ? "ssh"
            : "other",
      hostId: params?.hostId,
      runtime: hmuxBinding?.runtime,
      workspaceId: hmuxBinding?.workspaceId,
      provider: terminalProvider,
      executionLocationKnown:
        !hmuxBinding ||
        (Boolean(sessionId) &&
          executionLocationObserved &&
          executionLocation.kind !== "unknown"),
      displayState: sessionRuntimeDisplayState(sessionAgentRuntimeState),
      cwd: nestedSsh ? undefined : liveCwd || params?.cwd,
    },
    projects,
  );
  const managedPromotionLabel = hmuxManagedPromotionLabel(
    managedPromotion,
    terminalProvider,
  );
  const icon =
    agent && !nestedSsh ? (
      <PaneAgentIcon agent={agent} />
    ) : (
      <PaneChromeIcon
        component={component}
        nestedSsh={Boolean(nestedSsh)}
        agentProvider={agent?.provider}
        terminalProvider={terminalProvider}
      />
    );

  const agentCwd = agentLiveCwd || agent?.worktreePath;
  const agentExecutionProfile = agent
    ? sessionKindExecutionProfile(agent.sessionKind)
    : undefined;
  const agentHost = agentExecutionProfile?.hostLabel(agentSshHost?.name) ?? "local";
  const agentConversationTitle = useConversationTitle(agent?.id);
  const terminalDirectory = cwdName(nestedSsh ? undefined : liveCwd || params?.cwd);
  const terminalAutomaticFallback = terminalProvider
      ? [PROVIDERS[terminalProvider].label, terminalDirectory].filter(Boolean).join(" · ")
      : title;
  const automaticLabel = nestedSsh
    ? nestedSsh.target
    : agent
      ? resolveAgentPaneTitle({
          name: agent.name,
          displayName: agent.displayName,
          runtimeTitle: agentConversationTitle ?? terminalTitle,
          opaqueConversationId:
            hmuxPaneConversationId(hmuxBinding) ?? agent.conversationId,
          directoryCandidates: [agentLiveCwd, agent.worktreePath],
        })
      : component === "agent"
        ? t("common.unavailable")
        : paneTitleFromObservedTitle(terminalTitle, terminalAutomaticFallback);
  const renameControls = usePaneRenameControls({
    agent,
    api: props.api,
    automaticTitle: automaticLabel,
  });
  const file = fileTargetFromPane({ component, params: paneActionParams });
  const hideAndHistoryActions = usePaneHideAndHistoryActions({
    agent,
    binding: hmuxBinding,
    desktopId,
    panelId: props.api.id,
    file,
    projectKind: project?.kind,
  });
  const label = renameControls.overrideTitle ?? automaticLabel;
  const terminalDetail = component === "ssh"
    ? `${sshHost?.name ?? "ssh"} (${sshHost ? `${sshHost.user}@${sshHost.host}:${sshHost.port}` : "unknown host"}) · ${liveCwd || params?.cwd || "~"}`
    : component === "terminal"
      ? nestedSsh
        ? nestedSsh.target
        : showsHmux
        ? `${sshHost?.name ?? "local"} · ${displayedHmuxLabel} · ${liveCwd || params?.cwd || "~"}`
        : `${terminalTitle || "local"} · ${liveCwd || params?.cwd || "~"}`
      : undefined;
  const detail =
    agent && project
      ? `${agentLabel} · ${agentHost} · ${agentCwd ?? "~"} · ${project.name}`
      : (terminalDetail ?? title);
  const titleTooltip = paneTitleTooltip(label, detail);
  const hmuxHealthState = useManagedCredentialSwitchHealthState(
    agent?.id,
    agent?.pendingCredentialSwitch,
    hmuxHealth?.state,
  );
  const healthChip = showsHmux
    ? paneHealthChip(hmuxHealthState, hmuxHealth?.reason)
    : null;
  const conversion = usePaneSessionConversion({
    binding: hmuxBinding,
    sessionName: hmuxSessionName,
    panelId: props.api.id,
    managedPromotion,
  });

  const closePane = () => {
    setPaneMenuOpen(false);
    void closePaneWithPinGuard({
      id: props.api.id,
      pinKey,
      title: props.api.title,
      params: paneActionParams,
      close: () =>
        desktopId ? closePanelById(props.api.id, desktopId) : props.api.close(),
    });
  };

  const paneMenuSections = buildPaneActionMenuSections({
    basicInterface: interfaceMode === "basic",
    agent,
    changePermissionMode: permissionModeAvailable
      ? () => setPermissionModeOpen(true)
      : undefined,
    closePane,
    conversionBusy: conversion.busy,
    conversionTarget: conversion.target,
    convertSession: () => void conversion.convert(),
    copyIdentifier: (value) =>
      void copyTextToClipboard(value, { paneId: props.api.id }),
    copyTranscript: createPaneTranscriptCopyAction(agent, hmuxBinding, props.api.id),
    delegateTask:
      agent && desktopId
        ? () => requestDelegateTaskDialog(props.api.id)
        : undefined,
    desktopId,
    desktopKind,
    externalOpenTargets: externalWorkspaceOpen.targets,
    hide: hideAndHistoryActions.hide,
    history: hideAndHistoryActions.history,
    hostId: paneActionBinding?.hostId ?? paneActionParams?.hostId,
    newAgent: () => setNewAgentOpen(true),
    openAgentRename: renameControls.openAgentRename,
    openExternalWorkspace: externalWorkspaceOpen.open
      ? (targetId) => void externalWorkspaceOpen.open?.(targetId)
      : undefined,
    openPaneInfo: () => setPaneInfoOpen(true),
    openPaneRename: renameControls.openPaneRename,
    panelId: props.api.id,
    file,
    permissionModeBusy,
    pinned,
    ...rehostActions,
    removableWorktree: Boolean(removableWorktree),
    ...splitActions,
    sshHosts,
    switchCandidates,
    switchToAgent,
    togglePin: () => togglePanePin(pinKey),
    deleteAgent: () => {
      if (agent) openAgentRemovalDialog(agent);
    },
  });

  // Dialog가 열릴 때만 상세 projection을 만든다. 평소 모든 pane header가
  // mount된 상태에서는 기존 runtime/store 구독 외의 추가 작업을 하지 않는다.
  const paneInfo = paneInfoOpen
    ? buildPaneInfoModel({
        paneId: id,
        component,
        title: label,
        spaceId: desktopId,
        pinned,
        agent,
        project,
        binding: paneActionBinding,
        sessionId,
        cwd: agentCwd ?? (nestedSsh ? undefined : liveCwd || params?.cwd),
        executionLocation: resolvePaneInfoExecutionLocation({
          agentProfile: agentExecutionProfile,
          agentSshHostName: agentSshHost?.name,
          nestedSsh,
          component,
          binding: hmuxBinding,
          sshHostName: sshHost?.name,
          paramsHostId: paneActionParams?.hostId,
          observed: executionLocation,
        }),
        provider: terminalProvider,
        sessionMetadata: displayedHmuxMetadata,
        // Sequence receipts remain exact in the runtime store for automatic
        // rehost fences; Pane Info takes a fresh diagnostic snapshot on open.
        paneHealth: getHmuxHealthSnapshot(),
        effectivePaneHealth: hmuxBinding ? hmuxHealthState : undefined,
        sshState,
      })
    : undefined;

  // 시안 2070:32420 "Background+HorizontalBorder": 높이 32px, 오른쪽 여백만
  // 8px이고 왼쪽 여백은 탭이 자기 pl-16px으로 갖는다. 드래그 손잡이(grip)는
  // 시안에 없다 — 헤더 전체가 이미 드래그 표면이라 장식이었다.
  return (
    <>
    <PaneActionContextMenu
      open={paneContextMenuOpen}
      onOpenChange={(open) => { setPaneContextMenuOpen(open); quickCommands.captureTarget(open); }}
      sections={hmuxBinding ? [quickCommands.section, ...paneMenuSections] : paneMenuSections}
    >
    {/* The header is one row on the opaque glass/header band (design
        2355:50233). The band itself is painted by the tabs-and-actions
        container in index.css, not here — this element is a content-width tab,
        so a background on it would not line up with the card's rounded corner.
        The band is a structural separator, not an active-state signal: every
        pane carries it regardless of focus, because a 2px seam alone read as
        too weak a division (GLASS.md §3). No rounded-tl here — the card's own
        clipping makes the outer corner, and per-pane radius was retired
        (GLASS.md §3: 구 rounded-tl-12 방식 폐기 — pane 개별 카드형 라운드 금지).
        The design draws a second 32px row of session actions under this one.
        It is not reproduced: AgentPanelToolbarFrame already renders that exact
        cluster inside the pane content, so a header row would have been a
        second copy of a surface that already exists. */}
    <div
      ref={barElement}
      data-pane-active={isGroupActive ? "" : undefined}
      onClick={(event) => {
        const target = event.target;
        if (
          event.defaultPrevented || !(target instanceof Element) ||
          !event.currentTarget.contains(target) || target.closest("button")
        ) return;
        // Dockview activates its tab on press; a completed header click also
        // hands the keyboard to content. Toolbar and portal controls keep focus.
        focusPanelContent(props.containerApi, props.api.id);
      }}
      className={cn(
        "pane-chrome group group/pane-chrome @container/pane-chrome flex h-full w-full min-w-0 items-center overflow-hidden pr-2",
        isGroupActive &&
          // A 4% ring wash over the band the tabs container already paints —
          // not a second copy of the band with the ring mixed in, which
          // stacked two translucent layers on the focused header alone and
          // made it read solid under the surface alpha (owner report
          // 2026-09-09). At 100% the two are the same pixels.
          "bg-[color-mix(in_srgb,var(--ring)_4%,transparent)]",
      )}
    >
      {/* ContentTab (2355:50233 "Content") — 항목 사이 8px.
          시안의 고정 폭(120px, 88~166px)은 쓰지 않는다. 그 값들은 제목이
          짧은 목업 기준이라, 실제 제목("Codex · agent-ide")에 걸면 pane 폭이
          남아도는데도 166px에서 …으로 잘렸다. 대신 내용만큼 늘고 자리가
          모자랄 때만 줄어들게 둔다 — 잘림은 진짜 좁을 때만 일어난다.
          왼쪽 여백은 시안 16px 대신 12px. 오른쪽 끝의 ×는 pr-2(8px) 안의 24px
          버튼에 14px 글리프로 앉으므로 글리프 자체는 가장자리에서 13px에
          있다 — 왼쪽 글리프도 같은 거리에 서야 좌우가 맞는다(소유자 지적
          2026-09-10; 그전 8px은 pr-2와 같은 값이라 글리프 기준으로는 5px
          안쪽이었다). 시안의 16px은 아래에 액션 행이 한 줄 더 있는 전제에서
          나온 값이라 그대로 쓰지 않는다. */}
      <div
        className={cn(
          "flex h-full min-w-0 shrink items-center gap-2 overflow-hidden pr-2 pl-3",
          isGroupActive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {icon}
        {/* 전체 진단(detail)은 제목 텍스트에만 건다 — 바 전체에 걸면 hover가
            버튼 대신 툴팁부터 띄운다(Pinpoint 제보 2026-08-01: top bar
            hover는 버튼이 우선). */}
        <OverflowRevealText
          text={label}
          data-pane-title=""
          className="min-w-0 shrink text-xs leading-4 font-medium whitespace-nowrap"
          title={titleTooltip}
        />
      </div>
      {gitError && (
        <Titled title={t("workspace.pane.gitStatusRefreshFailed", { error: gitError })}>
          <span
            className="flex shrink-0"
          >
            <TriangleAlert className="size-3 text-status-warn" />
          </span>
        </Titled>
      )}
      {!rehostActions.rehostBusy && !agent && sshState && (
        // Connected is steady green, terminal failures are destructive, and
        // every in-between transport state pulses amber.
        <StatusDot
          tone={
            sshState === "connected"
              ? "run"
              : sshState === "error" || sshState === "closed"
                ? "error"
                : "warn"
          }
          pulse={sshState !== "connected" && sshState !== "error" && sshState !== "closed"}
          title={sshState}
        />
      )}
      <span className="min-w-0 flex-1" aria-hidden="true" />
      {!rehostActions.rehostBusy && healthChip ? (
        // Our badge geometry (h22, r8) on an opaque achromatic face. A failure
        // is a sentence plus a glyph, never a coloured fill.
        <Titled title={paneHealthChipTitle({
              sessionLabel: displayedHmuxLabel,
              metadata: displayedHmuxMetadata,
              healthState: hmuxHealthState,
              health: hmuxHealth,
            })}>
          <span
            className="flex h-[22px] max-w-40 shrink-0 items-center gap-2 truncate rounded-md border border-glass-hairline bg-glass-pane px-2 text-meta leading-4 font-medium text-muted-foreground"
          >
            {/* The 5px dot belongs to session activity; inside a chip it would
                blur that vocabulary. A hard problem reads as a warning glyph, a
                transient one as a spinner. */}
            {healthChip === "recovering" ? (
              <DureLoader decorative className="shrink-0" />
            ) : (
              <TriangleAlert className="size-3 shrink-0 text-status-error" />
            )}
            {/* Session name and retirement policy are noise on the pane
                (Pinpoint report 2026-07-31) — the only signal needed here is
                "something is wrong"; the full diagnostic, name included, stays
                in the hover title. */}
            {healthChip === "connectionError"
              ? t("workspace.health.connectionError")
              : healthChip === "notResponding"
                ? t("workspace.health.notResponding")
                : t("workspace.health.recovering")}
          </span>
        </Titled>
      ) : null}
      {hmuxBinding && (
        <PaneHmuxWindowActions
          agent={agent}
          active={isGroupActive}
          sourcePaneOwnerId={paneRuntimeId}
        />
      )}
      {interfaceMode === "pro" &&
        conversion.target === "managed" &&
        managedPromotion !== "hidden" && (
        <Titled title={managedPromotionLabel}>
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 text-primary transition-[color,background-color,opacity] duration-150 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-40"
            aria-label={managedPromotionLabel}
            disabled={conversion.busy || managedPromotion !== "eligible"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void conversion.convert();
            }}
          >
            {conversion.busy ? (
              <DureLoader decorative />
            ) : (
              <ShieldCheck className="size-3" />
            )}
          </button>
        </Titled>
      )}
      {/* Additional icons container (2070:31475) — 22px 버튼 3개, 간격 4px.
          분할 두 개는 우클릭·⋮가 공유하는 pane action model의 빠른 진입점이다.
          Fold thresholds: the five buttons take 142px with their gaps and the
          bar's padding, and a typical title ("local · dure-internal", 13px)
          takes ~180px with its glyph and insets, so the split pair stays up
          to 320px and folds below; the pin folds below 260px. 420/340 folded
          them while the bar still had a hand's width of air (owner report
          2026-09-13). */}
      <div data-pane-actions="" className="flex shrink-0 items-center gap-1 pl-2">
        {/* 분할·고정·세션 전환은 한 메뉴로 — 버튼 줄이 길수록 top bar hover의
            우선권(제목 대신 액션)이 흐려진다(사용자 요청 2026-08-01). 고정된
            pane은 트리거에 상태색을 남겨 접힌 뒤에도 읽힌다. */}
        {desktopId && (
          <span
            ref={splitButtons}
            className="hidden shrink-0 items-center gap-1 @min-[320px]/pane-chrome:flex"
          >
            <PaneActionButton
              label={t("common.splitRight")}
              onClick={() => splitActions.splitPane("right")}
            >
              <SquareSplitHorizontal />
            </PaneActionButton>
            <PaneActionButton
              label={t("common.splitDown")}
              onClick={() => splitActions.splitPane("below")}
            >
              <SquareSplitVertical />
            </PaneActionButton>
          </span>
        )}
        {/* Floating panes get the explicit way back to the grid — the
            shift+drag redock gesture alone was undiscoverable (2026-09-01). */}
        {floating && desktopId && (
          <PaneActionButton
            label={t("workspace.pane.dockBack")}
            onClick={() => {
              dockFloatingPaneToGrid(desktopId, props.api.id);
            }}
          >
            <PanelsTopLeft />
          </PaneActionButton>
        )}
        <span className="hidden shrink-0 @min-[260px]/pane-chrome:flex">
          <PaneActionButton
            label={pinned ? t("workspace.pane.unpin") : t("workspace.pane.pin")}
            onClick={() => togglePanePin(pinKey)}
            active={pinned}
          >
            {pinned ? <PinOff /> : <Pin />}
          </PaneActionButton>
        </span>
        <PaneActionDropdown
          open={paneMenuOpen}
          onOpenChange={(open) => {
            if (open) {
              const span = splitButtons.current;
              setHeaderFolded(!span || getComputedStyle(span).display === "none");
            }
            setPaneMenuOpen(open);
            quickCommands.captureTarget(open);
          }}
          headerFolded={headerFolded}
          sections={hmuxBinding ? [quickCommands.section, ...paneMenuSections] : paneMenuSections}
          trigger={
            // Not on the shared tooltip: this element is the dropdown's own
            // trigger, and a wrapper between them would swallow the props the
            // menu clones onto it. Named for assistive tech instead.
            <button
              type="button"
              className={cn(
                "flex size-[22px] shrink-0 items-center justify-center rounded-sm p-1 transition-colors duration-150 hover:bg-glass-tint-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-3.5",
                pinned
                  ? "text-foreground @min-[260px]/pane-chrome:text-muted-foreground"
                  : "text-muted-foreground",
              )}
              aria-label={t("workspace.paneMenu.title")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              {pinned ? (
                <>
                  <Pin className="@min-[260px]/pane-chrome:hidden" />
                  <MoreVertical className="hidden @min-[260px]/pane-chrome:block" />
                </>
              ) : (
                <MoreVertical />
              )}
            </button>
          }
        />
        <ErrorText className="max-w-40 truncate text-[10px]" title={quickCommands.error}>{quickCommands.error}</ErrorText>
        <PaneActionButton
          label={t("common.close")}
          onClick={closePane}
        >
          <X />
        </PaneActionButton>
      </div>
    </div>
    </PaneActionContextMenu>
      {quickCommands.editor && <QuickCommandDialog key={typeof quickCommands.editor === "object" ? quickCommands.editor.id : quickCommands.editor} editor={quickCommands.editor} commands={quickCommands.commands} onEditorChange={quickCommands.setEditor} onSave={quickCommands.save} onRemove={quickCommands.remove} onMove={quickCommands.move} />}
      {newAgentOpen && desktopId && (
        <WorktreeAgentDialog
          desktopId={desktopId}
          onClose={() => setNewAgentOpen(false)}
          onCreated={(created) => switchToAgent(created)}
        />
      )}
      {renameControls.dialogs}
      {paneInfo && (
        <PaneInfoDialog
          info={paneInfo}
          open={paneInfoOpen}
          onOpenChange={setPaneInfoOpen}
        />
      )}
      {permissionModeOpen && agent && (
        <AgentPermissionModeDialog
          agent={agent}
          panelId={props.api.id}
          open={permissionModeOpen}
          onOpenChange={setPermissionModeOpen}
          busy={permissionModeBusy}
          execute={executePermissionMode}
        />
      )}
    </>
  );
}

/** pane 헤더 오른쪽 액션 버튼 — 시안 2070:31476 (22px 박스 / 14px 아이콘 / 6px 라운드).
 *
 *  시안은 이 버튼들을 늘 보이게 둔다. 예전에는 hover에서만 나타났는데, pane이
 *  여러 개일 때 어느 pane에 마우스를 올려야 버튼이 나오는지 알 수 없어
 *  분할·닫기가 사실상 우클릭 메뉴 전용이었다. */
function PaneActionButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  /** 눌린 상태로 남는 토글(고정 등) — 색으로 현재 상태를 알린다. */
  active?: boolean;
}) {
  return (
    <IconButton
      title={label}
      // Toggle buttons (pin) pass their state; plain actions leave it
      // undefined so IconButton renders no aria-pressed for them.
      pressed={active}
      className="size-[22px] shrink-0 rounded-sm p-1 duration-150 hover:bg-glass-tint-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      // 헤더 전체가 드래그 표면이라, 버튼 위에서 시작한 포인터는 막아야 한다.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </IconButton>
  );
}
