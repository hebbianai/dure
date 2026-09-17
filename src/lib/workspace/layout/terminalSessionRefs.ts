import {
  panelsFromLayout,
  type SerializedPanelRef,
} from "@/lib/workspace/layout/layoutLifecycle";

/** One terminal pane/session reference inside a removal plan. `persistent`
 * marks Hmux-bound panes whose durable session outlives the view; the rest are
 * retired-legacy leftovers whose runtime no longer exists (2026-08-16). */
export interface TerminalSessionRef {
  kind: "pty" | "ssh";
  sessionId: string;
  panelId: string;
  persistent?: boolean;
}

export function terminalSessionFromPanel({
  id: panelId,
  component,
  params,
}: SerializedPanelRef): TerminalSessionRef | null {
  const kind = component === "terminal"
    ? "pty"
    : component === "ssh"
      ? "ssh"
      : null;
  if (!kind) return null;
  const sessionId =
    typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  const binding =
    params?.binding && typeof params.binding === "object"
      ? (params.binding as Record<string, unknown>)
      : null;
  const persistent =
    binding?.runtime === "hmux_session_v1" ||
    binding?.runtime === "hmux_standalone_v1" ||
    binding?.runtime === "hmux_managed_v1";
  return sessionId ? { kind, sessionId, panelId, persistent } : null;
}

/** Extract only ordinary terminal sessions. Registered agent panes deliberately
 * stay alive when their desktop view is removed. */
export function terminalSessionsFromLayout(layout: unknown): readonly TerminalSessionRef[] {
  const seen = new Set<string>();
  const sessions: TerminalSessionRef[] = [];
  for (const ref of terminalPanesFromLayout(layout)) {
    const key = `${ref.kind}:${ref.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(ref);
  }
  return sessions;
}

/** Every terminal pane in a layout, one entry per pane even when two panes
 * show the same session; desktop removal needs the per-pane view. */
export function terminalPanesFromLayout(layout: unknown): readonly TerminalSessionRef[] {
  const panes: TerminalSessionRef[] = [];
  for (const panel of panelsFromLayout(layout)) {
    const ref = terminalSessionFromPanel(panel);
    if (ref) panes.push(ref);
  }
  return panes;
}
