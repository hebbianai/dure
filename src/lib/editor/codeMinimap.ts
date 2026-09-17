// 미니맵 기하 — 문서 라인 수와 스트립 높이만으로 레이아웃을 계산한다.
// DOM도 CodeMirror도 모르는 순수 모듈이라 vitest에서 그대로 검증한다
// (실제 캔버스/이벤트 배선은 codeMinimapExtension.ts).

/** 스트립 폭(px). 이 폭 안에 들어가는 열까지만 막대로 그린다. */
export const MINIMAP_WIDTH = 64;
/** 한 열이 차지하는 폭(px). MINIMAP_WIDTH / 이 값 = 표현 가능한 열 수. */
export const MINIMAP_COLUMN_WIDTH = 1;
/** 미니맵 한 줄의 최대 높이(px) — 짧은 파일이 과하게 성기게 보이지 않도록. */
export const MINIMAP_MAX_ROW_HEIGHT = 3;
/** 한 줄이 이보다 얇아지면 높이를 더 줄이는 대신 줄을 건너뛰며 샘플링한다. */
export const MINIMAP_MIN_ROW_HEIGHT = 1;
/** 뷰포트 상자가 이보다 얇아지면 잡을 수 없다. */
export const MINIMAP_MIN_VIEWPORT_HEIGHT = 4;
/** 탭 한 개가 차지하는 열 수 — 에디터의 indentUnit("  ")과 맞춘다. */
const MINIMAP_TAB_COLUMNS = 2;

export interface MinimapLayout {
  /** 막대 하나의 높이(px) */
  rowHeight: number;
  /** 몇 줄마다 하나씩 그리는지 (1이면 모든 줄) */
  step: number;
  /** 실제로 그리는 막대 수 */
  rowCount: number;
  /** 막대가 실제로 덮는 세로 길이(px) — 스트립보다 짧을 수 있다 */
  drawnHeight: number;
}

/** 문서 전체를 스트립 안에 담는 레이아웃. 줄이 많으면 먼저 막대를 얇게 하고,
 *  1px에 닿으면 그때부터 줄을 건너뛴다 — 100k줄짜리 파일에서도 문서 전체의
 *  모양이 한 화면에 남게 하려는 것이다(스크롤되는 미니맵은 위치 감각을 준다는
 *  본래 목적을 잃는다). */
export function minimapLayout(totalLines: number, stripHeight: number): MinimapLayout {
  const lines = Math.max(0, Math.floor(totalLines));
  const height = Math.max(0, stripHeight);
  if (lines === 0 || height === 0) {
    return { rowHeight: MINIMAP_MAX_ROW_HEIGHT, step: 1, rowCount: 0, drawnHeight: 0 };
  }
  const ideal = height / lines;
  if (ideal >= MINIMAP_MAX_ROW_HEIGHT) {
    const rowHeight = MINIMAP_MAX_ROW_HEIGHT;
    return { rowHeight, step: 1, rowCount: lines, drawnHeight: lines * rowHeight };
  }
  if (ideal >= MINIMAP_MIN_ROW_HEIGHT) {
    return { rowHeight: ideal, step: 1, rowCount: lines, drawnHeight: lines * ideal };
  }
  const step = Math.ceil((lines * MINIMAP_MIN_ROW_HEIGHT) / height);
  const rowCount = Math.ceil(lines / step);
  return {
    rowHeight: MINIMAP_MIN_ROW_HEIGHT,
    step,
    rowCount,
    drawnHeight: rowCount * MINIMAP_MIN_ROW_HEIGHT,
  };
}

export interface MinimapBar {
  /** 막대가 시작하는 열(들여쓰기 폭) */
  indent: number;
  /** 막대 길이(열) — 0이면 빈 줄이라 아무것도 그리지 않는다 */
  length: number;
}

/** 한 줄의 들여쓰기와 내용 길이. 미니맵은 글자를 그리지 않고 "코드가 어디에
 *  얼마나 있는지"만 보여주므로 이 둘이면 충분하다. */
export function minimapBar(text: string): MinimapBar {
  let indent = 0;
  let index = 0;
  for (; index < text.length; index++) {
    const ch = text[index];
    if (ch === " ") indent += 1;
    else if (ch === "\t") indent += MINIMAP_TAB_COLUMNS;
    else break;
  }
  // 뒤쪽 공백은 코드가 아니다 — 막대가 실제 내용보다 길어 보이지 않게 자른다.
  const trimmed = text.replace(/\s+$/, "");
  return { indent, length: Math.max(0, trimmed.length - index) };
}

export interface MinimapViewportInput {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  drawnHeight: number;
}

/** 에디터 스크롤 위치를 미니맵 좌표계의 상자로 옮긴다. 상자는 막대가 실제로
 *  덮는 범위(drawnHeight) 안에서만 움직인다 — 스트립 전체를 기준으로 잡으면
 *  짧은 파일에서 상자가 코드 아래 빈 공간까지 내려간다. */
export function minimapViewport(input: MinimapViewportInput): { top: number; height: number } {
  const { scrollTop, clientHeight, scrollHeight, drawnHeight } = input;
  if (drawnHeight <= 0 || scrollHeight <= 0) return { top: 0, height: 0 };
  if (clientHeight >= scrollHeight) return { top: 0, height: drawnHeight };
  const height = Math.max(
    MINIMAP_MIN_VIEWPORT_HEIGHT,
    (clientHeight / scrollHeight) * drawnHeight,
  );
  const maxTop = Math.max(0, drawnHeight - height);
  const top = (Math.max(0, scrollTop) / scrollHeight) * drawnHeight;
  return { top: Math.min(maxTop, top), height };
}

export interface MinimapScrollInput {
  /** 스트립 안에서의 포인터 y(px) */
  pointerY: number;
  drawnHeight: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 미니맵을 찍은 지점이 뷰포트 한가운데가 되도록 하는 에디터 scrollTop.
 *  가장자리에서는 문서 범위 밖으로 나가지 않게 잘라낸다. */
export function minimapScrollTop(input: MinimapScrollInput): number {
  const { pointerY, drawnHeight, scrollHeight, clientHeight } = input;
  if (drawnHeight <= 0) return 0;
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const fraction = Math.min(1, Math.max(0, pointerY / drawnHeight));
  const centered = fraction * scrollHeight - clientHeight / 2;
  return Math.min(maxScroll, Math.max(0, centered));
}

/** 그릴 막대들의 문서 라인 번호(0-based). step 샘플링을 한 곳에서만 풀어
 *  캔버스 그리기와 테스트가 같은 규칙을 쓰게 한다. */
export function minimapSampledLines(layout: MinimapLayout, totalLines: number): number[] {
  const lines: number[] = [];
  for (let i = 0; i < layout.rowCount; i++) {
    const line = i * layout.step;
    if (line >= totalLines) break;
    lines.push(line);
  }
  return lines;
}
