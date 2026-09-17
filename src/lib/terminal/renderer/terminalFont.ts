/**
 * 터미널 글꼴 스택. 터미널과 코드 에디터가 같은 설정(설정 › 외관 › 글꼴)을
 * 공유하도록 한 곳에 둔다 — 나란히 뜨는 pane이라 글자 크기·모양이 다르면
 * 바로 눈에 띈다.
 *
 * xterm을 import 하지 않는 가벼운 모듈이어야 한다. 에디터는 지연 로드되는
 * 별도 청크라, 여기서 TerminalView를 끌어오면 xterm이 딸려 들어간다.
 */
export const DEFAULT_TERM_FONT_STACK =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Apple SD Gothic Neo', AppleGothic, monospace";

/** 사용자가 고른 글꼴을 기본 스택 앞에 붙인다. 비어 있으면 기본 스택만. */
export function terminalFontStack(family: string): string {
  return family ? `'${family}', ${DEFAULT_TERM_FONT_STACK}` : DEFAULT_TERM_FONT_STACK;
}

/** Shared typography defaults for terminal and editor consumers. */
export const DEFAULT_TERMINAL_FONT_SIZE = 10.5;
export const DEFAULT_TERMINAL_LINE_HEIGHT = 1.5;
export const MIN_TERMINAL_LINE_HEIGHT = 1;
export const MAX_TERMINAL_LINE_HEIGHT = 2;
export const TERMINAL_LINE_HEIGHT_STEP = 0.05;

/** Normalize untrusted persisted/input values once before they enter UiPrefs. */
export function normalizeTerminalLineHeight(value: unknown): number {
  if (typeof value === "string" && value.trim() === "") {
    return DEFAULT_TERMINAL_LINE_HEIGHT;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return DEFAULT_TERMINAL_LINE_HEIGHT;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TERMINAL_LINE_HEIGHT;
  const stepped = Math.round(parsed / TERMINAL_LINE_HEIGHT_STEP) * TERMINAL_LINE_HEIGHT_STEP;
  return Math.min(
    MAX_TERMINAL_LINE_HEIGHT,
    Math.max(MIN_TERMINAL_LINE_HEIGHT, Number(stepped.toFixed(2))),
  );
}
