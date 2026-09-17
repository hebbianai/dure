import { describe, expect, it } from "vitest";
import { BUNDLED_THEMES } from "./bundledThemes";
import { hexToOklch } from "./oklch";
import { resolveTheme } from "./resolveTheme";
import { parseThemeDefinition } from "./themeDefinition";
import { allThemes, BUILTIN_THEMES, themeById } from "./themeRegistry";

describe("bundledThemes (변환 산출물 검증)", () => {
  it("모든 번들 스킴이 canonical 스키마를 통과한다", () => {
    for (const theme of BUNDLED_THEMES) {
      const parsed = parseThemeDefinition(theme);
      expect(parsed.error, theme.id).toBeUndefined();
    }
  });

  it("id는 내장 포함 전체에서 유일하다", () => {
    const ids = allThemes().map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("appearance가 배경 명도와 일치한다 — 다크는 어둡고 라이트는 밝다", () => {
    for (const theme of BUNDLED_THEMES) {
      const l = hexToOklch(theme.terminal.background).l;
      if (theme.appearance === "dark") expect(l, theme.id).toBeLessThan(0.6);
      else expect(l, theme.id).toBeGreaterThan(0.6);
    }
  });

  it("큐레이션 규모와 페어 확보 — 다크·라이트 각각 충분히 있다", () => {
    const dark = BUNDLED_THEMES.filter((theme) => theme.appearance === "dark");
    const light = BUNDLED_THEMES.filter((theme) => theme.appearance === "light");
    expect(dark.length).toBeGreaterThanOrEqual(10);
    expect(light.length).toBeGreaterThanOrEqual(6);
  });

  it("모든 번들 스킴이 resolveTheme을 통과해 완전한 UI 토큰을 만든다", () => {
    for (const theme of BUNDLED_THEMES) {
      const resolved = resolveTheme(theme);
      for (const [token, value] of Object.entries(resolved.ui)) {
        expect(value, `${theme.id} ${token}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("대표 스킴 존재 — 문서·마케팅에서 언급할 기준선", () => {
    const ids = new Set(BUNDLED_THEMES.map((theme) => theme.id));
    for (const id of ["dracula", "nord", "solarized-dark", "solarized-light", "catppuccin-mocha", "tokyo-night", "github-light"]) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(BUILTIN_THEMES.length).toBe(2);
    expect(BUILTIN_THEMES.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "dure-dark", name: "Dure Dark" },
      { id: "dure-light", name: "Dure Light" },
    ]);
  });

  it("maps persisted pre-rename built-in ids to the canonical Dure definitions", () => {
    expect(allThemes().some((theme) => theme.id.startsWith("hebbian-"))).toBe(false);
    expect(themeById("hebbian-dark")?.id).toBe("dure-dark");
    expect(themeById("hebbian-light")?.id).toBe("dure-light");
  });
});
