import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { Titled } from "@/components/ui/tooltip";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { Button } from "@/components/ui/button";
import {
  ExternalLink,
  Folder,
  Monitor,
  MonitorCheck,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { StatusDot } from "@/components/ui/status-dot";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { SshConfigHost, SshConfigScan, SshHostConfig } from "@/types";
import { sshConfigHosts } from "@/lib/ipc";
import {
  SSH_CONFIG_HOST_DRAG_TYPE,
  type SshConfigHostDraft,
  findRegisteredHost,
  hasSshConfigHostDragType,
  readSshConfigHostDragData,
  serializeSshHostDraft,
  sshConfigHostDraft,
} from "@/lib/ssh/sshConfigRegistration";
import { registerSshConfigHostDurably } from "@/lib/ssh/sshConfigRouteLifecycle";
import { openSshTerminalPanel } from "@/lib/workspace/dock";
import { AddSshHostDialog, AddRemoteProjectDialog } from "@/components/ssh/SshHostDialogs";
import { useSshPaneState } from "@/components/ssh/useSshPaneState";
import {
  SectionHeaderRow,
} from "@/components/sidebar/SidebarItems";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { IconButton } from "@/components/ui/icon-button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import {
  executeSshHostRemoval,
} from "@/lib/agents/resourceLifecycle";
import {
  planSshHostRemoval,
  sshHostRemovalSessionCount,
  type SshHostRemovalPlan,
} from "@/lib/agents/sshHostRemovalPlan";
import { PaneEmptyState } from "@/components/common/PaneEmptyState";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/** 사이드바 폴더 한 줄 — 등록 목록과 설정 파일 묶음에 공통으로 쓴다.
 *  등록 목록은 설정 파일 호스트를 받는 드롭 대상이기도 하다. */
/** 등록 목록 구획의 접힘 키 — 설정 파일 구획은 파일 경로를 키로 쓴다. */
const REGISTERED_GROUP = "registered";

function GroupRow({
  className,
  label,
  open,
  onToggle,
  actions,
  dropTarget,
}: {
  /** Extra classes for the row box — the gap a group carries above itself. */
  className?: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  /** 오른쪽 hover 묶음에 캐럿과 함께 서는 액션들(12px 글리프) */
  actions?: ReactNode;
  /** 있으면 이 행이 드롭 대상 — 드래그가 얹혔을 때 테두리로 표시한다. */
  dropTarget?: {
    active: boolean;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
}) {
  return (
    // Geometry follows the File tab's SidebarGroupLabel (Figma 3404:86362): a
    // 32px row, 8px padding, an 11px medium label. The old 2391:44944 numbers
    // (pl-16 / pr-14 / py-4) predate that comp; the sidebar tabs share one
    // column, so a group label that sits differently here reads as the panel
    // moving when you switch tabs.
    //
    // hover에 배경을 칠하지 않는다. 공용 "Folder Label"의 Hover 상태
    // (559:39363)가 바꾸는 건 오른쪽 아이콘의 등장뿐이고 면은 그대로다 —
    // 구획 라벨은 누를 대상이라기보다 구획의 이름이라, 면까지 칠하면 목록
    // 항목처럼 선택 가능한 행으로 읽힌다.
    //
    // 버튼 안에 버튼을 넣을 수 없어 행은 div이고, 라벨과 각 액션이 형제다.
    //
    // 라벨 앞에 글리프를 달지 않는다(소유자 결정 2026-08-13). 공용 "Folder
    // Label"(559:39363)도 텍스트 하나뿐이다 — 구획 라벨은 종류를 말하는 자리가
    // 아니라 이름을 말하는 자리이고, 아이콘을 달면 아래 호스트 행들과 같은
    // "항목"으로 읽혀 계층이 무너진다.
    <div
      className={cn(
        "group/sshgroup group/label mt-2 flex h-8 items-center justify-between gap-2 rounded-md px-2",
        dropTarget?.active && "bg-glass-tint-selected inset-ring-1 inset-ring-ring",
        className,
      )}
      onDragOver={dropTarget?.onDragOver}
      onDragLeave={dropTarget?.onDragLeave}
      onDrop={dropTarget?.onDrop}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center text-left focus-visible:inset-ring-1 focus-visible:inset-ring-ring focus-visible:outline-none"
        aria-expanded={open}
        onClick={onToggle}
      >
        <OverflowRevealText text={label}
          className="min-w-0 text-meta leading-[18px] font-medium text-sidebar-foreground/70" />
        {/* After the label, shown while the row is hovered — every sidebar fold's
            one idiom (owner call 2026-09-10). */}
        <DisclosureChevron hint open={open} className="ml-2 text-current" />
      </button>
      {/* 오른쪽 액션 묶음 — 8px 간격, 글리프는 14px(3404:86362이 사이드바
          아이콘을 12에서 올렸다). 캐럿이 라벨에
          가장 가깝고 추가 액션이 바깥쪽이다(시안 순서 ChevronDown → FolderPlus2
          → Plus): 캐럿은 이 구획 자체를 여닫는 것이라 라벨에 붙고, 추가는 목록에
          무언가를 더하는 것이라 바깥에 선다. opacity로만 숨겨 폭을 차지하므로
          떴다 사라져도 라벨이 밀리지 않는다. */}
      <span
        className={cn(
          "flex shrink-0 items-center gap-2 opacity-0 transition-opacity",
          "group-hover/sshgroup:opacity-100 focus-within:opacity-100",
        )}
      >
        {actions}
      </span>
    </div>
  );
}

/** SSH 탭 (Figma 326-10820) — 원격 탐색기: 호스트 목록·연결 상태·터미널 열기.
 *  호스트 관리(추가/편집/제거)는 설정에서 이 탭으로 이동.
 *  등록 호스트 아래에 ~/.ssh/config(+Include)에서 감지한 호스트를 파일별 폴더로 붙인다. */
export function SshPane() {
  const {
    sshHosts,
    projects,
    agents,
    sshStates,
    activeDesktopId,
  } = useSshPaneState();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 구획 접힘 — 기본은 전부 펼침이고 사용자가 접은 것만 기억한다. 시안이
   *  펼친 상태를 보여주므로 "접힌 채로 시작"은 없다. */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SshHostConfig | null>(null);
  const [prefill, setPrefill] = useState<SshConfigHostDraft | null>(null);
  const [projectHost, setProjectHost] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Exact Host generation awaiting in-place removal confirmation (SOUL §6). */
  const [confirmingRemoveHost, setConfirmingRemoveHost] =
    useState<SshHostRemovalPlan | null>(null);
  const [removingHost, setRemovingHost] = useState(false);
  const [scan, setScan] = useState<SshConfigScan | null>(null);
  const [dropActive, setDropActive] = useState(false);

  /** ~/.ssh/config 스캔 — 읽기 전용이라 실패하면 폴더만 안 보이면 된다. */
  const rescanConfig = useCallback(async () => {
    try {
      setScan(await sshConfigHosts());
    } catch {
      setScan(null);
    }
  }, []);

  useEffect(() => {
    void rescanConfig();
  }, [rescanConfig]);

  /** 호스트별 원격 프로젝트 */
  const projectsByHost = useMemo(() => {
    const m = new Map<string, typeof projects>();
    for (const p of projects) {
      if (p.kind !== "ssh" || !p.sshHostId) continue;
      m.set(p.sshHostId, [...(m.get(p.sshHostId) ?? []), p]);
    }
    return m;
  }, [projects]);

  /** 호스트의 원격 에이전트 세션 중 하나라도 연결돼 있으면 연결됨 */
  const hostState = (hostId: string): "connected" | "connecting" | null => {
    let connecting = false;
    for (const a of agents) {
      if (a.sessionKind !== "ssh") continue;
      const p = projects.find((pp) => pp.id === a.projectId);
      if (p?.sshHostId !== hostId) continue;
      const st = sshStates[a.sessionId];
      if (st === "connected") return "connected";
      if (st === "connecting" || st === "reconnecting") connecting = true;
    }
    return connecting ? "connecting" : null;
  };

  /** 설정 파일 재스캔. 원격 에이전트는 hmux 런타임이 소유하므로 legacy SSH
   *  연결 상태 재조회는 데몬 은퇴(2026-08-16)와 함께 제거됐다. */
  const refresh = async () => {
    setRefreshing(true);
    try {
      await rescanConfig();
    } finally {
      setRefreshing(false);
    }
  };

  const openTerminal = (h: SshHostConfig, cwd?: string) =>
    openSshTerminalPanel(activeDesktopId, h.id, h.name, undefined, cwd);

  /** 설정 파일 호스트를 등록 호스트 초안으로 바꾼다. */
  const draftFor = (h: SshConfigHost): SshConfigHostDraft =>
    sshConfigHostDraft(h, scan?.defaultUser ?? "");

  const registerDraft = async (
    draft: SshConfigHostDraft,
  ): Promise<SshHostConfig | undefined> => {
    try {
      return (await registerSshConfigHostDurably(draft)).host;
    } catch (error) {
      await messageDialog(String(error), { kind: "error" });
      return undefined;
    }
  };

  /** 감지된 호스트 클릭 — 등록 안 돼 있으면 그 자리에서 등록하고 바로 터미널을 연다. */
  const openDetected = async (h: SshConfigHost) => {
    const registered = await registerDraft(draftFor(h));
    if (registered) openTerminal(registered);
  };

  const detectedFiles = scan?.files ?? [];
  // Nothing registered and no config file to read from: the pane is empty,
  // not just one of its sections.
  const paneIsEmpty = sshHosts.length === 0 && detectedFiles.length === 0;

  /** 설정 파일 호스트를 등록 목록 위로 떨어뜨리면 그대로 등록된다. */
  const registeredDropTarget = {
    active: dropActive,
    onDragOver: (e: React.DragEvent) => {
      if (!hasSshConfigHostDragType(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropActive(true);
    },
    onDragLeave: () => setDropActive(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropActive(false);
      const draft = readSshConfigHostDragData(e.dataTransfer);
      // 우리 페이로드가 아니면(다른 앱/텍스트 드래그) 조용히 무시한다.
      if (draft) void registerDraft(draft);
    },
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5">
      <SectionHeaderRow
        as="h2"
        className="shrink-0"
        label={t("ssh.remoteExplorer.title")}
        actions={
          <>
            <RefreshButton
              busy={refreshing}
              disabled={refreshing}
              onClick={() => void refresh()}
            />
            {/* Every other sidebar tab keeps "add" in its pane header — files
                has new file and new folder there, spaces has add-location and
                add-pane. This tab had only refresh, and adding a host lived on
                a `+` that appears when you hover the group row. With no hosts
                there is no row to hover, so the one action worth taking was
                the one you could not find (owner report 2026-09-08). */}
            <IconButton
              title={t("common.addSshHost")}
              onClick={() => setAdding(true)}
            >
              <Plus />
            </IconButton>
          </>
        }
      />

      {/* Nothing registered and no config file to read: the pane itself is
          empty, so it says so the way this app's other empty panes do — one
          muted sentence on the 16px column under the title, no glyph and no
          centring (source control's "not a git repository", the file tab's
          panel hint). The group label goes with it: there is no group to name
          (owner decision 2026-09-08).

          The action follows full width rather than as a chip beside the
          sentence — at that size it floated in a blank panel; spanning the
          column reads as the panel's one thing to do. A registered list that
          is empty *beside* a config file is a section, not a pane, and keeps
          its label and an inline notice instead. */}
      {paneIsEmpty ? (
        <PaneEmptyState
          role="status"
          compact
          title={t("ssh.hosts.empty")}
          description={t("ssh.hosts.emptyDescription")}
          action={
            <Button
              variant="glass"
              className="w-full"
              onClick={() => setAdding(true)}
            >
              <Plus aria-hidden />
              {t("common.addSshHost")}
            </Button>
          }
        />
      ) : (
      <SidebarScrollArea
        edgeFade
        className="min-h-0 flex-1"
        viewportClassName="px-2 pb-3"
      >
        <GroupRow
          label={t("ssh.hosts.title")}
          open={!collapsedGroups.has(REGISTERED_GROUP)}
          onToggle={() => toggleGroup(REGISTERED_GROUP)}
          actions={
            <Titled title={t("common.addSshHost")}>
              <button
                type="button"
                className="flex items-center text-muted-foreground hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={t("common.addSshHost")}
                onClick={() => setAdding(true)}
              >
                <Plus className="size-3.5" />
              </button>
            </Titled>
          }
          dropTarget={registeredDropTarget}
        />
        {sshHosts.length === 0 && !collapsedGroups.has(REGISTERED_GROUP) && (
          // 개수 배지가 시안에 없어 걷은 대신, 펼쳤을 때 비어 있다는 사실은
          // 말해 준다 — 화살표만 돌고 아무것도 안 나오면 고장으로 읽힌다.
          // 빈 상태는 다음 행동을 직접 준다(SpacesEmptyState와 같은 문법):
          // 헤더의 + 아이콘과 동일한 폼을 여는 액션이다.
          // The registered list is empty but the pane is not — a config file
          // has hosts below. That is a section notice, so it stays left-aligned
          // under its own label and offers the action inline.
          <div
            className="flex flex-col items-start gap-1.5 px-2 py-1"
            role="status"
          >
            <p className="text-xs text-muted-foreground">
              {t("ssh.hosts.empty")}
            </p>
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {t("common.addSshHost")}
            </Button>
          </div>
        )}
        {!collapsedGroups.has(REGISTERED_GROUP) &&
          sshHosts.map((h) => {
          const state = hostState(h.id);
          const hostProjects = projectsByHost.get(h.id) ?? [];
          const expandable = hostProjects.length > 0;
          const isOpen = expanded.has(h.id);
          const MonIcon = state === "connected" ? MonitorCheck : Monitor;
          if (confirmingRemoveHost?.hostId === h.id) {
            // The armed host row swaps to the in-place confirm; the risk
            // summary (what gets cleaned up, what stays) joins the question.
            const plan = confirmingRemoveHost;
            const sessionCount = sshHostRemovalSessionCount(plan);
            return (
              <InlineConfirmRow
                key={h.id}
                question={[
                  t("ssh.removeHost.confirm", { name: h.name }),
                  t("ssh.removeHost.cleanupSummary", {
                    projects: plan.projectIds.length,
                    agents: plan.agents.length,
                    sessions: sessionCount,
                  }),
                  t("ssh.removeHost.keepsRemoteData"),
                ].join(" ")}
                confirmLabel={t("ssh.removeHost.confirmLabel")}
                busy={removingHost}
                onConfirm={() => {
                  void (async () => {
                    setRemovingHost(true);
                    try {
                      await executeSshHostRemoval(plan);
                    } catch (error) {
                      await messageDialog(
                        t("ssh.removeHost.cleanupFailed", {
                          error: String(error),
                        }),
                        { title: t("ssh.removeHost.failedTitle"), kind: "error" },
                      );
                    } finally {
                      setRemovingHost(false);
                      setConfirmingRemoveHost(null);
                    }
                  })();
                }}
                onCancel={() => setConfirmingRemoveHost(null)}
              />
            );
          }
          return (
            <div key={h.id}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    className={cn(
                      "group/ssh group/label flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 focus-visible:inset-ring-1 focus-visible:inset-ring-ring focus-visible:outline-none",
                      "hover:bg-glass-tint-hover",
                    )}
                    data-ssh-host={`${h.user}@${h.host}:${h.port}`}
                    // 행이 포커스를 못 받으면 키보드 사용자는 터미널을 열 수도,
                    // 우클릭 메뉴(편집·제거·원격 프로젝트 추가)를 부를 수도 없다.
                    // 사이드바의 다른 클릭 가능한 행들과 같은 계약이다.
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      openTerminal(h);
                    }}
                    onClick={() => openTerminal(h)}
                  >
                    <MonIcon
                      className={cn(
                        "size-3.5 shrink-0",
                        state === "connected" ? "text-sidebar-foreground" : "text-muted-foreground",
                      )}
                    />
                    <OverflowRevealText text={h.name}
                      className="min-w-0 text-xs leading-none text-sidebar-foreground" />
                    {/* The fold chevron stands after the name and shows while the row
                        is hovered — every sidebar folder row's one idiom (owner call
                        2026-09-10); it used to lead the row at 14px. */}
                    {expandable && (
                      <button type="button"
                        className="flex shrink-0 items-center justify-center"
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = new Set(expanded);
                          if (isOpen) next.delete(h.id);
                          else next.add(h.id);
                          setExpanded(next);
                        }}
                      >
                        <DisclosureChevron hint open={isOpen} />
                      </button>
                    )}
                    {state && (
                      <span className="flex shrink-0 items-center gap-1">
                        <StatusDot
                          tone={state === "connected" ? "run" : "warn"}
                          pulse={state !== "connected"}
                          className="size-[5px]"
                        />
                        <span className="text-[10px] leading-4 text-muted-foreground">
                          {state === "connected" ? t("common.connected") : t("common.connecting")}
                        </span>
                      </span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="-my-0.5 ml-auto h-auto px-1 py-0 text-muted-foreground opacity-0 group-hover/ssh:opacity-100 [.group\/ssh:focus-within_:where(&)]:opacity-100"
                      title={t("ssh.hosts.openTerminal")}
                      onClick={(event) => {
                        event.stopPropagation();
                        openTerminal(h);
                      }}
                    >
                      {t("ssh.hosts.connect")}
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-52">
                  <ContextMenuItem onClick={() => openTerminal(h)}>
                    <ExternalLink />
                    <span className="text-xs">{t("ssh.hosts.openTerminal")}</span>
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => setProjectHost(h.id)}>
                    <Folder />
                    <span className="text-xs">{t("ssh.remoteExplorer.addProject")}</span>
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => setEditing(h)}>
                    <Pencil />
                    <span className="text-xs">{t("ssh.hosts.edit")}</span>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onClick={() => setConfirmingRemoveHost(planSshHostRemoval(h.id))}
                  >
                    <Trash2 />
                    <span className="text-xs">{t("ssh.removeHost.action")}</span>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {expandable &&
                isOpen &&
                hostProjects.map((p) => (
                  <div
                    key={p.id}
                    className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md pr-2 pl-[30px] hover:bg-glass-tint-hover"
                    onClick={() => openTerminal(h, p.path)}
                  >
                    {/* A step above the muted marks, like the file tree's folders. */}
                    <Folder className="size-3.5 shrink-0 text-sidebar-foreground/70" />
                    <OverflowRevealText text={p.name}
                      className="min-w-0 flex-1 text-xs leading-none text-sidebar-foreground" />
                  </div>
                ))}
            </div>
          );
        })}

        {/* ~/.ssh/config 에서 감지한 호스트 — 설정 파일 하나가 폴더 하나 */}
        {detectedFiles.map((file) => {
          return (
            <div key={file.path}>
              {/* 16px above, where the registered list used to be closed off
                  by a rule (2619:72539/72540). The label already names the
                  boundary — this group is a config file, the one above is the
                  registered list — so the rule said the same thing twice
                  (owner decision 2026-09-08). 16 and not 8 because a group that
                  follows a list needs more air than the first one under the
                  pane title, which is the file tab's rhythm. */}
              <GroupRow
                className="mt-4"
                label={file.displayPath}
                open={!collapsedGroups.has(file.path)}
                onToggle={() => toggleGroup(file.path)}
              />
              {!collapsedGroups.has(file.path) &&
                file.hosts.map((h) => {
                  const draft = draftFor(h);
                  const registered = findRegisteredHost(sshHosts, draft);
                  return (
                    <ContextMenu key={`${file.path}:${h.alias}`}>
                      <ContextMenuTrigger asChild>
                        <div
                          draggable
                          className="group/ssh flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-glass-tint-hover focus-visible:inset-ring-1 focus-visible:inset-ring-ring focus-visible:outline-none"
                          data-ssh-host={`${draft.user}@${draft.host}:${draft.port}`}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return;
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            void openDetected(h);
                          }}
                          onClick={() => void openDetected(h)}
                          onDragStart={(e) => {
                            e.dataTransfer.setData(
                              SSH_CONFIG_HOST_DRAG_TYPE,
                              serializeSshHostDraft(draft),
                            );
                            e.dataTransfer.setData(
                              "text/plain",
                              `${draft.user}@${draft.host}:${draft.port}`,
                            );
                            e.dataTransfer.effectAllowed = "copy";
                          }}
                          onDragEnd={() => setDropActive(false)}
                        >
                          <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
                          <OverflowRevealText text={h.alias}
                            className="min-w-0 text-xs leading-none text-sidebar-foreground" />
                          {registered && (
                            // This config destination also has a registered projection.
                            <span className="shrink-0 text-[10px] leading-4 text-muted-foreground">
                              {t("ssh.hosts.registered")}
                            </span>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="-my-0.5 ml-auto h-auto px-1 py-0 text-muted-foreground opacity-0 group-hover/ssh:opacity-100 [.group\/ssh:focus-within_:where(&)]:opacity-100"
                            title={t("ssh.hosts.openTerminal")}
                            onClick={(event) => {
                              event.stopPropagation();
                              void openDetected(h);
                            }}
                          >
                            {t("ssh.hosts.connect")}
                          </Button>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-56">
                        {registered ? (
                          <>
                            <ContextMenuItem
                              onClick={() => {
                                void registerDraft(draft).then((host) => {
                                  if (host) openTerminal(host);
                                });
                              }}
                            >
                              <ExternalLink />
                              <span className="text-xs">{t("ssh.hosts.openTerminal")}</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => {
                                void registerDraft(draft).then((host) => {
                                  if (host) setEditing(host);
                                });
                              }}
                            >
                              <Pencil />
                              <span className="text-xs">{t("ssh.hosts.edit")}</span>
                            </ContextMenuItem>
                          </>
                        ) : (
                          <>
                            <ContextMenuItem onClick={() => void registerDraft(draft)}>
                              <Plus />
                              <span className="text-xs">{t("ssh.hosts.add")}</span>
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => setPrefill(draft)}>
                              <Pencil />
                              <span className="text-xs">{t("ssh.hosts.editAndAdd")}</span>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={() => void openDetected(h)}>
                              <ExternalLink />
                              <span className="text-xs">{t("ssh.hosts.addAndOpenTerminal")}</span>
                            </ContextMenuItem>
                          </>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
            </div>
          );
        })}
      </SidebarScrollArea>
      )}

      {adding && <AddSshHostDialog onClose={() => setAdding(false)} />}
      {editing && <AddSshHostDialog existing={editing} onClose={() => setEditing(null)} />}
      {prefill && <AddSshHostDialog prefill={prefill} onClose={() => setPrefill(null)} />}
      {projectHost && (
        <AddRemoteProjectDialog hostId={projectHost} onClose={() => setProjectHost(null)} />
      )}
    </div>
  );
}
