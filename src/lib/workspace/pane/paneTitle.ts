import { normalizeAgentDisplayName } from "@/lib/agents/agentDisplayName";

export function cwdName(cwd?: string): string | undefined {
  const value = cwd?.trim();
  if (!value) return undefined;
  if (value === "/" || /^[A-Za-z]:[\\/]?$/.test(value)) return value;
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop();
}

export function agentPaneTitle(
  agentName: string,
  ...directoryCandidates: Array<string | undefined>
): string {
  return directoryCandidates.map(cwdName).find(Boolean) ?? agentName;
}

export function terminalPaneTitle(hostLabel: string, cwd?: string): string {
  const directory = cwdName(cwd);
  return directory ? `${hostLabel} · ${directory}` : hostLabel;
}

/** A runtime title worth showing as a name: trimmed, non-empty, and not the
 * provider's opaque conversation identity leaking through as if it were one.
 * Both the pane header and the Spaces row decide through this, so a title
 * that one of them shows is never one the other hides. */
export function observedTitle(
  runtimeTitle: string | undefined,
  opaqueConversationId?: string,
): string | undefined {
  const observed = runtimeTitle?.trim();
  if (!observed || observed === opaqueConversationId?.trim()) return undefined;
  return observed;
}

/** Prefer a runtime's replaceable presentation title without exposing the
 * provider's opaque conversation identity as a human-facing pane name. */
export function paneTitleFromObservedTitle(
  runtimeTitle: string | undefined,
  fallback: string,
  opaqueConversationId?: string,
): string {
  return observedTitle(runtimeTitle, opaqueConversationId) ?? fallback;
}

/** One authority for the Agent title rendered by Dockview, PaneChrome, and
 * Spaces. A name the user explicitly chose wins; replaceable provider evidence
 * comes next; directory identity is the stable fallback. */
export function resolveAgentPaneTitle({
  name,
  displayName,
  runtimeTitle,
  opaqueConversationId,
  directoryCandidates = [],
}: {
  name: string;
  displayName?: string;
  runtimeTitle?: string;
  opaqueConversationId?: string;
  directoryCandidates?: readonly (string | undefined)[];
}): string {
  const explicitName = normalizeAgentDisplayName(name, displayName);
  if (explicitName) return explicitName;
  return paneTitleFromObservedTitle(
    runtimeTitle,
    agentPaneTitle(name, ...directoryCandidates),
    opaqueConversationId,
  );
}

/** Keep the effective title in diagnostics without repeating it when the
 * metadata description already begins with that same title. */
export function paneTitleTooltip(title: string, detail: string): string {
  return detail === title || detail.startsWith(`${title} ·`)
    ? detail
    : `${title} — ${detail}`;
}
