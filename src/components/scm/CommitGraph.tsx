import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
// 멀티레인 커밋 그래프 — SourceControlPane에서 추출 (god-file 랫칫).
// 노드+선분 SVG + ref/author 배지, 브랜치 체크아웃/동기화 툴바 포함.
import { useCallback, useEffect, useMemo, useState } from "react";
import { DureLoader } from "@/components/ui/dure-loader";
import { IconButton } from "@/components/ui/icon-button";
import {
  Check,
  Cloud,
  CloudUpload,
  GitBranch,
  MoreHorizontal,
  RefreshCw,
  Target,
} from "lucide-react";
import { useStore } from "@/store";
import { openGitPanel } from "@/lib/workspace/dock/openScmPanel";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";
import {
  gitAction,
  gitBranches,
  gitLog,
  type GitBranches,
  type GitCommit,
} from "@/lib/scm/history/git";
import { computeGraph, LANE_COLORS, type GraphRow } from "@/lib/scm/history/gitGraph";
import { groupGitRefBadges } from "@/lib/scm/history/gitRefs";
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sidebarLabelTone } from "@/components/sidebar/SidebarItems";
import { SidebarScrollArea } from "@/components/ui/scroll-area";

const ROW_H = 32;
/** Lane spacing, tightened once a graph opens enough lanes. At 11px a ten-lane
 *  graph takes a 123px column — 41% of the 300px sidebar — leaving the subject
 *  109px, close to its 4.5rem floor. 9px cuts the column to 105px and gives
 *  the subject 18px back.
 *
 *  The floor is not node-to-node: a row draws exactly one node, so nodes never
 *  collide. What sets it is the clearance between a node and the neighbouring
 *  lane's line (LANE_W - NODE_R): 5px at 9px spacing, but only 3px at 7px,
 *  where the node starts reading as if it touches that line.
 *
 *  At five lanes or fewer nothing is tightened. A simple graph has no reason to
 *  get denser, and width only becomes the constraint above that. */
const LANE_W_WIDE = 11;
const LANE_W_TIGHT = 9;
const LANE_COMPRESS_ABOVE = 5;
const NODE_BASE = 12;
/** Node radius. The node is a filled dot with no stroke, so its on-screen
 *  diameter is simply 2r = 8px.
 *  The comp asks for r2.5 (diameter 5) but the radius stays an integer: 2.5
 *  puts the circle's edge on a half pixel and smears it on 1x displays (owner
 *  decision 2026-09-07). Rounding up rather than down, because at r=2 a
 *  muted-foreground dot all but disappears on light-mode glass.
 *  Marking ref-bearing commits with a hollow ring is retired. Ref names now
 *  render as text in the row (Glass v2 §1), so the node would only repeat what
 *  the row already says — and at this size the ring's hole (2r-2) drops below
 *  4px, where it stops reading as hollow anyway. */
const NODE_R = 4;

/** 한 행의 그래프 열을 SVG로 그림 (멀티레인 선분 + 노드) */
function GraphCell({
  row,
  isHead,
  trunkColorIdx,
  sideLaneColor,
  laneW,
}: {
  row: GraphRow;
  isHead: boolean;
  trunkColorIdx: number;
  sideLaneColor: Map<number, string>;
  laneW: number;
}) {
  const w = NODE_BASE * 2 + Math.max(0, row.width - 1) * laneW;
  const cx = (lane: number) => NODE_BASE + lane * laneW;
  const yTop = 0;
  const yMid = ROW_H / 2;
  const yBot = ROW_H;
  // Colour answers one question first: trunk or side branch. The trunk stays
  // achromatic and every side branch is tinted, so that reading survives no
  // matter how many lanes are open (Glass v2 §4). Telling side branches apart
  // is the second, weaker signal, and sideLaneColor sizes the palette for it.
  //
  // Trunk identity comes from colorIdx, not the lane index. Lane positions
  // shift as branches open and close, while colorIdx follows a lineage —
  // gitGraph.ts hands it down through the first parent. The trunk is whichever
  // lineage carries HEAD.
  //
  // Lines deliberately avoid glass/hairline. That token draws dividers inside a
  // panel (7% light, 9% dark), roughly ten times too faint for the primary
  // structure of a graph: the nodes showed and the rail vanished, leaving a
  // column of unconnected dots (reported 2026-09-07).
  const laneStroke = (colorIdx: number) =>
    colorIdx === trunkColorIdx
      ? "var(--muted-foreground)"
      : (sideLaneColor.get(colorIdx) ?? LANE_COLORS[0]);
  // A node outranks its line. Painting both in muted-foreground left the dot
  // flush with the rail and it read as missing (reported 2026-09-07), so the
  // line holds back at 55% while the node lands opaque. Side-branch nodes keep
  // their lane colour so the trunk/branch split survives the change.
  const nodeFill =
    row.nodeColorIdx === trunkColorIdx ? "var(--foreground)" : laneStroke(row.nodeColorIdx);
  return (
    <svg width={w} height={ROW_H} className="shrink-0" style={{ minWidth: w }}>
      {row.segments.map((s, k) => {
        const x1 = cx(s.top);
        const x2 = cx(s.bottom);
        const [ay, by] =
          s.half === "upper" ? [yTop, yMid] : s.half === "lower" ? [yMid, yBot] : [yTop, yBot];
        const midY = (ay + by) / 2;
        // 레인 변경은 부드러운 베지어, 직진은 직선
        const d =
          x1 === x2
            ? `M${x1} ${ay} L${x2} ${by}`
            : `M${x1} ${ay} C${x1} ${midY} ${x2} ${midY} ${x2} ${by}`;
        return (
          <path
            key={k}
            d={d}
            fill="none"
            stroke={laneStroke(s.colorIdx)}
            strokeOpacity={0.55}
            strokeWidth={1}
          />
        );
      })}
      <circle
        cx={cx(row.nodeLane)}
        cy={yMid}
        r={isHead ? NODE_R + 1 : NODE_R}
        fill={nodeFill}
      />
    </svg>
  );
}

/** 멀티레인 커밋 그래프 — 노드+선분 SVG + ref/author 배지.
 *  width: 패널 폭 → 헤더 툴바가 반응형으로 축소된다. */
export function CommitGraph({
  project,
  width,
  viewAsTree,
  onViewAsTree,
  onSelectCommit,
}: {
  project: Project;
  width: number;
  viewAsTree: boolean;
  onViewAsTree: (v: boolean) => void;
  /** 별도 창의 상세 영역 — 커밋 행 클릭 시 (없으면 클릭 무동작) */
  onSelectCommit?: (project: Project, hash: string) => void;
}) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const [branches, setBranches] = useState<GitBranches | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [log, br] = await Promise.all([gitLog(project, 200), gitBranches(project)]);
      setCommits(log);
      setBranches(br);
    } finally {
      setLoading(false);
    }
  }, [project]);
  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (commits ? computeGraph(commits) : []), [commits]);
  // The trunk is the colorIdx of the lineage carrying HEAD. It is one fact for
  // the whole graph, so it is resolved once instead of per row.
  const trunkColorIdx = useMemo(() => {
    const headRef = branches?.current;
    const headRow = headRef
      ? rows.find((r) => r.commit.refs.includes(headRef))
      : undefined;
    return (headRow ?? rows[0])?.nodeColorIdx ?? 0;
  }, [rows, branches]);

  // The number of side-branch colours tracks how complex the graph actually is.
  // Fixing it at three leaves ten open branches indistinguishable; fixing it at
  // ten spends more colour than two branches carry. So the palette is sized by
  // the widest row the graph reaches.
  //
  // Slots are handed out in order of first appearance rather than by colorIdx
  // modulo. colorIdx is a global counter that advances per lineage
  // (gitGraph.ts), so two lanes visible together collide whenever their indices
  // differ by a multiple of the palette length. Filling slots as lanes appear
  // keeps neighbouring branches off each other's colour.
  const maxLanes = useMemo(() => rows.reduce((m, r) => Math.max(m, r.width), 1), [rows]);
  const laneW = maxLanes > LANE_COMPRESS_ABOVE ? LANE_W_TIGHT : LANE_W_WIDE;
  const sideLaneColor = useMemo(() => {
    const size = Math.min(Math.max(maxLanes - 1, 1), LANE_COLORS.length);
    const slot = new Map<number, string>();
    for (const row of rows) {
      for (const idx of [row.nodeColorIdx, ...row.segments.map((seg) => seg.colorIdx)]) {
        if (idx === trunkColorIdx || slot.has(idx)) continue;
        slot.set(idx, LANE_COLORS[slot.size % size]);
      }
    }
    return slot;
  }, [rows, trunkColorIdx, maxLanes]);
  const branch = branches?.current || (commits?.find((c) => c.refs.length)?.refs[0] ?? "");

  /** 브랜치 체크아웃 (원격이면 로컬 트래킹 브랜치로) */
  const checkout = async (name: string) => {
    const args = name.startsWith("origin/")
      ? ["checkout", "-B", name.replace(/^origin\//, ""), "--track", name]
      : ["checkout", name];
    setActionErr(await gitAction(project, args));
    await load();
  };
  /** pull --ff-only 후 push */
  const sync = async () => {
    const e1 = await gitAction(project, ["pull", "--ff-only"]);
    const e2 = await gitAction(project, ["push"]);
    setActionErr(e2 || e1);
    await load();
  };
  /** HEAD(그래프 최상단) 커밋으로 스크롤 */
  const scrollToHead = () =>
    document.querySelector<HTMLElement>("[data-graph-head]")?.scrollIntoView({ block: "center" });

  /** 브랜치 목록 서브메뉴 (체크아웃) — Figma 브랜치 아이콘 기능 */
  const branchSub = (
    <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
      {!branches || (branches.local.length === 0 && branches.remote.length === 0) ? (
        <DropdownMenuItem disabled>
          <span className="text-xs">{t("scm.graph.noBranches")}</span>
        </DropdownMenuItem>
      ) : (
        <>
          {branches.local.map((bn) => (
            <DropdownMenuItem key={bn} onClick={() => void checkout(bn)}>
              <GitBranch />
              <span className="truncate text-xs">{bn}</span>
              {bn === branches.current && <Check className="ml-auto" />}
            </DropdownMenuItem>
          ))}
          {branches.remote.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-meta font-medium">{t("common.remote")}</DropdownMenuLabel>
              {branches.remote.map((bn) => (
                <DropdownMenuItem key={bn} onClick={() => void checkout(bn)}>
                  <Cloud />
                  <span className="truncate text-xs">{bn}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </>
      )}
    </DropdownMenuSubContent>
  );

  const showGraphLabel = width >= 350; // 정체성과 액션이 다 서고도 남을 때만


  return (
    <div className="flex min-h-[120px] flex-1 flex-col">
      {/* Graph toolbar — Figma 374-11505:
          GitBranch(main) / Target·GitBranch·CloudUpload·RefreshCw·Ellipsis
          (the comp's BookMarked repository label is dropped — see below) */}
      <div className="group/label flex h-9 shrink-0 items-center gap-2 pr-3.5 pl-4">
        {showGraphLabel && (
          <span className={cn("shrink-0 text-xs leading-4 font-semibold", sidebarLabelTone())}>
            GRAPH
          </span>
        )}
        {/* Identity on the left, actions on the right — a toolbar's usual
            division. Both used to sit in one right-aligned group, which left
            the row's whole left half empty once the repository name went
            (owner report 2026-09-08).

            That name is gone because the row directly above this graph already
            names the repository and its branch, and the pane title names it a
            third time; the toolbar was spending its width repeating them and
            truncating both. The branch stays and truncates rather than
            disappearing — a graph that does not say which branch it draws is
            worse than a shortened word. */}
        <span className="flex min-w-0 flex-1 items-center gap-1 text-meta font-medium text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <OverflowRevealText text={branch || "—"} />
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {/* The actions are one cluster, so they sit on the 4px every other
              header action rail uses (SectionHeaderRow). At the row's own 8px
              the five 24px buttons read as five separate controls spread down
              the row rather than as a toolbar (owner report 2026-09-08). */}
          <div className="flex shrink-0 items-center gap-1">
          {/* The shared sidebar action button: a 24px target with a 14px
              glyph and a hover tint. This rail drew its own 16px box with a
              12px glyph and no hover fill, so its controls read as inline
              marks rather than as buttons (owner report 2026-09-08) — and a
              16px target is below what a pointer wants. */}
          <IconButton title={t("scm.graph.goToCurrentCommit")} onClick={scrollToHead}>
            <Target />
          </IconButton>
          <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  className="data-[state=open]:text-sidebar-foreground"
                  title={t("scm.graph.checkoutBranch")}
                >
                  <GitBranch />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 w-52 overflow-y-auto">
                <DropdownMenuLabel className="text-meta font-medium">{t("scm.graph.checkoutBranch")}</DropdownMenuLabel>
                {branches?.local.map((bn) => (
                  <DropdownMenuItem key={bn} onClick={() => void checkout(bn)}>
                    <GitBranch />
                    <span className="truncate text-xs">{bn}</span>
                    {bn === branches.current && <Check className="ml-auto" />}
                  </DropdownMenuItem>
                ))}
                {branches && branches.remote.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-meta font-medium">{t("common.remote")}</DropdownMenuLabel>
                    {branches.remote.map((bn) => (
                      <DropdownMenuItem key={bn} onClick={() => void checkout(bn)}>
                        <Cloud />
                        <span className="truncate text-xs">{bn}</span>
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
          </DropdownMenu>
          <IconButton title={t("scm.actions.syncChanges")} onClick={() => void sync()}>
            <CloudUpload />
          </IconButton>
          <IconButton title={t("common.refresh")} onClick={() => void load()}>
            {loading ? (
              <DureLoader decorative className="text-sidebar-foreground" />
            ) : (
              <RefreshCw />
            )}
          </IconButton>
          {/* ⋯ 드롭다운 — 아이콘 기능들 + 보기(목록/트리) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                className="data-[state=open]:text-sidebar-foreground"
                title={t("scm.pane.more")}
              >
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {actionErr && (
                <>
                  <DropdownMenuLabel className="text-meta break-all text-destructive">
                    {actionErr}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={scrollToHead}>
                <Target />
                <span className="text-xs">{t("scm.graph.goToCurrentCommit")}</span>
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <GitBranch />
                  <span className="text-xs">{t("scm.graph.checkoutBranch")}</span>
                </DropdownMenuSubTrigger>
                {branchSub}
              </DropdownMenuSub>
              <DropdownMenuItem onClick={() => void sync()}>
                <CloudUpload />
                <span className="text-xs">{t("scm.actions.syncChanges")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void load()}>
                <RefreshCw />
                <span className="text-xs">{t("common.refresh")}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-meta font-medium">{t("scm.view.menuLabel")}</DropdownMenuLabel>
              {/* List or tree, never both — a dot, not a check. */}
              <DropdownMenuRadioGroup
                value={viewAsTree ? "tree" : "list"}
                onValueChange={(value) => onViewAsTree(value === "tree")}
              >
                <DropdownMenuRadioItem value="list">
                  <span className="text-xs">{t("scm.view.asList")}</span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="tree">
                  <span className="text-xs">{t("scm.view.asTree")}</span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  openGitPanel(useStore.getState().activeSpaceId, project.id, project.name)
                }
              >
                <span className="text-xs">{t("scm.actions.showGitOutput")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>
      </div>

      {/* viewportClassName px-1.5: 행의 hover 알약이 패널 양 끝에 닿지 않게
          6px을 비운다. 행이 자기 padding에서 그만큼 덜어가므로 글리프·제목의
          가로 위치는 그대로다 — 레인 선이 행마다 어긋나면 안 된다. */}
      <SidebarScrollArea edgeFade className="min-h-0 flex-1" viewportClassName="snap-y snap-proximity px-1.5">
        {commits === null && (
          <div className="px-4 py-2 text-xs text-muted-foreground">{t("common.loading")}</div>
        )}
        {commits?.length === 0 && (
          <div className="px-4 py-2 text-xs text-muted-foreground">{t("scm.graph.noCommits")}</div>
        )}
        {rows.map((row, i) => {
          const refs = groupGitRefBadges(row.commit.refs);
          // Badges on glass drop their fill and stay as text (Glass v2 §1),
          // joined into one line by a middle dot: `origin/main · +3`.
          const refsText = [
            ...refs.visible,
            ...(refs.hidden.length > 0 ? [`+${refs.hidden.length}`] : []),
          ].join(" · ");
          // Only HEAD's node is lifted to foreground. Row order is no guide:
          // under `--all --topo-order` row 0 is merely the newest commit across
          // every branch, so HEAD is matched through the current branch instead.
          const headRef = branches?.current;
          const isHead = headRef ? row.commit.refs.includes(headRef) : i === 0;
          return (
            <div
              key={row.commit.hash}
              {...(i === 0 ? { "data-graph-head": "" } : {})}
              className={cn(
                // hover는 전폭 띠가 아니라 둥근 알약이다 — FileTree·SpacesRows와
                // 같은 규칙이다. 전폭이면 목록 행이 아니라 화면 한 줄이 통째로
                // 반응하는 것처럼 읽힌다(사용자 지적 2026-09-04).
                "flex h-8 snap-start items-center gap-1.5 overflow-hidden rounded-sm pr-1.5 pl-1",
                onSelectCommit && "cursor-pointer hover:bg-glass-tint-hover",
              )}
              onClick={() => onSelectCommit?.(project, row.commit.hash)}
            >
              <GraphCell
                row={row}
                isHead={isHead}
                trunkColorIdx={trunkColorIdx}
                sideLaneColor={sideLaneColor}
                laneW={laneW}
              />
              {/* The yielding order (subject → author → refs) is the owner
                  decision recorded in the comment below, left as it stands.
                  What changed is the floor: with min-w-0 a row carrying three
                  or four refs squeezed the subject to 0px and it vanished
                  outright (reported). Comp 2391:45978 shows the subject
                  *truncated* to `fix(live…`, not absent — 4.5rem is the width
                  that keeps it in that state. Refs only begin to shrink once
                  the subject has reached it. */}
              <OverflowRevealText text={row.commit.subject}
                className="min-w-[4.5rem] flex-1 text-xs leading-4 text-sidebar-foreground" />
              {refsText && (
                // Dropping the pill also dropped its icons (Cloud, GitBranch).
                // They distinguished remote from local while a chip carried
                // them; on a text-only line the `origin/` prefix says it.
                <OverflowRevealText className="on-glass min-w-0 shrink font-mono text-2xs font-normal text-muted-foreground"
                  title={[...refs.visible, ...refs.hidden].join("\n")} text={refsText} />
              )}
              {row.commit.author && (
                // 작성자는 행의 오른쪽 끝에 고정이고 양보하지 않는다(소유자
                // 결정 2026-09-04). 커밋 목록에서 "누가"는 항상 같은 자리에
                // 있어야 세로로 훑을 수 있다 — 폭에 따라 사라지거나 위치가
                // 밀리면 그 열이 열로 안 읽힌다. 그래서 양보 순서는
                // 제목(min-w-0 flex-1) → ref → 작성자다.
                <OverflowRevealText text={row.commit.author}
                  className="on-glass ml-auto max-w-[52px] shrink-0 font-mono text-2xs font-normal text-muted-foreground" />
              )}
            </div>
          );
        })}
      </SidebarScrollArea>
    </div>
  );
}
