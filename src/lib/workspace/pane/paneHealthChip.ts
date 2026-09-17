import type { HmuxPaneHealthState } from "@/lib/terminal/terminalHealth";

/** Which health chip the pane header shows, or `null` for no chip at all.
 *  `connectionError`/`notResponding` are hard problems and carry a warning
 *  glyph; `recovering` is transient and carries a spinner. */
export type PaneHealthChip = "connectionError" | "notResponding" | "recovering";

/** The renderer catching up on a replay backlog is not a session problem — it
 *  resolves on its own within a frame or two, and raising chrome for it was the
 *  original complaint (see PaneChrome's renderer catch-up regression test). */
const SELF_RESOLVING_RECOVERY_REASONS = new Set(["render_backlog"]);

/** Map pane health onto the header chip.
 *
 *  `connecting` deliberately gets nothing: the first attach is the expected
 *  path, and the activity dot already pulses for it — a chip would turn every
 *  pane's opening frames into a status report. Everything else that is neither
 *  live nor a self-resolving renderer catch-up earns one chip. */
export function paneHealthChip(
  state: HmuxPaneHealthState | undefined,
  reason: string | undefined,
): PaneHealthChip | null {
  switch (state) {
    case "error":
      return "connectionError";
    case "stale":
      return "notResponding";
    case "recovering":
      return reason && SELF_RESOLVING_RECOVERY_REASONS.has(reason)
        ? null
        : "recovering";
    default:
      return null;
  }
}
