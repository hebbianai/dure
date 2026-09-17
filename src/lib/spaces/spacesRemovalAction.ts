import { t } from "@/lib/i18n";

export interface SpacesRemovalCandidate {
  readonly panelId: string;
  readonly desktopId: string;
  readonly kind: "agent" | "term" | "ssh";
  readonly agentId?: string;
}

export type SpacesRemovalIntent =
  | {
      readonly kind: "agent-dialog";
      readonly agentId: string;
      readonly items: readonly SpacesRemovalItem[];
    }
  | {
      readonly kind: "sessions";
      readonly items: readonly SpacesRemovalItem[];
      /** Registered agents caught in the bulk pane kill. Their destruction
       *  scope is narrower than the label suggests — only the pane closes —
       *  so the confirm copy must say what survives. */
      readonly agentCount: number;
    };

interface SpacesRemovalItem {
  readonly panelId: string;
  readonly desktopId: string;
}

/**
 * A registered agent has resource ownership beyond its visible pane, so its
 * destructive action must go through the resource dialog. Multi-selection and
 * standalone sessions keep the existing pane/session termination contract.
 */
export function planSpacesRemoval(
  candidates: readonly SpacesRemovalCandidate[],
): SpacesRemovalIntent {
  const items = candidates.map(({ panelId, desktopId }) => ({
    panelId,
    desktopId,
  }));
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only?.kind === "agent" && only.agentId) {
    return { kind: "agent-dialog", agentId: only.agentId, items };
  }
  return {
    kind: "sessions",
    items,
    agentCount: candidates.filter(
      (candidate) => candidate.kind === "agent" && candidate.agentId,
    ).length,
  };
}

/**
 * Confirm copy for the bulk session termination path. The same menu label
 * ("Kill n sessions") destroys different amounts depending on the row kind:
 * terminals lose their session, but a registered agent only loses its pane —
 * its registration and worktree stay. When agents are in scope, say so.
 */
export function spacesRemovalConfirmMessage(
  intent: Extract<SpacesRemovalIntent, { kind: "sessions" }>,
): string {
  const base =
    intent.items.length > 1
      ? t("spaces.kill.confirmMany", { n: intent.items.length })
      : t("spaces.kill.confirmOne");
  // Single line — the question renders in an InlineConfirmRow (SOUL §6),
  // where the risk note appends to the question instead of a dialog body.
  return intent.agentCount > 0
    ? `${base} ${t("spaces.kill.agentsKeepRegistration")}`
    : base;
}
