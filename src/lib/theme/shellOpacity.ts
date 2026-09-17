/**
 * Shell glass-tint opacity — the alpha App.tsx paints `glass-base` with over
 * the window's native vibrancy — one fixed pair per appearance. The Settings
 * sliders that overrode it were pulled on 2026-09-10 (owner decision).
 *
 * Two values must always agree on that alpha:
 *   1. the painted CSS alpha (`--shell-tint-alpha-{light,dark}` vars consumed
 *      by App.tsx `bg-glass-base/(--shell-tint-alpha)`), and
 *   2. resolveTheme's glass-base chroma gain, which pre-compensates the
 *      saturation the alpha will cut (gain = 1/alpha; see the
 *      GLASS_BASE_CHROMA_GAIN history comment in resolveTheme.ts).
 * This module is the single authority both derive from, so the alpha can
 * never drift apart from the gain — at 100% the gain degenerates to 1 and the
 * tint becomes the plain opaque surface color.
 */

export interface ShellOpacity {
  dark: number;
  light: number;
}

/** Percent units, one pair for the two appearances. Light is the heavier of
 *  the two today — the reverse of the 2026-08-02 tuning, which set dark heavy
 *  to pull the material down to the native target and light to a whisper over
 *  an already-bright one. What moved is light, and only light.
 *
 *  Light went 10% → 60% → 80% on 2026-09-08. At 10% the shell was 90%
 *  whatever sat behind the window: 236 over the desktop, 189 behind a dark
 *  terminal, while every opaque pane header stayed put and the glass around
 *  it drifted. At 60% it still fell to 215 there (the material itself drops
 *  to ~186 behind a dark window). Native sidebars hold still on any wallpaper
 *  because the material is mostly opaque; 80% brought the swing to about 10
 *  levels while colour still bled through. --glass-base was lightened in step
 *  each time so the resting brightness did not move.
 *
 *  2026-09-13 takes one step back to 70%: at 80% the two tints had drifted far
 *  apart — dark showed half the wallpaper and light a fifth — and the owner
 *  read the light window as having no show-through at all. 70% returns colour
 *  to the pane gaps and the window's edge without touching what sits behind
 *  text, since the surfaces have their own opacity (see surfaceOpacity). It is
 *  still heavier than dark, so the swing this value exists to damp stays
 *  bounded; the 2026-09-08 measurements above are the record of what a
 *  further step down costs. */
export const DEFAULT_SHELL_OPACITY: ShellOpacity = { dark: 50, light: 70 };

/** Keeps alpha 0 finite. For saturated schemes the cap is lossless — beyond
 *  the sRGB gamut clamp a larger coefficient no longer changes the output
 *  (measured 2026-08-02: 10·20·40 identical). Near-neutral schemes at alpha
 *  1–2% do get less than full 1/alpha compensation, but at that painted alpha
 *  the shortfall is imperceptible. */
export const MAX_SHELL_CHROMA_GAIN = 40;

/** Chroma gain that repays what painting at `alphaPercent` will cut. The
 *  dark default reproduces the historical constant exactly (100/50 = 2); light
 *  was 100/10 = 10 until the alpha moved to 80% (100/80 = 1.25). */
export function shellChromaGain(alphaPercent: number): number {
  if (alphaPercent <= 0) return MAX_SHELL_CHROMA_GAIN;
  return Math.min(MAX_SHELL_CHROMA_GAIN, Math.max(1, 100 / alphaPercent));
}
