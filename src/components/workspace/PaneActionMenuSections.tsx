import {
  ArrowLeftRight,
  CircleArrowUp,
  CirclePlus,
  Code2,
  Copy,
  ExternalLink,
  EyeOff,
  FolderOpen,
  GitFork,
  History,
  Info,
  PanelsTopLeft,
  PencilLine,
  Pin,
  PinOff,
  RefreshCw,
  Server,
  Share2,
  ShieldCheck,
  SquareSplitHorizontal,
  SquareSplitVertical,
  SquareTerminal,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import type {
  PaneActionMenuGroup,
  PaneActionMenuSection,
} from "@/components/workspace/PaneActionMenu";
import { availableProviders } from "@/lib/agents/agentInstalls";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { forkAgent } from "@/lib/agents/fork";
import { providerForkInheritsConversation } from "@/lib/agents/providerForkCapability";
import type { FileTarget } from "@/lib/files/fileTarget";
import { t } from "@/lib/i18n";
import { shareFileAtPointer } from "@/lib/platform/share";
import { openAgentPanel } from "@/lib/workspace/dock";
import { balanceActiveSpacePanes } from "@/lib/workspace/pane/paneShortcuts";
import { isMacPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import { popOutPanels, returnPopoutPanels } from "@/lib/workspace/window/popout";
import type {
  ExternalOpenTarget,
  ExternalOpenTargetGroup,
} from "@/lib/ipc/externalWorkspace";
import { PROVIDERS, type Agent, type Space, type SshHostConfig } from "@/types";
import {
  AGENT_TRANSCRIPT_ENTRY_LIMITS,
  type AgentTranscriptEntryLimit,
} from "../../../cli/lib/agent-transcript.mjs";

interface SwitchCandidate {
  agent: Agent;
  projectName: string;
}

function externalTargetIcon(group: ExternalOpenTargetGroup) {
  if (group === "finder") return <FolderOpen className="size-3.5" />;
  if (group === "terminal") return <Terminal className="size-3.5" />;
  return <Code2 className="size-3.5" />;
}

function externalTargetGroupLabel(group: ExternalOpenTargetGroup) {
  if (group === "finder") return t("common.fileExplorer");
  if (group === "terminal") return t("workspace.externalOpen.terminalGroup");
  return t("common.editor");
}

export function buildPaneActionMenuSections({
  agent,
  basicInterface = false,
  changePermissionMode,
  closePane,
  conversionBusy,
  conversionTarget,
  convertSession,
  copyIdentifier,
  copyTranscript,
  delegateTask,
  desktopId,
  desktopKind,
  externalOpenTargets = [],
  hide,
  history,
  hostId,
  newAgent,
  openAgentRename,
  openExternalWorkspace,
  openPaneInfo,
  openPaneRename,
  panelId,
  file,
  permissionModeBusy = false,
  pinned,
  refreshConversation,
  refreshDisabled = false,
  rehostAvailable,
  rehostBusy,
  recentSshHostId,
  rehostToCurrentBuild,
  removableWorktree,
  splitPane,
  splitSshPane,
  splitTerminalPane,
  sshHosts,
  switchCandidates,
  switchToAgent,
  togglePin,
  deleteAgent,
}: {
  agent: Agent | undefined;
  /** 기본 모드 간소화(2026-08-31): 오케스트레이션·멀티윈도우·플러밍 항목을
   * 접는다. 핀은 켜져 있는 동안(닫기 확인이라는 저장 상태가 동작 중) 남고,
   * popout의 원위치 방향은 항상 남는다. skip-permissions 위험 신호는 이
   * 메뉴가 아니라 툴바 권한 핀의 mustShow가 계속 표시한다. */
  basicInterface?: boolean;
  changePermissionMode?: () => void;
  closePane: () => void;
  conversionBusy: boolean;
  conversionTarget: "managed" | "standalone" | undefined;
  convertSession: () => void;
  copyIdentifier: (value: string) => void;
  copyTranscript?: (entryLimit: AgentTranscriptEntryLimit) => void;
  delegateTask: (() => void) | undefined;
  desktopId: string | undefined;
  desktopKind: Space["kind"] | undefined;
  externalOpenTargets?: readonly ExternalOpenTarget[];
  hide: (() => void) | undefined;
  history: (() => void) | undefined;
  hostId: string | undefined;
  newAgent: () => void;
  openAgentRename: (() => void) | undefined;
  openExternalWorkspace?: (targetId: string) => void;
  openPaneInfo: () => void;
  openPaneRename: () => void;
  panelId: string;
  file: FileTarget | undefined;
  permissionModeBusy?: boolean;
  pinned: boolean;
  refreshConversation?: () => void;
  refreshDisabled?: boolean;
  rehostAvailable: boolean;
  rehostBusy: boolean;
  /** 마지막으로 연 SSH 호스트 — 분할 서브메뉴의 "최근" 표시 대상. */
  recentSshHostId: string | undefined;
  rehostToCurrentBuild: () => void;
  removableWorktree: boolean;
  /** 이 pane이 실행 중인 곳을 그대로 이어받아 분할한다. */
  splitPane: (direction: "right" | "below") => void;
  splitSshPane: (direction: "right" | "below", host: SshHostConfig) => void;
  /** 이 pane이 원격이든 아니든 로컬 셸로 분할한다. */
  splitTerminalPane: (direction: "right" | "below") => void;
  sshHosts: SshHostConfig[];
  switchCandidates: SwitchCandidate[];
  switchToAgent: (agent: Agent) => void;
  togglePin: () => void;
  deleteAgent: () => void;
}) {
  const sections: PaneActionMenuSection[] = [];
  if (refreshConversation) {
    sections.push({
      id: "refresh",
      items: [
        {
          id: "refresh",
          label: t("common.refresh"),
          detail: t(
            refreshDisabled
              ? "workspace.refresh.identityUnavailable"
              : "workspace.refresh.description",
          ),
          icon: <RefreshCw />,
          disabled: refreshDisabled || rehostBusy,
          deferUntilClosed: true,
          onSelect: refreshConversation,
        },
      ],
    });
  }
  if (desktopId) {
    // 방향을 고른 다음 "새 pane에 무엇을 띄울지"를 고른다(시안 472:26050).
    //
    // 예전에는 오른쪽/아래가 즉시 실행이고 SSH만 "SSH로 분할"이라는 형제
    // 항목이었다. 같은 결정(무엇을 열까)이 두 층에 나뉘어 있어서 "SSH 호스트를
    // 아래쪽에 열기"는 메뉴로 만들 수 없는 조합이었고 — 그 항목은 방향을
    // "right"로 못 박고 있었다 — 방향 두 개는 대상을 고를 기회조차 없었다.
    // 이제 방향이 바깥 축, 대상이 안쪽 축이라 모든 조합이 나온다.
    const splitTargets = (
      direction: "right" | "below",
    ): PaneActionMenuGroup[] => {
      const groups: PaneActionMenuGroup[] = [
        {
          id: "inherit",
          items: [
            {
              id: "launcher",
              label: t("workspace.launcher.title"),
              icon: <CirclePlus />,
              onSelect: () => splitPane(direction),
            },
            {
              id: "terminal",
              label: t("common.terminal"),
              icon: <SquareTerminal />,
              onSelect: () => splitTerminalPane(direction),
            },
          ],
        },
      ];
      if (sshHosts.length > 0) {
        groups.push({
          id: "ssh",
          label: t("workspace.paneMenu.splitTargetSshGroup"),
          items: sshHosts.map((host) => ({
            id: host.id,
            label: host.name,
            // "최근"은 마지막으로 연 호스트 하나에만 붙는다. 목록 순서는
            // 그대로 둔다 — 최근 것을 위로 끌어올리면 메뉴가 열릴 때마다
            // 자리가 바뀌어, 위치로 기억하던 사용자가 매번 다시 읽어야 한다.
            hint:
              host.id === recentSshHostId
                ? t("workspace.paneMenu.splitTargetRecent")
                : undefined,
            icon: <Server />,
            onSelect: () => splitSshPane(direction, host),
          })),
        });
      }
      return groups;
    };

    sections.push({
      id: "split",
      // 두 시안(2332:36522 · 2338:35339)의 ⋮ 메뉴에는 분할이 없다. 동작은
      // 헤더 버튼과 탭 우클릭 메뉴에 그대로 남는다 — 단, 헤더가 좁아 분할
      // 버튼을 접은 pane에서는 ⋮ 메뉴가 받아 준다(foldedIntoMenu, 승연
      // 2026-09-13: 헤더에서 안 보이는 아이콘은 더보기로).
      hiddenOn: "dropdown",
      foldedIntoMenu: true,
      items: [
        {
          id: "split-right",
          label: t("common.splitRight"),
          icon: <SquareSplitHorizontal />,
          groups: splitTargets("right"),
        },
        {
          id: "split-below",
          label: t("common.splitDown"),
          icon: <SquareSplitVertical />,
          groups: splitTargets("below"),
        },
        // Balancing is Space-wide, but a right-click on a pane is where a
        // hand reaches for layout — the Space tab's menu alone went unfound
        // (owner call 2026-09-14). Same item as the terminal body's menu.
        {
          id: "balance-panes",
          label: t("workspace.desktopBar.balancePanes"),
          icon: <PanelsTopLeft />,
          onSelect: balanceActiveSpacePanes,
        },
      ],
    });
  }

  // 이름 변경·정보 확인처럼 pane의 정체를 다루는 항목이 먼저 오고, 고정처럼
  // 상태를 바꾸는 항목과 숨기기·최근 작업이 뒤따른다.
  // Rename은 pane당 하나다: 에이전트 pane은 에이전트 이름(유일한 사용자
  // 변경 가능 정체성 — pane 제목은 여기서 파생)을, 그 외 pane은 pane 제목을
  // 바꾼다. provider가 붙인 대화 제목은 설명일 뿐이라 rename 대상이 아니다.
  const paneActions: PaneActionMenuSection["items"] = [
    openAgentRename
      ? {
          id: "rename-agent",
          label: t("common.agentRename.menu"),
          icon: <PencilLine />,
          deferUntilClosed: true,
          onSelect: openAgentRename,
        }
      : {
          id: "rename-pane",
          label: t("workspace.paneMenu.rename"),
          icon: <PencilLine />,
          deferUntilClosed: true,
          onSelect: openPaneRename,
        },
  ];
  paneActions.push({
    id: "pane-info",
    label: t("workspace.paneMenu.info"),
    icon: <Info />,
    deferUntilClosed: true,
    onSelect: openPaneInfo,
  });
  if (copyTranscript) {
    paneActions.push({
      id: "copy-transcript",
      label: t("workspace.paneMenu.copyTranscript"),
      icon: <Copy />,
      groups: [
        {
          id: "scope",
          items: [
            ...AGENT_TRANSCRIPT_ENTRY_LIMITS.map((count) => ({
              id: `last-${count}`,
              label: t("workspace.paneMenu.copyTranscriptLastEntries", {
                count,
              }),
              onSelect: () => copyTranscript(count),
            })),
            {
              id: "whole-conversation",
              label: t("workspace.paneMenu.copyTranscriptWhole"),
              onSelect: () => copyTranscript(null),
            },
          ],
        },
      ],
    });
  }
  if (hostId && !basicInterface) {
    paneActions.push({
      id: "copy-host-id",
      label: t("workspace.paneMenu.copyHostId"),
      icon: <Copy />,
      onSelect: () => copyIdentifier(hostId),
    });
  }
  if (!basicInterface) {
    paneActions.push({
      id: "copy-pane-id",
      label: t("workspace.paneMenu.copyPaneId"),
      icon: <Copy />,
      onSelect: () => copyIdentifier(panelId),
    });
  }
  if (!basicInterface || pinned) {
    paneActions.push({
      id: "pin",
      label: pinned ? t("workspace.paneMenu.unpin") : t("workspace.paneMenu.pin"),
      icon: pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />,
      onSelect: togglePin,
    });
  }
  if (hide) {
    paneActions.push({
      id: "hide",
      // 시안 2336:37143 — 라벨은 "Pane 숨기기"로 짧게 두고, 어디로 가는지는
      // 오른쪽 흐린 힌트로 뺀다. 한 문장으로 붙여 두면 메뉴 폭에서 잘려
      // 목적지가 먼저 사라졌다.
      label: t("workspace.paneMenu.hide"),
      hint: t("workspace.paneMenu.hideHint"),
      icon: <EyeOff />,
      deferUntilClosed: true,
      onSelect: hide,
    });
  }
  if (history) {
    paneActions.push({
      id: "history",
      label: t("workspace.paneMenu.recentWork"),
      icon: <History />,
      deferUntilClosed: true,
      onSelect: history,
    });
  }
  sections.push({ id: "pane", items: paneActions });

  const placementActions: PaneActionMenuSection["items"] = [];
  if (desktopId && openExternalWorkspace && externalOpenTargets.length > 0) {
    placementActions.push({
      id: "open-external-workspace",
      label: t("workspace.externalOpen.menu"),
      icon: <ExternalLink />,
      // 여기 그룹은 하나다 — 소속(Finder·편집기·터미널)은 묶음 제목이 아니라
      // 항목의 아랫줄 detail로 말한다. 대상이 보통 한둘씩이라 제목마다
      // 구분선을 세우면 목록보다 구분선이 많아진다.
      groups: [
        {
          id: "targets",
          items: externalOpenTargets.map((target) => ({
            id: target.id,
            label: target.label,
            detail: externalTargetGroupLabel(target.group),
            icon: externalTargetIcon(target.group),
            deferUntilClosed: true,
            onSelect: () => openExternalWorkspace(target.id),
          })),
        },
      ],
    });
  }
  if (desktopId && (!basicInterface || desktopKind === "popout")) {
    placementActions.push({
      id: "popout",
      label:
        desktopKind === "popout"
          ? t("workspace.popout.returnToOrigin")
          : t("workspace.paneMenu.moveToNewWindow"),
      icon: <ExternalLink />,
      deferUntilClosed: true,
      onSelect: () =>
        desktopKind === "popout"
          ? void returnPopoutPanels(desktopId)
          : void popOutPanels(desktopId, [panelId]),
    });
  }
  if (isMacPlatform() && file?.source === "local") {
    const sharePath = file.path;
    placementActions.push({
      id: "share",
      label: t("common.share"),
      icon: <Share2 />,
      onSelect: () => void shareFileAtPointer(sharePath),
    });
  }
  if (delegateTask && !basicInterface) {
    placementActions.push({
      id: "delegate-task",
      label: t("common.delegateTask"),
      icon: <GitFork />,
      deferUntilClosed: true,
      onSelect: delegateTask,
    });
  }
  if (agent && desktopId && !basicInterface) {
    placementActions.push({
      id: "fork",
      label: t("common.conversationFork"),
      icon: <GitFork />,
      groups: [
        {
          id: "providers",
          items: availableProviders().map((provider) => ({
            id: provider,
            label: `${PROVIDERS[provider].label} · ${
              providerForkInheritsConversation(agent.provider, provider)
                ? t("common.conversationFork")
                : t("common.newConversation")
            }`,
            // 교체 서브메뉴와 같은 이유로 12px 고정 — <img> 로고는 [&_svg]가
            // 못 잡는다.
            icon: <ProviderGlyph provider={provider} className="size-3" />,
            onSelect: () => {
              forkAgent(agent.id, provider)
                .then((forked) => openAgentPanel(desktopId, forked))
                .catch((error) =>
                  messageDialog(
                    t("workspace.paneMenu.forkFailed", { error: String(error) }),
                    { kind: "error" },
                  ),
                );
            },
          })),
        },
      ],
    });
  }
  if (desktopId) {
    placementActions.push({
      id: "switch-agent",
      label: t("workspace.paneMenu.replaceWithAgent"),
      icon: <ArrowLeftRight />,
      groups: [
        {
          id: "candidates",
          items: [
            {
              id: "new-agent",
              label: t("common.startNewAgent"),
              icon: <CirclePlus />,
              deferUntilClosed: true,
              onSelect: newAgent,
            },
            ...switchCandidates.map(({ agent: candidate, projectName }) => ({
              id: candidate.id,
              label: agentDisplayName(candidate),
              // 프로젝트는 아랫줄이 아니라 우측 정렬 열이다(시안 2341:35433).
              hint: projectName,
              // 로고는 <img>로 그려지는 프로바이더가 있어 메뉴의 [&_svg]
              // 규칙이 안 걸린다 — 여기서 12px로 못 박는다.
              icon: (
                <ProviderGlyph
                  provider={candidate.provider}
                  className="size-3"
                />
              ),
              deferUntilClosed: true,
              onSelect: () => switchToAgent(candidate),
            })),
          ],
        },
      ],
    });
  }
  if (placementActions.length > 0) {
    sections.push({ id: "placement", items: placementActions });
  }

  const runtimeActions: PaneActionMenuSection["items"] = [];
  if (agent && changePermissionMode && !basicInterface) {
    runtimeActions.push({
      id: "permission-mode",
      label: t("workspace.paneMenu.changePermissionMode"),
      icon: <ShieldCheck />,
      disabled: permissionModeBusy,
      deferUntilClosed: true,
      onSelect: changePermissionMode,
    });
  }
  if (rehostAvailable && !basicInterface) {
    runtimeActions.push({
      id: "rehost",
      label: t("workspace.rehost.action"),
      icon: <CircleArrowUp />,
      disabled: rehostBusy,
      onSelect: rehostToCurrentBuild,
    });
  }
  if (conversionTarget === "standalone" && !basicInterface) {
    runtimeActions.push({
      id: "convert-standalone",
      label: t("workspace.paneMenu.convertToStandalone"),
      icon: <Terminal />,
      disabled: conversionBusy,
      onSelect: convertSession,
    });
  }
  if (runtimeActions.length > 0) {
    sections.push({ id: "runtime", items: runtimeActions });
  }

  const closeActions: PaneActionMenuSection["items"] = [];
  if (agent) {
    closeActions.push({
      id: "delete-agent",
      label: t("common.deleteAgent"),
      detail: removableWorktree ? t("workspace.paneMenu.worktreeRemovalAvailable") : undefined,
      icon: <Trash2 />,
      destructive: true,
      deferUntilClosed: true,
      onSelect: deleteAgent,
    });
  }
  closeActions.push({
    id: "close",
    label: t("common.close"),
    icon: <X />,
    deferUntilClosed: true,
    onSelect: closePane,
  });
  sections.push({ id: "close", items: closeActions });
  return sections;
}
