import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import type { ReactNode } from "react";
import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { ActivityDot } from "@/components/agents/StatusBits";
import { ProviderBadge } from "@/components/agents/ProviderLogo";
import type { Provider } from "@/types";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";

/** 사이드바 공용 프리미티브 — Figma 187-3698 (Sidebar/Project Item 등).
 *  프레젠테이션 전용: 상태·핸들러는 호출 쪽(Sidebar)이 소유한다. */

/** 사이드바 라벨의 색 상태 — Figma 559:39362 "Sidebar/Label".
 *
 *  상태는 Default와 Hover 둘뿐이고, 둘 사이에 바뀌는 건 글자색뿐이다:
 *  muted-foreground → sidebar-foreground. 어느 상태에서도 배경을 채우지 않는다.
 *
 *  호버 판정은 라벨이 아니라 감싼 행이 한다 — 행에 `group/label`을 달아두면
 *  행 어디를 스쳐도 라벨이 같이 밝아진다. `selected`는 그 밝은 상태를 고정해서
 *  활성 데스크탑처럼 "지금 여기" 표시가 필요한 행에 쓴다.
 *
 *  Typography belongs to each caller; this helper only supplies color states. */
export function sidebarLabelTone(selected = false) {
  return cn(
    "transition-colors duration-150 ease-out",
    selected
      ? "text-sidebar-foreground"
      : "text-muted-foreground group-hover/label:text-sidebar-foreground",
  );
}

/** 섹션 헤더 라벨의 색 — 시안 2070:32041.
 *
 *  시안은 `secondary-foreground`를 opacity 70%로 쓴다. 본문 라벨
 *  (`sidebarLabelTone`의 muted-foreground)보다 진해서 섹션 제목이 먼저 읽히고,
 *  그 아래 항목들이 뒤로 물러난다 — 둘이 같은 회색이면 위계가 사라진다.
 *
 *  호버는 라벨 톤과 같은 규칙을 쓴다: 감싼 행의 `group/label`이 판정한다. */
export function sidebarSectionLabelTone() {
  return cn(
    "transition-colors duration-150 ease-out",
    "text-sidebar-foreground/70 group-hover/label:text-sidebar-foreground",
  );
}

/** A rule between two sidebar sections — Figma 2386:41170 / 2391:46579.
 *
 *  It draws where the **kind** of thing changes, not where one group ends and
 *  the next begins: pinned panes against everything else, sessions that are
 *  open against agents that are not, buckets of open sessions against
 *  repositories with nothing open in them. Two groups of the same kind — two
 *  repositories, two spaces, two status buckets — are separated by their own
 *  labels and 16px of space, because a rule there would say only "a boundary",
 *  which the label already says (owner rule 2026-09-08; this replaces the
 *  earlier reading that a label and a rule always duplicate each other — they
 *  duplicate only when the two sides hold the same kind of row).
 *
 *  Inset 12px on each side: a line that reaches the panel edges reads as the
 *  panel splitting in two rather than as two sections of one list.
 *
 *  **Do not draw one with nothing above it** — a rule at the top of a scroll
 *  area divides nothing. Condition it on the preceding section at the call
 *  site. */
export function SidebarHairline({ className }: { className?: string }) {
  return (
    <div className={cn("shrink-0 px-3 pt-1 pb-1.5", className)}>
      <div className="h-px w-full bg-glass-hairline" />
    </div>
  );
}

/** The label that names a group of sidebar rows — Figma 3404:86362
 *  "Sidebar / SidebarGroupLabel": a 32px row, 8px side padding, holding an 11px
 *  medium label.
 *
 *  8px, the comp's own value: both callers render inside a scroll viewport
 *  that already pads 8px, so the label text lands 16px from the pane edge and
 *  shares that line with the row labels under it. A caller outside such a
 *  viewport has to supply the missing 8px itself.
 *
 *  A group label and a hairline do the same job, so a section takes one or the
 *  other, never both. Where every group carries its own label the hairline is
 *  redundant — the comp above draws none between "Recent files" and
 *  "Registered Files".
 *
 *  The dimmed `foreground/70`, deliberately against 3404:86362 — that comp puts
 *  the group label on the full foreground and separates it from its rows by
 *  size and weight alone. In the app that left no hierarchy at all: the pane
 *  title was dimmer than the labels under it, and the labels matched their own
 *  rows. A group label names a group; it should sit under what it names, the
 *  way a Finder sidebar heading does (owner call 2026-09-08). The title is now
 *  the full foreground instead — see SectionHeaderRow.
 *
 *  Not interactive: no hover tone, because a row that lights up promises a
 *  control that is not there. */
export function SidebarGroupLabel({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("flex h-8 shrink-0 items-center px-2", className)}>
      {/* Full foreground, one step above the 70% a space label wears: a band
          marks a stretch of the list, a label names one group inside it, and
          with both at 11px medium 70% the two read as one kind of thing eight
          pixels apart in the facet views. Size and weight stay, so at 11px
          it still sits under the 13px rows it introduces (owner call
          2026-09-14, on the comp of colour / weight / rule). The reveal-on-
          hover viewport is #703's and stays. */}
      <OverflowRevealText text={children}
        className="text-meta leading-[18px] font-medium text-sidebar-foreground" />
    </div>
  );
}

/** Section heading with an optional fold toggle and trailing icon actions.
 *  좌 16px·우 8px (Figma 2386:41104 "Sidebar/Project").
 *
 *  `size`가 층위를 가른다:
 *  - `pane`(기본) — 패널 머리행. 24px(h-6)·13px semibold, 행 hover에 라벨이
 *    밝아진다(sidebarSectionLabelTone). 13px은 이 리포의 `text-xs`가 12px이
 *    아니라 13px이기 때문이다(index.css, 시안 2249:35790) — 주석은 2026-09-13까지
 *    12px이라고 적혀 있었지만 화면에 난 값은 줄곧 13px이었다.
 *  - `sub` — 목록 안 구획 헤더(구 sessions/SessionSectionHeader). 28px(h-7)·
 *    11px semibold, hover 톤 없음 — 구획은 내용보다 조용해야 한다.
 *
 *  `as` marks a real hierarchy level such as a pane title or facet. The
 *  default is span so peer labels do not become a flat list of headings. */
export function SectionHeaderRow({
  label,
  expanded,
  onToggle,
  actions,
  as: Tag = "span",
  size = "pane",
  weight = "semibold",
  chevron = "leading",
  className,
  id,
}: {
  label: string;
  expanded?: boolean;
  /** 있으면 라벨 영역 전체가 접기 토글 버튼이 되고 왼쪽에 셰브런이 붙는다 */
  onToggle?: () => void;
  actions?: ReactNode;
  as?: "span" | "h2" | "h3";
  /** `label` is the files tab's "All files" row (SidebarGroupLabel's
   *  geometry — 32px, 8px sides, 11px medium at /70) with this row's fold
   *  and actions. It names a section whose members are folder
   *  headings or rows, one tier above them in size (owner call
   *  2026-09-09, External sessions). */
  size?: "pane" | "sub" | "label";
  /** `medium` when the row stands beside headings that are medium (the
   *  Spaces list, where every group label is 13px medium) — a semibold
   *  section among them would read as a title, not a peer. */
  weight?: "semibold" | "medium";
  /** Whether the row folds with a chevron. Every sidebar fold shares one
   *  chevron idiom since 2026-09-10 (owner call): it stands at the row's end,
   *  after the label, and shows while the row is hovered — so `leading` and
   *  `trailing` draw the same thing and stay only as the callers' intent;
   *  `none` for a heading that does not fold. */
  chevron?: "leading" | "trailing" | "none";
  className?: string;
  /** No `title` here: a row's tooltip was the OS's plain box over text the
   *  row already shows (owner call 2026-09-09). Context the label leaves
   *  out belongs in the label or in an app Tooltip on an icon control. */
  /** 감싸는 `<section aria-labelledby>` 배선용 — 라벨 요소에 붙는다 */
  id?: string;
}) {
  const labelContent = (
    <Tag
      id={id}
      className={cn(
        // OverflowRevealText reserves 16px on its right for the fade;
        // folded back like the repository and group headers do, or the
        // chevron sits 24px off the label instead of the row's 8.
        "-mr-4 min-w-0",
        weight === "medium" || size === "label" ? "font-medium" : "font-semibold",
        // A pane title carries the full foreground; everything below it in
        // the sidebar is quieter. `as="h2"` is how a caller says "this row is
        // the title of a tab" — the same declaration that makes it a heading
        // for assistive tech — so the tone rides on it rather than on a
        // second prop that could disagree with the markup. In-list section
        // headings (`h3`, or the default span) keep the dimmed tone: they
        // name a group, and a group label should sit under its own rows, the
        // way a Finder sidebar heading does (owner call 2026-09-08).
        size === "pane"
          ? cn(
              "text-xs leading-[18px]",
              Tag === "h2"
                ? "text-sidebar-foreground"
                : sidebarSectionLabelTone(),
            )
          : size === "label"
            // Full foreground like SidebarGroupLabel — the same band, with
            // optional folding and actions (see the note there).
            ? "text-meta leading-[18px] text-sidebar-foreground"
            : "text-[11px] text-sidebar-foreground/70",
      )}
    >
      <OverflowRevealText text={label} />
    </Tag>
  );
  return (
    <div
      className={cn(
        // The hover tone rides on `group/label`, so only a row you can press
        // carries it. A pane title is a name with icon buttons beside it —
        // no toggle, nothing to click — and lighting it up on hover promises
        // a control that is not there (owner call 2026-09-08). Dropping the
        // group class is enough: sidebarSectionLabelTone keeps its colour and
        // its hover half simply never matches.
        onToggle && "group/label",
        "flex min-w-0 items-center gap-1",
        size === "label" ? "h-8 px-2" : "pr-2 pl-4",
        size === "pane" ? "h-6" : size === "sub" ? "h-7" : undefined,
        className,
      )}
    >
      {onToggle ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onToggle}
        >
          {labelContent}
          {chevron !== "none" && (
            <DisclosureChevron hint open={expanded} />
          )}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{labelContent}</div>
      )}
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

/** 프로젝트 헤더 행 — 폴더 아이콘(12px) + 이름(12px semibold) + 셰브런(12px, 45%) */
export function ProjectHeaderRow({
  icon,
  name,
  expanded,
  badge,
  actions,
  className,
  onKeyDown,
  ...rest
}: {
  icon: ReactNode;
  name: string;
  expanded: boolean;
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "group group/label flex cursor-pointer items-center gap-1.5 px-4 pt-3 pb-1.5",
        className,
      )}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.currentTarget.click();
      }}
      {...rest}
    >
      <span className="flex size-3 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3">
        {icon}
      </span>
      <OverflowRevealText className={cn("text-xs leading-4 font-semibold", sidebarLabelTone())} text={name} />
      <DisclosureChevron
        open={expanded}
        className="text-sidebar-foreground opacity-45"
      />
      {badge}
      <span className="ml-auto hidden shrink-0 items-center gap-1 group-hover:flex">{actions}</span>
    </div>
  );
}

/** 에이전트 행 — 1행: 프로바이더 아이콘(16px)+이름(12px medium)+상태 점(5px, 이름 우측),
 *  2행: 브랜치 아이콘(10px)+브랜치명(11px mono). 호버/메뉴 열림 시 우측에 메뉴 슬롯. */
export function AgentItemRow({
  provider,
  name,
  branch,
  activity,
  unread,
  menu,
  menuOpen,
  diffBadge,
  title,
  className,
  onKeyDown,
  ...rest
}: {
  provider: Provider;
  name: string;
  branch?: string;
  activity: AgentDisplayState;
  /** 확인하지 않은 done/blocked/입력대기 에피소드가 있으면 점에 링 표시 */
  unread?: boolean;
  /** 우측 22px 슬롯 (점 세개 메뉴) — group-hover 시 표시 */
  menu?: ReactNode;
  menuOpen?: boolean;
  /** 브랜치 행 우측의 ±변경량 배지 슬롯 */
  diffBadge?: ReactNode;
  title?: string;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "group/item flex cursor-pointer items-center gap-2 rounded-md p-2 hover:bg-glass-tint-hover",
        menuOpen && "bg-glass-tint-selected",
        className,
      )}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.currentTarget.click();
      }}
      {...rest}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1">
          <ProviderBadge provider={provider} className="size-4 rounded-[6px] border-0" />
          <OverflowRevealText className="text-xs leading-none font-medium text-sidebar-foreground" text={name} />
          <ActivityDot activity={activity} unread={unread} className="ml-0.5 size-[5px]" />
        </div>
        {branch && (
          <div className="flex w-full items-center gap-1">
            <GitBranch className="size-[10px] shrink-0 text-muted-foreground" />
            <OverflowRevealText text={branch}
              className="min-w-0 flex-1 font-mono text-meta leading-none text-muted-foreground" />
            {diffBadge}
          </div>
        )}
      </div>
      {/* opacity가 아니라 display로 숨김 — 안 보일 때 이름 공간을 뺏지 않게 */}
      <span
        className={cn("hidden shrink-0 group-hover/item:block", menuOpen && "block")}
        onClick={(e) => e.stopPropagation()}
      >
        {menu}
      </span>
    </div>
  );
}
