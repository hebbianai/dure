import { notifyCloseIntentCleared } from "@/lib/workspace/layout/closeIntentObservers";
import {
  isExactPaneBindingSnapshot,
  matchesPersistedLayoutRevision,
  matchesExactPaneBinding,
  type ExactPaneBindingSnapshot,
} from "@/lib/workspace/layout/layoutCloseIdentity";
import {
  panelsFromLayout,
  removePanelIdsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";

const KEY_PREFIX = "agent-ide-pane-close-intent-v1:";
const MAX_INTENTS = 128;
const MAX_INTENT_BYTES = 2 * 1024 * 1024;

export type PaneCloseIntentPhase =
  | "prepared"
  | "departure_started"
  | "departure_processed";

export interface PaneCloseIntentV1 {
  schemaVersion: 1;
  operationId: string;
  desktopId: string;
  panelId: string;
  expectedLayoutRevision: string;
  removedLayoutRevision: string;
  expectedBinding: ExactPaneBindingSnapshot;
  originalLayout: unknown;
  removedLayout: unknown;
  phase: PaneCloseIntentPhase;
}

export function paneCloseIntentStorageKey(
  desktopId: string,
  panelId: string,
): string {
  return `${KEY_PREFIX}${encodeURIComponent(desktopId)}:${encodeURIComponent(panelId)}`;
}

function writeIntent(intent: PaneCloseIntentV1): void {
  const encoded = JSON.stringify(intent);
  if (new TextEncoder().encode(encoded).byteLength > MAX_INTENT_BYTES) {
    throw new Error("pane_close_intent_too_large");
  }
  localStorage.setItem(
    paneCloseIntentStorageKey(intent.desktopId, intent.panelId),
    encoded,
  );
}

export function persistPaneCloseIntent(intent: PaneCloseIntentV1): void {
  writeIntent(intent);
}

export function markPaneCloseIntent(
  intent: PaneCloseIntentV1,
  phase: PaneCloseIntentPhase,
): PaneCloseIntentV1 {
  const next = { ...intent, phase };
  writeIntent(next);
  return next;
}

export function clearPaneCloseIntent(intent: PaneCloseIntentV1): void {
  localStorage.removeItem(
    paneCloseIntentStorageKey(intent.desktopId, intent.panelId),
  );
  notifyCloseIntentCleared(intent.desktopId);
}

export function readPaneCloseIntent(
  desktopId: string,
  panelId: string,
): PaneCloseIntentV1 | null {
  return parseIntent(paneCloseIntentStorageKey(desktopId, panelId));
}

function parseIntent(key: string): PaneCloseIntentV1 | null {
  try {
    const encoded = localStorage.getItem(key) ?? "";
    if (new TextEncoder().encode(encoded).byteLength > MAX_INTENT_BYTES) {
      return null;
    }
    const value = JSON.parse(encoded) as PaneCloseIntentV1;
    const expectedBinding = value.expectedBinding;
    if (
      value.schemaVersion !== 1 ||
      typeof value.operationId !== "string" ||
      typeof value.desktopId !== "string" ||
      typeof value.panelId !== "string" ||
      typeof value.expectedLayoutRevision !== "string" ||
      typeof value.removedLayoutRevision !== "string" ||
      !isExactPaneBindingSnapshot(expectedBinding) ||
      !["prepared", "departure_started", "departure_processed"].includes(
        value.phase,
      ) ||
      !matchesPersistedLayoutRevision(
        value.originalLayout,
        value.originalLayout,
        value.expectedLayoutRevision,
      ) ||
      !matchesPersistedLayoutRevision(
        value.removedLayout,
        value.removedLayout,
        value.removedLayoutRevision,
      ) ||
      !panelsFromLayout(value.originalLayout).some(
        (panel) =>
          panel.id === value.panelId &&
          matchesExactPaneBinding(panel.params, expectedBinding),
      ) ||
      panelsFromLayout(value.removedLayout).some(
        (panel) => panel.id === value.panelId,
      ) ||
      key !== paneCloseIntentStorageKey(value.desktopId, value.panelId)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function paneCloseCrossedPanelIds(
  layout: unknown,
  intent: PaneCloseIntentV1,
): ReadonlySet<string> {
  if (
    intent.phase !== "departure_started" &&
    intent.phase !== "departure_processed"
  ) {
    return new Set();
  }
  const current = panelsFromLayout(layout).find(
    (panel) => panel.id === intent.panelId,
  );
  return new Set(
    current && matchesExactPaneBinding(current.params, intent.expectedBinding)
      ? [intent.panelId]
      : [],
  );
}

/**
 * Before the Host boundary, restore only the exact optimistic removal. Once
 * departure may have crossed, remove that exact old pane from any newer layout
 * while preserving sibling additions/reorders and retargeted replacements.
 */
export function replayPaneCloseIntents(): void {
  const intents: Array<{ key: string; value: PaneCloseIntentV1 }> = [];
  try {
    for (
      let index = 0;
      index < localStorage.length && intents.length < MAX_INTENTS;
      index += 1
    ) {
      const key = localStorage.key(index);
      if (!key?.startsWith(KEY_PREFIX)) continue;
      const value = parseIntent(key);
      if (value) intents.push({ key, value });
    }
  } catch {
    return;
  }

  for (const { key, value } of intents) {
    try {
      const state = useStore.getState();
      const current = state.layouts[value.desktopId];
      if (
        value.phase === "prepared" &&
        matchesPersistedLayoutRevision(
          current,
          value.removedLayout,
          value.removedLayoutRevision,
        )
      ) {
        state.saveLayout(value.desktopId, value.originalLayout);
      } else {
        const crossed = paneCloseCrossedPanelIds(current, value);
        if (crossed.size > 0) {
          state.saveLayout(
            value.desktopId,
            removePanelIdsFromLayout(current, crossed),
          );
        }
      }
      // A moved, new, or retargeted pane is a newer generation and survives.
      // The exact crossed pane has now been reconciled from divergent layouts.
      localStorage.removeItem(key);
    } catch {
      // Retain the journal when store persistence itself faults.
    }
  }
}
