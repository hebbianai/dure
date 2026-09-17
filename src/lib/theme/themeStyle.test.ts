// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DARK_TERMINAL_PALETTE } from "@/lib/theme/terminalTheme";
import { resolveTheme } from "./resolveTheme";
import { applyThemeStyle, buildThemeCss, THEME_STYLE_ELEMENT_ID } from "./themeStyle";

const resolved = resolveTheme({
  id: "dure-dark",
  name: "Dure Dark",
  appearance: "dark",
  terminal: DARK_TERMINAL_PALETTE,
});

describe("themeStyle", () => {
  it("html:root 선택자로 모든 ui 토큰을 CSS 변수로 낸다", () => {
    const css = buildThemeCss(resolved);
    expect(css).toContain("html:root {");
    expect(css).toContain(`--background: ${DARK_TERMINAL_PALETTE.background};`);
    expect(css).toContain("--sidebar-primary:");
    expect(css).toContain("scheme: dure-dark");
  });

  it("applyThemeStyle: 단일 style 요소를 원자 교체하고, 빈 css면 제거한다", () => {
    expect(THEME_STYLE_ELEMENT_ID).toBe("dure-theme-overrides");
    const legacy = document.createElement("style");
    legacy.id = "hebbian-theme-overrides";
    legacy.textContent = "html:root { --background: #ff0000; }";
    document.head.appendChild(legacy);
    const css = buildThemeCss(resolved);
    applyThemeStyle(document, css);
    const el = document.getElementById(THEME_STYLE_ELEMENT_ID);
    expect(el?.textContent).toBe(css);
    expect(document.getElementById("hebbian-theme-overrides")).toBeNull();
    // 두 번째 적용도 요소는 하나
    applyThemeStyle(document, `${css}/* v2 */`);
    expect(document.querySelectorAll(`#${THEME_STYLE_ELEMENT_ID}`).length).toBe(1);
    expect(document.getElementById(THEME_STYLE_ELEMENT_ID)?.textContent).toContain("v2");
    // 제거 = 기본 룩 복귀
    applyThemeStyle(document, "");
    expect(document.getElementById(THEME_STYLE_ELEMENT_ID)).toBeNull();
  });
});
