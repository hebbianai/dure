import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { Titled } from "@/components/ui/tooltip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, GitBranch, MoreHorizontal, RefreshCw } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { vcsStatusTone } from "@/lib/scm/status/vcsStatusTone";
import { useStore } from "@/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";
import {
  gitExec,
  gitInfo,
  type GitInfo,
} from "@/lib/scm/history/git";
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
import { Button } from "@/components/ui/button";
import { openSourceControlWindow } from "@/lib/workspace/window/windows";
import { openScmDetailInWindow } from "@/lib/scm/scmDetailRelay";
import { GitActionsMenu } from "@/components/scm/GitActionsMenu";
import { CommitGraph } from "@/components/scm/CommitGraph";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { IconButton, RowMenuButton } from "@/components/ui/icon-button";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import type { FocusCtxSnapshot } from "@/lib/scm/focusCtxBroadcast";
import { PaneEmptyState } from "@/components/common/PaneEmptyState";
import { PanelStatus } from "@/components/common/PanelStatus";
import { GitAvailabilityNotice } from "./GitAvailabilityNotice";
import { useGitAvailability } from "./useGitAvailability";

/** 프로젝트별 소스 제어 카드 — 브랜치·메시지·커밋/동기화 */
function RepoCard({
  project,
  narrow,
  viewAsTree = false,
  collapseSignal = 0,
  refreshSignal = 0,
  onSelectFile,
}: {
  project: Project;
  narrow: boolean;
  viewAsTree?: boolean;
  collapseSignal?: number;
  /** 값이 바뀌면 git 상태만 다시 읽는다 — 카드를 다시 마운트하지 않는다. */
  refreshSignal?: number;
  /** 별도 창의 상세(diff) 영역 — 파일 행 클릭 시 (없으면 클릭 무동작) */
  onSelectFile?: (project: Project, path: string) => void;
}) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // 헤더의 "모두 접기" 신호에 반응
  useEffect(() => {
    if (collapseSignal > 0) setCollapsed(true);
  }, [collapseSignal]);

  const refresh = useCallback(async () => {
    setInfo(await gitInfo(project));
  }, [project]);
  // refreshSignal이 따로 필요한 이유: 헤더 새로고침은 대개 repoRoot를 같은
  // 값으로 되돌려놓아서 focusProject(useMemo)도, 그래서 refresh의 정체성도
  // 그대로다 — 신호가 없으면 아무 일도 일어나지 않는다.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshSignal]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  /** 커밋 변형들 (Figma 378-18804). stage=add -A 여부, extra=commit 추가 인자 */
  const doCommit = (opts?: { stage?: boolean; extra?: string[]; needMsg?: boolean }) =>
    run("commit", async () => {
      const { stage = true, extra = [], needMsg = true } = opts ?? {};
      if (needMsg && !msg.trim()) return;
      if (stage) await gitExec(project, ["add", "-A"]);
      const args = ["commit", ...extra];
      if (needMsg) args.push("-m", msg.trim());
      const c = await gitExec(project, args);
      if (c.code !== 0) {
        setErr((c.stderr || c.stdout).trim());
        return;
      }
      setMsg("");
    });
  const commit = () => doCommit();
  const undoLast = () =>
    run("commit", async () => {
      await gitExec(project, ["reset", "--soft", "HEAD~1"]);
    });

  const sync = () =>
    run("sync", async () => {
      const pull = await gitExec(project, ["pull", "--ff-only"]);
      if (pull.code !== 0 && pull.stderr.trim()) setErr(pull.stderr.trim());
      await gitExec(project, ["push"]);
    });

  const dirty = (info?.files.length ?? 0) > 0;
  const ahead = info?.ahead ?? 0;
  const behind = info?.behind ?? 0;
  const canSync = ahead > 0 || behind > 0;

  return (
    <div className="flex flex-col">
      {/* 레포 행 — 셰브런 + 이름 + 브랜치 + 액션 (Figma 376-13380).
          The file tab's row rule: the pane insets 8px, the row's fill starts
          there and its glyph 8px inside (16px from the edge). This row sat at
          6/14, the one row in the sidebar between the rules (owner call
          2026-09-13).
          Folded, the row is the card's last thing, so it carries the 12px the
          button leaves under itself when open (its own 6 plus 6): the rule
          under the card stays where it was when the card folds (owner report
          2026-09-13). */}
      <div className={cn("px-2", collapsed && "pb-1.5")}>
        <div className="group/repo flex items-center gap-1.5 rounded-[6px] px-2 py-1.5">
          <Titled title={collapsed ? t("scm.pane.expandRepo") : t("scm.pane.collapseRepo")}>
            <button type="button"
              className="flex shrink-0 items-center text-muted-foreground"
              aria-label={collapsed ? t("scm.pane.expandRepo") : t("scm.pane.collapseRepo")}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((c) => !c)}
            >
              {/* text-current inherits the wrapping button's muted color */}
              <DisclosureChevron open={!collapsed} className="text-current" />
            </button>
          </Titled>
          {/* 이름과 브랜치는 한 묶음 — 셰브런/액션과의 간격(6px)보다 넓은 8px */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <OverflowRevealText text={project.name}
              className="max-w-[50%] text-xs leading-none text-sidebar-foreground" />
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <GitBranch className="size-3 shrink-0 text-muted-foreground" />
              <OverflowRevealText text={info?.branch || "…"}
                className="min-w-0 font-mono text-meta leading-4 font-normal text-muted-foreground" />
            </span>
          </div>
          {/* 시안 2640:86380의 레포 줄에는 오른쪽 액션이 없다. 있던 셋 중 둘은
              지운다: ✓는 바로 아래 기본 버튼과 같은 커밋이었고, ⟳는 헤더
              새로고침이 이 카드를 통째로 다시 마운트하므로 같은 일이었다.
              남는 ⋯만 쉼 상태에서 물러난다(호버/포커스에서 돌아온다) —
              여기 말고는 git 액션으로 가는 길이 없다. */}
          <div className="flex shrink-0 items-center text-muted-foreground">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* "Git actions", not "More" — this panel has three ⋯ buttons (panel
                    header, this row, graph toolbar), and if all three share one name a
                    screen reader cannot tell which is which.
                    The hide/reveal must live on this button, not the wrapping div: with
                    the parent at opacity-0 a child's opacity-100 cannot win (opacity
                    applies to the whole subtree, it is not inherited), so if the pointer
                    left the row while the menu was open, the trigger would vanish and
                    leave the open menu floating. Radix portals the menu away, so
                    focus-within cannot catch that moment either — data-[state=open]
                    does. */}
                <RowMenuButton
                  className="opacity-0 transition-opacity hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none group-hover/repo:opacity-100 data-[state=open]:text-sidebar-foreground data-[state=open]:opacity-100"
                  title={t("scm.actions.menuLabel")}
                />
              </DropdownMenuTrigger>
              {/* 커밋 변형은 예전에 기본 버튼에 붙은 셰브런이 열었는데, 시안의
                  버튼은 쪼개져 있지 않다. 초안 메시지를 아는 건 이 카드뿐이라
                  항목은 여기서 만들어 넘긴다. */}
              <GitActionsMenu project={project} onDone={() => void refresh()}>
                {/* Lock everything while running. The chevron that used to open these
                    items had `disabled={!!busy}`, and that guard was lost when they moved
                    into a submenu — `run()` has no reentrancy guard, so pressing "Undo
                    last commit" during a sync would run push and reset --soft together,
                    and whichever finished first would clear busy in its finally, even
                    reviving the primary button. */}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={!!busy}>
                    <span className="text-xs">{t("common.commit")}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem disabled={!!busy || !msg.trim()} onClick={commit}>
                      <span className="text-xs">{t("common.commit")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!!busy || !msg.trim()}
                      onClick={() => void doCommit({ stage: false })}
                    >
                      <span className="text-xs">{t("scm.commit.staged")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!!busy || !msg.trim()} onClick={commit}>
                      <span className="text-xs">{t("scm.commit.all")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!!busy} onClick={undoLast}>
                      <span className="text-xs">{t("scm.commit.undoLast")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={!!busy}
                      onClick={() => void doCommit({ extra: ["--amend"], needMsg: false })}
                    >
                      <span className="text-xs">{t("scm.commit.amend")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!!busy}
                      onClick={() => void doCommit({ extra: ["--amend"], needMsg: !!msg.trim() })}
                    >
                      <span className="text-xs">{t("scm.commit.allAmend")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={!!busy || !msg.trim()}
                      onClick={() => void doCommit({ extra: ["--signoff"] })}
                    >
                      <span className="text-xs">{t("scm.commit.signedOff")}</span>
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </GitActionsMenu>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {collapsed ? null : (
      <>
      {/* Commit message — Search/Glass/Small from mockup 2640:83062. The former
          white surface is recessed into glass/chrome. This is not a change for
          this input alone but a pair with the button right below: the button
          rises as glass/tray, so the input must sink for the card to split
          "where you type" from "where you press" by elevation. If both were
          white surfaces, a single border would be the only separation and
          nothing would read as pressed.
          The border is the mockup's glass/hairline-glass (#e5e5e5), and that
          value is exactly this file's --border — do not mint a third hairline
          token. Still no shadow: stacked on a 24px row it overlaps the border
          and reads as doubled.
          pt-0.5: with the repo row's own 6px below it, 8px of air before the
          field — the gap the file tab leaves under its search, instead of
          whatever padding the row happened to leave (owner call 2026-09-13). */}
      <div className="px-3 pt-0.5">
        <input
          className="h-8 w-full min-w-0 rounded-md border border-border bg-glass-chrome px-2 text-xs shadow-none outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/50"
          placeholder={t("scm.commit.messagePlaceholder")}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
      </div>

      {/* 커밋/동기화 버튼 — 시안 2640:82963 / 2640:83071의 Button/Glass.
          채운 primary에서 유리 트레이로 바뀌었다: 위 입력이 파인 면이라,
          같은 카드 안에서 뜬 면이어야 둘의 관계가 성립한다.
          쪼개진 셰브런은 없다 — 커밋 변형은 레포 줄 ⋯로 옮겼다. */}
      {/* pb-3: 버튼과 아래 구분선 사이 12px. pb-1(4px)이면 버튼이 선에
          붙어 읽힌다(사용자 지적 2026-09-04). */}
      <div className="px-3 pt-1.5 pb-3">
        {/* 32px, the height every other field and button in this app stands
            at — this card had a 24px input and a 28px button, the only controls
            in the sidebar below the shared size, and the tab stood out for it
            (owner report 2026-09-08). The recessed input against the raised
            glass button stays; only the sizes move. */}
        <Button
          variant="glass"
          className="w-full gap-2 px-3 text-xs"
          disabled={!!busy || (canSync ? false : !msg.trim())}
          onClick={canSync ? sync : commit}
        >
          {busy === "sync" || busy === "commit" ? (
            <DureLoader decorative />
          ) : canSync ? (
            <RefreshCw className="size-3" />
          ) : (
            <Check className="size-3.5" />
          )}
          {canSync ? (
            <span className="flex items-center gap-1.5">
              {!narrow && t("scm.actions.syncChanges")}
              {/* behind/ahead — 숫자와 화살표가 한 묶음, 묶음 사이 4px (Figma 2140-28449) */}
              <span className="flex items-center gap-1 text-meta font-medium">
                <span>{behind}↓</span>
                <span>{ahead}↑</span>
              </span>
            </span>
          ) : (
            t("common.commit")
          )}
        </Button>
      </div>

      {/* 변경 파일 */}
      {dirty && (
        // The same 8px inset as the repo row above; a file is one level under
        // it, so its text starts 12px further in (the file tab's per-depth
        // step: 8 + 12 = 20 inside the inset).
        <div className="px-2 pb-1">
          {info!.files.slice(0, 30).map((f) => {
            const name = f.path.split("/").pop() ?? f.path;
            const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, "");
            return (
              <Titled key={f.path} title={f.path}>
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-[6px] py-1 pr-2 pl-5 text-xs hover:bg-glass-tint-hover",
                    onSelectFile && "cursor-pointer",
                  )}
                  onClick={() => onSelectFile?.(project, f.path)}
                >
                  <OverflowRevealText text={viewAsTree ? f.path : name}
                    className="min-w-0 text-sidebar-foreground" />
                  {!viewAsTree && dir && (
                    <OverflowRevealText className="min-w-0 flex-1 text-[10px] text-muted-foreground" text={dir} />
                  )}
                  <span
                    className={cn(
                      "ml-auto shrink-0 font-mono text-meta",
                      vcsStatusTone(f.xy),
                    )}
                  >
                    {f.xy.startsWith("?") ? "U" : f.xy.replace(/\./g, "").slice(0, 1) || "M"}
                  </span>
                </div>
              </Titled>
            );
          })}
        </div>
      )}
      {err && <div className="px-4 pb-1 text-meta break-all text-destructive">{err}</div>}
      </>
      )}
    </div>
  );
}

// Figma 376-13497 등: 행 24px, 레인 간격 11px, 노드 중심 lane0=12px, 노드 8px

/** 소스 제어(GitHub) 탭 — Figma 374-11404. 포커스한 패널의 작업 폴더가 속한 git 저장소
 *  하나만. ctxOverride: 별도 창의 follow/pin 컨텍스트 주입(undefined면 이 창의 focusCtx). */
export function SourceControlPane({
  ctxOverride,
  onSelectFile,
  onSelectCommit,
  refreshSignal,
}: {
  ctxOverride?: FocusCtxSnapshot | null;
  onSelectFile?: (project: Project, path: string) => void;
  onSelectCommit?: (project: Project, hash: string) => void;
  /** 외부(별도 창의 주기 fetch)에서 값이 바뀌면 그래프·리포 정보를 재조회 */
  refreshSignal?: number;
} = {}) {
  const focus = useStore((s) => (ctxOverride !== undefined ? ctxOverride : s.focusCtx));
  const git = useGitAvailability(focus?.source === "ssh" ? focus.hostId ?? "" : null, !!focus);
  // 사이드바(핸들러 미주입)에서는 행 클릭이 소스 제어 창을 열어 상세를 띄운다.
  const defaultSelectFile = useCallback(
    (project: Project, path: string) => openScmDetailInWindow("file", project, path),
    [],
  );
  const defaultSelectCommit = useCallback(
    (project: Project, hash: string) => openScmDetailInWindow("commit", project, hash),
    [],
  );
  const [reloadKey, setReloadKey] = useState(0);
  // 별도 창의 fetch 주기와 동기 — refs가 갱신됐으니 --all 그래프를 다시 그린다
  useEffect(() => {
    if (refreshSignal !== undefined && refreshSignal > 0) setReloadKey((k) => k + 1);
  }, [refreshSignal]);
  // 포커스 cwd가 속한 실제 repo 루트: null=조회 전, ""=repo 아님
  const [repoRoot, setRepoRoot] = useState<string | null>(null);

  // gitExec에 넘길 합성 프로젝트 (cwd 기준 — git이 상위 repo 루트를 자동으로 찾음)
  const focusProject = useMemo<Project | null>(() => {
    if (!focus) return null;
    return {
      id: `focus:${focus.cwd}`,
      name: (repoRoot || focus.cwd).replace(/\/+$/, "").split("/").filter(Boolean).pop() || focus.cwd,
      path: repoRoot || focus.cwd,
      kind: focus.source,
      sshHostId: focus.hostId,
      isRepo: true,
    };
  }, [focus, repoRoot]);

  // 포커스가 바뀌면 이전 저장소의 카드를 즉시 내린다 — 다음 rev-parse가 끝날
  // 때까지 남겨두면 새 패널 밑에 옛 저장소의 변경 내용이 잠깐 붙어 보인다.
  // 이 초기화가 아래 rev-parse 이펙트 안에 있으면 안 된다: 그 이펙트는
  // reloadKey에도 걸려 있어서, 새로고침 때마다 repoRoot가 null로 내려가
  // "불러오는 중…" 가지로 갈아타고 RepoCard가 언마운트된다 — 쓰던 커밋 메시지
  // 초안이 거기서 사라진다(리뷰 지적). 새로고침은 화면을 비우는 일이 아니다.
  useEffect(() => {
    setRepoRoot(null);
  }, [focus]);

  // 포커스한 cwd가 git repo인지 + 루트 경로를 확인 (새로고침 때도 다시)
  useEffect(() => {
    let cancelled = false;
    if (!focus || git.state.status !== "available") return;
    const probe: Project = {
      id: "probe",
      name: "",
      path: focus.cwd,
      kind: focus.source,
      sshHostId: focus.hostId,
      isRepo: true,
    };
    void gitExec(probe, ["rev-parse", "--show-toplevel"]).then((r) => {
      if (cancelled) return;
      setRepoRoot(r.code === 0 ? r.stdout.trim() : "");
    });
    return () => {
      cancelled = true;
    };
  }, [focus, reloadKey, git.state.status]);

  const isRepo = repoRoot !== null && repoRoot !== "";

  // 패널 크기 측정 (그래프 헤더 반응형 + 리사이즈 클램프)
  const paneRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 600 });
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Vertical changes/graph split. A null value sizes the changes region to its
  // content within the available height; overflow belongs to its viewport.
  const [changesH, setChangesH] = useState<number | null>(null);
  /** 스크롤 뷰포트가 실제로 담고 있는 높이. 이보다 크게 늘리면 빈 공간만 생긴다. */
  const changesContentHeight = () => {
    const viewport = changesRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    return viewport ? viewport.scrollHeight : Number.POSITIVE_INFINITY;
  };
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = changesH ?? changesRef.current?.getBoundingClientRect().height ?? 120;
    const move = (ev: MouseEvent) => {
      const next = startH + (ev.clientY - startY);
      // 위: 최소 64, 아래(그래프): 최소 120 남김.
      // 상한은 패널 높이가 아니라 **콘텐츠 높이**다. 예전에는 size.h - 160이라
      // 카드 한 장(≈110px)뿐인데도 패널 절반까지 늘어났고, 그 아래는 전부 빈
      // 유리였다 — 시안에 카드가 세 장이라 그 프레임에서는 안 보이는 상태다.
      // 핸들은 1px에 히트 영역 ±4px이라 근처에서 살짝 끌리기만 해도 그 상태로
      // 굳었다(사용자 화면에서 실제로 그렇게 보였다).
      const max = Math.min(size.h - 160, changesContentHeight());
      setChangesH(Math.max(64, Math.min(max, next)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const changesRef = useRef<HTMLDivElement>(null);

  // 변경 내용 보기 상태 (378-16698): 트리/목록, 모두 접기 신호
  const [viewAsTree, setViewAsTree] = useState(false);
  const [collapseSignal, setCollapseSignal] = useState(0);

  return (
    <div ref={paneRef} className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5">
      {/* Source control header — mockup 2391:45857 keeps a single ⋯ as the
          right-side action, visible even at rest. The view toggle, collapse-all,
          and ⋯ that used to hang on the "Changes" row moved up here: that row in
          mockup 2397:49776 is label-only, and everything the three icons pointed
          at (list/tree, collapse, refresh) is panel-wide state, so it belongs to
          the panel head, not the repo card. */}
      <SectionHeaderRow
        label={t("common.sourceControl")}
        as="h2"
        actions={
          // 저장소가 없으면 메뉴를 걸지 않는다 — 모두 접기·새로고침·보기 토글이
          // 전부 아무도 읽지 않는 상태만 올린다. 유일하게 뜻이 서는 "새 창으로
          // 열기"는 그 창도 같은 빈 상태를 보여줄 뿐이다.
          isRepo && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton title={t("scm.pane.more")}>
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => setCollapseSignal((n) => n + 1)}>
                <span className="text-xs">{t("scm.pane.collapseAll")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setReloadKey((k) => k + 1)}>
                <span className="text-xs">{t("common.refresh")}</span>
              </DropdownMenuItem>
              {/* 별도 창(미러)에서는 다시 열기가 무의미 — 사이드바 호스팅일 때만 */}
              {ctxOverride === undefined && (
                <DropdownMenuItem onClick={() => void openSourceControlWindow()}>
                  <span className="text-xs">{t("common.openInNewWindow")}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-meta font-medium">{t("scm.view.menuLabel")}</DropdownMenuLabel>
              {/* List or tree, never both — a dot, not a check. */}
              <DropdownMenuRadioGroup
                value={viewAsTree ? "tree" : "list"}
                onValueChange={(value) => setViewAsTree(value === "tree")}
              >
                <DropdownMenuRadioItem value="list">
                  <span className="text-xs">{t("scm.view.asList")}</span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="tree">
                  <span className="text-xs">{t("scm.view.asTree")}</span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          )
        }
      />

      {/* An empty pane says so in the middle of itself, not tucked under the
          title: PanelStatus already draws that shape, and the sidebar tabs were
          each hand-rolling `px-4 pt-3` instead. Other IDEs do the same —
          centred muted copy on generous vertical padding, no glyph
          (owner decision 2026-09-08).

          The bottom padding is larger than the top on purpose: `justify-center`
          finds the geometric middle, and in a column this tall the geometric
          middle reads as sitting low. The heavier bottom lifts the block to
          where the eye expects the centre (사용자 지적 2026-09-08). */}
      {focus && git.state.status !== "available" && (
        <div className="px-4 py-3"><GitAvailabilityNotice {...git} /></div>
      )}
      {!focus ? (
        <PaneEmptyState
          compact
          title={t("scm.pane.selectPanelHint")}
        />
      ) : git.state.status !== "available" && !isRepo ? null : repoRoot === null ? (
        <PanelStatus size="xs" className="min-h-0 flex-1 px-4 pt-8 pb-24 text-center">
          {t("common.loading")}
        </PanelStatus>
      ) : !isRepo ? (
        <PaneEmptyState
          compact
          title={t("scm.pane.notGitRepo")}
        />
      ) : (
        // A new capability observation may temporarily hide controls. Keep
        // the existing card mounted so its commit draft survives the check.
        <div className={git.state.status === "available" ? "contents" : "hidden"} inert={git.state.status !== "available"}>
          {/* Changes region: automatic height until the user resizes it. */}
          {/* 여기에 key={reloadKey}를 걸면 안 된다: 새로고침이 카드를 다시
              마운트해서 사용자가 쓰던 커밋 메시지 초안을 되돌릴 방법 없이
              날린다(접힘 상태·오류 줄·스크롤 위치도 같이). 새로고침은
              refreshSignal로 git 상태만 다시 읽게 한다. */}
          <SidebarScrollArea
            edgeFade
            ref={changesRef}
            className="min-h-16 shrink"
            style={changesH !== null ? { height: changesH } : undefined}
          >
            {/* 변경 내용 — 시안 2397:49776의 "Folder label": 라벨 한 줄뿐이다.
                액션은 패널 헤더의 ⋯로 올라갔다(위 주석).

                11px, not 13: this names the rows under it, which is what every
                other group label in the sidebar does at 11px — at 13 it stood
                the same size as the pane title two lines above and the tab read
                as having two titles. And 14px of air above it, the gap the
                other tabs leave under their own title, so the band at the top
                of a tab holds still when you switch (owner report
                2026-09-08). */}
            <div className="px-4 pt-3.5 pb-1">
              <OverflowRevealText text={t("common.changes")}
                className="block min-w-0 text-meta leading-[18px] font-medium text-sidebar-foreground/70" />
            </div>
            {focusProject && (
              <RepoCard
                project={focusProject}
                narrow={size.w < 200}
                viewAsTree={viewAsTree}
                collapseSignal={collapseSignal}
                refreshSignal={reloadKey}
                onSelectFile={onSelectFile ?? defaultSelectFile}
              />
            )}
          </SidebarScrollArea>

          {/* Vertical resize handle — double-click is the only "reset to auto".
              Once dragged, changesH hardens into a number and cannot return to
              content height. */}
          {/* role="separator"를 달지 않는다: 그 역할은 aria-valuenow/min/max를
              요구하는데 이 핸들은 키보드로 못 움직인다 — 값을 붙이면 거짓말이
              된다. 마우스 전용 어포던스로 둔다. */}
          {/* 여백은 선 *위*에 있다 — 커밋 버튼 블록의 pb-3이 만든다. 아래에
              margin을 줬다가 되돌렸다(2026-09-04): 벌어지는 쪽이 툴바 행이라
              선이 버튼에 붙어 있는 문제는 그대로였다. 선 아래는 CommitGraph
              헤더(h-9)가 자기 여백을 이미 갖고 있다. */}
          <Titled title={t("scm.pane.resizeHeight")}>
            <div
              data-slot="scm-resize-handle"
              className="group relative h-px shrink-0 cursor-row-resize bg-glass-hairline"
              onMouseDown={onResizeStart}
              onDoubleClick={() => setChangesH(null)}
            >
              <div className="absolute inset-x-0 -top-1 -bottom-1 z-10 group-hover:bg-primary/10" />
            </div>
          </Titled>

          {focusProject && (
            <CommitGraph
              key={`${focusProject.path}:${reloadKey}`}
              project={focusProject}
              width={size.w}
              viewAsTree={viewAsTree}
              onViewAsTree={setViewAsTree}
              onSelectCommit={onSelectCommit ?? defaultSelectCommit}
            />
          )}
        </div>
      )}
    </div>
  );
}
