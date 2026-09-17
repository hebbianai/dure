import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store";
import {
  hasSplitContent,
  splitDiffRows,
  splitGutterWidth,
  splitWindow,
  type SplitCell,
  type SplitRow,
} from "@/lib/scm/diff/diffSplitView";
import {
  DEFAULT_TERMINAL_LINE_HEIGHT,
  terminalFontStack,
} from "@/lib/terminal/renderer/terminalFont";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const cellTone = (kind: SplitCell["kind"]) =>
  kind === "add"
    ? "bg-vcs-added/12"
    : kind === "del"
      ? "bg-vcs-deleted/12"
      : kind === "empty"
        ? "bg-muted/30"
        : "";

function Side({ cell, gutter }: { cell: SplitCell; gutter: number }) {
  return (
    <div className={cn("flex min-w-0", cellTone(cell.kind))}>
      <span
        className="shrink-0 select-none px-2 text-right text-muted-foreground/60 tabular-nums"
        style={{ width: `${gutter + 1}ch` }}
      >
        {cell.lineNumber ?? ""}
      </span>
      {/* Left and right rows must align 1:1, so horizontal scroll is used
          instead of wrapping (the 'Diff line wrap' setting belongs to the inline
          view). Hiding overflow here would keep the outer container from ever
          seeing it, so no scrollbar would appear at all — long lines would be
          clipped with no way to reach them. */}
      <pre className="whitespace-pre pr-4">{cell.text || " "}</pre>
    </div>
  );
}

function Row({ row, gutter }: { row: SplitRow; gutter: number }) {
  if (row.kind === "hunk") {
    return (
      <div className="col-span-3 bg-status-run/14 px-2 text-muted-foreground">
        <pre className="whitespace-pre">{row.label}</pre>
      </div>
    );
  }
  if (row.kind === "meta") {
    return (
      <div className="col-span-3 px-2 text-muted-foreground/70 opacity-80">
        <pre className="whitespace-pre">{row.label}</pre>
      </div>
    );
  }
  return (
    <>
      <Side cell={row.left} gutter={gutter} />
      <div className="w-px shrink-0 bg-border" />
      <Side cell={row.right} gutter={gutter} />
    </>
  );
}

/**
 * 나란히 보기 diff — 좌열 변경 전, 우열 변경 후. 행 배치와 창 계산은
 * diffSplitView.ts의 순수 로직이 정하고 여기서는 그리기만 한다.
 *
 * 행 높이가 고정이라 화면에 걸치는 행만 만들고 위아래는 스페이서로 채운다.
 * 전체 파일 diff는 수만 행이 되는데, 인라인 보기(CodeMirror)와 달리 여기엔
 * 가상화가 없으면 pane을 열 때마다 메인 스레드가 멈춘다 — content-visibility는
 * 그리기만 건너뛸 뿐 DOM은 그대로 만들기 때문에 그것만으로는 부족하다.
 */
export function SplitDiffView({ diffText }: { diffText: string }) {
  const fontSize = useStore((s) => s.terminalFontSize);
  const fontFamily = useStore((s) => s.uiPrefs?.terminalFontFamily ?? "");
  const lineHeight = useStore(
    (s) => s.uiPrefs?.terminalLineHeight ?? DEFAULT_TERMINAL_LINE_HEIGHT,
  );
  const rows = useMemo(() => splitDiffRows(diffText), [diffText]);
  const gutter = useMemo(() => splitGutterWidth(rows), [rows]);
  const rowHeight = Math.max(1, Math.round(fontSize * lineHeight));

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const measure = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    setViewportHeight(element.clientHeight);
  }, []);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  // 파일을 바꾸면 맨 위로 — 이전 파일의 스크롤 위치를 물려받으면 빈 화면이 뜬다.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [diffText]);

  const view = splitWindow({
    rowCount: rows.length,
    rowHeight,
    scrollTop,
    viewportHeight,
  });

  if (!hasSplitContent(rows)) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {t("scm.diff.noSideBySideChanges")}
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      className="h-full overflow-auto"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      style={{
        fontFamily: terminalFontStack(fontFamily),
        fontSize,
        lineHeight,
      }}
    >
      <div style={{ height: view.padTop }} />
      {/* One grid sizes both columns across the visible rows. Per-row widths
          move the divider and let long text overlap the other side. */}
      <div
        className="grid w-max min-w-full grid-cols-[1fr_1px_1fr]"
        style={{ gridAutoRows: rowHeight }}
      >
        {rows.slice(view.start, view.end).map((row, index) => (
          <Row key={view.start + index} row={row} gutter={gutter} />
        ))}
      </div>
      <div style={{ height: view.padBottom }} />
    </div>
  );
}
