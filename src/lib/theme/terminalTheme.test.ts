import { describe, expect, it } from "vitest";
import {
  DARK_TERMINAL_PALETTE,
  LIGHT_TERMINAL_PALETTE,
  type TerminalPalette,
  terminalPalette,
} from "@/lib/theme/terminalTheme";

const HEX = /^#[0-9a-f]{6}$/;

/** WCAG 상대 휘도 → 대비비. 팔레트 심사 기준이 "몇 대 1"이라 여기서 실제로 잰다. */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** 배경 자신과 선택 배경은 텍스트가 아니다 — 대비 심사 대상에서 뺀다. */
const NON_TEXT_SLOTS = new Set(["background", "selectionBackground"]);

/** 액센트(3:1)로 심사하는 슬롯. 나머지 텍스트 슬롯은 본문급 4.5:1.
 *  - 다크 brightBlack: 접힌 줄 안내·힌트·경과 시간 등 보조 텍스트.
 *  - 라이트 yellow: 짧은 경고 라벨. 앰버로 옮긴 뒤에도 3.2:1. */
const ACCENT_SLOTS: Record<"dark" | "light", Set<string>> = {
  dark: new Set(["brightBlack"]),
  light: new Set(["yellow"]),
};

/** Dark ANSI black is a near-background surface slot, so exempt it from text
 *  contrast. Light black remains the darkest text against a white base. */
const EXEMPT_SLOTS: Record<"dark" | "light", Set<string>> = {
  dark: new Set(["black"]),
  light: new Set(),
};

describe("terminalPalette", () => {
  it("다크/라이트 선택", () => {
    expect(terminalPalette(true)).toBe(DARK_TERMINAL_PALETTE);
    expect(terminalPalette(false)).toBe(LIGHT_TERMINAL_PALETTE);
  });

  it("모든 슬롯이 6자리 hex — xterm ITheme과 외부 테마 포맷이 공유하는 형태", () => {
    for (const palette of [DARK_TERMINAL_PALETTE, LIGHT_TERMINAL_PALETTE]) {
      for (const [slot, color] of Object.entries(palette)) {
        expect(color, slot).toMatch(HEX);
      }
    }
  });

  it("두 팔레트는 같은 슬롯 집합을 가진다 — 테마 교체 시 누락 방지", () => {
    expect(Object.keys(LIGHT_TERMINAL_PALETTE).sort()).toEqual(
      Object.keys(DARK_TERMINAL_PALETTE).sort(),
    );
  });

  // 기본 테마의 단일 기준값(미드 팔레트). 다크는 원값 + neutral-300 18%,
  // 라이트는 원값 + neutral-600 8%(yellow만 15% + 앰버 hue)로 뽑았다.
  // 값을 바꾸려면 이 표부터 바꾼다 — 시안·Figma·구현이 여기서 가져간다.
  it("다크 확정값 — 미드 혼합 18%", () => {
    expect(DARK_TERMINAL_PALETTE).toEqual({
      // glass/pane (Figma 2355:50233) — the surface the design draws the
      // terminal body on, not the app's darkest anchor (#0a0a0a, pinned as
      // dure-dark's ui.background). See defaultTerminalSurface.test.ts.
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
    });
  });

  it("라이트 확정값 — 미드 혼합 8%, 노랑은 앰버", () => {
    expect(LIGHT_TERMINAL_PALETTE).toEqual({
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
    });
  });

  it("라이트는 어두운 전경/밝은 배경 — 다크의 반전이 실제로 일어났는지", () => {
    expect(LIGHT_TERMINAL_PALETTE.foreground).not.toBe(DARK_TERMINAL_PALETTE.foreground);
    expect(LIGHT_TERMINAL_PALETTE.background).toBe("#ffffff");
    expect(LIGHT_TERMINAL_PALETTE.foreground).toBe("#171717");
  });

  // 새 스킴을 심사할 때의 판정 기준을 코드로 고정한다 — 색을 손보다가 여기가
  // 무너지면 push 전에 잡힌다. 값이 아니라 기준선을 지키는 테스트다.
  describe.each([
    ["dark", DARK_TERMINAL_PALETTE],
    ["light", LIGHT_TERMINAL_PALETTE],
  ] as const)("%s 대비 기준", (mode, palette: TerminalPalette) => {
    const slots = Object.entries(palette).filter(
      ([slot]) => !NON_TEXT_SLOTS.has(slot) && !EXEMPT_SLOTS[mode].has(slot),
    );

    it.each(slots)("%s 는 배경 대비 기준을 넘는다", (slot, color) => {
      const ratio = contrastRatio(color, palette.background);
      const floor = ACCENT_SLOTS[mode].has(slot) ? 3 : 4.5;
      expect(ratio, `${slot} ${color} → ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(floor);
    });
  });

  it("keeps dark black as a near-background ANSI slot", () => {
    expect(
      contrastRatio(DARK_TERMINAL_PALETTE.black, DARK_TERMINAL_PALETTE.background),
    ).toBeLessThan(2);
  });
});
