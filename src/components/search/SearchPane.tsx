import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { Titled } from "@/components/ui/tooltip";
import { useEffect, useState } from "react";
import { DureLoader } from "@/components/ui/dure-loader";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import {
  CaseSensitive,
  CaseLower,
  CaseUpper,
  ChevronRight,
  File,
  Loader,
  MoreHorizontal,
  ReplaceAll,
  TriangleAlert,
} from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { saveTempFile } from "@/lib/ipc";
import { openFileViewer } from "@/lib/files/fileViewerPane";
import { SectionHeaderRow, sidebarLabelTone } from "@/components/sidebar/SidebarItems";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { ErrorText } from "@/components/ui/error-text";
import { IconButton } from "@/components/ui/icon-button";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import { bytesToBase64 } from "@/lib/platform/base64";
import {
  buildWorkspaceSearchMarkdown,
  MAX_WORKSPACE_SEARCH_LINES,
} from "@/lib/search/workspaceSearch";
import { SEARCH_FIELD_SURFACE_WITHIN, SEARCH_FIELD_TEXT } from "@/lib/ui/searchField";
import { useWorkspaceSearch } from "@/components/search/useWorkspaceSearch";
import type { WorkspaceReplacement } from "@/lib/search/workspaceSearchController";
import { useSearchPaneState } from "@/components/search/useSearchPaneState";

/** 매치 부분을 bg-accent로 강조 (Figma Emphasis/Item) */
function highlight(text: string, q: string, cs: boolean): React.ReactNode {
  if (!q) return text;
  const hay = cs ? text : text.toLowerCase();
  const needle = cs ? q : q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  for (;;) {
    const idx = hay.indexOf(needle, i);
    if (idx < 0) break;
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      // 라인 높이(16px)를 꽉 채우는 사각 박스 (Figma Emphasis/Item).
      // 앱 --accent(≈#2b2b2b)는 시안 강조(#404040)보다 어두워 히트가 묻힌다.
      // foreground/20이 그 밝기를 내면서 라이트 모드에서도 뒤집힌다 —
      // neutral-700로 박아두면 흰 배경에 검은 블록이 얹혀 글자가 사라졌다.
      <span key={idx} className="inline-block h-4 bg-foreground/20 align-top">
        {text.slice(idx, idx + needle.length)}
      </span>,
    );
    i = idx + needle.length;
  }
  if (!parts.length) return text;
  parts.push(text.slice(i));
  return parts;
}

/** Search, replacement, and filter fields leave room for shared icon controls. */
function BoxInput({
  value,
  placeholder,
  onChange,
  onEnter,
  onEscape,
  autoFocus,
  actions,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  onEscape?: () => void;
  autoFocus?: boolean;
  actions?: React.ReactNode;
}) {
  return (
    <div className={cn("flex h-8 w-full min-w-0 items-center gap-1 rounded-md border px-2 transition-[color,box-shadow]", SEARCH_FIELD_SURFACE_WITHIN)}>
      <input
        className={cn("h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground", SEARCH_FIELD_TEXT)}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter?.();
          if (e.key === "Escape") onEscape?.();
        }}
      />
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

/** 필터 섹션 타이틀 (11px medium muted) — Figma Sidebar item title */
function FilterTitle({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="group/label flex h-6 items-center justify-between pr-3 pl-4">
      <span className={cn("text-meta leading-4 font-medium", sidebarLabelTone())}>{label}</span>
      {action}
    </div>
  );
}

/** 검색 탭 (Figma 205-4504 · 205-4571 · 210-4671)
 *  — 포커스한 패널의 작업 폴더에서 grep, perl로 일괄 바꾸기 */
export function SearchPane() {
  const { currentSpaceId, focus } = useSearchPaneState();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const search = useWorkspaceSearch(focus);
  const { snapshot, error } = search;
  const groups = snapshot?.result.groups ?? null;
  const truncated = snapshot?.result.truncated ?? false;
  const lastQuery = snapshot?.input.query ?? "";
  const lastCs = snapshot?.input.caseSensitive ?? false;
  const busy = search.phase === "searching";
  const replacing = search.phase === "replacing";
  const notice = search.replacedFiles === null ? null : t("search.replace.completed", { n: search.replacedFiles });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => setCollapsed(new Set()), [snapshot]);
  // 바꾸기 (셰브런 토글)
  const [showReplace, setShowReplace] = useState(false);
  const [replaceText, setReplaceText] = useState("");
  const [preserveCase, setPreserveCase] = useState(false);
  /** Replace-all armed for in-place confirmation (SOUL §6). */
  const [replacement, setReplacement] = useState<WorkspaceReplacement | null>(null);
  const confirmingReplaceAll = replacement?.snapshot === snapshot && replacement !== null && search.phase === "idle";
  const armReplacement = () => {
    if (snapshot && groups?.length && search.phase === "idle") {
      setReplacement({ snapshot, replacement: replaceText, preserveCase });
    }
  };
  // 포함/제외 파일 (점세개 토글)
  const [showFilters, setShowFilters] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("");
  const [excludeGlob, setExcludeGlob] = useState("");
  const run = (opts?: { cs?: boolean; ww?: boolean }) => search.controller.search({
    query,
    caseSensitive: opts?.cs ?? caseSensitive,
    wholeWord: opts?.ww ?? wholeWord,
    includeGlob,
    excludeGlob,
  });

  const clear = () => {
    setQuery("");
    search.controller.clear();
  };

  const openMatch = (file: string) => {
    if (!snapshot) return;
    openFileViewer(currentSpaceId(), {
      path: `${snapshot.target.cwd.replace(/\/+$/, "")}/${file}`,
      source: snapshot.target.source,
      hostId: snapshot.target.hostId,
    });
  };

  const total = groups?.reduce((n, g) => n + g.matches.length, 0) ?? 0;

  /** 결과를 마크다운으로 임시 파일에 써서 파일 뷰어로 연다 */
  const openInEditor = async () => {
    if (!snapshot || !groups?.length) return;
    const markdown = buildWorkspaceSearchMarkdown({
      title: t("search.pane.title"),
      query: lastQuery,
      cwd: snapshot.target.cwd,
      groups,
    });
    try {
      const path = await saveTempFile({
        dataB64: bytesToBase64(new TextEncoder().encode(markdown)),
        fileName: "search-results.md",
      });
      openFileViewer(currentSpaceId(), { path, source: "local" });
    } catch (e) {
      search.controller.reportError(snapshot, e);
    }
  };

  const ellipsisBtn = (
    // Pixel-preserving overrides: glass hover without text brighten, 12px glyph.
    <IconButton
      className="hover:bg-glass-tint-hover hover:text-muted-foreground [&_svg]:size-3"
      title={t("search.filters.toggleTitle")}
      onClick={() => setShowFilters(!showFilters)}
    >
      <MoreHorizontal />
    </IconButton>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5">
      <SectionHeaderRow as="h2" label={t("search.pane.title")} />

      {/* 바꾸기 토글 + 검색 인풋 (Aa · ab · 로더) [+ 바꾸기 인풋] */}
      <div className="flex items-start gap-1.5 px-3 pt-2 pb-1.5">
        <Titled title={t("search.replace.action")}>
          <button type="button"
            className="flex h-8 w-5 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80"
            aria-label={t("search.replace.action")}
            onClick={() => setShowReplace(!showReplace)}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", showReplace && "rotate-90")}
            />
          </button>
        </Titled>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <BoxInput
            value={query}
            placeholder={t("search.pane.title")}
            onChange={(v) => {
              setQuery(v);
              // 키워드를 지우면 이전 결과("결과 없음" 포함)도 치운다
              if (!v.trim()) {
                search.controller.clear();
              }
            }}
            onEnter={() => void run()}
            onEscape={clear}
            actions={
              <>
                <IconButton
                  pressed={caseSensitive}
                  title={t("search.options.matchCase")}
                  onClick={() => {
                    setCaseSensitive(!caseSensitive);
                    void run({ cs: !caseSensitive });
                  }}
                >
                  <CaseSensitive />
                </IconButton>
                <IconButton
                  pressed={wholeWord}
                  title={t("search.options.wholeWord")}
                  onClick={() => {
                    setWholeWord(!wholeWord);
                    void run({ ww: !wholeWord });
                  }}
                >
                  <CaseLower />
                </IconButton>
                {/* The mark holds its slot while idle so the row does not
                    shift; it moves only while a search runs. */}
                {busy ? (
                  <DureLoader decorative className="text-muted-foreground" />
                ) : (
                  <Loader className="size-3 text-muted-foreground" />
                )}
              </>
            }
          />
          {showReplace && confirmingReplaceAll && (
            <InlineConfirmRow
              question={t("search.replace.confirmAll", {
                n: groups?.length ?? 0,
                q: replacement?.snapshot.input.query ?? "",
                r: replacement?.replacement ?? "",
              })}
              confirmLabel={t("search.replace.action")}
              busy={replacing}
              onConfirm={() => {
                setReplacement(null);
                if (replacement) void search.controller.replace(replacement);
              }}
              onCancel={() => setReplacement(null)}
            />
          )}
          {showReplace && !confirmingReplaceAll && (
            <div className="flex w-full items-center gap-1">
              <div className="min-w-0 flex-1">
              <BoxInput
                value={replaceText}
                placeholder={t("search.replace.action")}
                onChange={setReplaceText}
                onEnter={armReplacement}
                onEscape={() => setShowReplace(false)}
                autoFocus
                actions={
                  <>
                    <IconButton
                      pressed={preserveCase}
                      title={t("search.replace.preserveCase")}
                      onClick={() => setPreserveCase(!preserveCase)}
                    >
                      <CaseUpper />
                    </IconButton>
                    {replacing && (
                      <DureLoader decorative className="text-muted-foreground" />
                    )}
                  </>
                }
              />
              </div>
              <Titled title={t("search.replace.all")}>
                <button type="button"
                  className="flex shrink-0 items-center px-2 py-1.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  disabled={!groups?.length || search.phase !== "idle"}
                  aria-label={t("search.replace.all")}
                  onClick={armReplacement}
                >
                  <ReplaceAll className="size-3" />
                </button>
              </Titled>
            </div>
          )}
        </div>
      </div>

      {/* 포함/제외 파일 — 점세개로 토글 (Figma 210-4671) */}
      {showFilters ? (
        <>
          <FilterTitle label={t("search.filters.includeLabel")} action={ellipsisBtn} />
          <div className="px-3">
            <BoxInput
              value={includeGlob}
              placeholder={t("search.filters.includePlaceholder")}
              onChange={setIncludeGlob}
              onEnter={() => void run()}
              autoFocus
            />
          </div>
          <div className="pt-1">
            <FilterTitle label={t("search.filters.excludeLabel")} />
          </div>
          <div className="px-3 pb-1.5">
            <BoxInput
              value={excludeGlob}
              placeholder={t("search.filters.excludePlaceholder")}
              onChange={setExcludeGlob}
              onEnter={() => void run()}
            />
          </div>
        </>
      ) : (
        <div className="flex h-6 shrink-0 items-center justify-end pr-3 pl-4">{ellipsisBtn}</div>
      )}

      {/* 컨트롤과 결과 구분선 (Figma 217-4192) — 검색한 뒤에만 */}
      {(groups !== null || error) && (
        <div className="mt-1.5 h-px w-full shrink-0 bg-glass-hairline" />
      )}

      {/* 결과 요약(고정) — 목록만 스크롤 (Figma 217-4193) */}
      <div className="shrink-0">
        {!focus && (
          <div className="px-4 py-2 text-xs text-muted-foreground">
            {t("search.pane.selectPanelHint")}
          </div>
        )}
        {error && <ErrorText className="px-4 py-2 break-all">{error}</ErrorText>}
        {notice && !error && (
          <div className="px-4 pt-2 text-meta leading-4 text-muted-foreground">{notice}</div>
        )}
        {groups && !error && (
          // 인라인 텍스트 한 흐름으로 — 좁아지면 전체가 글자 단위로 줄바꿈
          <div className="px-4 py-2 text-meta leading-4 break-all text-muted-foreground">
            {total ? (
              <>
                <span className="font-semibold text-foreground">{groups.length}</span>
                {t("search.results.fileCountSuffix")}{" "}
                <span className="font-semibold text-foreground">{total}</span>
                {t("search.results.countSuffix")}
                {" · "}
                <button type="button"
                  className="inline border-b border-muted-foreground text-left break-all text-muted-foreground hover:text-foreground"
                  onClick={() => void openInEditor()}
                >
                  {t("search.results.openInEditor")}
                </button>
              </>
            ) : (
              <span>{t("common.noResults")}</span>
            )}
          </div>
        )}
        {/* 잘림 경고 (Figma 217-10665): 앰버 삼각형 + 안내.
            두 문장을 한 인라인 흐름으로 — 넓으면 문장 단위 두 줄, 좁으면 이어서 글자 단위 줄바꿈 */}
        {truncated && groups && !error && (
          <div className="px-4 pb-2 text-meta leading-4 break-all text-muted-foreground">
            <TriangleAlert className="mr-[5px] inline size-3 align-[-2px] text-status-warn" />
            {t("common.topResultsOnly", { n: MAX_WORKSPACE_SEARCH_LINES })}{" "}
            {t("search.results.refineHint")}
          </div>
        )}
      </div>
      <SidebarScrollArea edgeFade className="min-h-0 flex-1" viewportClassName="pb-3">
        <div className="px-1.5 pt-0.5">
          {groups?.map((g) => {
            const isCollapsed = collapsed.has(g.file);
            const base = g.file.split("/").pop() ?? g.file;
            const dir = g.file.slice(0, g.file.length - base.length).replace(/\/$/, "");
            return (
              <div key={g.file}>
                {/* 파일 그룹 행 — Search/File/Item (h-24) */}
                <button type="button"
                  className="flex h-6 w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-xs leading-none hover:bg-glass-tint-hover"
                  onClick={() => {
                    const next = new Set(collapsed);
                    if (isCollapsed) next.delete(g.file);
                    else next.add(g.file);
                    setCollapsed(next);
                  }}
                >
                  <DisclosureChevron open={!isCollapsed} />
                  <File className="size-3 shrink-0 text-muted-foreground" />
                  <OverflowRevealText className="text-sidebar-foreground" text={base} />
                  {dir && (
                    <OverflowRevealText className="min-w-0 flex-1 text-muted-foreground" text={dir} />
                  )}
                  <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-secondary px-1 text-center text-[10px] leading-4 font-semibold text-secondary-foreground">
                    {g.matches.length}
                  </span>
                </button>
                {/* 펼치면 첫 자식으로 파일 행(이름+경로) — Figma Search/File/Item/File */}
                {!isCollapsed && (
                  <button type="button"
                    className="flex h-6 w-full items-center gap-1.5 rounded-[6px] py-1 pr-2 pl-11 text-left text-xs leading-none hover:bg-glass-tint-hover"
                    onClick={() => openMatch(g.file)}
                  >
                    <OverflowRevealText className="max-w-[50%] text-sidebar-foreground" text={base} />
                    <OverflowRevealText className="min-w-0 flex-1 text-muted-foreground" text={g.file} />
                  </button>
                )}
                {/* 매치 행 — 라인 텍스트에 검색어 하이라이트 (bg-accent) */}
                {!isCollapsed &&
                  g.matches.map((m, i) => (
                    <button type="button"
                      key={`${m.line}:${i}`}
                      data-match={`${g.file}:${m.line}`}
                      className="flex h-6 w-full items-center rounded-[6px] py-1 pr-2 pl-11 text-left hover:bg-glass-tint-hover"
                      onClick={() => openMatch(g.file)}
                    >
                      <OverflowRevealText text={m.text} className="flex-1 text-xs leading-4 text-foreground">
                        {highlight(m.text, lastQuery, lastCs)}
                      </OverflowRevealText>
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      </SidebarScrollArea>
    </div>
  );
}
