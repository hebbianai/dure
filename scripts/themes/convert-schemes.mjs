#!/usr/bin/env node
/**
 * iTerm2-Color-Schemes(upstream, MIT)의 Windows Terminal export를 canonical
 * ThemeDefinition으로 변환해 번들 산출물을 갱신한다.
 *
 *   node scripts/themes/convert-schemes.mjs
 *
 * 산출물(커밋 대상 — 일반 빌드는 네트워크 없이 재현된다):
 *   - src/lib/theme/bundledThemes.ts   생성 코드 (편집 금지)
 *   - scripts/themes/manifest.json     upstream 커밋·원본 파일·라이선스 기록
 *   - scripts/themes/UPSTREAM-LICENSE  upstream 라이선스 원문 (MIT 고지)
 *
 * upstream 갱신은 이 스크립트의 UPSTREAM_COMMIT을 올리고 재실행하는 명시적
 * 작업으로만 한다 (codex 설계 검토 D).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_REPO = "mbadolato/iTerm2-Color-Schemes";
const UPSTREAM_COMMIT = "171945cb5f1f0ec6a2c6e7338e3a86c1107b4eb0"; // 2026-07-28
const CONVERTER_VERSION = 1;

/** 큐레이션 — file은 upstream windowsterminal/ 안의 정확한 파일명.
 *  id/name은 우리 표기(예: "iTerm2 Solarized Dark" → solarized-dark). */
const CURATED = [
  // 다크
  { file: "Dracula.json", id: "dracula", name: "Dracula" },
  { file: "Nord.json", id: "nord", name: "Nord" },
  { file: "Catppuccin Mocha.json", id: "catppuccin-mocha", name: "Catppuccin Mocha" },
  { file: "Catppuccin Macchiato.json", id: "catppuccin-macchiato", name: "Catppuccin Macchiato" },
  { file: "iTerm2 Solarized Dark.json", id: "solarized-dark", name: "Solarized Dark" },
  { file: "Gruvbox Dark.json", id: "gruvbox-dark", name: "Gruvbox Dark" },
  { file: "One Half Dark.json", id: "one-half-dark", name: "One Half Dark" },
  { file: "TokyoNight.json", id: "tokyo-night", name: "Tokyo Night" },
  { file: "TokyoNight Storm.json", id: "tokyo-night-storm", name: "Tokyo Night Storm" },
  { file: "GitHub Dark Default.json", id: "github-dark", name: "GitHub Dark" },
  { file: "Rose Pine.json", id: "rose-pine", name: "Rosé Pine" },
  { file: "Kanagawa Wave.json", id: "kanagawa-wave", name: "Kanagawa Wave" },
  { file: "Everforest Dark Med.json", id: "everforest-dark", name: "Everforest Dark" },
  { file: "Monokai Remastered.json", id: "monokai", name: "Monokai" },
  { file: "Ayu Mirage.json", id: "ayu-mirage", name: "Ayu Mirage" },
  { file: "Night Owl.json", id: "night-owl", name: "Night Owl" },
  { file: "Iceberg Dark.json", id: "iceberg-dark", name: "Iceberg Dark" },
  { file: "Dark Modern.json", id: "vscode-dark-modern", name: "VS Code Dark Modern" },
  { file: "Dark+.json", id: "vscode-dark-plus", name: "VS Code Dark+" },
  { file: "Atom One Dark.json", id: "one-dark", name: "One Dark" },
  { file: "Cobalt2.json", id: "cobalt2", name: "Cobalt2" },
  { file: "Horizon.json", id: "horizon", name: "Horizon" },
  { file: "Oceanic Next.json", id: "oceanic-next", name: "Oceanic Next" },
  { file: "Tomorrow Night.json", id: "tomorrow-night", name: "Tomorrow Night" },
  { file: "Synthwave Everything.json", id: "synthwave-84", name: "SynthWave '84" },
  { file: "Flexoki Dark.json", id: "flexoki-dark", name: "Flexoki Dark" },
  // 라이트
  { file: "iTerm2 Solarized Light.json", id: "solarized-light", name: "Solarized Light" },
  { file: "Catppuccin Latte.json", id: "catppuccin-latte", name: "Catppuccin Latte" },
  { file: "Gruvbox Light.json", id: "gruvbox-light", name: "Gruvbox Light" },
  { file: "One Half Light.json", id: "one-half-light", name: "One Half Light" },
  { file: "TokyoNight Day.json", id: "tokyo-night-day", name: "Tokyo Night Day" },
  { file: "GitHub Light Default.json", id: "github-light", name: "GitHub Light" },
  { file: "Rose Pine Dawn.json", id: "rose-pine-dawn", name: "Rosé Pine Dawn" },
  { file: "Ayu Light.json", id: "ayu-light", name: "Ayu Light" },
  { file: "Everforest Light Med.json", id: "everforest-light", name: "Everforest Light" },
  { file: "Iceberg Light.json", id: "iceberg-light", name: "Iceberg Light" },
  { file: "Atom One Light.json", id: "one-light", name: "One Light" },
  { file: "Flexoki Light.json", id: "flexoki-light", name: "Flexoki Light" },
  { file: "Alabaster.json", id: "alabaster", name: "Alabaster" },
  { file: "Tomorrow.json", id: "tomorrow", name: "Tomorrow" },
];

const HEX = /^#[0-9a-fA-F]{6}$/;

function hexOrThrow(value, context) {
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new Error(`${context}: #rrggbb가 아님 — ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

/** OKLab 명도 근사(cbrt(Y)) — appearance(dark/light) 판정.
 *  bundledThemes.test.ts의 OKLCH L<0.6 가드와 같은 척도를 쓴다. */
function okLightness(hex) {
  const channel = (i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return Math.cbrt(y);
}

/** selectionBackground가 없을 때의 결정적 폴백 — bg→fg 30% 혼합 */
function mixHex(a, b, t) {
  const part = (i) =>
    Math.round(
      Number.parseInt(a.slice(i, i + 2), 16) * (1 - t) +
        Number.parseInt(b.slice(i, i + 2), 16) * t,
    )
      .toString(16)
      .padStart(2, "0");
  return `#${part(1)}${part(3)}${part(5)}`;
}

function convert(entry, wt) {
  const background = hexOrThrow(wt.background, `${entry.file} background`);
  const foreground = hexOrThrow(wt.foreground, `${entry.file} foreground`);
  const slot = (key, fallback) =>
    wt[key] === undefined && fallback !== undefined
      ? fallback
      : hexOrThrow(wt[key], `${entry.file} ${key}`);
  const terminal = {
    background,
    foreground,
    cursor: slot("cursorColor", foreground),
    // Windows Terminal은 selectionBackground를 ~50% 알파로 합성해 그린다.
    // 우리 팔레트는 불투명 hex라 원색을 그대로 쓰면 밝은 선택색 스킴(Nord,
    // Catppuccin)에서 글자가 씻겨 나간다 — WT가 실제로 보여주는 색(배경과
    // 50% 혼합)으로 미리 합성한다.
    selectionBackground:
      wt.selectionBackground === undefined
        ? mixHex(background, foreground, 0.3)
        : mixHex(
            background,
            hexOrThrow(wt.selectionBackground, `${entry.file} selectionBackground`),
            0.5,
          ),
    black: slot("black"),
    red: slot("red"),
    green: slot("green"),
    yellow: slot("yellow"),
    blue: slot("blue"),
    magenta: slot("purple"),
    cyan: slot("cyan"),
    white: slot("white"),
    brightBlack: slot("brightBlack"),
    brightRed: slot("brightRed"),
    brightGreen: slot("brightGreen"),
    brightYellow: slot("brightYellow"),
    brightBlue: slot("brightBlue"),
    brightMagenta: slot("brightPurple"),
    brightCyan: slot("brightCyan"),
    brightWhite: slot("brightWhite"),
  };
  return {
    id: entry.id,
    name: entry.name,
    appearance: okLightness(background) < 0.6 ? "dark" : "light",
    terminal,
  };
}

async function fetchUpstream(pathname) {
  const url = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}/${encodeURIComponent(pathname).replaceAll("%2F", "/")}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch 실패 ${response.status}: ${url}`);
  return response.text();
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const themes = [];
for (const entry of CURATED) {
  const wt = JSON.parse(await fetchUpstream(`windowsterminal/${entry.file}`));
  themes.push({ entry, theme: convert(entry, wt) });
}

const ids = new Set(themes.map(({ theme }) => theme.id));
if (ids.size !== themes.length) throw new Error("중복 id");
themes.sort(
  (a, b) =>
    a.theme.appearance.localeCompare(b.theme.appearance) ||
    a.theme.name.localeCompare(b.theme.name),
);

const generated = `// 자동 생성 파일 — 편집 금지. 갱신: node scripts/themes/convert-schemes.mjs
// upstream: ${UPSTREAM_REPO}@${UPSTREAM_COMMIT.slice(0, 12)} (MIT) — 출처·라이선스는
// scripts/themes/manifest.json, scripts/themes/UPSTREAM-LICENSE 참조.
import type { ThemeDefinition } from "./themeDefinition";

export const BUNDLED_THEMES: ThemeDefinition[] = ${JSON.stringify(
  themes.map(({ theme }) => theme),
  null,
  2,
)};
`;

await writeFile(path.join(repoRoot, "src/lib/theme/bundledThemes.ts"), generated);

const manifest = {
  upstreamRepo: UPSTREAM_REPO,
  upstreamCommit: UPSTREAM_COMMIT,
  license: "MIT",
  converterVersion: CONVERTER_VERSION,
  generatedBy: "scripts/themes/convert-schemes.mjs",
  schemes: themes.map(({ entry, theme }) => ({
    id: theme.id,
    appearance: theme.appearance,
    sourceFile: `windowsterminal/${entry.file}`,
  })),
};
await mkdir(path.join(repoRoot, "scripts/themes"), { recursive: true });
await writeFile(
  path.join(repoRoot, "scripts/themes/manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  path.join(repoRoot, "scripts/themes/UPSTREAM-LICENSE"),
  await fetchUpstream("LICENSE"),
);

console.log(`변환 완료: ${themes.length}개 스킴 (${manifest.upstreamCommit.slice(0, 12)})`);
