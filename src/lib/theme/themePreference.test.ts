// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useStore } from "@/store";
import { DEFAULT_SHELL_OPACITY } from "@/lib/theme/shellOpacity";
import { DARK_TERMINAL_PALETTE } from "@/lib/theme/terminalTheme";
import {
  currentTerminalDefaultColors,
  isDarkPreference,
  resolvedUiSurfaceColors,
  useRootDarkClass,
} from "@/lib/theme/themePreference";
import { THEME_STYLE_ELEMENT_ID } from "@/lib/theme/themeStyle";

describe("isDarkPreference", () => {
  it("dark/light는 시스템 상태와 무관", () => {
    expect(isDarkPreference("dark", false)).toBe(true);
    expect(isDarkPreference("dark", true)).toBe(true);
    expect(isDarkPreference("light", true)).toBe(false);
    expect(isDarkPreference("light", false)).toBe(false);
  });

  it("system은 OS 다크모드를 따른다", () => {
    expect(isDarkPreference("system", true)).toBe(true);
    expect(isDarkPreference("system", false)).toBe(false);
  });

  it("설정 없음(구버전 저장분)은 기존 기본값 dark 유지", () => {
    expect(isDarkPreference(undefined, false)).toBe(true);
  });
});

describe("currentTerminalDefaultColors", () => {
  afterEach(() => {
    useStore.setState({ customThemes: [] });
    useStore.getState().setUiPrefs({ theme: "dark", themeScheme: undefined });
    document.documentElement.classList.remove("dark");
  });

  it("uses the resolved terminal surface instead of the ANSI black slot", () => {
    useStore.setState({
      customThemes: [
        {
          id: "default-color-proof",
          name: "Default Color Proof",
          appearance: "dark",
          terminal: {
            ...DARK_TERMINAL_PALETTE,
            foreground: "#123456",
            background: "#654321",
            black: "#abcdef",
          },
          ui: { background: "#fedcba" },
        },
      ],
    });
    useStore.getState().setUiPrefs({
      theme: "dark",
      themeScheme: { dark: "default-color-proof" },
    });
    document.documentElement.classList.add("dark");

    expect(currentTerminalDefaultColors()).toEqual({
      foregroundRgb: 0x123456,
      backgroundRgb: 0x654321,
    });
  });
});

describe("resolvedUiSurfaceColors", () => {
  it("uses the CSS app-floor defaults when no colour scheme is selected", () => {
    expect(resolvedUiSurfaceColors(undefined, false, [])).toEqual({
      background: "#ffffff",
      foreground: "#171717",
    });
    expect(resolvedUiSurfaceColors(undefined, true, [])).toEqual({
      background: "#0d0d0d",
      foreground: "#fafafa",
    });
  });

  it("uses the active scheme's exact surface colours for native chrome", () => {
    const theme = {
      id: "native-caption-proof",
      name: "Native Caption Proof",
      appearance: "dark" as const,
      terminal: DARK_TERMINAL_PALETTE,
      ui: { background: "#102030", foreground: "#f0e0d0" },
    };

    expect(
      resolvedUiSurfaceColors({ dark: theme.id }, true, [theme]),
    ).toEqual({
      background: "#102030",
      foreground: "#f0e0d0",
    });
  });
});

describe("useRootDarkClass 셸 불투명도", () => {
  const root = () => document.documentElement;

  afterEach(() => {
    document.getElementById(THEME_STYLE_ELEMENT_ID)?.remove();
    root().style.removeProperty("--shell-tint-alpha-dark");
    root().style.removeProperty("--shell-tint-alpha-light");
    root().classList.remove("dark");
  });

  // The pair is fixed (the Settings sliders were pulled 2026-09-10) but still
  // lands as inline root vars, so the CSS alpha and resolveTheme's chroma gain
  // keep reading the same numbers.
  it("출하 값(다크 50 · 라이트 80)이 인라인 루트 변수로 반영된다", () => {
    renderHook(() => useRootDarkClass());
    expect(root().style.getPropertyValue("--shell-tint-alpha-dark")).toBe(
      `${DEFAULT_SHELL_OPACITY.dark}%`,
    );
    expect(root().style.getPropertyValue("--shell-tint-alpha-light")).toBe(
      `${DEFAULT_SHELL_OPACITY.light}%`,
    );
  });
});
