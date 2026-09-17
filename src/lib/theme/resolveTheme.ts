/**
 * ThemeDefinition → ResolvedTheme: UI 토큰 완성본을 결정적으로 생성한다.
 *
 * 파생 원리(Warp 방식 + 우리 기본 팔레트 실측 곡선): 각 표면 토큰은 터미널
 * bg→fg 사이를 OKLCH로 보간한 지점이다. 곡선 t값은 index.css의 기본
 * 다크/라이트 토큰을 역산한 것 — 기본 팔레트를 넣으면 기존 룩이 거의
 * 그대로 나오고, 외부 스킴을 넣으면 같은 위계가 그 색조로 재현된다.
 * 명시 ui 오버라이드가 항상 파생값을 이긴다. (codex 설계 검토 B)
 *
 * Since 2026-09-10 text is not a point on that axis. Its lightness is the
 * app's own (INK_LIGHTNESS — index.css's shadcn neutrals), muted text is
 * lifted only as far as the derived surfaces need for AA, and the scheme
 * contributes hue at no more than a tinted neutral's chroma
 * (TEXT_CHROMA_CAP). Borders and the input stroke are the app's own alpha
 * strokes and are not derived at all — see APP_OWNED_TOKENS.
 */
import type { TerminalPalette } from "@/lib/theme/terminalTheme";
import { hexToOklch, mixOklch, oklchToHex } from "./oklch";
import {
  DEFAULT_SHELL_OPACITY,
  type ShellOpacity,
  shellChromaGain,
} from "./shellOpacity";
import type { ThemeDefinition, UiTokenName } from "./themeDefinition";

/** Tokens a scheme does not own. Borders and the input stroke are alpha
 *  strokes in index.css (black 10% light, white 10% / 15% dark), so they
 *  follow whatever surface they sit on; derived as opaque tints they drew a
 *  flat line over the glass — the scheme cards in Settings (owner report
 *  2026-09-10). An explicit `ui` override in a theme definition still wins. */
export const APP_OWNED_TOKENS = ["border", "sidebar-border", "input"] as const;
type AppOwnedTokenName = (typeof APP_OWNED_TOKENS)[number];
/** What a scheme derives. */
export type SchemeTokenName = Exclude<UiTokenName, AppOwnedTokenName>;

/** UI text under a scheme (owner decision 2026-09-10).
 *
 *  Text used to be a point on the bg→fg axis like every surface, with the
 *  terminal foreground's full chroma: Gruvbox (c 0.057) put cream text on
 *  every panel and Everforest Light olive. Measured over the 40 bundled
 *  schemes that axis also never guaranteed contrast — it inherits each
 *  scheme's own fg:bg ratio, so muted text sat under AA on 34 of them
 *  (Solarized Light 2.0:1). Plain app neutrals were better (fg ≥ 7.5:1
 *  everywhere) but still lost muted on 30, because those schemes' backgrounds
 *  sit far from the app's own (Nord 3.0:1).
 *
 *  So text takes the app's own lightness (index.css's shadcn neutrals), muted
 *  text is lifted toward the ink only as far as the derived pane, sheet and
 *  overlay need to reach MUTED_MIN_CONTRAST, and the scheme lends its hue at
 *  no more than a tinted neutral's chroma — about a Tailwind stone or slate
 *  grey. The shipped neutral palettes reproduce index.css exactly. */
export const TEXT_CHROMA_CAP = 0.012;
const MUTED_MIN_CONTRAST = 4.5;
const INK_LIGHTNESS = {
  dark: { foreground: 0.985, muted: 0.708 },
  light: { foreground: 0.205, muted: 0.523 },
} as const;

/** WCAG relative-luminance contrast between two 6-digit hex colours. */
function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channel = (i: number) => {
      const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The muted lightness that clears MUTED_MIN_CONTRAST on every surface text
 *  sits on: `start` if it already does, otherwise the closest point between
 *  `start` and the ink's own lightness that does (the ink itself if none). */
function mutedLightness(
  start: number,
  bound: number,
  surfaces: readonly string[],
  ink: (l: number) => string,
): number {
  const worst = (l: number) => Math.min(...surfaces.map((s) => contrastRatio(ink(l), s)));
  if (worst(start) >= MUTED_MIN_CONTRAST) return start;
  if (worst(bound) < MUTED_MIN_CONTRAST) return bound;
  let fails = start;
  let passes = bound;
  for (let i = 0; i < 16; i++) {
    const mid = (fails + passes) / 2;
    if (worst(mid) >= MUTED_MIN_CONTRAST) passes = mid;
    else fails = mid;
  }
  return passes;
}

export interface ResolvedTheme {
  id: string;
  name: string;
  appearance: "dark" | "light";
  terminal: TerminalPalette;
  /** 완성된 UI 토큰 — buildThemeCss가 그대로 CSS 변수로 쓴다 */
  ui: Record<SchemeTokenName, string> & Partial<Record<AppOwnedTokenName, string>>;
}

/** bg→fg 보간 지점(t). 기본 터미널 팔레트(bg/fg)와 index.css 기본 토큰의
 *  OKLCH 명도를 역산한 값 — 다크는 bg L0.145→fg L0.922, 라이트는
 *  bg L1.0→fg L0.205 기준. primary는 양쪽 모두 fg 그대로(t=1). */
const SURFACE_CURVE: Record<"dark" | "light", Partial<Record<UiTokenName, number>>> = {
  dark: {
    card: 0.077,
    popover: 0.077,
    sidebar: 0.077,
    "surface-sunken": 0.077,
    secondary: 0.16,
    muted: 0.16,
    "sidebar-accent": 0.16,
    accent: 0.291,
    ring: 0.529,
    "sidebar-ring": 0.529,
    primary: 1,
    "primary-foreground": 0.077,
    "glass-pane": 0.146,
    "glass-sheet": 0.199,
    // Pane header band, below the pane (0.146) — chrome darker than content,
    // as in light. It sat on the sheet value (0.199) until 2026-09-09: equal,
    // the band and the seam between panes were one material, and
    // neighbouring headers fused into a strip across the gap (owner report).
    // #1a1a1a for the shipped dark theme.
    "glass-header": 0.093,
    // 다크에서 셸 틴트의 역할은 '색을 얹는 것'이 아니라 'material 출력을
    // 끌어내리는 것'이다 — 밝기도 색도 창 뒤 NSVisualEffectView가 만들고,
    // CSS는 그 위를 눌러 어둡게만 한다. 그래서 값이 pane보다 밝을 이유가
    // 없고, 오히려 배경(t=0) 근처여야 한다.
    //
    // 2026-08-02 실측: material(hudWindow) 출력 87, 목표는 네이티브 앱의 52.
    // 틴트가 #363636(54)이면 54 > 52라 아무리 얹어도 52에 못 내려간다 —
    // 알파 106%가 필요하다는 계산이 나왔다. 거의 검정(t=0.02, #0d0d0d)이면
    // 알파 40%로 58까지 내려가고 뒤 변동폭은 60%가 남는다.
    //
    // 색은 잃지 않는다: t=0.02는 스킴 배경 그 자체라 그 팔레트의 색조를 띤다.
    "glass-base": 0.02,
    "glass-overlay": 0.104,
    // Settings dialog glass (#424244 reverse-engineered). Derived like the
    // other glass SURFACES — leaving it static made the settings dialog the
    // one neutral island under a chromatic scheme (user report, 2026-08-13).
    "glass-dialog": 0.2995,
    // Menu glass (#272727 — the macOS native menu, measured against ours on
    // the same backdrops; see the --glass-menu comment in index.css). Derived
    // like the other glass SURFACES: static left every context/dropdown menu a
    // neutral island under a chromatic scheme (user report, 2026-08-15). Alpha
    // (75%) stays at the consumer (MENU_SURFACE_CLASS) per the 6-hex contract.
    "glass-menu": 0.163,
  },
  light: {
    card: 0,
    popover: 0,
    sidebar: 0.019,
    "surface-sunken": 0.01,
    secondary: 0.038,
    muted: 0.038,
    "sidebar-accent": 0.038,
    accent: 0.038,
    ring: 0.367,
    "sidebar-ring": 0.367,
    primary: 1,
    "primary-foreground": 0.019,
    "glass-pane": 0,
    // #ececec — 정본(2026-09-04, 피그마 변수와 일치). 밝기 236을 유지하고
    // 시안의 푸른 기만 걷은 값이다. 더 어둡게 가려면 muted-foreground부터
    // 재결정해야 한다(#e5e5e5에서 대비 4.29 < AA 4.5) — index.css 주석 참조.
    "glass-sheet": 0.0712,
    // #f1f1f4 reverse-engineered. Unlike dark, light keeps the band a step
    // above the seam rather than equal to it.
    "glass-header": 0.051,
    // #ebebeb (2026-09-08) — index.css --glass-base와 같은 값이어야 한다.
    // 0.16(#d5d5d5)은 알파 10% 전제였다: 틴트가 거의 안 칠해지니 틴트 자체를
    // pane보다 ΔL 0.127 어둡게 잡아야 사이드바와 콘텐츠가 갈렸다(사용자 지적,
    // 2026-08-01: "슬랙 정도로 톤 차이가 보여야"). 알파가 80%가 되면서 틴트 색이
    // 곧 셸 색이 됐으므로, 셸이 쉬는 밝기(236)를 그대로 내는 값으로 옮겼다.
    // 스킴을 골랐을 때의 톤 차이는 이제 틴트의 어둡기가 아니라 칠해지는 양이
    // 만든다 — 같은 0.0745를 유채색 축에 얹으면 80%가 그대로 셸에 실린다.
    "glass-base": 0.0745,
    "glass-overlay": 0,
    "glass-dialog": 0.066, // #ededf1 reverse-engineered
    // Menu glass (#fafafa — the macOS native menu, measured 2026-09-04; see
    // index.css --glass-menu). Not the scheme background: a pure-white tint
    // cannot land below its own backdrop, so it could never reach the native
    // #fcfcfc over a white pane.
    "glass-menu": 0.0186,
  },
};

/** glass-base 채도 증폭 — 셸 틴트 알파의 역수다(App.tsx
 *  `bg-glass-base/(--shell-tint-alpha)`, 기본 라이트 10% / 다크 50%).
 *
 *  glass-base만 다른 유리 토큰과 처지가 다르다. pane·sheet·overlay는 불투명
 *  면이라 파생된 색이 그대로 화면에 나오지만, base는 알파를 얹어 칠하므로
 *  화면에 도달하는 채도가 알파배로 깎인다. 2026-08-02 실측(번들 40종):
 *  라이트 base 채도 중앙값 0.0118 × 0.10 = 0.0012, 다크 0.0211 × 0.50 =
 *  0.0106 — 라이트는 지각 한계 한참 아래라 어떤 스킴을 골라도 셸이 뉴트럴로
 *  보였다(사용자 지적).
 *
 *  규칙은 "알파가 깎는 만큼 미리 되갚되, sRGB가 허락하는 데까지"다. 채도가
 *  낮은 스킴은 역수를 곱한 그대로 복원되지만, 진한 스킴은 감마 경계에서
 *  잘린다 — 그리고 실제로 자주 잘린다. 실측(2026-08-02): everforest-light는
 *  gain 8, cobalt2는 gain 2에서 이미 경계라 계수를 10·20·40으로 올려도 출력이
 *  같다. 즉 진한 스킴에서 이 층이 하는 일은 '본래 채도 복원'이 아니라 '그
 *  L·H에서 가능한 최대 채도'이고, 클램프는 부수 효과가 아니라 설계의 일부다.
 *  번들 40종 합성/pane 채도비는 다크 평균 0.91, 라이트 0.64다(증폭 전 다크
 *  0.50 / 라이트 0.10).
 *
 *  입력 L·H는 그대로 두고 C만 곱한다. 밝기는 창 뒤 material 출력을 목표치로
 *  끌어내리는 실측 튜닝의 소관이라(라이트 10 / 다크 50) 여기서 움직이면 그
 *  튜닝이 깨진다. 다만 밝기가 완전히 불변은 아니고, 정작 튜닝이 겨냥하는
 *  것은 토큰이 아니라 **합성된 픽셀**이다 — 알파 합성은 감마 sRGB에서
 *  채널별로 일어나므로 토큰의 OKLab L을 지켜도 합성 L은 지켜지지 않는다.
 *  실측(중성 배경, 실제 알파): 토큰 L은 최대 0.0023(oceanic-next) 움직이고
 *  합성 L은 그 3배인 **최대 0.0071**까지 움직인다. 채널로는 다크 13/255,
 *  라이트 21/255다. 목표 밝기 대비로는 작지만 0.0023이 상한은 아니다.
 *  밝기 사다리(glass-base < glass-pane)는 40종 전부 유지된다.
 *
 *  기본 팔레트는 무채색(C=0)이라 몇을 곱해도 C=0 — '기본' 스킴에서 셸 색이
 *  바뀌지 않는다는 계약은 그대로다.
 *
 *  전제: glass-base는 **항상 알파와 함께** 칠해진다. 소비처는 App.tsx의
 *  셸 한 곳뿐이고(`bg-glass-base/(--shell-tint-alpha)`), 증폭한 채도는
 *  그 알파를 통과해야 제 값이 된다. 불투명하게 칠하면 라이트 토큰이 #ffc800
 *  같은 형광색이라 그대로 튄다 — src/ 전체를 훑는 테스트가 막는다
 *  (resolveTheme.test "셸 틴트는 어디서도 알파 없이 칠하지 않는다").
 *
 *  한계 둘, 알고 남긴다:
 *  1. 라이트 10배는 L 0.87에서 sRGB 밖으로 나가 14종 중 7종이 클램프된다
 *     (실효 배율 2.44~10.3). 경계를 넘으면 출력이 원본 채도에 더는 반응하지
 *     않아, 같은 색상(hue)에 원본 채도 0.011 이상인 두 스킴은 셸이 같은
 *     색으로 수렴한다. 번들 40종에는 그런 쌍이 없어 지금 증상은 없다.
 *     줄이면 클램프는 덜하지만 애초 요청(스킴 톤이 보이게)이 약해진다 —
 *     톤 가시성을 택했다.
 *  2. 사용자 테마가 ui["glass-base"]를 직접 주면 그 값은 그대로 쓰인다
 *     (definition.ui가 derived를 덮는다). 파생값은 '알파로 나눠 놓은 틴트'
 *     인데 오버라이드는 평범한 표면색으로 해석되므로, 파생값을 복사해 손보는
 *     사용자는 라이트에서 의도보다 10배 옅은 셸을 보게 된다.
 *
 *  2026-08-13: the alpha became a user preference (uiPrefs.shellOpacity), so
 *  the gain is no longer a constant pair — it derives from the same
 *  preference via shellChromaGain (100/alpha, capped), keeping tint alpha and
 *  chroma gain in lockstep from one source. Dark keeps the old constant
 *  (50% → 2); light moved from 10% (gain 10) to 80% (gain 1.25) on
 *  2026-09-08 — see shellOpacity.ts.
 *
 *  2026-09-10: the preference was pulled again (owner decision). The pair is
 *  DEFAULT_SHELL_OPACITY and the gain still derives from it by the same
 *  path, so nothing here changed. */

export function resolveTheme(
  definition: ThemeDefinition,
  shellOpacity: ShellOpacity = DEFAULT_SHELL_OPACITY,
): ResolvedTheme {
  const { terminal, appearance } = definition;
  // The derivation anchor. A scheme's terminal background is normally also the
  // app's darkest tone, which is what moves the whole app when you pick one.
  // A theme that pins `ui.background` is saying those are different facts —
  // our dark theme draws the terminal on glass/pane (#242424) while the app
  // anchors a step below it (#0a0a0a), and the curve below derives that pane
  // value back from the anchor. Reading the anchor here rather than adding a
  // second seed field keeps one source: whatever `background` resolves to is
  // what everything else is measured from.
  const seed = definition.ui?.background ?? terminal.background;
  const bg = hexToOklch(seed);
  const fg = hexToOklch(terminal.foreground);
  const step = (t: number) => oklchToHex(mixOklch(bg, fg, t));
  const curve = SURFACE_CURVE[appearance];
  // The surfaces text sits on, derived first so the muted ink can be measured
  // against them.
  const glassPane = step(curve["glass-pane"] ?? 0.146);
  const glassSheet = step(curve["glass-sheet"] ?? 0.199);
  const glassOverlay = step(curve["glass-overlay"] ?? 0.104);
  /** Text ink: the app's lightness, the scheme's hue at a tinted neutral's chroma. */
  const ink = (l: number) => oklchToHex({ l, c: Math.min(fg.c, TEXT_CHROMA_CAP), h: fg.h });
  const inkLightness = INK_LIGHTNESS[appearance];
  const uiForeground = ink(inkLightness.foreground);
  const mutedForeground = ink(
    mutedLightness(
      inkLightness.muted,
      inkLightness.foreground,
      [glassPane, glassSheet, glassOverlay],
      ink,
    ),
  );
  /** 같은 보간 지점이되 채도만 키운 색 — 알파로 칠하는 셸 틴트 전용. */
  const tintStep = (t: number) => {
    const mixed = mixOklch(bg, fg, t);
    return oklchToHex({ ...mixed, c: mixed.c * shellChromaGain(shellOpacity[appearance]) });
  };

  const derived: Record<SchemeTokenName, string> = {
    background: seed,
    foreground: uiForeground,
    card: step(curve.card ?? 0),
    "card-foreground": uiForeground,
    popover: step(curve.popover ?? 0),
    "popover-foreground": uiForeground,
    primary: step(curve.primary ?? 1),
    "primary-foreground": step(curve["primary-foreground"] ?? 0),
    secondary: step(curve.secondary ?? 0.1),
    "secondary-foreground": uiForeground,
    muted: step(curve.muted ?? 0.1),
    "muted-foreground": mutedForeground,
    accent: step(curve.accent ?? 0.2),
    "accent-foreground": uiForeground,
    ring: step(curve.ring ?? 0.45),
    sidebar: step(curve.sidebar ?? 0.05),
    "sidebar-foreground": uiForeground,
    // 사이드바 포인트 컬러는 팔레트의 blue를 그대로 — 기본 다크 디자인과 동일한 관례
    "sidebar-primary": appearance === "dark" ? terminal.blue : step(curve.primary ?? 1),
    "sidebar-primary-foreground":
      appearance === "dark" ? uiForeground : step(curve["primary-foreground"] ?? 0),
    "sidebar-accent": step(curve["sidebar-accent"] ?? 0.1),
    "sidebar-accent-foreground": uiForeground,
    "sidebar-ring": step(curve["sidebar-ring"] ?? 0.45),
    "surface-sunken": step(curve["surface-sunken"] ?? 0.05),
    link: terminal.blue,
    // 유리 표면. pane은 pane 카드/헤더, sheet는 카드 사이로 드러나는 바닥,
    // base는 셸 전체에 덮이는 틴트다 — 셋 다 스킴 배경에서 갈라져 나온다.
    // base의 투명도는 토큰이 아니라 셸이 칠할 때 얹는다(App.tsx) — 토큰은
    // 6자리 hex 계약을 지켜야 유저 테마 오버라이드도 그대로 통한다.
    "glass-pane": glassPane,
    "glass-sheet": glassSheet,
    // base만 tintStep이다 — 알파로 얹히느라 깎이는 채도를 미리 되돌린다.
    "glass-base": tintStep(curve["glass-base"] ?? 0.304),
    // 설정 창 본문 배경 — 기본 다크 #1c1c1c(t 역산 0.104), 라이트는 스킴 배경.
    "glass-overlay": glassOverlay,
    // glass/dialog. 2026-09-09부터 다이얼로그는 셸 유리(glass-base, 사이드바와
    // 같은 재질)를 쓰므로 앱 안에서 이 토큰을 소비하는 표면은 없다 — 스킴
    // 정의(themeDefinition)의 일부라 파생만 유지한다.
    "glass-dialog": step(curve["glass-dialog"] ?? 0.2995),
    // 메뉴 유리(MENU_SURFACE_CLASS bg-glass-menu/67·75). 알파는 소비자 소유.
    "glass-menu": step(curve["glass-menu"] ?? 0.163),
    // Pane header band. Derived like every other glass SURFACE — left static
    // it was the one neutral island under a chromatic scheme, the same way
    // glass-dialog and glass-menu were before it (user reports 2026-08-13 and
    // 08-15; this one 2026-09-01).
    "glass-header": step(curve["glass-header"] ?? 0.199),
  };

  return {
    id: definition.id,
    name: definition.name,
    appearance,
    terminal,
    ui: { ...derived, ...definition.ui },
  };
}

/** A surface colour with its chroma multiplied by the inverse of the alpha it
 *  will be painted at (capped by shellChromaGain, and by sRGB), so that after
 *  compositing over a neutral backdrop it shows the chroma the scheme designed
 *  — the rule glass-base follows for the shell tint, applied to the panes, the
 *  header band, the sheet and the terminal canvas once they took an alpha
 *  (lib/theme/surfaceOpacity, 2026-09-09). At 100% it returns the input. */
export function surfaceTintHex(hex: string, alphaPercent: number): string {
  if (alphaPercent >= 100) return hex;
  const color = hexToOklch(hex);
  return oklchToHex({ ...color, c: color.c * shellChromaGain(alphaPercent) });
}
