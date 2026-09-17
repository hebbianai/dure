// Spaces 행 컴포넌트 — SpacesPane에서 추출한 렌더 전용 memo 컴포넌트들.
// 목록 전체가 스토어 갱신마다 재렌더되지 않도록 행 단위 prop 동등성으로 자른다.
// 상태 해석(표시 상태·unread)은 부모(useSpaces)가 원료에서 파생해 내려준다.

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { EyeOff, GitBranch, ShieldCheck } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { AgentDiffBadge } from "@/components/agents/AgentDiffBadge";
import { AgentActivityGlyph } from "@/components/agents/AgentActivityGlyph";
import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { UnopenedAgentDetails } from "@/components/spaces/UnopenedAgentDetails";
import { spacesEnvironmentLabel } from "@/components/spaces/spacesFacetLabels";
import {
  OpenSpaceRowMenu,
  UnopenedAgentRowMenu,
} from "@/components/spaces/SpacesRowMenus";
import type {
  SpaceMenuHandlers,
  SpaceRowView,
} from "@/components/spaces/spacesRowTypes";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useOpenSpaceRowState,
  useUnopenedAgentRowState,
} from "@/components/spaces/useSpacesRowsState";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { encodeDureDragPayload } from "@/lib/platform/productDragPayload";
import type { Agent, Provider } from "@/types";
import {
  hmuxManagedPromotionLabel,
} from "@/lib/hmux/conversion/hmuxManagedPromotionEligibility";
import {
  clearSpacesPaneHover,
  setSpacesPaneHover,
  spacesPaneHoverKey,
} from "@/lib/spaces/spacesPaneHover";
import { AgentRenameDialog } from "@/components/agents/AgentRenameDialog";
import { latestAgentActivity } from "@/lib/spaces/spacesDisplay";
import { formatRelativeAge } from "@/lib/ui/relativeAge";
import { resolveUnopenedAgentPresentation } from "@/lib/spaces/unopenedAgentPresentation";
import { useNowTick } from "@/components/spaces/useNowTick";
import type {
  SpacesGrouping,
  SpacesVisibleField,
} from "@/lib/spaces/spacesViewOptions";
import { visibleSpacesRowMetadata } from "@/lib/spaces/spacesViewProjection";

export type {
  SpaceMenuHandlers,
  SpaceRowView,
} from "@/components/spaces/spacesRowTypes";

const SPACE_ROW_VIEW_KEYS: readonly (keyof SpaceRowView)[] = [
  "key",
  "desktopId",
  "desktopName",
  "kind",
  "title",
  "detail",
  "detailSource",
  "cwd",
  "projectId",
  "projectName",
  "relativePath",
  "branch",
  "hostId",
  "hostLabel",
  "hostBuild",
  "provider",
  "managedPromotion",
  "displayState",
  "hidden",
  "unread",
  "agentId",
  "activityAt",
];

interface OpenSpaceRowProps {
  space: SpaceRowView;
  visibleFields: readonly SpacesVisibleField[];
  groupBy?: SpacesGrouping;
  /** A space heading stands over this row, so the row does not repeat it. */
  spaceHeading: boolean;
  /** Show › Space; off, no row says its space. */
  showSpaces: boolean;
  canViewDiff: boolean;
  isSelected: boolean;
  isContextTarget: boolean;
  /** 이 행에서 액션 실행 시 적용될 세션 수 (선택에 포함되면 선택 크기) */
  selectionCount: number;
  promotionEligibleCount: number;
  promotionDeferredCount: number;
  promotionBusy: boolean;
  onSpaceClick: (event: MouseEvent, key: string, desktopId: string) => void;
  onContextMenuOpenChange: (key: string, open: boolean) => void;
  /** 행 드래그(pane 이동) — 페이로드 구성은 부모가 선택 상태로 결정한다 */
  onRowDragStart: (event: DragEvent, key: string) => void;
  onRowDragEnd: () => void;
  menuHandlers: SpaceMenuHandlers;
}

/** useSpaces가 매 재계산마다 행 객체를 새로 만들므로 참조 비교로는 memo가
 *  절대 적중하지 않는다 — 행 필드(전부 원시값) 단위로 비교한다. */
function openSpaceRowPropsEqual(prev: OpenSpaceRowProps, next: OpenSpaceRowProps): boolean {
  return (
    prev.isSelected === next.isSelected &&
    prev.visibleFields === next.visibleFields &&
    prev.groupBy === next.groupBy &&
    prev.spaceHeading === next.spaceHeading &&
    prev.showSpaces === next.showSpaces &&
    prev.canViewDiff === next.canViewDiff &&
    prev.isContextTarget === next.isContextTarget &&
    prev.selectionCount === next.selectionCount &&
    prev.promotionEligibleCount === next.promotionEligibleCount &&
    prev.promotionDeferredCount === next.promotionDeferredCount &&
    prev.promotionBusy === next.promotionBusy &&
    prev.onSpaceClick === next.onSpaceClick &&
    prev.onContextMenuOpenChange === next.onContextMenuOpenChange &&
    prev.onRowDragStart === next.onRowDragStart &&
    prev.onRowDragEnd === next.onRowDragEnd &&
    prev.menuHandlers === next.menuHandlers &&
    SPACE_ROW_VIEW_KEYS.every((field) => prev.space[field] === next.space[field])
  );
}

/**
 * The row's trailing metadata, stacked outside the focus button: Git status
 * on the title line, the relative time on the metadata line, both ending on
 * one right edge. Inside the button the time stopped at the button's edge
 * while the badge sat beyond it, so the two read as unrelated (owner report
 * 2026-09-06). Without a metadata line the time keeps the title line, ahead
 * of the badge. The line boxes mirror the text column (13px, 2px, 15px) so
 * each lands on its line.
 */
function SpacesRowTrailingMeta({
  badge,
  activity,
  hasInfoLine,
  className,
}: {
  badge?: ReactNode;
  activity?: ReactNode;
  hasInfoLine: boolean;
  className?: string;
}) {
  if (!badge && !activity) return null;
  const activityOnMetaLine = hasInfoLine && Boolean(activity);
  return (
    <span
      data-slot="space-row-trailing"
      // The same 13px/15px line boxes the title column keeps, with the same
      // 6px between them: this stack pairs line for line with the text beside
      // it, so the timestamp centres on the info line and the badge on the
      // title. A 2px gap and a 1px nudge left the second line riding four
      // pixels above its neighbour (owner report 2026-09-14).
      className={cn(
        "flex shrink-0 flex-col items-end gap-1.5 self-start",
        className,
      )}
    >
      <span data-row-line="title" className="flex h-[13px] items-center gap-2">
        {!activityOnMetaLine && activity}
        {badge}
      </span>
      {activityOnMetaLine && (
        <span data-row-line="meta" className="flex h-[15px] items-center">
          {activity}
        </span>
      )}
    </span>
  );
}

export const OpenSpaceRow = memo(function OpenSpaceRow({
  space,
  visibleFields,
  groupBy,
  spaceHeading,
  showSpaces,
  canViewDiff,
  isSelected,
  isContextTarget,
  selectionCount,
  promotionEligibleCount,
  promotionDeferredCount,
  promotionBusy,
  onSpaceClick,
  onContextMenuOpenChange,
  onRowDragStart,
  onRowDragEnd,
  menuHandlers,
}: OpenSpaceRowProps) {
  const [dragging, setDragging] = useState(false);
  const { isFocused } = useOpenSpaceRowState(space);
  const rowRef = useRef<HTMLDivElement>(null);
  // Reveal on focus: the focused pane's row scrolls into view (nearest — a
  // row already on screen stays put). A folded repository keeps drawing this
  // one row (SpacesRepositorySection), so there is always a row to scroll to.
  useEffect(() => {
    if (isFocused) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [isFocused]);
  const showUpdated =
    visibleFields.includes("updated") && space.displayState !== "working";
  const now = useNowTick(showUpdated);
  const lastActivity =
    !showUpdated || space.activityAt === undefined
      ? undefined
      : formatRelativeAge(space.activityAt, now);
  const rowMetadata = visibleSpacesRowMetadata(space, visibleFields, {
    groupBy,
    spaceHeading,
    showSpaces,
  }).map(({ field, value }) =>
    field === "environment"
      ? spacesEnvironmentLabel(value)
      : value,
  );
  const detail = [
    ...rowMetadata,
    !visibleFields.includes("details") ||
    (groupBy === "location" && space.detailSource === "location")
      ? ""
      : space.detail,
  ]
    .filter(Boolean)
    .join(" · ");
  const hasInfoLine = Boolean(detail || space.hidden);
  const activityLabel = lastActivity && (
    <span className="shrink-0 font-mono text-meta text-muted-foreground">
      {lastActivity}
    </span>
  );
  const paneHoverKey = spacesPaneHoverKey(space.desktopId, space.key);
  useEffect(
    () => () => clearSpacesPaneHover(paneHoverKey),
    [paneHoverKey],
  );
  const promotionLabel = hmuxManagedPromotionLabel(
    space.managedPromotion,
    space.provider,
  );
  const promotionDescription =
    space.managedPromotion === "eligible"
      ? t("spaces.managed.keepsRunning")
      : promotionLabel;
  return (
    <ContextMenu onOpenChange={(open) => onContextMenuOpenChange(space.key, open)}>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          // Figma 3419:88033 "Sidebar / SidebarMenuButton": 8px inside the
          // card on every side, and the card itself is what steps in. The step
          // a session takes under its space sits on the rows' container, so
          // the hover and selection card moves with the tier and its inner
          // padding stays the 8px the Files and Sessions tabs' cards keep.
          // Putting the step inside the row instead — the Primer / VS Code
          // full-width fill — was tried once the ladder had three rungs, and a
          // two-line 50px card with 24px of nothing down its left read as a
          // slab, where those references' one-line 20px rows never show it
          // (owner call 2026-09-14, on the comp of the three). A 4px trailing
          // edge had the timestamp against the card; 8 on both sides.
          // `min-h-8` gives a one-line row (a terminal, which has no info line)
          // the comp's 32px; a two-line row grows past it.
          className={cn(
            "group/space-row flex min-h-8 w-full min-w-0 cursor-grab items-center gap-x-2 gap-y-1 rounded-md px-2 py-2 text-left transition-colors duration-150 ease-out @max-[220px]/space-open-rows:flex-wrap hover:bg-glass-tint-hover active:cursor-grabbing active:bg-glass-tint-hover focus-visible:outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-ring",
            // The focused pane reads one step above hover — the same tint
            // the host rail and shortcut list use for "this one" — so the
            // list always says which pane has the keyboard (사용자 요청 2026-09-03).
            isFocused && "bg-glass-tint-selected hover:bg-glass-tint-selected",
            // 선택은 호버보다 확실히 진해야 한다. --accent가 라이트에서 거의 흰색
            // (oklch .97)이라 70%로 얹으면 유리 위에서 선택인지 렌더 얼룩인지
            // 구분이 안 됐다(사용자 지적, 2026-08-01). macOS 사이드바의 비활성
            // 선택(unemphasizedSelectedContentBackground)처럼 중성 틴트를 한 단
            // 진하게 쓴다 — 호버 4%/7% 위에 9%/13%이라 위계가 남는다.
            // 레일 활성 칩과 같은 언어를 쓴다 (railTone.ts 주석): 라이트는 흰 면 +
            // 헤어라인(그림자 없음), 다크는 밝은 틴트. 유리 밝기가 어느 쪽이
            // 읽히는지를 정하기 때문이다.
            (isSelected || isContextTarget) &&
              "bg-glass-pane/75 inset-ring-1 inset-ring-glass-pane-border hover:bg-glass-pane/75 hover:inset-ring-glass-pane-border dark:bg-foreground/[0.13] dark:inset-ring-0 dark:hover:bg-foreground/[0.13] dark:hover:inset-ring-0",
            dragging &&
              "bg-glass-tint-hover opacity-55 hover:bg-glass-tint-hover hover:ring-0",
          )}
          data-pane-dragging={dragging ? "" : undefined}
          data-pane-focused={isFocused ? "" : undefined}
          data-space-selected={isSelected ? "" : undefined}
          data-space-key={space.key}
          data-space-kind={space.kind}
          draggable
          onPointerEnter={() => setSpacesPaneHover(paneHoverKey)}
          onPointerLeave={() => clearSpacesPaneHover(paneHoverKey)}
          onDragStart={(event) => {
            clearSpacesPaneHover(paneHoverKey);
            setDragging(true);
            if (space.hidden && space.agentId) {
              // 숨긴 pane은 이동할 패널이 없다 — 에이전트 페이로드로 바꿔
              // Workspace 드롭이 드롭 지점에 pane을 다시 연다(열리면 숨김
              // 자동 해제). UnopenedAgentRow와 같은 계약.
              event.dataTransfer.setData(
                "text/plain",
                encodeDureDragPayload({ type: "agent", agentId: space.agentId }),
              );
              event.dataTransfer.effectAllowed = "copyMove";
              return;
            }
            onRowDragStart(event, space.key);
          }}
          onDragEnd={() => {
            setDragging(false);
            onRowDragEnd();
          }}
        >
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 cursor-grab! items-center gap-2 rounded text-left active:cursor-grabbing! @max-[220px]/space-open-rows:basis-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              // 숨긴 pane — 세션은 살아 있고 표면만 걷힌 상태. 흐리게 + EyeOff로
              // 구분하고, 클릭하면 pane이 복원된다(사용자 요청 2026-08-01).
              space.hidden && "opacity-60",
            )}
            onClick={(event) =>
              onSpaceClick(event, space.key, space.desktopId)
            }
          >
            {/* The leading slot is who the session is and whether it is
                busy — AgentActivityGlyph, the same rule as the pane header
                and the unopened rows (owner decision 2026-09-03). It sits
                on the 13px title line. */}
            <AgentActivityGlyph
              size={14}
              provider={space.provider}
              activity={space.displayState}
              unread={space.unread}
              // A 14px box: the glyph is 14 now, the size everything else in
              // the sidebar draws at, and it centres on the 13px title line
              // half a pixel low, which nothing reads (owner call 2026-09-14).
              className="h-3.5 items-center self-start"
            />
            {/* 6px between the title and its info line (3419:88033), up
                from the 2px of 559:31527. The fixed line boxes below stay:
                they exist so `truncate`'s overflow does not clip the top
                and bottom strokes of Hangul, and the wider gap only gives
                that overflow more room. */}
            <span className="flex min-w-[80px] flex-1 flex-col gap-1.5">
              {/* 559:31528 제목 줄 — text-xs(13px) regular, 텍스트만. 시안의 이
                  줄에는 아이콘이 하나도 없다. 제공자 아이콘도, 숨김 표시도
                  아래 정보 줄이 맡는다(소유자 결정 2026-08-02).
                  줄 상자는 시안대로 13px이지만 글자 줄높이는 토큰(16px) 그대로
                  둔다. 글자에 leading-none을 주면 truncate의 overflow:hidden이
                  한글 위아래 획을 잘라낸다 — 상자만 13px로 잡고 넘치는 1.5px은
                  아래 2px 간격으로 흘려보낸다. */}
              <span className="flex h-[13px] w-full min-w-0 items-center gap-2">
                <OverflowRevealText
                  text={space.title}
                  className="flex-1 text-xs font-normal text-sidebar-foreground"
                />
              </span>
              {/* 559:31532 "Sidebar nested item info" — 11px 고정 높이를 15px
                  줄 안에 세로 가운데로 두고, 아이콘과 경로 사이는 2px. The
                  provider glyph moved up to the leading slot (2026-09-03);
                  this line keeps the hidden marker and the branch/path.
                  숨김은 EyeOff 하나로만 알리지 않는다 — 행 전체가
                  opacity-60으로 흐려지는 것이 1차 신호이고 아이콘은 그 이유를
                  말해 준다. */}
              {hasInfoLine && (
                <span className="flex h-[15px] w-full min-w-0 items-center gap-[2px]">
                  {space.hidden && (
                    <EyeOff className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  {/* 559:31535 — 브랜치·경로는 muted-foreground가 아니라
                      foreground 70%다. 옆의 12px 프로바이더 글리프가 더 옅어서
                      글자가 아이콘보다 앞으로 나온다(시안의 대비 순서). */}
                  <OverflowRevealText
                    text={detail}
                    className="flex-1 font-mono text-meta text-sidebar-foreground/70"
                  />
                </span>
              )}
            </span>
          </button>
          <SpacesRowTrailingMeta
            badge={
              space.agentId && visibleFields.includes("gitStatus") ? (
                <AgentDiffBadge
                  agentId={space.agentId}
                  // The diff window reads a local worktree; a remote row
                  // keeps its counters but does not launch it.
                  onClick={
                    space.hostId
                      ? undefined
                      : () => menuHandlers.onViewDiff(space.key)
                  }
                />
              ) : undefined
            }
            activity={activityLabel}
            hasInfoLine={hasInfoLine}
            // A narrow container wraps the row (the button takes the full
            // width); the stack then follows as one right-aligned line so the
            // row grows by a single line, as the badge alone did.
            className="@max-[220px]/space-open-rows:mt-0 @max-[220px]/space-open-rows:ml-auto @max-[220px]/space-open-rows:flex-row-reverse @max-[220px]/space-open-rows:items-center @max-[220px]/space-open-rows:gap-x-2"
          />
          {space.managedPromotion !== "hidden" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-glass-tint-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40",
                    // 전환 불가 상태의 방패는 행을 스칠 때만 나타난다 — 목록
                    // 대부분이 disabled 방패로 채워지는 상시 노이즈를 걷어내되,
                    // size-6 자리는 남겨 행 레이아웃이 흔들리지 않는다. 이 분기는
                    // 곧 disabled와 동치라 disabled 변형으로 써서 기본
                    // disabled:opacity-40을 tailwind-merge가 대체하게 한다.
                    space.managedPromotion !== "eligible" &&
                      !promotionBusy &&
                      "disabled:opacity-0 group-hover/space-row:disabled:opacity-40",
                  )}
                  aria-label={promotionLabel}
                  disabled={
                    space.managedPromotion !== "eligible" || promotionBusy
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    menuHandlers.onPromoteManaged(space.key);
                  }}
                >
                  {promotionBusy ? (
                    <DureLoader decorative />
                  ) : (
                    <ShieldCheck className="size-3.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent description={promotionDescription}>
                {t("common.switchToManagedSession")}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* Radix mounts content children only while the menu is open, so the
            menu's subscriptions and entry building start on right-click. */}
        <OpenSpaceRowMenu
          space={space}
          canViewDiff={canViewDiff}
          selectionCount={selectionCount}
          promotionEligibleCount={promotionEligibleCount}
          promotionDeferredCount={promotionDeferredCount}
          menuHandlers={menuHandlers}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}, openSpaceRowPropsEqual);

export const UnopenedAgentRow = memo(function UnopenedAgentRow({
  agent,
  displayState,
  unread,
  projectName,
  remote,
  detail,
  conversation,
  onOpen,
  onViewDiff,
  onFork,
  onHide,
  onKill,
}: {
  agent: Agent;
  displayState: AgentDisplayState;
  unread: boolean;
  projectName: string;
  /** SSH worktree: the diff badge stays an indicator, never a launcher. */
  remote: boolean;
  detail: string;
  conversation?: ProviderConversationRecord;
  onOpen: (agent: Agent) => void;
  onViewDiff: (agent: Agent) => void;
  onFork: (agent: Agent, provider: Provider) => void;
  /** 목록에서 숨기기 — 등록·세션은 그대로, 새 attention 에피소드가 되살린다 */
  onHide: (agent: Agent) => void;
  /** 에이전트 제거 — 세션 종료(canonical stop) 포함, 확인은 부모가 담당 */
  onKill: (agent: Agent) => void;
}) {
  // undefined = the dialog was never requested, so it never mounts for the
  // dozens of rows nobody renames; after the first open it stays mounted so
  // the close transition still runs.
  const [renameOpen, setRenameOpen] = useState<boolean>();
  const requestRename = useCallback(
    // The menu unmounts on select — reopen the dialog outside that tick.
    () => window.setTimeout(() => setRenameOpen(true), 0),
    [],
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const {
    promptActivity,
    sessionTitle,
    conversationTitle,
    conversationActivityAt,
    visibleFields,
  } = useUnopenedAgentRowState(agent);
  const unopenedNow = useNowTick(visibleFields.includes("updated") || detailsOpen);
  const recentActivity = latestAgentActivity(promptActivity);
  const presentation = resolveUnopenedAgentPresentation({
    agent,
    liveConversationTitle: conversationTitle,
    conversationActivityAt,
    liveSessionTitle: sessionTitle,
    conversation,
    promptActivity,
  });
  const lastActivity =
    presentation.activityAt === undefined
      ? undefined
      : formatRelativeAge(presentation.activityAt, unopenedNow);
  const visibleActivity = visibleFields.includes("updated")
    ? lastActivity
    : undefined;
  const visibleDetail = !visibleFields.includes("details")
    ? ""
    : recentActivity
      ? [projectName, recentActivity.text].join(" · ")
      : detail;
  const activityLabel = visibleActivity && (
    <span className="shrink-0 font-mono text-meta text-muted-foreground">
      {visibleActivity}
    </span>
  );
  const toggleDetails = () => setDetailsOpen((open) => !open);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
        <div
          // 열린 세션 행(2386:41129)과 같은 상자다 — 같은 목록 안에서 두
          // 섹션의 행 높이·들여쓰기·모서리가 다르면 목록이 둘로 읽힌다.
          // The sessions card's three states and geometry (RecentWorkSection):
          // flat at rest, the hover tint under the pointer, the selected tint
          // while open; 8px sides and 8px top and bottom, the info line 6px
          // under the title (owner call 2026-09-10: the unopened card follows
          // the sessions card's style).
          className={cn(
            "group/unopened-row flex w-full min-w-0 cursor-grab flex-wrap items-center gap-x-2 gap-y-0 rounded-md px-2 py-2 transition-colors duration-150 ease-out hover:bg-glass-tint-hover active:cursor-grabbing active:bg-glass-tint-hover focus-within:bg-glass-tint-hover data-[state=open]:bg-glass-tint-selected",
            detailsOpen && "bg-glass-tint-selected",
          )}
          data-agent-id={agent.id}
          data-space-kind="unopened-agent"
          draggable
          onDragStart={(event) => {
            // Sidebar 에이전트 행과 같은 페이로드 — Workspace 드롭이 pane을 연다.
            event.dataTransfer.setData(
              "text/plain",
              encodeDureDragPayload({ type: "agent", agentId: agent.id }),
            );
            event.dataTransfer.effectAllowed = "copyMove";
          }}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-grab! items-center gap-2 text-left active:cursor-grabbing! focus-visible:outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-ring"
            aria-expanded={detailsOpen}
            onClick={toggleDetails}
          >
            {/* Same leading slot as the open rows above — the provider glyph,
                the loader while working, and the state (exited included, as
                the hollow dot) as a corner badge. One slot shape keeps the two
                lists reading as one list. The slot stays the glyph in every
                state: the row folds from its own click with no disclosure
                marker, the same as the sessions card (owner call: unify,
                replacing the 2026-09-03 hover chevron). */}
            <span className="flex size-3.5 shrink-0 items-center justify-center self-start">
              <AgentActivityGlyph
                size={14}
                provider={agent.provider}
                activity={displayState}
                unread={unread}
              />
            </span>
            {/* 열린 세션 행(위)과 같은 구성으로 둔다 — 같은 목록 안에서 행마다
                제공자 아이콘이 제목 줄에 있다 정보 줄에 있다 하면 목록이 두
                종류로 읽힌다. 시안 559:31527/31532의 2px 간격도 그대로.
                열린 행과 달리 min-w는 0이다 — 이 목록은 @container 밖이라
                좁은 사이드바에서 줄바꿈으로 도망칠 곳이 없다. */}
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              {/* 열린 세션 행과 같은 13px 줄 상자 */}
              <span className="flex h-[13px] min-w-0 items-center gap-2">
                <OverflowRevealText
                  text={presentation.title}
                  className="flex-1 text-xs font-normal text-sidebar-foreground"
                />
              </span>
              {visibleDetail && (
                <span className="flex h-[15px] min-w-0 items-center gap-[2px] font-mono text-meta text-sidebar-foreground/70">
                  {/* The branch glyph labels a branch name; with nothing to name
                      (an agent at its repository root writes no path) it would
                      stand alone — owner report 2026-09-03. */}
                  {!recentActivity && (
                    <GitBranch className="size-[10px] shrink-0" />
                  )}
                  <OverflowRevealText text={visibleDetail} className="flex-1" />
                </span>
              )}
            </span>
          </button>
          <SpacesRowTrailingMeta
            badge={
              visibleFields.includes("gitStatus") ? (
                <AgentDiffBadge
                  agentId={agent.id}
                  onClick={remote ? undefined : () => onViewDiff(agent)}
                />
              ) : undefined
            }
            activity={activityLabel}
            hasInfoLine={Boolean(visibleDetail)}
          />
          {detailsOpen && (
            <UnopenedAgentDetails
              agent={agent}
              displayState={displayState}
              unread={unread}
              projectName={projectName}
              recentActivity={recentActivity}
              activityAt={presentation.activityAt}
              lastActivity={lastActivity}
              onResume={() => onOpen(agent)}
              onClose={() => onKill(agent)}
            />
          )}
        </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <UnopenedAgentRowMenu
            agent={agent}
            displayName={presentation.title}
            onOpen={onOpen}
            onViewDiff={onViewDiff}
            onRename={requestRename}
            onHide={onHide}
            onFork={onFork}
            onKill={onKill}
          />
        </ContextMenuContent>
      </ContextMenu>
      {renameOpen !== undefined && (
        <AgentRenameDialog
          agent={agent}
          open={renameOpen}
          onOpenChange={setRenameOpen}
        />
      )}
    </>
  );
});
