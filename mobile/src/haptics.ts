/**
 * One tick per key press, when the person wants it.
 *
 * The plugin is loaded on the first tick rather than at import: it is a
 * mobile-only module, and a desktop build or a jsdom test must not pay for it
 * (or fail on it) merely by drawing a key.
 */

export type ImpactStyle = "light" | "medium" | "heavy" | "soft" | "rigid";
/** The plugin's `impactFeedback`, or a fake standing in for it. */
export type Impact = (style: ImpactStyle) => Promise<unknown>;

async function pluginImpact(style: ImpactStyle): Promise<unknown> {
  const { impactFeedback } = await import("@tauri-apps/plugin-haptics");
  return impactFeedback(style);
}

/**
 * Ticks once for a finger on a key. Never throws and never surfaces a
 * failure: the tauri-specta binding answers a permission refusal with
 * `{ status: "error" }` rather than rejecting, a missing plugin rejects, and
 * the desktop no-op resolves — none of which is the key press's problem.
 */
export function keyTapFeedback(enabled: boolean, impact: Impact = pluginImpact): void {
  if (!enabled) return;
  void impact("light").then(
    () => undefined,
    () => undefined,
  );
}
