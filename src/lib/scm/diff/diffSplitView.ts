// 나란히 보기(side-by-side) diff의 순수 로직 — unified diff를 좌/우 짝이 맞는
// 행으로 편다. 설정 › 일반 › 편집기 › 기본 차이점 보기가 이 뷰를 고른다.
// CodeMirror·DOM 없이 vitest로 검증 가능해야 한다 (diffReview.ts와 같은 규칙).

import { classifyDiffLine } from "@/lib/scm/diff/diffReview";

type SplitCellKind = "context" | "add" | "del" | "empty";

export interface SplitCell {
  /** 원본 파일 기준 줄 번호. 채움 행(empty)이면 null. */
  lineNumber: number | null;
  /** 접두(+/-/공백)를 뗀 본문. */
  text: string;
  kind: SplitCellKind;
}

type SplitRowKind = "hunk" | "meta" | "pair";

export interface SplitRow {
  kind: SplitRowKind;
  /** hunk·meta 행의 원문 (pair 행에서는 비어 있다). */
  label?: string;
  left: SplitCell;
  right: SplitCell;
}

const EMPTY_CELL: SplitCell = { lineNumber: null, text: "", kind: "empty" };

/** `@@ -12,7 +12,9 @@ …` 에서 좌/우 시작 줄 번호를 뽑는다.
 *  개수가 생략된 `@@ -1 +1 @@` 형태도 받는다. 해석에 실패하면 null. */
export function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

/** 삭제 줄 묶음과 추가 줄 묶음을 위에서부터 한 줄씩 맞물린다. 한쪽이 남으면
 *  반대쪽은 채움 행이 된다 — 이렇게 해야 좌우 행 수가 같아져서 두 열이
 *  같은 높이로 정렬된다(스크롤 동기화의 전제). */
function pairRuns(dels: SplitCell[], adds: SplitCell[]): SplitRow[] {
  const rows: SplitRow[] = [];
  const length = Math.max(dels.length, adds.length);
  for (let i = 0; i < length; i++) {
    rows.push({
      kind: "pair",
      left: dels[i] ?? EMPTY_CELL,
      right: adds[i] ?? EMPTY_CELL,
    });
  }
  return rows;
}

/**
 * unified diff 텍스트 → 좌우가 짝이 맞는 행 목록.
 *
 * 좌열은 변경 전, 우열은 변경 후다. 문맥 줄은 양쪽에 같은 내용으로 들어가고,
 * 삭제/추가 줄은 묶음 단위로 맞물린다. `\ No newline at end of file` 같은
 * 부가 줄은 diff 본문이 아니므로 meta 행으로 흘려보낸다.
 */
export function splitDiffRows(diffText: string): SplitRow[] {
  const rows: SplitRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];

  const flushRuns = () => {
    if (dels.length || adds.length) rows.push(...pairRuns(dels, adds));
    dels = [];
    adds = [];
  };

  for (const line of diffText.split("\n")) {
    const kind = classifyDiffLine(line);

    if (kind === "hunk") {
      flushRuns();
      const header = parseHunkHeader(line);
      inHunk = header !== null;
      oldLine = header?.oldStart ?? 0;
      newLine = header?.newStart ?? 0;
      rows.push({ kind: "hunk", label: line, left: EMPTY_CELL, right: EMPTY_CELL });
      continue;
    }

    // hunk 안의 "\ No newline at end of file"은 바로 앞 줄에 붙는 주석이지
    // 그 자체가 diff 본문이 아니다. 여기서 묶음을 닫으면 -old/+new 짝이
    // 갈라져 반쪽짜리 행 두 개와 전폭 배너가 사이에 끼어든다.
    if (inHunk && line.startsWith("\\")) continue;

    if (kind === "meta" || !inHunk) {
      flushRuns();
      // hunk 밖의 줄(파일 헤더·index·binary 안내)은 폭 전체를 쓰는 안내 행이다.
      if (line !== "" || rows.length > 0) {
        rows.push({ kind: "meta", label: line, left: EMPTY_CELL, right: EMPTY_CELL });
      }
      continue;
    }

    if (kind === "del") {
      dels.push({ lineNumber: oldLine++, text: line.slice(1), kind: "del" });
      continue;
    }
    if (kind === "add") {
      adds.push({ lineNumber: newLine++, text: line.slice(1), kind: "add" });
      continue;
    }

    // git 출력은 개행으로 끝나서 split("\n")의 마지막 원소가 빈 문자열이다.
    // 그걸 문맥 줄로 세면 모든 diff 끝에 번호 붙은 빈 행이 하나씩 생긴다.
    if (line === "") continue;

    // context — 앞선 삭제/추가 묶음을 닫고 양쪽에 같은 줄을 놓는다.
    flushRuns();
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      kind: "pair",
      left: { lineNumber: oldLine++, text, kind: "context" },
      right: { lineNumber: newLine++, text, kind: "context" },
    });
  }

  flushRuns();
  return rows;
}

/** 좌/우 열의 최대 줄 번호 자릿수 — 번호 칸 폭을 한 번만 계산하려고. */
export function splitGutterWidth(rows: readonly SplitRow[]): number {
  let max = 0;
  for (const row of rows) {
    max = Math.max(max, row.left.lineNumber ?? 0, row.right.lineNumber ?? 0);
  }
  return Math.max(2, String(max).length);
}

/** 나란히 보기가 실제로 보여줄 게 있는지 — 전부 meta뿐이면 안내를 대신 띄운다. */
export function hasSplitContent(rows: readonly SplitRow[]): boolean {
  return rows.some((row) => row.kind === "pair");
}

/** 가상 스크롤 창 — 화면에 걸치는 행만 그리고 위아래는 스페이서로 채운다. */
export interface SplitWindow {
  /** 그리기 시작할 행 인덱스 */
  start: number;
  /** 그리기를 끝낼 행 인덱스(미포함) */
  end: number;
  /** 위쪽 스페이서 높이(px) */
  padTop: number;
  /** 아래쪽 스페이서 높이(px) */
  padBottom: number;
}

/** 스크롤 위아래로 더 그려 두는 여유 행 수 — 빠르게 굴릴 때 빈 칸이 보이지 않게. */
const SPLIT_OVERSCAN = 20;

/**
 * 행 높이가 고정이라(모두 같은 글꼴·줄 높이) 산술만으로 창을 구할 수 있다.
 *
 * content-visibility는 그리기만 건너뛸 뿐 DOM은 그대로 만든다 — 2만 행이면
 * 노드가 십수만 개라 pane을 열 때마다 메인 스레드가 멈춘다. 그래서 실제로
 * 만드는 행 수를 화면 크기로 제한한다.
 */
export function splitWindow(input: {
  rowCount: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}): SplitWindow {
  const { rowCount, rowHeight } = input;
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const overscan = input.overscan ?? SPLIT_OVERSCAN;
  const viewport = Math.max(0, input.viewportHeight);
  const scrollTop = Math.min(Math.max(0, input.scrollTop), rowCount * rowHeight);
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewport / rowHeight) + overscan * 2;
  const end = Math.min(rowCount, first + Math.max(1, visible));
  return {
    start: first,
    end,
    padTop: first * rowHeight,
    padBottom: Math.max(0, (rowCount - end) * rowHeight),
  };
}
