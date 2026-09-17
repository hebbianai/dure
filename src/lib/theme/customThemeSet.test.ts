import { describe, expect, it } from "vitest";
import { DARK_TERMINAL_PALETTE } from "@/lib/theme/terminalTheme";
import {
  addCustomTheme,
  clearThemeSchemeSlotsForId,
  removeCustomTheme,
} from "./customThemeSet";
import { ThemeIdCollisionError } from "./themeDefinition";

const theme = (id: string) => ({
  id,
  name: id,
  appearance: "dark" as const,
  terminal: DARK_TERMINAL_PALETTE,
});

describe("addCustomTheme", () => {
  it("새 테마를 목록 끝에 추가한다", () => {
    expect(addCustomTheme([], [], theme("a"))).toEqual([theme("a")]);
    expect(addCustomTheme([theme("a")], [], theme("b"))).toEqual([theme("a"), theme("b")]);
  });

  it("등록된(내장·번들) 목록과 충돌하면 거부한다", () => {
    expect(() => addCustomTheme([], [theme("dracula")], theme("dracula"))).toThrow(
      ThemeIdCollisionError,
    );
  });

  it("기존 커스텀 목록과 충돌하면 거부한다", () => {
    expect(() => addCustomTheme([theme("mine")], [], theme("mine"))).toThrow(
      ThemeIdCollisionError,
    );
  });
});

describe("removeCustomTheme", () => {
  it("id로 제거하고 나머지는 그대로 둔다", () => {
    expect(removeCustomTheme([theme("a"), theme("b")], "a")).toEqual([theme("b")]);
  });

  it("없는 id는 무해하게 무시한다", () => {
    expect(removeCustomTheme([theme("a")], "missing")).toEqual([theme("a")]);
  });
});

describe("clearThemeSchemeSlotsForId", () => {
  it("해당 id가 선택된 슬롯만 지운다", () => {
    expect(clearThemeSchemeSlotsForId({ dark: "mine", light: "other" }, "mine")).toEqual({
      light: "other",
    });
  });

  it("양쪽 슬롯이 같은 id면 둘 다 지운다", () => {
    expect(clearThemeSchemeSlotsForId({ dark: "mine", light: "mine" }, "mine")).toEqual({});
  });

  it("일치하는 슬롯이 없으면 그대로 반환한다", () => {
    expect(clearThemeSchemeSlotsForId({ dark: "other" }, "mine")).toEqual({ dark: "other" });
  });

  it("undefined themeScheme도 안전하게 처리한다", () => {
    expect(clearThemeSchemeSlotsForId(undefined, "mine")).toEqual({});
  });
});
