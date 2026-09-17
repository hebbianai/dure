/**
 * 터미널(xterm)·코드 에디터가 공유하는 ANSI 팔레트 — 색의 단일 출처.
 *
 * xterm은 캔버스에 직접 그리므로 CSS 변수를 읽지 못한다. 그래서 UI 토큰
 * (index.css)과 달리 팔레트를 데이터로 들고, 해석된 다크 여부에 따라 골라
 * 쓴다. 이후 테마 시스템(외부 테마 템플릿 import)은 이 팔레트를 테마
 * 데이터로 갈아끼우는 방식으로 확장한다 — 모든 소비처(터미널·코드
 * 에디터)는 terminalPalette()를 거친다.
 */

export interface TerminalPalette {
  /** What the terminal canvas paints (terminalCanvasTheme) and what the host is
   *  seeded with as its default background (terminalDefaultColors).
   *
   *  It is also the tone every UI surface derives from (resolveTheme), which is
   *  what makes picking a scheme move the app and its terminals together —
   *  unless the theme pins `ui.background`, in which case that pinned value is
   *  the derivation anchor and this stays purely the terminal's surface. Only
   *  our own dark theme needs that split; see DARK_TERMINAL_PALETTE. */
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** 다크 팔레트 — "미드" 혼합: Tailwind 원값(base 400 / bright 300)에
 *  neutral-300(#d4d4d4)을 18% 섞는다. 비비드(0%)는 검은 배경에서 yellow와
 *  cyan이 형광으로 튀고, 소프트(35%)는 6색이 파스텔로 모여 red/brightRed와
 *  magenta/blue의 구분이 흐려진다. 18%는 그 형광기가 사라지는 첫 지점이면서
 *  나머지 10색은 거의 원값이라, 색별 예외 없이 한 비율로 끝난다.
 *  대비는 앵커(#0a0a0a) 기준 본문급 4.5:1 / 액센트 3:1을 만족한다 — 실제로
 *  칠하는 면(#242424)은 그보다 밝으므로 이 여유는 유지된다.
 *
 *  background is `glass/pane` (Figma 2355:50233 variable measurement), the
 *  surface the design draws the terminal body on. It is deliberately NOT the
 *  app's darkest tone: `dure-dark` pins `ui.background` to #0a0a0a, and the
 *  surface curve reproduces the design's own values from that anchor
 *  (t=0.146 → #242424 = this palette's background, t=0.199 → #2e2e2e =
 *  glass/header). Collapsing the two painted the terminal near-black
 *  (2026-09-01, corrected the next day against the Figma variables).
 *  ANSI black (SGR 30) is the one exception: it is intentionally a
 *  near-background slot. */
export const DARK_TERMINAL_PALETTE: TerminalPalette = {
  background: "#242424",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  selectionBackground: "#404040",
  black: "#171717",
  red: "#f18383",
  green: "#79dd86",
  yellow: "#f4ce38",
  blue: "#75adf4",
  magenta: "#c492f5",
  cyan: "#42d3e9",
  white: "#e5e5e5",
  brightBlack: "#737373",
  brightRed: "#fcb4b4",
  brightGreen: "#a7f5b1",
  brightYellow: "#fee668",
  brightBlue: "#a7cffe",
  brightMagenta: "#dfc1fe",
  brightCyan: "#82ecfa",
  brightWhite: "#fafafa",
};

/** 라이트 팔레트 — 같은 미드 규칙의 거울상이지만 혼합비는 neutral-600
 *  (#525252) 8%다. 검은 배경에서 탈채도는 차분함이 되지만 흰 배경에서
 *  같은 조작은 탁함이 되고, 어두운 색은 이미 명도로 대비를 확보하므로
 *  비율을 다크의 절반 이하로 둔다.
 *
 *  노랑만 예외로 hue를 앰버로 옮겼다(yellow #d97706 / brightYellow
 *  #af5e00). 노랑은 색상환에서 명도가 가장 높아 흰 배경에서 대비를 맞추려
 *  어둡게 내리면 노랑이 아니라 갈색으로 읽힌다 — Tailwind yellow-700조차
 *  올리브가 된다. base는 8% 혼합이 2.97:1로 액센트 기준에 미달해 15% 값을
 *  쓴다(3.2:1); 경고 라벨은 짧은 강조 텍스트라 액센트 3:1을 적용한다.
 *
 *  white 계열은 어둡게 둔다(VS Code Light+ 관례): SGR 37/97로 찍히는
 *  텍스트가 흰 배경에서 사라지지 않도록 white < brightBlack 순의 회색
 *  단계를 유지하고, brightWhite는 굵은 본문·제목이라 foreground와 같다. */
export const LIGHT_TERMINAL_PALETTE: TerminalPalette = {
  background: "#ffffff",
  foreground: "#171717",
  cursor: "#171717",
  selectionBackground: "#d4d4d4",
  black: "#0a0a0a",
  red: "#d12a2a",
  green: "#1a7c3f",
  yellow: "#d97706",
  blue: "#2961df",
  magenta: "#8e36de",
  cyan: "#13718b",
  white: "#525252",
  brightBlack: "#737373",
  brightRed: "#ae1d1d",
  brightGreen: "#186034",
  brightYellow: "#af5e00",
  brightBlue: "#1e4cca",
  brightMagenta: "#7823c1",
  brightCyan: "#165b6f",
  brightWhite: "#171717",
};

/** 해석된 다크 여부 → 사용할 팔레트 */
export function terminalPalette(isDark: boolean): TerminalPalette {
  return isDark ? DARK_TERMINAL_PALETTE : LIGHT_TERMINAL_PALETTE;
}
