/**
 * 터미널 팔레트에 맞춘 CodeMirror 에디터 테마 + 구문 강조 스타일.
 *
 * 언어 문법(문법 패키지)은 여기 없다 — codeLangLoader.ts가 열린 파일의 것만
 * 동적으로 가져온다(hebbian-frontend-75j). 이 모듈은 CodeMirror 코어만 쓰므로
 * 에디터 청크에 남아도 가볍다. 확장자 매핑은 codeLang.ts.
 */
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { TerminalPalette } from "@/lib/theme/terminalTheme";

// 터미널과 같은 팔레트(lib/terminalTheme 단일 출처)를 쓴다 — 같은 창에서
// 터미널과 에디터가 나란히 뜨므로 색이 다르면 눈에 띄게 튄다. 팔레트에
// 없는 에디터 전용 크롬(현재 줄·패널·경계선·매치 하이라이트)만 모드별로
// 따로 정의한다.
interface EditorChrome {
  gutterBorder: string;
  controlBorder: string;
  /** blue 계열 매치 하이라이트 알파 — 색 자체는 팔레트에서 파생 */
  selectionMatchAlpha: number;
  matchingBracketAlpha: number;
  /** 검색 마커는 팔레트가 아니라 "형광펜" 관례 — 어느 모드든 밝은 노랑 */
  searchMatch: string;
  searchMatchSelected: string;
}

const DARK_CHROME: EditorChrome = {
  gutterBorder: "rgba(255,255,255,0.06)",
  controlBorder: "rgba(255,255,255,0.1)",
  selectionMatchAlpha: 0.18,
  matchingBracketAlpha: 0.25,
  searchMatch: "rgba(250,204,21,0.25)",
  searchMatchSelected: "rgba(250,204,21,0.45)",
};

const LIGHT_CHROME: EditorChrome = {
  gutterBorder: "rgba(0,0,0,0.06)",
  controlBorder: "rgba(0,0,0,0.12)",
  selectionMatchAlpha: 0.14,
  matchingBracketAlpha: 0.2,
  searchMatch: "rgba(250,204,21,0.35)",
  searchMatchSelected: "rgba(250,204,21,0.6)",
};

/** #rrggbb + 알파 → rgba() — 매치 하이라이트를 팔레트 hex에서 파생해,
 *  테마 템플릿이 팔레트를 갈아끼워도 함께 따라가게 한다. */
function hexAlpha(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 불투명 크롬(현재 줄·패널·패널 입력)은 팔레트 bg→fg 축의 지점에서
 *  파생한다 — 기본 팔레트에서는 기존 상수(#141414·#1f1f1f / #f5f5f5·#ffffff)를
 *  그대로 재현하는 비율이고, 사용자 테마가 팔레트를 갈아끼우면 함께 따라간다
 *  (하드코딩 점검, 2026-07-31). 반 단계 스텝이라 선형 RGB 혼합으로 충분하다. */
export function mixHex(from: string, to: string, t: number): string {
  const channel = (i: number) => {
    const a = Number.parseInt(from.slice(i, i + 2), 16);
    const b = Number.parseInt(to.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** 주석/메타 — ANSI 슬롯에 없는 중간 회색. 흰/검정 배경 양쪽에서 읽힌다. */
const COMMENT_DIM = "#737373";

function makeEditorAppearance(P: TerminalPalette, dark: boolean): Extension {
  const chrome = dark ? DARK_CHROME : LIGHT_CHROME;
  // The editor sits on a pane that carries the user's surface alpha
  // (lib/theme/surfaceOpacity): its own background folds the same alpha in,
  // and the active-line wash is a foreground tint over whatever is behind
  // rather than an opaque near-background strip — at 100% both read exactly
  // as before (owner check 2026-09-09).
  const surface = `color-mix(in srgb, ${P.background} var(--surface-alpha, 100%), transparent)`;
  const activeLine = hexAlpha(P.foreground, 0.045);
  const panelInput = dark ? mixHex(P.background, P.foreground, 0.096) : P.background;
  const theme = EditorView.theme(
    {
      "&": { backgroundColor: surface, color: P.foreground, height: "100%" },
      // 글꼴(크기·글꼴군·줄높이)은 CodeEditor가 터미널 설정에서 가져와
      // 별도 칸막이로 넣는다 — 여기서 정하면 설정 변경을 못 따라간다.
      ".cm-content": { caretColor: P.cursor },
      "&.cm-focused": { outline: "none" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: P.cursor },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: P.selectionBackground,
      },
      ".cm-gutters": {
        backgroundColor: surface,
        color: P.brightBlack,
        border: "none",
        borderRight: `1px solid ${chrome.gutterBorder}`,
      },
      ".cm-activeLine": { backgroundColor: activeLine },
      ".cm-activeLineGutter": { backgroundColor: activeLine, color: P.foreground },
      ".cm-selectionMatch": { backgroundColor: hexAlpha(P.blue, chrome.selectionMatchAlpha) },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: hexAlpha(P.blue, chrome.matchingBracketAlpha),
        outline: "none",
      },
      ".cm-searchMatch": { backgroundColor: chrome.searchMatch },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: chrome.searchMatchSelected,
      },
      ".cm-panels": { backgroundColor: activeLine, color: P.foreground },
      ".cm-panels input, .cm-panels button": {
        backgroundColor: panelInput,
        color: P.foreground,
        border: `1px solid ${chrome.controlBorder}`,
        borderRadius: "3px",
        padding: "1px 4px",
      },
      ".cm-tooltip": {
        backgroundColor: panelInput,
        border: `1px solid ${chrome.controlBorder}`,
        color: P.foreground,
      },
    },
    { dark },
  );
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: P.magenta },
    { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: P.foreground },
    { tag: [t.function(t.variableName), t.labelName], color: P.blue },
    { tag: [t.constant(t.name), t.standard(t.name)], color: P.yellow },
    { tag: [t.definition(t.name), t.separator], color: P.foreground },
    {
      tag: [t.typeName, t.className, t.namespace, t.changed, t.annotation, t.self],
      color: P.cyan,
    },
    { tag: [t.number, t.bool, t.null, t.atom], color: P.yellow },
    { tag: [t.operator, t.operatorKeyword, t.escape], color: P.cyan },
    { tag: [t.string, t.special(t.string)], color: P.green },
    { tag: [t.regexp], color: P.red },
    { tag: [t.meta, t.comment], color: COMMENT_DIM, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.link, color: P.blue, textDecoration: "underline" },
    { tag: t.heading, fontWeight: "bold", color: P.blue },
    { tag: t.invalid, color: P.red },
  ]);
  return [theme, syntaxHighlighting(highlight)];
}

// 팔레트 객체(내장 상수·스킴 정의의 안정 참조)×모드당 한 번만 빌드해 재사용 —
// Compartment reconfigure가 같은 참조를 받으면 CodeMirror가 재계산을 건너뛴다.
// 모드를 키에 포함해, 같은 팔레트 객체가 다른 dark 플래그로 불려도 어긋난
// 크롬이 캐시되지 않는다.
const appearanceCache = new WeakMap<TerminalPalette, { dark?: Extension; light?: Extension }>();

/** 에디터 테마+문법 강조 한 벌 — CodeEditor가 Compartment로 갈아끼운다.
 *  팔레트는 활성 스킴의 것(useActiveTerminalPalette)을 넘긴다. */
export function editorAppearance(palette: TerminalPalette, dark: boolean): Extension {
  let slot = appearanceCache.get(palette);
  if (!slot) {
    slot = {};
    appearanceCache.set(palette, slot);
  }
  const mode = dark ? "dark" : "light";
  const appearance = slot[mode] ?? makeEditorAppearance(palette, dark);
  slot[mode] = appearance;
  return appearance;
}
