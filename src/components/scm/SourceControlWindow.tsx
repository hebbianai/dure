// 소스 제어 별도 창 (hebbian-frontend-slds) — 사이드바 패널의 미러.
// 이동이 아니라 미러: 사이드바는 그대로 있고, 이 창은 독립 뷰다.
// 기본은 메인 창 포커스를 따라가는 follow(라이브 미러), 📌으로 현재 리포에
// 고정할 수 있다. DiffWindow(?diff=)와 같은 bare-root 창 문법.
// 파일 행 클릭 → 그 파일의 diff, 커밋 행 클릭 → 커밋 상세(메시지·stat·패치)를
// 아래 상세 영역에 보여준다 (사용자 요청).
import { Suspense, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Clock3, GitCommitHorizontal, Pin, PinOff, UserRound, X } from "lucide-react";
import { SourceControlPane } from "@/components/scm/SourceControlPane";
import { Titled } from "@/components/ui/tooltip";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { IconButton } from "@/components/ui/icon-button";
import { ActiveBranchFeed } from "@/components/scm/ActiveBranchFeed";
import {
  SecondaryWindowShell,
  useSecondaryWindowBoot,
} from "@/components/workspace/SecondaryWindowShell";
import { LazyCodeEditor } from "@/components/editor/LazyCodeEditor";
import { diffLineHighlight } from "@/lib/scm/diff/diffReviewExtensions";
import { useStore } from "@/store";
import {
  useBroadcastFocusCtx,
  type FocusCtxSnapshot,
} from "@/lib/scm/focusCtxBroadcast";
import { gitExec } from "@/lib/scm/history/git";
import {
  consumeFreshScmDetail,
  onScmDetail,
  type ScmDetailRequest,
} from "@/lib/scm/scmDetailRelay";
import { splitDiffSections } from "@/lib/scm/diff/diffSections";
import { copyTextToClipboard } from "@/lib/platform/clipboardWrite";
import type { Project } from "@/types";
import { t } from "@/lib/i18n";
import {
  clearMaintenanceLaneInterval,
  setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import { cn } from "@/lib/utils";

interface DetailTarget {
  kind: "file" | "commit";
  project: Project;
  /** file이면 경로, commit이면 해시 */
  ref: string;
}

/** stat·오류 등 diff 본문 밖 텍스트 렌더 — 본문은 HighlightedDiffBlock이 맡는다. */
function DiffText({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-[1.6] whitespace-pre">
      {text.split("\n").map((line, index) => (
        <div
          key={index}
          className={cn(
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-vcs-added/10 text-vcs-added"
              : line.startsWith("-") && !line.startsWith("---")
                ? "bg-vcs-deleted/10 text-vcs-deleted"
                : line.startsWith("@@")
                  ? "text-vcs-renamed"
                  : line.startsWith("diff ") || line.startsWith("index ")
                    ? "text-muted-foreground"
                    : undefined,
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/** diff 본문을 에디터 pane과 같은 CodeMirror 스택(파일 언어 구문 강조 +
 *  ± 라인 배경)으로 렌더. 내용 높이만큼 차지하고 긴 파일만 내부 스크롤. */
function HighlightedDiffBlock({ text, fileName }: { text: string; fileName: string }) {
  const fontSize = useStore((s) => s.terminalFontSize);
  const lineCount = useMemo(() => text.split("\n").length, [text]);
  // line-height 1.5(diff 읽기 모드) 기준 추정 — wrap된 긴 라인은 내부 스크롤로.
  const height = Math.min(lineCount * Math.ceil(fontSize * 1.5) + 14, 480);
  return (
    <div style={{ height }}>
      <Suspense
        fallback={<p className="px-3 py-2 text-xs text-muted-foreground">{t("common.editorLoading")}</p>}
      >
        <LazyCodeEditor
          value={text}
          fileName={fileName}
          diffDocument
          readOnly
          extraExtensions={diffLineHighlight}
        />
      </Suspense>
    </div>
  );
}

interface CommitMeta {
  hash: string;
  author: string;
  email: string;
  date: string;
  relDate: string;
  subject: string;
  body: string;
}

/** `%H%x1f%an%x1f%ae%x1f%ad%x1f%ar%x1f%s%x1f%b` 출력 파싱. */
function parseCommitMeta(out: string): CommitMeta | null {
  const parts = out.replace(/\n+$/, "").split("\x1f");
  if (parts.length < 6) return null;
  const [hash, author, email, date, relDate, subject, ...rest] = parts;
  return { hash, author, email, date, relDate, subject, body: rest.join("\x1f").trim() };
}

/** 커밋 메타데이터 카드 — 제목·본문·작성자·날짜·해시를 구조화해 보여준다. */
function CommitMetaCard({ meta }: { meta: CommitMeta }) {
  return (
    <div className="border-b px-3 py-2">
      <div className="text-[13px] leading-snug font-medium">{meta.subject}</div>
      {meta.body && (
        <pre className="mt-1 font-sans text-xs whitespace-pre-wrap text-muted-foreground">
          {meta.body}
        </pre>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1">
          <UserRound className="size-3 shrink-0" />
          <span className="truncate">
            {meta.author} <span className="opacity-70">&lt;{meta.email}&gt;</span>
          </span>
        </span>
        <Titled title={meta.relDate}>
          <span className="inline-flex items-center gap-1 font-mono">
            <Clock3 className="size-3 shrink-0" />
            {meta.date} · {meta.relDate}
          </span>
        </Titled>
        <Titled title={t("scm.commitDetail.copyFullHash", { hash: meta.hash })}>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 font-mono hover:bg-glass-tint-hover"
            onClick={() => void copyTextToClipboard(meta.hash)}
          >
            <GitCommitHorizontal className="size-3" />
            {meta.hash.slice(0, 10)}
          </button>
        </Titled>
      </div>
    </div>
  );
}

/** 파일별 접기/펼치기 섹션 — 커밋 상세에서 파일 단위로 다룬다(사용자 요청).
 *  파일 수가 많으면 기본 접힘으로 시작해 스크롤 폭주를 막는다. */
function DiffFileSection({ file, text, defaultOpen }: { file: string; text: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/60">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-glass-tint-hover"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <DisclosureChevron open={open} />
        <span className="min-w-0 truncate font-mono text-[11px] text-foreground">{file}</span>
      </button>
      {open && <HighlightedDiffBlock text={text} fileName={file} />}
    </div>
  );
}

/** diff 텍스트를 헤더 + 파일별 접이식 섹션으로 렌더. */
function SectionedDiff({ text, fallbackFile }: { text: string; fallbackFile?: string }) {
  const sections = splitDiffSections(text);
  const files = sections.filter((section) => section.file !== null);
  const defaultOpen = files.length <= 8;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {sections.map((section) =>
        section.file === null ? (
          fallbackFile && section.text.includes("@@") ? (
            <HighlightedDiffBlock key="header" text={section.text} fileName={fallbackFile} />
          ) : (
            <DiffText key="header" text={section.text} />
          )
        ) : (
          <DiffFileSection
            key={section.file}
            file={section.file}
            text={section.text}
            defaultOpen={defaultOpen}
          />
        ),
      )}
    </div>
  );
}

/** 상세 영역 — 선택된 파일 diff 또는 커밋 상세를 gitExec로 가져와 표시. */
function DetailArea({ target, onClose }: { target: DetailTarget; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [meta, setMeta] = useState<CommitMeta | null>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setMeta(null);
    if (target.kind === "commit") {
      // 메타(작성자·날짜·메시지)는 구조화 카드로, 패치는 stat+diff만 받는다.
      void gitExec(target.project, [
        "show",
        "--no-patch",
        "--date=format:%Y-%m-%d %H:%M",
        "--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%ar%x1f%s%x1f%b",
        target.ref,
      ]).then((r) => {
        if (!cancelled && r.code === 0) setMeta(parseCommitMeta(r.stdout));
      });
    }
    const args =
      target.kind === "file"
        ? ["diff", "HEAD", "--", target.ref]
        : ["show", "--format=", "--stat", "--patch", target.ref];
    void gitExec(target.project, args).then(async (r) => {
      if (cancelled) return;
      let out = r.code === 0 ? r.stdout : r.stderr || r.stdout;
      if (target.kind === "file" && r.code === 0 && !out.trim()) {
        // 추적 전(untracked) 파일 — HEAD와의 diff가 비므로 no-index로 내용 표시
        const untracked = await gitExec(target.project, [
          "diff",
          "--no-index",
          "--",
          "/dev/null",
          target.ref,
        ]);
        if (cancelled) return;
        out = untracked.stdout.trim() ? untracked.stdout : t("scm.status.noChanges");
      }
      setText(out || t("scm.status.noChanges"));
    });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const heading =
    target.kind === "file" ? target.ref : `${t("common.commit")} ${target.ref.slice(0, 12)}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {heading}
        </span>
        <IconButton title={t("common.close")} onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {text === null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {meta && <CommitMetaCard meta={meta} />}
          <SectionedDiff
            text={text}
            fallbackFile={target.kind === "file" ? target.ref : undefined}
          />
        </div>
      )}
    </div>
  );
}

export function SourceControlWindowRoot() {
  const followed = useBroadcastFocusCtx();
  const [pinned, setPinned] = useState<FocusCtxSnapshot | null>(null);
  const ctx = pinned ?? followed;
  // Shared secondary-window boot (dark class, language, keyboard focus,
  // store sync) — the native title follows the mirrored repo (taskbar /
  // window-switcher identity).
  const lang = useSecondaryWindowBoot(
    ctx ? `${t("common.sourceControl")} — ${ctx.label}` : t("common.sourceControl"),
  );
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  // 좌측 pane 폭 — 상세와 공간을 나눠 갖고, 경계 드래그로 조절(사용자 요청)
  const [paneWidth, setPaneWidth] = useState(340);
  const onDividerDown = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = paneWidth;
    const onMove = (move: MouseEvent) =>
      setPaneWidth(
        Math.min(Math.max(240, startWidth + move.clientX - startX), window.innerWidth - 280),
      );
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  // 같은 항목 재클릭 = 닫기 (토글 — 사용자 요청)
  const toggleDetail = (next: DetailTarget) =>
    setDetail((current) =>
      current &&
      current.kind === next.kind &&
      current.ref === next.ref &&
      current.project.path === next.project.path
        ? null
        : next,
    );

  // follow로 리포가 "바뀌면" 이전 리포의 상세는 무의미 — 닫는다. 최초 도착
  // (undefined → cwd)은 예외 — 사이드바 relay로 갓 열린 상세를 지우지 않기 위함.
  const previousCwdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = previousCwdRef.current;
    previousCwdRef.current = ctx?.cwd;
    if (previous !== undefined && previous !== ctx?.cwd) setDetail(null);
  }, [ctx?.cwd]);
  // 사이드바에서 넘어온 상세 요청 — 창 기동 직후 1회 소비 + 열려 있는 동안 실시간 수신.
  useEffect(() => {
    const apply = (request: ScmDetailRequest) =>
      setDetail({
        kind: request.kind,
        ref: request.ref,
        project: {
          id: `relay:${request.project.path}`,
          name: request.project.name,
          path: request.project.path,
          kind: request.project.kind as Project["kind"],
          sshHostId: request.project.sshHostId,
          isRepo: true,
        },
      });
    const initial = consumeFreshScmDetail();
    if (initial) apply(initial);
    return onScmDetail(apply);
  }, []);
  // 별도 창이 열려 있는 동안 60초 주기 fetch — --all 그래프에 remote 브랜치
  // 활동이 실시간 반영된다(사용자 요청). refs만 갱신하는 안전한 작업.
  const [fetchTick, setFetchTick] = useState(0);
  useEffect(() => {
    if (!ctx) return;
    const probe: Project = {
      id: `fetch:${ctx.cwd}`,
      name: "",
      path: ctx.cwd,
      kind: ctx.source,
      sshHostId: ctx.hostId,
      isRepo: true,
    };
    let cancelled = false;
    const run = () => {
      void gitExec(probe, ["fetch", "--quiet", "--prune"]).then((r) => {
        if (!cancelled && r.code === 0) setFetchTick((tick) => tick + 1);
      });
    };
    run();
    const timer = setMaintenanceLaneInterval(run, 60_000, "scm-auto-fetch");
    return () => {
      cancelled = true;
      clearMaintenanceLaneInterval(timer);
    };
  }, [ctx]);

  return (
    <SecondaryWindowShell key={lang} className="bg-glass-pane">
      <header
        className="flex h-9 shrink-0 items-center gap-2 border-b px-3"
        data-tauri-drag-region
      >
        <span className="min-w-0 truncate text-xs font-semibold">
          {ctx?.label ?? t("scm.window.noFocusedPanel")}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {pinned ? t("scm.window.pinnedToRepo") : t("scm.window.followsFocus")}
        </span>
        <IconButton
          className="shrink-0 hover:bg-glass-tint-hover"
          title={pinned ? t("scm.window.unpinTooltip") : t("scm.window.pinTooltip")}
          pressed={Boolean(pinned)}
          onClick={() => setPinned((current) => (current ? null : followed))}
          disabled={!pinned && !followed}
        >
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </IconButton>
      </header>
      {/* 상세는 오른쪽 컬럼(사용자 요청) — pane은 좌측 고정 폭으로 접힌다.
          pane 래퍼는 flex 컨테이너여야 높이 체인이 살아 스크롤이 된다. */}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn("flex min-h-0 flex-col", detail ? "shrink-0" : "flex-1")}
          style={detail ? { width: paneWidth } : undefined}
        >
          {/* 가장 활발한 브랜치 요약/피드 (l36t) — 커밋 클릭은 상세 재사용 */}
          {ctx && (
            <ActiveBranchFeed
              project={{
                id: `feed:${ctx.cwd}`,
                name: "",
                path: ctx.cwd,
                kind: ctx.source,
                sshHostId: ctx.hostId,
                isRepo: true,
              }}
              refreshSignal={fetchTick}
              onSelectCommit={(project, hash) =>
                toggleDetail({ kind: "commit", project, ref: hash })
              }
            />
          )}
          <SourceControlPane
            ctxOverride={ctx}
            refreshSignal={fetchTick}
            onSelectFile={(project, path) => toggleDetail({ kind: "file", project, ref: path })}
            onSelectCommit={(project, hash) => toggleDetail({ kind: "commit", project, ref: hash })}
          />
        </div>
        {detail && (
          <>
            {/* 세로 경계 — 드래그로 좌/우 폭 조절 */}
            <Titled title={t("scm.window.resizeWidth")}>
              <div
                className="group relative w-px shrink-0 cursor-col-resize bg-border"
                onMouseDown={onDividerDown}
              >
                <div className="absolute inset-y-0 -left-1 -right-1 z-10 group-hover:bg-primary/10" />
              </div>
            </Titled>
            <DetailArea target={detail} onClose={() => setDetail(null)} />
          </>
        )}
      </div>
    </SecondaryWindowShell>
  );
}
