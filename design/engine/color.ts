// Self-contained color math for token value equivalence. Engine isolation
// forbids runtime src imports; the adjacent contract test prevents divergence
// from src/lib/theme/oklch.ts.

export interface OklchColor {
  l: number;
  c: number;
  h: number;
  alpha: number;
}

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function rgbToOklch(r: number, g: number, b: number, alpha: number): OklchColor {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb);
  const h = c < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h, alpha };
}

export function hexToOklch(hex: string): OklchColor | null {
  let body = hex.replace(/^#/, "");
  if (body.length === 3 || body.length === 4) {
    body = [...body].map((ch) => ch + ch).join("");
  }
  if (body.length !== 6 && body.length !== 8) return null;
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;
  const r = Number.parseInt(body.slice(0, 2), 16) / 255;
  const g = Number.parseInt(body.slice(2, 4), 16) / 255;
  const b = Number.parseInt(body.slice(4, 6), 16) / 255;
  const alpha = body.length === 8 ? Number.parseInt(body.slice(6, 8), 16) / 255 : 1;
  return rgbToOklch(r, g, b, alpha);
}

const num = (token: string): number | null => {
  if (token.endsWith("%")) {
    const v = Number.parseFloat(token.slice(0, -1));
    return Number.isNaN(v) ? null : v / 100;
  }
  const v = Number.parseFloat(token);
  return Number.isNaN(v) ? null : v;
};

/** Parse a CSS color value we care about: #hex or oklch(L C H [/ A]). */
export function parseCssColor(value: string): OklchColor | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return hexToOklch(trimmed);
  const match = trimmed.match(/^oklch\(\s*([^\s/)]+)\s+([^\s/)]+)\s+([^\s/)]+)\s*(?:\/\s*([^\s)]+))?\s*\)$/i);
  if (!match) return null;
  const l = num(match[1]);
  const c = num(match[2]);
  const h = match[3].toLowerCase() === "none" ? 0 : Number.parseFloat(match[3]);
  const alpha = match[4] === undefined ? 1 : num(match[4]);
  if (l === null || c === null || Number.isNaN(h) || alpha === null) return null;
  return { l, c, h, alpha };
}

const L_TOLERANCE = 0.01;
const C_TOLERANCE = 0.01;
const H_TOLERANCE = 1.5;
const ALPHA_TOLERANCE = 0.02;
/** Below this chroma the hue channel is numeric noise, not a perceptual fact. */
const ACHROMATIC_C = 0.005;

export function colorsEquivalent(a: OklchColor, b: OklchColor): boolean {
  if (Math.abs(a.l - b.l) > L_TOLERANCE) return false;
  if (Math.abs(a.c - b.c) > C_TOLERANCE) return false;
  if (Math.abs(a.alpha - b.alpha) > ALPHA_TOLERANCE) return false;
  if (a.c < ACHROMATIC_C && b.c < ACHROMATIC_C) return true;
  const dh = Math.abs(a.h - b.h);
  return Math.min(dh, 360 - dh) <= H_TOLERANCE;
}

/** Value equivalence for token drift checks: colors perceptually, rest textually. */
export function tokenValuesEquivalent(documented: string, defined: string): boolean {
  const docColor = parseCssColor(documented);
  const defColor = parseCssColor(defined);
  if (docColor && defColor) return colorsEquivalent(docColor, defColor);
  const normalize = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  return normalize(documented) === normalize(defined);
}
