// Test-only contract against src/lib/theme/oklch.ts:
// the engine's self-contained color math must not diverge from the product's.

import { describe, expect, it } from "vitest";
// The src import is test-only, permitted by engine-isolation.test.ts's
// *.test.ts exemption.
import { hexToOklch as productHexToOklch } from "../../src/lib/theme/oklch.ts";
import { colorsEquivalent, hexToOklch, parseCssColor, tokenValuesEquivalent } from "./color.ts";

const SAMPLES = ["#15803d", "#b45309", "#171717", "#fafafa", "#d97757", "#a5b4fc", "#000000", "#ffffff"];

describe("color contract with src/lib/theme/oklch.ts", () => {
  it("matches the product conversion on sample tokens", () => {
    for (const hex of SAMPLES) {
      const engine = hexToOklch(hex);
      const product = productHexToOklch(hex);
      expect(engine, hex).not.toBeNull();
      expect(Math.abs(engine!.l - product.l), `${hex} l`).toBeLessThan(1e-9);
      expect(Math.abs(engine!.c - product.c), `${hex} c`).toBeLessThan(1e-9);
      expect(Math.abs(engine!.h - product.h), `${hex} h`).toBeLessThan(1e-9);
    }
  });
});

describe("css color parsing and equivalence", () => {
  it("parses oklch with alpha percentage", () => {
    const color = parseCssColor("oklch(1 0 0 / 10%)");
    expect(color).toMatchObject({ l: 1, c: 0, h: 0 });
    expect(color!.alpha).toBeCloseTo(0.1, 5);
  });

  it("treats #ffffff1a and oklch(1 0 0 / 10%) as equivalent", () => {
    expect(tokenValuesEquivalent("#ffffff1a", "oklch(1 0 0 / 10%)")).toBe(true);
  });

  it("flags genuinely different colors", () => {
    expect(tokenValuesEquivalent("#16a34a", "#15803d")).toBe(false);
    expect(tokenValuesEquivalent("#d97706", "#b45309")).toBe(false);
  });

  it("hex and its own oklch form are equivalent", () => {
    const oklch = hexToOklch("#15803d")!;
    expect(colorsEquivalent(oklch, parseCssColor(`oklch(${oklch.l} ${oklch.c} ${oklch.h})`)!)).toBe(true);
  });

  it("compares non-color values textually", () => {
    expect(tokenValuesEquivalent("0.625rem", "0.625rem")).toBe(true);
    expect(tokenValuesEquivalent("0.625rem", "0.5rem")).toBe(false);
  });
});
