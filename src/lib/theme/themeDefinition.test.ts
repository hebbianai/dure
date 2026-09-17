import { describe, expect, it } from "vitest";
import { DARK_TERMINAL_PALETTE } from "@/lib/theme/terminalTheme";
import { parseThemeDefinition } from "./themeDefinition";

const valid = () => ({
  id: "solarized-dark",
  name: "Solarized Dark",
  appearance: "dark",
  terminal: { ...DARK_TERMINAL_PALETTE },
});

describe("parseThemeDefinition", () => {
  it("유효한 정의를 통과시키고 hex를 소문자로 정규화한다", () => {
    const input = valid();
    input.terminal.red = "#F87171";
    const parsed = parseThemeDefinition(input);
    expect(parsed.error).toBeUndefined();
    expect(parsed.theme?.terminal.red).toBe("#f87171");
  });

  it("terminal 슬롯 누락·형식 오류를 슬롯 이름과 함께 거부한다", () => {
    const missing = valid() as Record<string, unknown>;
    delete (missing.terminal as Record<string, unknown>).brightCyan;
    expect(parseThemeDefinition(missing).error).toContain("brightCyan");
    const bad = valid();
    bad.terminal.blue = "blue";
    expect(parseThemeDefinition(bad).error).toContain("blue");
  });

  it("ui 오버라이드는 allowlist 밖 토큰·비hex 값을 거부한다", () => {
    const evil = { ...valid(), ui: { "glass-shadow-shell": "#000000" } };
    expect(parseThemeDefinition(evil).error).toContain("glass-shadow-shell");
    const badValue = { ...valid(), ui: { background: "url(https://x)" } };
    expect(parseThemeDefinition(badValue).error).toContain("background");
    const ok = { ...valid(), ui: { background: "#101010" } };
    expect(parseThemeDefinition(ok).theme?.ui?.background).toBe("#101010");
  });

  it("id 형식·appearance·비객체 입력을 거부한다", () => {
    expect(parseThemeDefinition({ ...valid(), id: "Bad Id!" }).error).toBeTruthy();
    expect(parseThemeDefinition({ ...valid(), appearance: "auto" }).error).toBeTruthy();
    expect(parseThemeDefinition("dark").error).toBeTruthy();
    expect(parseThemeDefinition(null).error).toBeTruthy();
  });
});
