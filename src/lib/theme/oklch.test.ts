import { describe, expect, it } from "vitest";
import { hexToOklch, mixOklch, oklchToHex } from "./oklch";

describe("oklch", () => {
  it("왕복 변환이 안정적이다 (±1/255)", () => {
    for (const hex of ["#0a0a0a", "#fafafa", "#60a5fa", "#dc2626", "#16a34a", "#ffffff", "#000000"]) {
      const back = oklchToHex(hexToOklch(hex));
      const dist = (a: string, b: string) =>
        Math.max(
          ...[1, 3, 5].map((i) =>
            Math.abs(Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16)),
          ),
        );
      expect(dist(back, hex), `${hex} → ${back}`).toBeLessThanOrEqual(1);
    }
  });

  it("알려진 값과 일치 — 흰색 L≈1, 검정 L≈0, 무채색 c≈0", () => {
    expect(hexToOklch("#ffffff").l).toBeCloseTo(1, 2);
    expect(hexToOklch("#000000").l).toBeCloseTo(0, 2);
    expect(hexToOklch("#808080").c).toBeLessThan(0.001);
  });

  it("shadcn 다크 배경 oklch(0.145 0 0) ≈ #0a0a0a와 상호 일치", () => {
    expect(hexToOklch("#0a0a0a").l).toBeCloseTo(0.145, 1);
    expect(oklchToHex({ l: 0.145, c: 0, h: 0 })).toBe("#0a0a0a");
  });

  it("감마 밖 색은 명도를 보존한 채 채도만 줄인다", () => {
    const out = hexToOklch(oklchToHex({ l: 0.6, c: 0.4, h: 150 }));
    expect(out.l).toBeCloseTo(0.6, 1);
  });

  it("mixOklch: 끝점 고정·중간 명도 보간, 무채색 hue는 상대를 따른다", () => {
    const bg = hexToOklch("#0a0a0a");
    const fg = hexToOklch("#fafafa");
    expect(mixOklch(bg, fg, 0).l).toBeCloseTo(bg.l, 5);
    expect(mixOklch(bg, fg, 1).l).toBeCloseTo(fg.l, 5);
    expect(mixOklch(bg, fg, 0.5).l).toBeCloseTo((bg.l + fg.l) / 2, 5);
    const blue = hexToOklch("#60a5fa");
    expect(mixOklch(bg, blue, 0.5).h).toBeCloseTo(blue.h, 0);
  });
});
