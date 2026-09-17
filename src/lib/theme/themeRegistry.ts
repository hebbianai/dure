/**
 * 사용 가능한 테마 목록과 id 조회 — 내장 기본 + 번들 스킴
 * (iTerm2-Color-Schemes 큐레이션, bundledThemes.ts는 변환 스크립트 산출물).
 * P3(유저 커스텀)이 이 목록에 소스를 추가한다.
 * 모르는 id는 undefined → 호출부가 기본 룩(주입 없음)으로 fallback한다.
 */
import {
  DARK_TERMINAL_PALETTE,
  LIGHT_TERMINAL_PALETTE,
} from "@/lib/theme/terminalTheme";
import { BUNDLED_THEMES } from "./bundledThemes";
import type { ThemeDefinition } from "./themeDefinition";
import { canonicalThemeId } from "@/lib/theme/themeIdCompatibility";

export { canonicalThemeId } from "@/lib/theme/themeIdCompatibility";

/** 내장 기본 — index.css 기본 토큰의 룩을 canonical 포맷으로 근사한 것.
 *  파생은 명도 곡선 기준이라 대부분 일치하지만 알파 토큰(다크 border/input의
 *  반투명 흰색)은 불투명 근사가 되고 sidebar-primary는 팔레트 blue를 쓴다 —
 *  "기본 룩(스킴 없음)"과 "dure-dark 선택"은 그 지점에서 미세하게 다르다.
 *  픽셀 동일성이 필요하면 ui 오버라이드로 고정할 것(P2에서 재검토). */
export const BUILTIN_THEMES: ThemeDefinition[] = [
  {
    id: "dure-dark",
    name: "Dure Dark",
    appearance: "dark",
    terminal: DARK_TERMINAL_PALETTE,
    // The one theme whose terminal surface and app anchor differ: the design
    // draws the terminal on glass/pane (#242424) over a darker shell. Pinning
    // the anchor here is what the surface curve measures from, and it lands
    // back on the palette's own background — see terminalTheme.ts.
    ui: { background: "#0a0a0a" },
  },
  {
    id: "dure-light",
    name: "Dure Light",
    appearance: "light",
    terminal: LIGHT_TERMINAL_PALETTE,
  },
];

/** 선택 UI(P3)가 나열할 전체 목록 — 내장 먼저, 그다음 번들(appearance·이름순) */
export function allThemes(): ThemeDefinition[] {
  return [...BUILTIN_THEMES, ...BUNDLED_THEMES];
}

export function themeById(id: string | undefined): ThemeDefinition | undefined {
  const canonicalId = canonicalThemeId(id);
  if (!canonicalId) return undefined;
  return allThemes().find((theme) => theme.id === canonicalId);
}
