// 스페이스 목록의 데스크탑 그룹 머리행 — SpacesPane에서 추출한 렌더 전용 조각.
// 드롭 타깃 여부와 액션은 부모가 소유하고 prop으로 내려온다; 활성 여부만 이
// 머리행이 스토어에서 직접 읽는다(스페이스 전환이 바뀐 두 머리행만 다시
// 그리도록). 드래그·드롭 자체는 감싼 SpacesDesktopSection 하나가 받는다 —
// 머리행이 따로 받으면 pane 탭 드롭이 두 번 이동했다.
//
// Figma 2386:41113/41114: pt-6px·px-8px 컨테이너 안에 Sidebar/Label
// (px-8px py-4px rounded-6px, 13px medium foreground 70%, 18px 줄높이).
// 6 + 4 + 18 + 4 = 32px — 머리행 높이는 패딩에서 나오고 고정 높이를 두지 않는다.
//
// Two levels (2026-09-03, project → space → pane hierarchy): `group` is the
// top of the space-first list described above; `sub` is the space heading
// nested under a repository in the project-first list — 11px label at the
// 21px column, no add menu (the repository row above already starts sessions
// in that repository), still a switch target and a drop target.

import { confirmAndCloseDesktop } from "@/lib/workspace/desktop/desktopClose";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { sidebarSectionLabelTone } from "@/components/sidebar/SidebarItems";
import { DesktopAddMenuButton } from "@/components/spaces/DesktopAddMenuButton";
import { useIsActiveDesktop } from "@/components/spaces/useSpacesPaneState";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";

/** Where a heading stands: top of the list (`group`) or nested one level
 *  down (`sub`) — the space heading under a repository in the project-first
 *  list, the repository heading under a space in the space-first list. */
export type SpacesGroupLevel = "group" | "sub";

export interface SpacesGroupHeaderProps {
  desktop: { readonly id: string; readonly name: string };
  /** 행 드래그가 이 섹션 위에 있을 때 한 단 진한 하이라이트 */
  isDropTarget: boolean;
  onActivate: (desktopId: string) => void;
  onAddAgent: (desktopId: string) => void;
  onAddTerminal: (desktopId: string) => void;
  /** 마지막 일반 데스크탑은 닫을 수 없다 — 호출자가 판정 */
  canClose: boolean;
  /** 이 데스크탑에서 주의가 필요한 세션 수(error·blocked·input). 0이면
   *  아무것도 그리지 않는다 — 잘 돌아가는 중은 조용한 것이 기본값(SOUL §5.1).
   *  스크롤 밖·접힌 그룹의 대기 세션을 머리행이 대신 말해 준다. */
  attentionCount?: number;
  /** Top of the list (`group`, default) or nested under a repository (`sub`). */
  level?: SpacesGroupLevel;
  /** Semantic level when another grouping axis wraps this hierarchy. */
  heading?: "h3" | "h4" | "h5";
  /** Whether this space's section is folded away. */
  collapsed?: boolean;
  /** Fold the section. Omitted leaves the heading unfoldable and chevronless —
   *  a chevron on a row that cannot fold promises an action that is not
   *  there. */
  onToggleCollapsed?: () => void;
}

/** Attention rollup glyph shared by the space and repository headings: a 5px
 *  blocked-status dot and a mono count, drawn only when someone is waiting on
 *  a human. Zero draws nothing — silence is the default (SOUL §5.1). */
export function SpacesAttentionRollup({ count }: { count: number }) {
  if (count <= 0) return null;
  const label = t("spaces.group.attentionCount", { n: count });
  return (
    <span
      className="ml-1.5 flex shrink-0 items-center gap-1 font-mono text-meta text-muted-foreground"
      aria-label={label}
    >
      <span className="block size-[5px] rounded-full bg-status-blocked" />
      {count}
    </span>
  );
}

export function SpacesGroupHeader({
  desktop,
  isDropTarget,
  onActivate,
  onAddAgent,
  onAddTerminal,
  canClose,
  attentionCount = 0,
  level = "group",
  heading,
  collapsed = false,
  onToggleCollapsed,
}: SpacesGroupHeaderProps) {
  // 활성 데스크탑 — 라벨 색은 바뀌지 않는다(시안에 활성 상태가 없다).
  // aria-current로만 나가고, 지금 어느 데스크탑인지는 창 상단 탭이 말한다.
  const isActive = useIsActiveDesktop(desktop.id);
  const Heading = heading ?? (level === "group" ? "h3" : "h4");
  return (
    // 559:39362 — 호버·활성 모두 글자색만 움직인다. 배경 칠은 없다.
    // 머리행은 [전환 버튼 | hover '+' 메뉴]의 가로 배치 — 버튼 안에 버튼을 넣을
    // 수 없어 형제로 둔다. 우클릭 = 데스크탑 닫기(사용자 요청).
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div
      className={cn(
        // group/label이 있어야 sidebarSectionLabelTone의 hover 대비가 실제로 걸린다
        // (추출 전에는 group/desktop만 있어 Hover 상태가 죽어 있었다).
        // 2386:41114 "Sidebar/Label" — 라벨 글자는 패널 기준 16px에서 시작한다
        // (컨테이너 8px + 버튼 8px). 아래 저장소 머리행 21px, 세션 행 24px과
        // 함께 세 층의 들여쓰기를 만든다. The sub level takes the 21px column
        // itself (rows container 12px + 9px).
        // 8px padding from Figma 3419:88033 "Sidebar / SidebarGroupLabel",
        // and its 32px box at the `group` level, where the heading carries the
        // 13px label.
        //
        // A short, glyphless 11px row — a different kind of thing from the
        // 13px icon rows it names, not a lighter version of them. Both comps
        // draw it this way, and a shipping IDE's stylesheet agrees: its section
        // header is 22px at 11px bold, uppercase, and its icon slot is
        // explicitly hidden (`.pane-header > .icon { display: none }`).
        // Giving it a glyph and equal weight was tried and read as flat
        // (owner report 2026-09-08) — with both at the same weight only the
        // indent said which contained which.
        //
        // That IDE carries "you can act on this" with a twisty, which is not
        // available here: this heading switches desktops, it does not fold. The
        // affordance is the hover tone instead (sidebarSectionLabelTone, keyed
        // on the row's own `group/label`).
        // 20px, under the 32px repository row above it and the 32px session
        // rows below: a heading has to be smaller than what it names or it
        // reads as one of them (owner call 2026-09-14).
        "group/desktop group/label flex h-5 items-center gap-1 rounded-md",
        // Two columns: the repository at 16, this heading at 24 with the rows
        // it names — their glyph on 24, their card wrapping the block from 16.
        // Three columns eight apart (rows at 32) was tried on the VS Code /
        // Primer step and read as stairs at rest; a label standing on the
        // column of the rows it names is what the Files tab and the Pinned
        // marker already do (owner call 2026-09-14). At the top level a space
        // has no repository above it, so it keeps the 16.
        level === "group" ? "px-2" : "pr-1 pl-4",
        isDropTarget && "bg-accent/60 ring-1 ring-ring/40",
      )}
    >
      <button
        type="button"
        aria-current={isActive ? "page" : undefined}
        data-desktop-id={desktop.id}
        className={cn(
          // No vertical padding of its own — the row above is a fixed 32px
          // box and the button centres inside it. No gap either: the number's
          // own 14px box already leaves ~4px beside a digit, which is the gap
          // the desktop bar puts between a number and its name (DesktopBar's
          // gap-1), and stacking 8 on top of that read as twice the bar's
          // (owner report 2026-09-14). What follows the label carries its own
          // spacing — the attention rollup its ml, the fold's count its pl.
          "flex min-w-0 flex-1 items-center gap-0 rounded-sm text-left focus-visible:inset-ring-1 focus-visible:inset-ring-ring focus-visible:outline-none",
          level === "group" && "px-2",
        )}
        aria-expanded={onToggleCollapsed ? !collapsed : undefined}
        onClick={onToggleCollapsed ?? (() => onActivate(desktop.id))}
      >
        {/* 2386:41114 "Sidebar/Label" — text-xs(13px) medium, 줄높이 18px,
            foreground 70%. 이전 시안(2070:32054)의 11px semibold에서 한 단계
            키우고 굵기는 낮춘 것이다: 크기가 올라간 만큼 semibold는 과했다.
            색은 시안대로 foreground 70% — 저장소 머리행·브랜치 줄과 같은 값이다.
            시안의 위계는 색이 아니라 크기(13px medium vs 11px)와 들여쓰기
            (16/21/24px)가 지고 있으므로, 여기서 색을 한 단 더 진하게 만들면
            그 그룹만 제목처럼 튄다.
            활성 데스크탑이라고 진하게 만들지 않는다. 시안의 이 라벨은 Default와
            Hover 두 상태뿐이고 ‘활성’ 상태가 없다 — 지금 어느 데스크탑에 있는지는
            창 최상단 탭이 이미 말한다. 여기서 한 번 더 진하게 칠하면 목록에서
            그 그룹만 제목처럼 튀어 보인다. The sub level drops to 11px — the
            repository above it holds the 13px slot. */}
        {/* No number. The desktop bar's ⌘n numeral was carried here for a day
            (2026-09-14) and taken back the same day: beside the folded count
            it read as a second count, grouped by repository it came out of
            sequence (2, 3, 6 under one folder), and every other marker in the
            sidebar — Recent file, Pinned, Unopened agents — is a bare name.
            The bar keeps the number and the shortcut; the sidebar keeps the
            name. */}
        <Heading
          className={cn(
            // 11px at either level: the size says this is a section marker, not
            // an item, however the list is grouped.
            // −16px: the fading viewport keeps 16px behind its text so a
            // revealed name clears the fade as it slides, and that padding
            // counted as part of the name — the fold's control stood 24px out
            // instead of 8 (owner report 2026-09-14). Taking it off the text
            // instead put the fade on top of every name that fits.
            "-mr-4 min-w-0 text-meta leading-[18px] font-medium",
            sidebarSectionLabelTone(),
          )}
        >
          {/* A name too long for the row fades out and slides open on hover,
              the way the session titles under it do. An ellipsis here and a
              fade one row below were two answers to one question inside a
              single list (owner call 2026-09-14). */}
          <OverflowRevealText text={desktop.name} />
        </Heading>
        <SpacesAttentionRollup count={attentionCount} />
        {/* Folded, the heading is all that is left of this space: nothing
            follows it, and two folded spaces in a row read as two loose labels
            (owner report 2026-09-14). What the fold says for itself is the
            count of what it holds, in the repository heading's own idiom —
            and only when the number says something. One hidden row is already
            what folding means, so it starts at two; a pass that printed "1" on
            three headings in a row was just noise, and a chevron pinned open
            on each of them was the same noise in another form (owner calls,
            same day). The chevron stays a hint at both states. */}
        {/* The fold's count and its chevron stand right after the name, where
            the repository heading above keeps its own. The row's end was tried
            and is not available to both: a repository's trailing edge belongs
            to its hover action rail, which appears behind a 40px lead-in, so a
            chevron sent there lands mid-row (owner report 2026-09-14). After
            the name is the one place both headings can share. */}
        {onToggleCollapsed && (
          <span className="flex shrink-0 items-center gap-2 pl-2">
            <DisclosureChevron hint open={!collapsed} />
          </span>
        )}
      </button>
      {level === "group" && (
        <DesktopAddMenuButton
          desktop={desktop}
          onAddAgent={onAddAgent}
          onAddTerminal={onAddTerminal}
        />
      )}
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {/* The row's click folds now, the way the repository row above it does
            — this list's rule is that a heading's own click opens and closes
            it, and the chevron that used to carry the fold was the only one in
            the sidebar (owner report 2026-09-08). Switching moves here rather
            than being lost: the window's desktop bar is the primary switcher
            anyway, and folding has nowhere else to live. */}
        <ContextMenuItem onClick={() => onActivate(desktop.id)}>
          {t("spaces.desktop.moveTo", { name: desktop.name })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          disabled={!canClose}
          onClick={() => void confirmAndCloseDesktop(desktop.id, desktop.name)}
        >
          {t("common.closeDesktop")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
