import { describe, expect, it } from "vitest";
import { defaultSchemeDisclosure } from "@/lib/theme/themeSchemeDisclosure";

describe("defaultSchemeDisclosure", () => {
  it("시스템이면 다크·라이트 둘 다 펼친다 — 둘 다 실제로 쓰인다", () => {
    expect(defaultSchemeDisclosure("system")).toEqual({ dark: true, light: true });
  });

  it("다크로 고정하면 다크만 펼친다", () => {
    expect(defaultSchemeDisclosure("dark")).toEqual({ dark: true, light: false });
  });

  it("라이트로 고정하면 라이트만 펼친다", () => {
    expect(defaultSchemeDisclosure("light")).toEqual({ dark: false, light: true });
  });

  it("고정 테마에서 펼쳐지는 쪽은 정확히 하나다", () => {
    for (const theme of ["dark", "light"] as const) {
      const open = defaultSchemeDisclosure(theme);
      expect(Object.values(open).filter(Boolean)).toHaveLength(1);
      expect(open[theme]).toBe(true);
    }
  });
});
