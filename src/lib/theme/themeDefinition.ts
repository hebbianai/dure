/**
 * canonical 테마 포맷 — 외부 테마 템플릿(iTerm2-Color-Schemes 계열, VS Code 등)은
 * 전부 import 어댑터가 이 형태로 변환한다. terminal 팔레트 20슬롯이 필수,
 * UI 토큰은 선택 오버라이드(미지정 시 resolveTheme이 터미널 팔레트에서 파생).
 *
 * 유저 파일(~/.dure/themes/*.json)도 이 스키마로 들어오므로 검증은
 * allowlist 기반으로 보수적으로 한다 (codex 설계 검토 E).
 */
import { t } from "@/lib/i18n";
import type { TerminalPalette } from "@/lib/theme/terminalTheme";

/** 오버라이드 가능한 UI 토큰 — index.css의 파생 대상 코어 토큰만.
 *  status/agent 계열은 테마 불변.
 *
 *  glass는 표면만 파생 대상이다: pane·sheet·base·overlay·dialog는 스킴
 *  배경에서 갈라져 나온 진짜 표면이라 스킴을 바꾸면 같이 움직여야 한다(안
 *  그러면 터미널만 그 색조가 되고 셸 크롬은 뉴트럴로 남아 톤이 갈린다). 반면 hairline/chrome/edge/
 *  tint-hover/pane-border는 표면이 아니라 그 위에 얹는 흰·검 대비 오버레이라
 *  색조와 무관하게 옳으므로 불변으로 둔다. */
export const UI_TOKEN_ALLOWLIST = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "surface-sunken",
  "link",
  "glass-overlay",
  "glass-dialog",
  "glass-menu",
  "glass-header",
  "glass-pane",
  "glass-sheet",
  "glass-base",
] as const;
export type UiTokenName = (typeof UI_TOKEN_ALLOWLIST)[number];

const TERMINAL_SLOTS = [
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export interface ThemeDefinition {
  /** 안정 식별자 (스킴 선택 persist 대상) — 소문자 kebab */
  id: string;
  /** 표시 이름 */
  name: string;
  appearance: "dark" | "light";
  terminal: TerminalPalette;
  /** 미지정 토큰은 terminal 팔레트에서 파생 */
  ui?: Partial<Record<UiTokenName, string>>;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class ThemeIdCollisionError extends Error {
  constructor(readonly id: string) {
    super(`theme id already in use: ${id}`);
    this.name = "ThemeIdCollisionError";
  }
}

/** 신뢰할 수 없는 입력(유저 파일·import 산출물)을 검증해 ThemeDefinition으로.
 *  실패 사유는 사람이 읽을 한 줄 문자열 — 설정 UI가 그대로 보여준다. */
export function parseThemeDefinition(
  input: unknown,
): { theme: ThemeDefinition; error?: undefined } | { theme?: undefined; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: t("theme.validation.notObject") };
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== "string" || !ID.test(raw.id)) {
    return { error: t("theme.validation.invalidId") };
  }
  if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 120) {
    return { error: t("theme.validation.invalidName") };
  }
  if (raw.appearance !== "dark" && raw.appearance !== "light") {
    return { error: t("theme.validation.invalidAppearance") };
  }
  if (typeof raw.terminal !== "object" || raw.terminal === null) {
    return { error: t("theme.validation.terminalPaletteMissing") };
  }
  const terminal = raw.terminal as Record<string, unknown>;
  for (const slot of TERMINAL_SLOTS) {
    const value = terminal[slot];
    if (typeof value !== "string" || !HEX.test(value)) {
      return { error: t("theme.validation.terminalSlotFormat", { slot }) };
    }
  }
  let ui: ThemeDefinition["ui"];
  if (raw.ui !== undefined) {
    if (typeof raw.ui !== "object" || raw.ui === null || Array.isArray(raw.ui)) {
      return { error: t("theme.validation.uiNotObject") };
    }
    ui = {};
    for (const [key, value] of Object.entries(raw.ui as Record<string, unknown>)) {
      if (!(UI_TOKEN_ALLOWLIST as readonly string[]).includes(key)) {
        return { error: t("theme.validation.uiTokenUnknown", { key }) };
      }
      if (typeof value !== "string" || !HEX.test(value)) {
        return { error: t("theme.validation.uiTokenFormat", { key }) };
      }
      ui[key as UiTokenName] = value.toLowerCase();
    }
  }
  const palette = Object.fromEntries(
    TERMINAL_SLOTS.map((slot) => [slot, (terminal[slot] as string).toLowerCase()]),
  ) as unknown as TerminalPalette;
  return {
    theme: { id: raw.id, name: raw.name, appearance: raw.appearance, terminal: palette, ui },
  };
}
