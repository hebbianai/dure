/**
 * sRGB(#rrggbb) ↔ OKLCH 변환 — 테마 파생 생성(resolveTheme)의 기반.
 *
 * Björn Ottosson의 OKLab 공식 그대로. 파생을 CSS(color-mix)가 아니라 JS에서
 * 하는 이유: 감마 클램프·최소 대비·모드별 명도 곡선을 결정적으로 검증하고,
 * import/미리보기/export가 같은 결과를 내야 하기 때문 (codex 설계 검토 B).
 */

export interface Oklch {
  /** 0..1 */
  l: number;
  /** 0..~0.4 */
  c: number;
  /** 도(deg), 0..360. 무채색이면 0 */
  h: number;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

export function hexToOklch(hex: string): Oklch {
  const r = srgbToLinear(Number.parseInt(hex.slice(1, 3), 16) / 255);
  const g = srgbToLinear(Number.parseInt(hex.slice(3, 5), 16) / 255);
  const b = srgbToLinear(Number.parseInt(hex.slice(5, 7), 16) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb);
  const h = c < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function oklchToSrgb({ l: L, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: [number, number, number]) =>
  rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/** OKLCH → #rrggbb. 감마 밖이면 chroma를 이분탐색으로 줄여 클램프한다 —
 *  명도(대비)는 보존하고 채도만 양보하는 표준 전략. */
export function oklchToHex(color: Oklch): string {
  let rgb = oklchToSrgb(color);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToSrgb({ ...color, c: mid }))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToSrgb({ ...color, c: lo });
  }
  const to255 = (v: number) =>
    Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, v))))) * 255);
  return `#${rgb.map((v) => to255(v).toString(16).padStart(2, "0")).join("")}`;
}

/** 두 색을 OKLCH 공간에서 보간 (t=0 → a, t=1 → b). 무채색(-c≈0)의 hue는
 *  상대 색의 hue를 따라가 보간 중 색상환을 헤매지 않는다. t>1 외삽 시
 *  chroma가 음수가 되면 0으로 클램프한다 — 음수 chroma는 hue 180° 반전과
 *  같아서 보색으로 튄다(resolveTheme가 2026-09-10까지 쓰던 FG_OVERSHOOT
 *  외삽이 그랬다; 지금은 t>1 호출자가 없지만 클램프는 그대로 둔다). */
export function mixOklch(a: Oklch, b: Oklch, t: number): Oklch {
  const ha = a.c < 1e-6 ? b.h : a.h;
  const hb = b.c < 1e-6 ? a.h : b.h;
  let dh = hb - ha;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return {
    l: a.l + (b.l - a.l) * t,
    c: Math.max(0, a.c + (b.c - a.c) * t),
    h: (ha + dh * t + 360) % 360,
  };
}
