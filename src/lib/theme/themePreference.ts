import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useStore, type UiPrefs } from "@/store";
import { terminalPalette, type TerminalPalette } from "@/lib/theme/terminalTheme";
import { resolveTheme } from "@/lib/theme/resolveTheme";
import { resolveDarkAppearance } from "@/lib/theme/themeAppearance";
import { DEFAULT_SHELL_OPACITY } from "@/lib/theme/shellOpacity";
import { SURFACE_OPACITY } from "@/lib/theme/surfaceOpacity";
import type { ThemeDefinition } from "@/lib/theme/themeDefinition";
import { themeById } from "@/lib/theme/themeRegistry";
import { applyThemeStyle, buildThemeCss } from "@/lib/theme/themeStyle";
import {
  terminalDefaultColors,
  type TerminalDefaultColors,
} from "@/lib/terminal/state/terminalDefaultColors";

export type ThemePreference = UiPrefs["theme"];

/** 외관 설정의 테마 + 시스템 다크 여부 → 실제 다크 여부 (순수 로직).
 *  규칙 자체는 themeAppearance.ts에 있다 — 부팅 스플래시가 스토어 없이 같은
 *  답을 내야 해서 그쪽이 정본이고, 여기는 타입을 좁힌 래퍼다. */
export function isDarkPreference(
  theme: ThemePreference | undefined,
  systemDark: boolean,
): boolean {
  return resolveDarkAppearance(theme, systemDark);
}

function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

/** 외관 설정의 테마를 실제 다크 여부로 해석 — system은 OS 다크모드를 따르고
 *  변경(라이트↔다크 전환)에도 반응한다. */
export function useResolvedDark(): boolean {
  const theme = useStore((s) => s.uiPrefs?.theme);
  const [sysDark, setSysDark] = useState(systemPrefersDark);
  useEffect(() => {
    const m = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!m) return;
    const on = () => setSysDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return isDarkPreference(theme, sysDark);
}

/** 해석된 다크 여부에 맞는 활성 스킴 정의 — 커스텀(유저 가져오기)을 내장·
 *  번들보다 먼저 찾는다(같은 id 충돌은 store가 가져오기 시점에 막지만,
 *  구버전 persist 잔재에 대한 방어). 모르는 id, appearance 불일치는
 *  undefined(기본 룩 fallback). */
function activeSchemeDefinition(
  themeScheme: UiPrefs["themeScheme"],
  isDark: boolean,
  customThemes: readonly ThemeDefinition[],
) {
  const id = themeScheme?.[isDark ? "dark" : "light"];
  const definition = customThemes.find((theme) => theme.id === id) ?? themeById(id);
  if (!definition) return undefined;
  return definition.appearance === (isDark ? "dark" : "light") ? definition : undefined;
}

export interface UiSurfaceColors {
  background: string;
  foreground: string;
}

/** The exact opaque app floor and its text colour. These defaults mirror the
 * --background/--foreground values in index.css; selected schemes already
 * resolve to six-digit hex through resolveTheme. */
export function resolvedUiSurfaceColors(
  themeScheme: UiPrefs["themeScheme"],
  isDark: boolean,
  customThemes: readonly ThemeDefinition[],
): UiSurfaceColors {
  const definition = activeSchemeDefinition(themeScheme, isDark, customThemes);
  if (definition) {
    const { background, foreground } = resolveTheme(definition).ui;
    return { background, foreground };
  }
  return isDark
    ? { background: "#0d0d0d", foreground: "#fafafa" }
    : { background: "#ffffff", foreground: "#171717" };
}

/** Reactive colours used by native window chrome outside the webview. */
export function useResolvedUiSurfaceColors(): UiSurfaceColors {
  const isDark = useResolvedDark();
  const themeScheme = useStore((state) => state.uiPrefs?.themeScheme);
  const customThemes = useStore((state) => state.customThemes);
  return useMemo(
    () => resolvedUiSurfaceColors(themeScheme, isDark, customThemes),
    [themeScheme, isDark, customThemes],
  );
}

/** 해석된 다크 여부를 <html>의 .dark 클래스로 반영하고, 선택된 컬러 스킴을
 *  관리형 <style>로 주입한다 — 각 창(웹뷰) 루트에서 한 번 호출한다. Radix
 *  포털은 body 바로 아래에 렌더돼 App 루트 div의 클래스가 닿지 않으므로,
 *  documentElement 한 곳에 걸어 창 전체(포털 포함)가 같은 소스에서 테마를
 *  받게 한다. useLayoutEffect라 첫 페인트 전에 붙는다.
 *  값을 읽고 싶으면 useResolvedDark를 쓴다 — 이 훅은 루트 부수효과 전용. */
export function useRootDarkClass(): void {
  const isDark = useResolvedDark();
  const themeScheme = useStore((s) => s.uiPrefs?.themeScheme);
  const customThemes = useStore((s) => s.customThemes);
  const surfaceOpacity = SURFACE_OPACITY[isDark ? "dark" : "light"];
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    // Shell tint alpha — one fixed pair for both appearances since the
    // Settings sliders were pulled (owner decision 2026-09-10). Written as
    // inline root vars so the .dark cascade in index.css picks the
    // appearance-matching value; the scheme <style> below derives its chroma
    // gain from the same numbers.
    const shellOpacity = DEFAULT_SHELL_OPACITY;
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--shell-tint-alpha-dark", `${shellOpacity.dark}%`);
    rootStyle.setProperty("--shell-tint-alpha-light", `${shellOpacity.light}%`);
    // Backgrounds share the fixed appearance alpha; text remains opaque.
    rootStyle.setProperty("--surface-alpha", `${surfaceOpacity}%`);
    const definition = activeSchemeDefinition(themeScheme, isDark, customThemes);
    applyThemeStyle(
      document,
      definition
        ? buildThemeCss(resolveTheme(definition, shellOpacity), surfaceOpacity)
        : "",
    );
  }, [isDark, themeScheme, customThemes, surfaceOpacity]);
}

/** Scheme-override CSS for a REQUESTED appearance (not the app's live one).
 *  Mirrors useRootDarkClass's injection exactly, so an embedded preview (e.g.
 *  the mockup pane's light/dark toggle) shows the scheme the app WOULD use in
 *  that appearance; "" when no scheme is configured — the default look. */
export function schemeOverrideCss(previewDark: boolean): string {
  const state = useStore.getState();
  const definition = activeSchemeDefinition(
    state.uiPrefs?.themeScheme,
    previewDark,
    state.customThemes,
  );
  if (!definition) return "";
  return buildThemeCss(
    resolveTheme(definition),
    SURFACE_OPACITY[previewDark ? "dark" : "light"],
  );
}

function activeTerminalPalette(
  themeScheme: UiPrefs["themeScheme"],
  isDark: boolean,
  customThemes: readonly ThemeDefinition[],
): TerminalPalette {
  const definition = activeSchemeDefinition(
    themeScheme,
    isDark,
    customThemes,
  );
  return definition ? definition.terminal : terminalPalette(isDark);
}

/** Current presentation defaults for seeding a newly constructed Host core. */
export function currentTerminalDefaultColors(): TerminalDefaultColors {
  const state = useStore.getState();
  const isDark = isDarkPreference(state.uiPrefs?.theme, systemPrefersDark());
  return terminalDefaultColors(
    activeTerminalPalette(state.uiPrefs?.themeScheme, isDark, state.customThemes),
  );
}

/** 활성 스킴의 터미널 팔레트 — 스킴·테마 변경 시 재렌더된다.
 *  반환 참조는 스킴 정의의 안정 객체라 deps로 써도 안전하다. */
export function useActiveTerminalPalette(): TerminalPalette {
  const isDark = useResolvedDark();
  const themeScheme = useStore((s) => s.uiPrefs?.themeScheme);
  const customThemes = useStore((s) => s.customThemes);
  return activeTerminalPalette(themeScheme, isDark, customThemes);
}
