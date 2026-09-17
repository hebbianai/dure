import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DARK_TERMINAL_PALETTE, LIGHT_TERMINAL_PALETTE } from "@/lib/theme/terminalTheme";
import { hexToOklch } from "./oklch";
import { BUNDLED_THEMES } from "./bundledThemes";
import {
  APP_OWNED_TOKENS,
  resolveTheme,
  type SchemeTokenName,
  TEXT_CHROMA_CAP,
} from "./resolveTheme";
import { DEFAULT_SHELL_OPACITY } from "./shellOpacity";
import { UI_TOKEN_ALLOWLIST } from "./themeDefinition";
import { themeById } from "./themeRegistry";

/** 우리 기본 테마 그대로 — 팔레트만으로 정의를 다시 짜면 dure-dark가 고정한
 *  파생 앵커(ui.background)가 빠져 index.css와 다른 셸이 나온다. '기본을
 *  스킴으로 골랐을 때'를 재는 계약이므로 실제 출하 정의를 쓴다. */
const shippedTheme = (id: "dure-dark" | "dure-light") => {
  const theme = themeById(id);
  if (!theme) throw new Error(`${id} is not registered`);
  return theme;
};

interface ThemeSource {
  entry: string;
  text: string;
}

function collectGlassBasePaints(sources: ThemeSource[]): string[] {
  const paints: string[] = [];
  for (const { entry, text } of sources) {
    // 주석은 걷어낸다 — index.css와 resolveTheme.ts는 이 토큰의 계약을
    // 산문으로 길게 설명하고 있어서, 안 걷으면 그 설명문이 '칠하기'로 잡힌다.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    // Tailwind 유틸(bg-glass-base…)과 CSS의 직접 참조(var(--glass-base)) 둘 다.
    for (const use of code.match(/bg-glass-base(\/(\[?[\d.]+%?\]?|\(--[\w-]+\)))?/g) ?? []) {
      paints.push(`${entry}: ${use}`);
    }
    // index.css는 토큰을 정의하고 Tailwind에 별칭을 다는 곳이라 제외한다.
    if (/var\(--glass-base\)/.test(code) && !entry.endsWith("index.css")) {
      paints.push(`${entry}: var(--glass-base)`);
    }
  }
  return paints;
}

function sourcesMentioningGlassBase(): ThemeSource[] {
  const repositoryRoot = new URL("../../../", import.meta.url);
  // 698개 source를 Node로 재귀 순회하고 전부 읽는 대신 Git의 인덱스 검색으로
  // 후보만 좁힌다. --untracked는 아직 add하지 않은 새 소비처도 계약에 포함한다.
  const search = spawnSync(
    "git",
    [
      "-C",
      fileURLToPath(repositoryRoot),
      "grep",
      "--untracked",
      "--exclude-standard",
      "-Ilz",
      "-e",
      "bg-glass-base",
      "-e",
      "var(--glass-base)",
      "--",
      "src",
    ],
    { encoding: "utf8" },
  );
  if (search.error) throw search.error;
  if (search.status !== 0 && search.status !== 1) {
    throw new Error(`glass-base source search failed: ${search.stderr}`);
  }

  return search.stdout
    .split("\0")
    .filter((entry) => /\.(tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
    .map((entry) => ({
      entry,
      text: readFileSync(new URL(entry, repositoryRoot), "utf8"),
    }));
}

describe("resolveTheme", () => {
  it("모든 allowlist 토큰이 hex로 완성된다", () => {
    const resolved = resolveTheme({
      id: "hebbian-dark",
      name: "Hebbian Dark",
      appearance: "dark",
      terminal: DARK_TERMINAL_PALETTE,
    });
    for (const token of UI_TOKEN_ALLOWLIST) {
      if ((APP_OWNED_TOKENS as readonly string[]).includes(token)) {
        // Borders and the input stroke are the app's own, never the scheme's.
        expect(resolved.ui[token], token).toBeUndefined();
        continue;
      }
      expect(resolved.ui[token], token).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("기본 다크 테마 → index.css 기본 다크 토큰 근사 (명도 ±0.02)", () => {
    const resolved = resolveTheme(shippedTheme("dure-dark"));
    // index.css .dark의 대표 토큰 OKLCH 명도
    const expected: Record<string, number> = {
      background: 0.145,
      card: 0.205,
      secondary: 0.269,
      accent: 0.371,
      ring: 0.556,
      "muted-foreground": 0.708,
      primary: 0.922,
      foreground: 0.985,
    };
    for (const [token, lightness] of Object.entries(expected)) {
      const actual = hexToOklch(resolved.ui[token as SchemeTokenName]).l;
      expect(Math.abs(actual - lightness), `${token}: ${actual}`).toBeLessThan(0.02);
    }
  });

  it("기본 라이트 팔레트 → 라이트 토큰 근사, 흰 표면 유지", () => {
    const resolved = resolveTheme({
      id: "hebbian-light",
      name: "Hebbian Light",
      appearance: "light",
      terminal: LIGHT_TERMINAL_PALETTE,
    });
    expect(resolved.ui.background).toBe("#ffffff");
    expect(resolved.ui.card).toBe("#ffffff");
    // The neutral light palette reproduces index.css's ink exactly
    // (INK_LIGHTNESS.light): foreground 0.205, muted 0.523 — white surfaces
    // clear 4.5:1 without lifting muted.
    expect(Math.abs(hexToOklch(resolved.ui.foreground).l - 0.205)).toBeLessThan(0.02);
    expect(Math.abs(hexToOklch(resolved.ui["muted-foreground"]).l - 0.523)).toBeLessThan(0.02);
  });

  it("유채색 스킴은 표면에 배경 색조가 유지된다 (solarized류)", () => {
    const resolved = resolveTheme({
      id: "solarized-dark",
      name: "Solarized Dark",
      appearance: "dark",
      terminal: { ...DARK_TERMINAL_PALETTE, background: "#002b36", foreground: "#839496" },
    });
    const bgHue = hexToOklch("#002b36").h;
    const cardHue = hexToOklch(resolved.ui.card).h;
    expect(Math.abs(cardHue - bgHue)).toBeLessThan(15);
    expect(hexToOklch(resolved.ui.card).l).toBeGreaterThan(hexToOklch("#002b36").l);
  });

  it("기본 테마의 glass 표면은 Figma 값을 그대로 재현한다", () => {
    // 스킴을 고르지 않으면 index.css 값이 그대로 쓰이지만, '기본'을 스킴으로
    // 고르는 경로도 있다 — 그때 셸이 다른 색이 되면 안 된다.
    const dark = resolveTheme(shippedTheme("dure-dark"));
    // 터미널이 실제로 앉는 면이기도 하다 — 팔레트 background와 같은 값이다.
    expect(dark.ui["glass-pane"]).toBe("#242424");
    expect(dark.ui["glass-pane"]).toBe(DARK_TERMINAL_PALETTE.background);
    for (const [token, figma] of [
      ["glass-sheet", "#2e2e2e"],
      ["glass-base", "#0d0d0d"],
      // pane 헤더 밴드 — 본문(#242424) 아래, 라이트처럼 크롬이 내용보다 어둡다.
      // 심(#2e2e2e)과 같으면 옆 pane 헤더가 틈을 건너 한 띠로 붙는다(오너 지적
      // 2026-09-09).
      ["glass-header", "#1a1a1a"],
    ] as const) {
      const drift = Math.abs(hexToOklch(dark.ui[token]).l - hexToOklch(figma).l);
      expect(drift, `${token} drift from ${figma}`).toBeLessThan(0.005);
    }
    const light = resolveTheme(shippedTheme("dure-light"));
    expect(light.ui["glass-pane"]).toBe("#ffffff");
    // 설정 창 본문(glass-overlay)도 스킴을 따른다 — 기본값은 index.css와 동일.
    expect(dark.ui["glass-overlay"]).toBe("#1c1c1c");
    expect(light.ui["glass-overlay"]).toBe("#ffffff");
    // 설정 다이얼로그 유리(glass-dialog)도 표면이라 스킴을 따른다 — 정적으로
    // 남겨 두면 유채색 스킴에서 설정 창만 무채색 섬이 된다(사용자 보고,
    // 2026-08-13). 기본 팔레트에서는 index.css 값을 재현한다.
    for (const [resolved, figma] of [
      [dark.ui["glass-dialog"], "#424244"],
      [light.ui["glass-dialog"], "#ededf1"],
    ] as const) {
      const drift = Math.abs(hexToOklch(resolved).l - hexToOklch(figma).l);
      expect(drift, `glass-dialog drift from ${figma}`).toBeLessThan(0.005);
    }
    // 메뉴 유리(glass-menu)도 표면이라 스킴을 따른다 — 정적으로 남겨 두면
    // 유채색 스킴에서 우클릭 메뉴만 무채색 섬이 된다(사용자 보고, 2026-08-15).
    // 알파(라이트 67%/다크 75%)는 6자리 hex 계약에 따라 소비자
    // (MENU_SURFACE_CLASS)가 얹는다. 다크 참조값 #272727은 macOS 네이티브
    // 메뉴 실측이다(2026-09-04, index.css --glass-menu 주석).
    // 헤더 밴드도 표면이라 스킴을 따른다 — 정적으로 남겨 두면 유채색 스킴에서
    // pane 헤더만 무채색 섬이 된다(사용자 보고, 2026-09-01). 라이트는 다크와
    // 달리 심보다 한 단계 위다.
    for (const [resolved, figma] of [
      [dark.ui["glass-header"], "#1a1a1a"],
      [light.ui["glass-header"], "#f1f1f1"],
      [dark.ui["glass-menu"], "#272727"],
      [light.ui["glass-menu"], "#fafafa"],
    ] as const) {
      const drift = Math.abs(hexToOklch(resolved).l - hexToOklch(figma).l);
      expect(drift, `glass-menu drift from ${figma}`).toBeLessThan(0.005);
    }
  });

  it("glass 표면이 스킴 색조를 따라간다 — 셸 크롬만 뉴트럴로 남지 않는다", () => {
    const background = "#2d353b"; // everforest dark
    const resolved = resolveTheme({
      id: "everforest-dark",
      name: "Everforest Dark",
      appearance: "dark",
      terminal: { ...DARK_TERMINAL_PALETTE, background, foreground: "#d3c6aa" },
    });
    // 셸 크롬이 나머지 파생 표면과 같은 축 위에 있어야 톤이 갈리지 않는다.
    // 축은 배경→전경이므로, 색조는 그 둘 사이에 있고 채도는 0이 아니어야 한다
    // (뉴트럴 회색으로 떨어지면 그게 지금 문제의 증상이다).
    const bg = hexToOklch(background);
    const fg = hexToOklch("#d3c6aa");
    const lo = Math.min(bg.h, fg.h);
    const hi = Math.max(bg.h, fg.h);
    for (const token of [
      "glass-pane",
      "glass-sheet",
      "glass-base",
      "glass-dialog",
      "glass-menu",
    ] as const) {
      const surface = hexToOklch(resolved.ui[token]);
      expect(surface.h, `${token} hue in [${lo}, ${hi}]`).toBeGreaterThanOrEqual(lo);
      expect(surface.h, `${token} hue in [${lo}, ${hi}]`).toBeLessThanOrEqual(hi);
      expect(surface.c, `${token} chroma`).toBeGreaterThan(0);
    }
    // 표면 위계: 터미널 배경 < pane 카드 < 카드 사이 바닥 < 셸 틴트.
    const l = (token: "glass-pane" | "glass-sheet" | "glass-base") =>
      hexToOklch(resolved.ui[token]).l;
    expect(bg.l).toBeLessThan(l("glass-pane"));
    expect(l("glass-pane")).toBeLessThan(l("glass-sheet"));
    // glass-base는 이 사다리에 없다. 다크에서 그것은 '표면'이 아니라 창 뒤
    // material의 출력을 끌어내리는 층이고(App.tsx
    // bg-glass-base/(--shell-tint-alpha), 다크 기본 50%),
    // 밝기와 색은 NSVisualEffectView가 만든다. 그래서 값이 pane보다 어둡다 —
    // 밝으면 아무리 얹어도 목표 밝기로 못 내려간다(2026-08-02 실측).
    expect(l("glass-base")).toBeLessThan(l("glass-pane"));
  });

  /** glass-base는 알파로 얹혀서(App.tsx `bg-glass-base/(--shell-tint-alpha)`,
   *  기본 라이트 80% / 다크 50% — 라이트는 2026-09-08까지 10%였고 아래 수치는
   *  그때 것이다) 화면에 닿는 채도가 알파배로 깎인다. 증폭 전 라이트는 채도 중앙값
   *  0.0118 × 0.10 = 0.0012로 지각 한계 아래라, 어떤 스킴을 골라도 셸이
   *  뉴트럴로 보였다(사용자 지적, 2026-08-02). 알파의 역수만큼 미리 키워
   *  합성 채도를 불투명 면(pane) 수준으로 되돌린다. */
  it("셸 틴트는 알파로 깎일 채도를 미리 되갚는다 — 합성이 pane 톤에 닿는다", () => {
    const shellAlpha = { light: 0.8, dark: 0.5 } as const;
    const cases = [
      {
        appearance: "light",
        palette: LIGHT_TERMINAL_PALETTE,
        background: "#efebd4", // everforest light
        foreground: "#5c6a72",
      },
      {
        appearance: "dark",
        palette: DARK_TERMINAL_PALETTE,
        background: "#132738", // cobalt2
        foreground: "#ffffff",
      },
    ] as const;

    // 하한을 외형별로 따로 둔다. 다크 base는 t=0.02(스킴 배경 그 자체)라
    // 채도가 원래 높고 pane은 t=0.146으로 이미 전경 쪽으로 희석돼 있어서,
    // 증폭이 없어도 pane*0.3은 넘는다 — 공용 문턱을 쓰면 다크 쪽 증폭이
    // 통째로 무증명으로 남는다(리뷰 지적, 2026-08-02). 증폭 전 합성/pane
    // 비율은 다크 0.5 / 라이트 0.067이므로, 그 사이를 가르는 값으로 잡는다.
    const floor = { light: 0.3, dark: 0.75 } as const;
    // 상한은 여기서 단언하지 않는다. sRGB 감마가 이미 묶기 때문이다 —
    // 실측(2026-08-02): 이 두 케이스는 라이트 gain 8 / 다크 gain 2에서 이미
    // 경계에 닿아, gain을 10·20·40으로 올려도 출력이 완전히 같다(다크 합성/
    // pane 비율이 1.005로 고정). 그래서 "과증폭을 막는다"는 단언을 걸면 절대
    // 실패할 수 없는 문장이 된다. 상한을 지키는 것은 우리 코드가 아니라 감마다.

    for (const { appearance, palette, background, foreground } of cases) {
      const resolved = resolveTheme({
        id: `tone-${appearance}`,
        name: `tone ${appearance}`,
        appearance,
        terminal: { ...palette, background, foreground },
      });
      const base = hexToOklch(resolved.ui["glass-base"]);
      const pane = hexToOklch(resolved.ui["glass-pane"]);
      const composite = base.c * shellAlpha[appearance];
      expect(composite, `${appearance} 합성 채도 하한`).toBeGreaterThan(pane.c * floor[appearance]);
      // 밝기는 여전히 창 뒤 material 튜닝의 소관 — 사다리를 넘지 않는다.
      expect(base.l, `${appearance} 밝기 사다리`).toBeLessThan(pane.l);
    }
  });

  it("불투명 셸 틴트 소비처를 Tailwind와 CSS 양쪽에서 검출한다", () => {
    expect(
      collectGlassBasePaints([
        { entry: "safe.tsx", text: 'className="bg-glass-base/10 dark:bg-glass-base/[0.5]"' },
        { entry: "var.tsx", text: 'className="bg-glass-base/(--shell-tint-alpha)"' },
        { entry: "opaque.tsx", text: 'className="bg-glass-base"' },
        { entry: "opaque.css", text: ".shell { background: var(--glass-base); }" },
        { entry: "comment.ts", text: "// bg-glass-base" },
      ]),
    ).toEqual([
      "safe.tsx: bg-glass-base/10",
      "safe.tsx: bg-glass-base/[0.5]",
      "var.tsx: bg-glass-base/(--shell-tint-alpha)",
      "opaque.tsx: bg-glass-base",
      "opaque.css: var(--glass-base)",
    ]);
  });

  // The chroma gain must follow the configured shell alpha as its reciprocal:
  // a user who raises opacity toward 100% should converge on the plain surface
  // color (gain 1), and lowering it should amplify accordingly. Ratios are
  // asserted loosely because the hex round-trip quantizes chroma to 8-bit.
  it("채도 증폭은 설정된 셸 알파를 따라간다", () => {
    const definition = {
      id: "tone-dark-alpha",
      name: "tone dark alpha",
      appearance: "dark",
      terminal: { ...DARK_TERMINAL_PALETTE, background: "#1a1f2e", foreground: "#dde3e9" },
    } as const;
    const chromaAt = (opacity?: { dark: number; light: number }) =>
      hexToOklch(resolveTheme(definition, opacity).ui["glass-base"]).c;
    const atDefault = chromaAt(); // dark 50% → gain 2
    const atOpaque = chromaAt({ dark: 100, light: 100 }); // gain 1
    const atQuarter = chromaAt({ dark: 25, light: 25 }); // gain 4
    expect(atOpaque, "유채색 입력은 gain 1에서도 색을 유지한다").toBeGreaterThan(0);
    expect(atDefault).toBeGreaterThan(atOpaque * 1.5);
    expect(atQuarter).toBeGreaterThan(atDefault * 1.5);
  });

  /** 증폭된 glass-base는 알파를 통과해야 제 값이 된다. 라이트 토큰은
   *  #ffc800(gruvbox-light)처럼 고채도라, 알파 없이 칠하면 셸이 형광색으로
   *  튄다. 10배 증폭 설계 전체가 이 전제 위에 서 있으므로 App.tsx만이 아니라
   *  src/ 전체의 토큰 언급을 찾는다 — 리뷰에서 다른 파일에 불투명 사용을
   *  넣었을 때 이 테스트가 못 잡는 것이 실증됐다(2026-08-02). */
  it("셸 틴트는 어디서도 알파 없이 칠하지 않는다", () => {
    const paints = collectGlassBasePaints(sourcesMentioningGlassBase());

    expect(paints.length, "셸 틴트를 칠하는 곳이 최소 하나는 있어야 한다").toBeGreaterThan(0);
    for (const paint of paints) {
      // 알파는 `/50`, 임의값 `/[0.08]`, 그리고 설정 연동 변수
      // `/(--shell-tint-alpha)`만 허용한다. 다른 변수는 안 된다 —
      // resolveTheme의 채도 gain이 이 변수의 소스(shellOpacity.ts의 DEFAULT_SHELL_OPACITY)에서만
      // 파생되므로, 다른 변수로 칠하면 gain과 알파의 결합이 깨진다.
      expect(paint, `${paint} — glass-base는 알파와 함께만 칠한다`).toMatch(
        /\/(\d+|\[[\d.]+%?\]|\(--shell-tint-alpha\))$/,
      );
    }
  });

  it("무채색 스킴은 채도 증폭 뒤에도 색이 안 낀다", () => {
    // 무채색 입력의 잔여 채도는 부동소수 찌꺼기(~1e-8)라 어떤 계수를 곱해도
    // OKLCH 문턱을 못 넘는다 — 채도로 재면 계수 4000에서도 통과하는 무의미한
    // 단언이 된다(리뷰 지적). 그래서 결과 hex의 R=G=B로 잰다: 증폭이 8비트
    // 출력에 색을 한 칸이라도 밀어넣으면 그때 깨진다.
    for (const [appearance, palette, background, foreground] of [
      ["dark", DARK_TERMINAL_PALETTE, "#1a1a1a", "#e5e5e5"],
      ["light", LIGHT_TERMINAL_PALETTE, "#ffffff", "#343434"],
    ] as const) {
      const resolved = resolveTheme({
        id: `neutral-${appearance}`,
        name: `neutral ${appearance}`,
        appearance,
        terminal: { ...palette, background, foreground },
      });
      const hex = resolved.ui["glass-base"];
      expect(hex, `${appearance} 무채색 유지`).toMatch(/^#([0-9a-f]{2})\1\1$/);
    }
  });

  /** 라이트 곡선의 glass-base가 0.066이던 시절, 셸과 콘텐츠의 단차가 다크의
   *  절반도 안 됐다(ΔL 0.054 대 0.125). 그래서 스킴을 바꿔도 사이드바가
   *  콘텐츠와 한 톤으로 뭉개져 "톤 차이가 없다"는 지적이 나왔다(2026-08-01).
   *
   *  그때는 토큰의 ΔL을 쟀다. 그런데 셸은 토큰이 아니라 **칠해진 결과**다 —
   *  알파 × 틴트 + (1 − 알파) × 창 뒤 material 출력. 알파 10%에서는 틴트가
   *  3레벨밖에 못 움직여서 토큰 ΔL 0.127이 화면에는 없었고, 60%(2026-09-08)
   *  에서는 틴트 색이 곧 셸 색이다. 그래서 계약을 화면 값으로 옮긴다: 알파와
   *  틴트가 함께 움직여도 셸이 쉬는 밝기(흰 바탕화면 위 236, 2026-08-02부터
   *  소유자가 보고 있던 값)는 그대로여야 한다. 알파만 올리거나 틴트만 밝히면
   *  여기서 먼저 깨진다. */
  it("라이트 셸의 칠해진 밝기는 알파·틴트가 함께 움직여도 그대로다", () => {
    // menu material이 흰 바탕화면 위에서 내는 출력(실측 2026-09-08: 10% 틴트
    // #d5d5d5를 얹은 셸이 236이었으므로 0.1×213 + 0.9×M = 236 → M ≈ 239).
    const MATERIAL_LIGHT_OVER_WHITE = 239;
    const RESTING_SHELL_LIGHT = 236;
    const resolved = resolveTheme({
      id: "gap-light",
      name: "gap",
      appearance: "light",
      terminal: LIGHT_TERMINAL_PALETTE,
    });
    const tint = Number.parseInt(resolved.ui["glass-base"].slice(1, 3), 16);
    const alpha = DEFAULT_SHELL_OPACITY.light / 100;
    const painted = alpha * tint + (1 - alpha) * MATERIAL_LIGHT_OVER_WHITE;
    expect(Math.abs(painted - RESTING_SHELL_LIGHT), `painted ${painted}`).toBeLessThanOrEqual(2);
    // 다크에서 셸의 밝기는 창 뒤 material이 정하고 glass-base는 그것을 눌러
    // 내리는 층일 뿐이다 — 토큰이 pane보다 어둡기만 하면 된다(2026-08-02).
    const dark = resolveTheme({
      id: "gap-dark",
      name: "gap",
      appearance: "dark",
      terminal: DARK_TERMINAL_PALETTE,
    });
    expect(
      hexToOklch(dark.ui["glass-pane"]).l - hexToOklch(dark.ui["glass-base"]).l,
      "dark tint sits below content — it darkens, not surfaces",
    ).toBeGreaterThan(0);
  });

  /** 표면과 전경이 각각 따로 파생되다 보니 둘 사이 대비를 보장하는 장치가
   *  없었다. 2026-08-01에 glass-base를 어둡게 하자 그 위 muted 글자가 1.71:1까지
   *  떨어져 읽히지 않았다(설정 내비 실측). 글자가 실제로 앉는 표면들에 대해
   *  최소 대비를 여기서 못 박는다 — 곡선을 만질 때 이 테스트가 먼저 깨진다. */
  it("본문·보조 글자가 앉는 표면에서 최소 대비를 지킨다", () => {
    // WCAG 상대휘도. 표면/전경이 어느 모드든 같은 식으로 비교된다.
    const luminance = (hex: string) => {
      const channel = (i: number) => {
        const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const [appearance, id] of [
      ["light", "dure-light"],
      ["dark", "dure-dark"],
    ] as const) {
      const { ui } = resolveTheme(shippedTheme(id));
      // 글자가 실제로 앉는 표면: pane 카드, 카드 사이 바닥, 대화상자 본문.
      // glass-base는 셸 틴트라 알파를 얹어 칠하므로 여기 넣지 않는다.
      for (const surface of ["glass-pane", "glass-sheet", "glass-overlay"] as const) {
        expect(ratio(ui.foreground, ui[surface]), `${appearance} foreground on ${surface}`)
          .toBeGreaterThan(7);
        expect(
          ratio(ui["muted-foreground"], ui[surface]),
          `${appearance} muted-foreground on ${surface}`,
        ).toBeGreaterThan(4.5);
      }
    }
  });

  /** Text keeps the axis's lightness and drops the terminal foreground's
   *  chroma to a tinted neutral (TEXT_CHROMA_CAP). Both halves are contracts:
   *  the lightness is what keeps muted text above AA on schemes whose
   *  background sits far from the app's own (neutral text failed 30 of these
   *  40), and the cap is what keeps a warm scheme from painting the chrome in
   *  cream (owner decision 2026-09-10). */
  it("모든 내장 스킴에서 글자는 틴트 중립이고 표면 위 대비를 지킨다", () => {
    const luminance = (hex: string) => {
      const channel = (i: number) => {
        const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const definition of BUNDLED_THEMES) {
      const { ui } = resolveTheme(definition);
      for (const token of ["foreground", "muted-foreground", "sidebar-foreground"] as const) {
        // hex round-trip adds a little chroma noise; allow a hair over the cap.
        expect(hexToOklch(ui[token]).c, `${definition.name} ${token} chroma`).toBeLessThan(
          TEXT_CHROMA_CAP + 0.004,
        );
      }
      for (const surface of ["glass-pane", "glass-sheet", "glass-overlay"] as const) {
        expect(
          ratio(ui.foreground, ui[surface]),
          `${definition.name} foreground on ${surface}`,
        ).toBeGreaterThan(7);
        expect(
          ratio(ui["muted-foreground"], ui[surface]),
          `${definition.name} muted-foreground on ${surface}`,
        ).toBeGreaterThan(4.5);
      }
    }
  });

  it("glass-base는 알파 없는 6자리 hex다 — 투명도는 셸이 얹는다", () => {
    const resolved = resolveTheme({
      id: "default-dark",
      name: "기본",
      appearance: "dark",
      terminal: DARK_TERMINAL_PALETTE,
    });
    expect(resolved.ui["glass-base"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("명시 ui 오버라이드가 파생값을 이긴다", () => {
    const resolved = resolveTheme({
      id: "custom",
      name: "Custom",
      appearance: "dark",
      terminal: DARK_TERMINAL_PALETTE,
      ui: { card: "#123456" },
    });
    expect(resolved.ui.card).toBe("#123456");
  });

  it("link는 팔레트 blue를 따른다", () => {
    const resolved = resolveTheme({
      id: "hebbian-dark",
      name: "Hebbian Dark",
      appearance: "dark",
      terminal: DARK_TERMINAL_PALETTE,
    });
    expect(resolved.ui.link).toBe(DARK_TERMINAL_PALETTE.blue);
  });
});
