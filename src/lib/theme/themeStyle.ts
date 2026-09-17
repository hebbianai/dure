/**
 * ResolvedTheme → CSS 텍스트, 그리고 창(webview)별 관리형 <style> 주입.
 *
 * 창마다 <style id="dure-theme-overrides"> 하나를 만들어 textContent를
 * 원자적으로 교체한다 — 포털은 같은 document의 CSS 변수를 상속하고, 테마
 * 교체 시 이전 optional 토큰이 남지 않는다. 선택자는 html:root(0,1,1)로
 * index.css의 :root/.dark(0,1,0)를 로드 순서와 무관하게 이긴다.
 * (codex 설계 검토 A/E)
 */
import { LEGACY_PRODUCT_COMPATIBILITY } from "@/lib/platform/legacyProductCompatibility";
import { type ResolvedTheme, surfaceTintHex } from "./resolveTheme";

export const THEME_STYLE_ELEMENT_ID = "dure-theme-overrides";

export function buildThemeCss(
  resolved: ResolvedTheme,
  surfaceOpacity = 100,
): string {
  const lines = Object.entries(resolved.ui)
    .map(([token, value]) => `    --${token}: ${value};`)
    .join("\n");
  // The colour the terminal canvas actually paints, published so surfaces that
  // butt against a terminal can match it without a seam. It is not a derived UI
  // token: for a scheme it is that scheme's own background, and for the default
  // theme it is glass/pane rather than the app floor the surfaces derive from.
  const terminal = `    --terminal-background: ${resolved.terminal.background};`;
  // The surfaces painted at the user's surface alpha take chroma-restored
  // twins (resolveTheme surfaceTintHex; index.css --surface-*).
  const tints = [
    ["glass-pane-tint", resolved.ui["glass-pane"]],
    ["glass-header-tint", resolved.ui["glass-header"]],
    ["glass-sheet-tint", resolved.ui["glass-sheet"]],
    ["background-tint", resolved.ui.background],
    ["terminal-background-tint", resolved.terminal.background],
  ]
    .map(([token, hex]) => `    --${token}: ${surfaceTintHex(hex, surfaceOpacity)};`)
    .join("\n");
  return `/* scheme: ${resolved.id} (${resolved.appearance}) */\nhtml:root {\n${lines}\n${terminal}\n${tints}\n}\n`;
}

/** css가 빈 문자열이면 style 요소를 제거한다 (기본 테마로 복귀). */
export function applyThemeStyle(doc: Document, css: string): void {
  let el = doc.getElementById(THEME_STYLE_ELEMENT_ID);
  const legacy = doc.getElementById(
    LEGACY_PRODUCT_COMPATIBILITY.themeStyleElementId,
  );
  if (!el && legacy) {
    legacy.id = THEME_STYLE_ELEMENT_ID;
    el = legacy;
  } else {
    legacy?.remove();
  }
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement("style");
    el.id = THEME_STYLE_ELEMENT_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}
