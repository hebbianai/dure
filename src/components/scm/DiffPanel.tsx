import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DureLoader } from "@/components/ui/dure-loader";
import { Titled } from "@/components/ui/tooltip";
import type { IDockviewPanelProps } from "dockview-react";
import {
  Columns2,
  FileDiff,
  GitCommitHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Rows2,
  Send,
  X,} from "lucide-react";
import { vcsStatusTone } from "@/lib/scm/status/vcsStatusTone";
import {
  createDiffReviewTarget,
  diffReviewSnapshot,
  type ReviewSnapshotV1,
} from "@/lib/ipc";
import { clampPanelWidth, panelWidthCeiling } from "@/lib/workspace/panelResize";
import { statLabel, statTotals } from "@/lib/scm/diff/diffReview";
import { splitDiffSections } from "@/lib/scm/diff/diffSections";
import { diffLineHighlight } from "@/lib/scm/diff/diffReviewExtensions";
import { formatDiffComments, unsentComments } from "@/lib/scm/review/diffComments";
import { deliverAgentPrompt } from "@/lib/agents/agentDelivery";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import { type DiffReviewPanelParams, newDiffReviewId, resolveDiffReviewTarget } from "@/lib/scm/review/diffReviewTarget";
import { syncCurrentDiffReviewTargets } from "@/lib/scm/review/diffReviewRetention";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { LazyCodeEditor } from "@/components/editor/LazyCodeEditor";
import { SplitDiffView } from "@/components/scm/SplitDiffView";
import { usePaneFirstReveal } from "@/components/workspace/usePaneFirstReveal";
import { PanelStatus } from "@/components/common/PanelStatus";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  persistDiffFileListWidth,
  useDiffPanelState,
  useDiffReviewCommentsState,
} from "@/components/scm/useDiffPanelState";

/**
 * 읽기 전용 Diff Review pane — 로컬 worktree가 fork-point(기본 브랜치와의
 * merge-base) 대비 무엇을 바꿨는지 보여준다. 커밋 + 미커밋 + untracked 전부.
 * managed agent는 코멘트→프롬프트 회신도 제공하고 standalone은 읽기 전용이다.
 */
export function DiffPanel(props: IDockviewPanelProps<DiffReviewPanelParams>) {
  const parameterReviewId = props.params.reviewId;
  const fallbackReviewIdRef = useRef(parameterReviewId ?? newDiffReviewId());
  const reviewId = parameterReviewId ?? fallbackReviewIdRef.current;
  const legacyAgentId = props.params.agentId;
  const standaloneCwd = props.params.cwd;
  const {
    legacyAgent,
    project,
    storedListWidth,
    diffWordWrap,
    defaultDiffFileTree,
    defaultDiffView,
    markdownReviewNotes,
  } = useDiffPanelState(legacyAgentId);
  const target = useMemo(
    () => resolveDiffReviewTarget({ agentId: legacyAgentId, cwd: standaloneCwd }, legacyAgent),
    [legacyAgentId, standaloneCwd, legacyAgent],
  );
  const [snapshot, setSnapshot] = useState<ReviewSnapshotV1 | null>(null);
  const reviewTarget = snapshot?.target;
  const stat = snapshot?.review;
  const diffText = stat?.diff ?? "";
  const resolvedWorktreePath = stat?.worktreePath ?? "";
  const [selected, setSelected] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(storedListWidth);
  useEffect(() => setListWidth(storedListWidth), [storedListWidth]);
  // 파일 목록 표시 여부는 pane마다 따로 잡는다 — 설정은 "열 때의 기본값"이지
  // 이미 열린 pane을 되돌리는 값이 아니다(설정을 바꾸는 순간 보던 목록이
  // 사라지면 그게 더 놀랍다).
  const [showFileList, setShowFileList] = useState(defaultDiffFileTree === "shown");
  // 인라인/나란히도 같은 규칙 — 설정은 여는 시점의 기본값이고, pane 안에서는
  // 헤더 토글로 바꾼다.
  const [diffView, setDiffView] = useState(defaultDiffView);
  const listResizing = useRef(false);
  const listBounds = () => ({
    min: 160,
    max: panelWidthCeiling(typeof window === "undefined" ? 0 : window.innerWidth),
  });
  const startListResize = (event: React.MouseEvent) => {
    event.preventDefault();
    listResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (moved: MouseEvent) => {
      if (!listResizing.current) return;
      setListWidth(clampPanelWidth(moved.clientX, listBounds()));
    };
    const onUp = (moved: MouseEvent) => {
      listResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      persistDiffFileListWidth(clampPanelWidth(moved.clientX, listBounds()));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // 에디터 커서 라인 — 라인 앵커 코멘트(L{n}에 추가)의 앵커.
  const [cursorLine, setCursorLine] = useState(1);
  const feedbackAgentId =
    reviewTarget?.feedbackAgentId ??
    (!parameterReviewId && target.status === "ready" ? target.feedbackAgentId : undefined);
  const {
    agent,
    comments,
    addDiffComment,
    removeDiffComment,
    markDiffCommentsSent,
  } = useDiffReviewCommentsState(feedbackAgentId);

  const sourcePath = target.status === "ready" ? target.sourcePath : undefined;
  const sourceSessionId = props.params.sessionId ?? legacyAgent?.sessionId;
  const remote = project?.kind === "ssh";
  // 연속 새로고침의 순서 보장 — 늦게 도착한 이전 스냅샷이 최신을 덮지 않게.
  const refreshSeqRef = useRef(0);

  // pane-open 지연 계측: 마운트 → 에디터(lazy CodeMirror) 준비까지.
  const paneId = props.api.id;
  useEffect(() => {
    workspacePerformance.beginPaneOpen(paneId, "diff");
  }, [paneId]);
  const handleEditorReady = useCallback(() => {
    workspacePerformance.markPaneReady(paneId);
  }, [paneId]);

  // 나란히 보기는 lazy CodeMirror를 쓰지 않으므로 계측 완료 신호를 직접 낸다.
  // 반드시 beginPaneOpen effect보다 뒤에 선언해야 한다 — effect는 선언 순서대로
  // 돌기 때문에, 앞에 두면 샘플이 생기기 전에 불려 in-flight로 남는다.
  useEffect(() => {
    if (diffView === "split") workspacePerformance.markPaneReady(paneId);
  }, [diffView, paneId]);

  // 구버전 layout의 {agentId}/{cwd} pane에도 먼저 안정적인 id를 부여한다.
  // create 재시도나 StrictMode remount가 다른 durable review를 만들지 않는다.
  useEffect(() => {
    if (parameterReviewId) return;
    // Dockview는 이 메서드를 제공하지만, 단독 창이나 구버전 host의 최소
    // 어댑터에는 없을 수 있다. fallback ref만으로도 현재 창 수명은 안정적이다.
    if (typeof props.api.updateParameters !== "function") return;
    props.api.updateParameters({
      ...props.params,
      reviewId,
    });
  }, [parameterReviewId, props.api, props.params, reviewId]);

  const refresh = useCallback(async () => {
    if (remote) return;
    const seq = ++refreshSeqRef.current;
    setBusy(true);
    setError(null);
    try {
      const durableTarget = await createDiffReviewTarget({
        reviewId,
        path: sourcePath ?? "",
        sourceSessionId,
        feedbackAgentId: target.status === "ready" ? target.feedbackAgentId : undefined,
      });
      // The pane parameter and target creation can complete in either order.
      // A second complete-root reconciliation makes the resulting target
      // active once both durable halves exist.
      syncCurrentDiffReviewTargets();
      const snapshot = await diffReviewSnapshot(durableTarget.reviewId);
      if (seq !== refreshSeqRef.current) return;
      const rv = snapshot.review;
      setSnapshot(snapshot);
      // 사라진 파일을 가리키는 stale 선택은 전체 보기로 되돌린다.
      setSelected((prev) => (prev && rv.files.some((f) => f.path === prev) ? prev : null));
    } catch (e) {
      if (seq === refreshSeqRef.current) setError(String(e));
    } finally {
      if (seq === refreshSeqRef.current) setBusy(false);
    }
  }, [remote, reviewId, sourcePath, sourceSessionId, target]);

  // 명시적인 재-open은 새 reviewId를 부여한다. 이전 비동기 응답도 무효화해
  // 다른 review의 스냅샷이 잠깐 보이지 않게 한다.
  useEffect(() => {
    refreshSeqRef.current += 1;
    setSnapshot(null);
    setSelected(null);
    setError(null);
  }, [reviewId]);

  // 숨은 탭·오프스크린 데스크탑에서 마운트만으로 diff(index 사본 + merge-base
  // + full diff)를 만들지 않는다 — 첫 조회는 실제로 보일 때(P0-c).
  const revealed = usePaneFirstReveal(props.api);
  useEffect(() => {
    if (revealed) refresh();
  }, [revealed, refresh]);

  const sections = useMemo(
    () => new Map(splitDiffSections(diffText).filter((s) => s.file !== null).map((s) => [s.file, s.text])),
    [diffText],
  );
  const totals = useMemo(() => statTotals(stat?.files ?? []), [stat]);

  const list = comments ?? [];
  const pending = useMemo(() => unsentComments(list), [list]);

  const addComment = useCallback(() => {
    const body = draft.trim();
    if (!body || selected === null || !feedbackAgentId) return;
    addDiffComment({
      agentId: feedbackAgentId,
      filePath: selected,
      line: 0,
      body,
      now: Date.now(),
    });
    setDraft("");
  }, [draft, selected, feedbackAgentId, addDiffComment]);

  const sendComments = useCallback(async () => {
    if (!agent || pending.length === 0 || sending) return;
    const snapshot = pending.map((c) => ({ id: c.id, body: c.body }));
    const text = formatDiffComments(pending);
    setSending(true);
    setError(null);
    try {
      await deliverAgentPrompt(agent, text);
      // 전달된 시점의 본문과 아직 일치하는 코멘트만 sent 처리(전송 중 수정 대비).
      if (feedbackAgentId) markDiffCommentsSent(feedbackAgentId, snapshot, Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }, [agent, pending, sending, feedbackAgentId, markDiffCommentsSent]);

  if (!parameterReviewId && !reviewTarget && target.status === "missing-agent")
    return <div className="p-3 text-xs text-muted-foreground">{t("common.agentNotFound")}</div>;
  if (!parameterReviewId && !reviewTarget && target.status === "missing-path")
    return <div className="p-3 text-xs text-muted-foreground">{t("panels.diff.noWorkingDirectory")}</div>;
  if (remote)
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {t("panels.diff.localOnly")}
      </div>
    );

  const revisionLabel =
    reviewTarget?.headCommitSha.slice(0, 8) ?? (target.status === "ready" ? target.revisionLabel : "HEAD");
  const shownWorktreePath = reviewTarget?.worktreePath ?? sourcePath ?? "";
  const shownDiff = selected === null ? diffText : (sections.get(selected) ?? t("panels.diff.emptyFileDiff"));
  // diffDocument 모드가 파일 경계별 언어를 스스로 고른다 — 선택 파일은 경계
  // 없는 조각일 수 있어 fallback 언어 판별용으로 경로를 넘긴다.
  const syntaxFileName = selected ?? "review.diff";

  // 라인 앵커 코멘트 — 커서가 가리키는 diff 라인 번호와 그 내용을 스냅샷으로
  // 함께 저장한다 (코드가 움직여도 프롬프트는 리뷰 시점 인용을 유지).
  const addLineComment = () => {
    const body = draft.trim();
    if (!body || selected === null || !feedbackAgentId) return;
    const lineText = shownDiff.split("\n")[cursorLine - 1] ?? "";
    addDiffComment({
      agentId: feedbackAgentId,
      filePath: selected,
      line: cursorLine,
      lineText,
      body,
      now: Date.now(),
    });
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col bg-glass-pane">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2">
        <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-muted-foreground">
          {stat ? `${stat.baseRef} @ ${stat.mergeBase.slice(0, 8)} → ${revisionLabel}` : "…"}
        </span>
        <Titled title={resolvedWorktreePath || shownWorktreePath}>
          <span
            className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/70"
            aria-label={resolvedWorktreePath || shownWorktreePath}
          >
            {resolvedWorktreePath}
          </span>
        </Titled>
        <span className="ml-1 shrink-0 font-mono text-xs">
          <span className="text-vcs-added">+{totals.added}</span>{" "}
          <span className="text-vcs-deleted">−{totals.deleted}</span>
          {totals.binary > 0 && (
            <span className="text-muted-foreground"> · {totals.binary} BIN</span>
          )}
        </span>
        <IconButton
          className="ml-auto size-5 rounded hover:bg-accent"
          onClick={() => setDiffView((v) => (v === "inline" ? "split" : "inline"))}
          title={diffView === "inline" ? t("panels.diff.sideBySideView") : t("panels.diff.inlineView")}
          pressed={diffView === "split"}
        >
          {diffView === "inline" ? <Columns2 className="size-3.5" /> : <Rows2 className="size-3.5" />}
        </IconButton>
        <IconButton
          className="size-5 rounded hover:bg-accent"
          onClick={() => setShowFileList((v) => !v)}
          title={showFileList ? t("panels.diff.fileList.hide") : t("panels.diff.fileList.show")}
          pressed={showFileList}
        >
          {showFileList ? <PanelLeftClose className="size-3.5" /> : <PanelLeftOpen className="size-3.5" />}
        </IconButton>
        <IconButton
          className="size-5 rounded hover:bg-accent"
          onClick={refresh}
          title={t("common.refresh")}
          showTooltip={false}
        >
          {busy ? <DureLoader decorative /> : <RefreshCw className="size-3.5" />}
        </IconButton>
      </div>

      {error && (
        <pre className="shrink-0 overflow-auto border-b px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-destructive">
          {error}
        </pre>
      )}

      <div className="flex min-h-0 flex-1">
        {showFileList && (
        <div
          className="shrink-0 overflow-auto border-r py-1"
          style={{ width: listWidth }}
        >
          <button type="button"
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-xs hover:bg-accent",
              selected === null && "bg-accent",
            )}
            onClick={() => setSelected(null)}
          >
            <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {t("panels.diff.allFiles", { n: stat?.files.length ?? 0 })}
            </span>
          </button>
          {stat?.files.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t("panels.diff.noChangesVsBase")}
            </div>
          )}
          {stat?.files.map((f) => (
            <Titled key={f.path} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-xs hover:bg-accent",
                  selected === f.path && "bg-accent",
                )}
                onClick={() => setSelected(f.path)}
                aria-label={f.path}
              >
                <span className={cn("w-3 shrink-0", vcsStatusTone(f.status))}>{f.status}</span>
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="shrink-0 text-muted-foreground">{statLabel(f)}</span>
              </button>
            </Titled>
          ))}
        </div>
        )}

        {/* 목록과 본문 사이의 조절 손잡이. 스크롤 컨테이너 안이 아니라 형제로
            둔다 — 안에 두면 목록을 스크롤할 때 손잡이도 같이 밀려 올라간다. */}
        {showFileList && (
        <div
          className="panel-resize-handle w-1 shrink-0 cursor-col-resize bg-transparent"
          onMouseDown={startListResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("panels.diff.fileList.resize")}
          aria-valuenow={listWidth}
          aria-valuemin={160}
          aria-valuemax={listBounds().max}
        />
        )}

        <div className="min-w-0 flex-1">
          {diffView === "split" ? (
            <SplitDiffView diffText={shownDiff} />
          ) : (
            <Suspense
              fallback={
                <PanelStatus size="xs">{t("common.editorLoading")}</PanelStatus>
              }
            >
              <LazyCodeEditor
                value={shownDiff}
                fileName={syntaxFileName}
                diffDocument
                readOnly
                wordWrap={diffWordWrap}
                extraExtensions={diffLineHighlight}
                onCursor={(line) => setCursorLine(line)}
                onReady={handleEditorReady}
              />
            </Suspense>
          )}
        </div>
      </div>

      {/* 리뷰 코멘트 루프는 수신 agent binding이 있을 때만 제공한다. standalone
          worktree diff는 안전한 1차 범위에서 읽기 전용이다. */}
      {feedbackAgentId && agent && markdownReviewNotes && (
        <div className="shrink-0 border-t">
          {list.length > 0 && (
            <ul className="max-h-28 overflow-auto px-2 py-1">
              {list.map((c) => (
                <li key={c.id} className="flex items-start gap-1.5 py-0.5 text-[11px]">
                  <Titled title={c.sentAt ? t("panels.diff.comments.delivered") : t("panels.diff.comments.undelivered")}>
                    <span
                      className={cn(
                        "mt-0.5 size-1.5 shrink-0 rounded-full",
                        c.sentAt ? "bg-muted-foreground/40" : "bg-status-warn",
                      )}
                    />
                  </Titled>
                  <Titled title={c.filePath}>
                    <button type="button"
                      className="min-w-0 shrink-0 truncate font-mono text-muted-foreground underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 hover:text-foreground"
                      style={{ maxWidth: "9rem" }}
                      onClick={() => setSelected(c.filePath)}
                    >
                      {c.filePath.split("/").pop()}
                      {c.line > 0 ? `:L${c.line}` : ""}
                    </button>
                  </Titled>
                  <span className="min-w-0 flex-1 truncate">{c.body}</span>
                  <IconButton
                    className="size-5 shrink-0 hover:text-destructive"
                    onClick={() => removeDiffComment(feedbackAgentId, c.id)}
                    title={t("panels.diff.comments.delete")}
                  >
                    <X className="size-3" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-1.5 p-1.5">
            <Textarea
              className="min-h-8 flex-1 resize-none text-xs"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  addComment();
                }
              }}
              placeholder={
                selected === null
                  ? t("panels.diff.comments.selectFilePrompt")
                  : t("panels.diff.comments.placeholder", {
                      f: selected.split("/").pop() ?? "",
                    })
              }
              disabled={selected === null}
            />
            <Button type="button" size="xs" variant="outline"
              className="shrink-0"
              onClick={addComment}
              disabled={selected === null || draft.trim() === ""}
            >
              {t("common.add")}
            </Button>
            <Button type="button" size="xs" variant="outline"
              className="shrink-0"
              onClick={addLineComment}
              disabled={selected === null || draft.trim() === ""}
              title={t("panels.diff.comments.anchorHint")}
            >
              {t("panels.diff.comments.addAtLine", { n: cursorLine })}
            </Button>
            <Button type="button" size="xs"
              className="shrink-0"
              onClick={sendComments}
              disabled={pending.length === 0 || sending}
              title={t("panels.diff.comments.sendUndeliveredHint")}
            >
              {sending ? <DureLoader decorative /> : <Send />}
              {t("panels.diff.comments.send", { n: pending.length })}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
