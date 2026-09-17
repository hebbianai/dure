import { notifyCloseIntentCleared } from "@/lib/workspace/layout/closeIntentObservers";
import {
  exactLayoutRevision,
  exactPaneBindingSnapshot,
  isExactPaneBindingSnapshot,
  matchesExactPaneBinding,
  type ExactPaneBindingSnapshot,
} from "@/lib/workspace/layout/layoutCloseIdentity";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { removePanelIdsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";

const KEY_PREFIX = "agent-ide-desktop-close-intent-v1:";
const MAX_INTENTS = 128;
const MAX_INTENT_BYTES = 2 * 1024 * 1024;
const MAX_PANES_PER_INTENT = 2_048;
const MAX_IDENTIFIER_BYTES = 512;

export interface DesktopClosePaneIdentity {
  panelId: string;
  binding: ExactPaneBindingSnapshot;
  departureState: "not_required" | "pending" | "started" | "processed";
}

export interface DesktopCloseIntentV1 {
  schemaVersion: 1;
  operationId: string;
  desktopId: string;
  expectedLayoutRevision: string;
  expectedPanes: readonly DesktopClosePaneIdentity[];
  phase: "prepared" | "departure_processed";
}

export function desktopCloseIntentStorageKey(desktopId: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(desktopId)}`;
}

export function desktopClosePaneIdentities(
  layout: unknown,
  departurePanelIds: ReadonlySet<string> = new Set(),
): readonly DesktopClosePaneIdentity[] {
  return panelsFromLayout(layout).map((panel) => ({
    panelId: panel.id,
    binding: exactPaneBindingSnapshot(panel.params),
    departureState: departurePanelIds.has(panel.id)
      ? "pending"
      : "not_required",
  }));
}

/** Persisted only after failure-prone legacy teardown has completed. */
export function persistDesktopCloseIntent(
  input: Omit<DesktopCloseIntentV1, "schemaVersion" | "phase">,
): DesktopCloseIntentV1 {
  const intent: DesktopCloseIntentV1 = {
    schemaVersion: 1,
    ...input,
    phase: "prepared",
  };
  return writeDesktopCloseIntent(intent);
}

/** Crossed only after every explicit Hmux departure attempt has completed. */
export function markDesktopCloseDepartureProcessed(
  intent: DesktopCloseIntentV1,
): DesktopCloseIntentV1 {
  const processed: DesktopCloseIntentV1 = {
    ...intent,
    phase: "departure_processed",
  };
  return writeDesktopCloseIntent(processed);
}

function writeDesktopCloseIntent(
  intent: DesktopCloseIntentV1,
): DesktopCloseIntentV1 {
  const encoded = JSON.stringify(intent);
  if (new TextEncoder().encode(encoded).byteLength > MAX_INTENT_BYTES) {
    throw new Error("desktop_close_intent_too_large");
  }
  localStorage.setItem(
    desktopCloseIntentStorageKey(intent.desktopId),
    encoded,
  );
  return intent;
}

export function markDesktopClosePaneStarted(
  intent: DesktopCloseIntentV1,
  panelId: string,
): DesktopCloseIntentV1 {
  return writeDesktopCloseIntent({
    ...intent,
    expectedPanes: intent.expectedPanes.map((pane) =>
      pane.panelId === panelId && pane.departureState === "pending"
        ? { ...pane, departureState: "started" as const }
        : pane,
    ),
  });
}

export function markDesktopClosePaneProcessed(
  intent: DesktopCloseIntentV1,
  panelId: string,
): DesktopCloseIntentV1 {
  return writeDesktopCloseIntent({
    ...intent,
    expectedPanes: intent.expectedPanes.map((pane) =>
      pane.panelId === panelId &&
      (pane.departureState === "pending" ||
        pane.departureState === "started")
        ? { ...pane, departureState: "processed" as const }
        : pane,
    ),
  });
}

export function clearDesktopCloseIntent(desktopId: string): void {
  localStorage.removeItem(desktopCloseIntentStorageKey(desktopId));
  notifyCloseIntentCleared(desktopId);
}

function exactLayoutStillMatches(
  layout: unknown,
  intent: DesktopCloseIntentV1,
): boolean {
  if (exactLayoutRevision(layout) !== intent.expectedLayoutRevision) return false;
  const panels = new Map(
    panelsFromLayout(layout).map((panel) => [panel.id, panel.params]),
  );
  return (
    panels.size === intent.expectedPanes.length &&
    intent.expectedPanes.every((expected) => {
      const params = panels.get(expected.panelId);
      return (
        params !== undefined &&
        matchesExactPaneBinding(params, expected.binding)
      );
    })
  );
}

export function readDesktopCloseIntent(
  desktopId: string,
): DesktopCloseIntentV1 | null {
  return parseIntent(desktopCloseIntentStorageKey(desktopId));
}

function parseIntent(storageKey: string): DesktopCloseIntentV1 | null {
  try {
    const encoded = localStorage.getItem(storageKey) ?? "";
    if (new TextEncoder().encode(encoded).byteLength > MAX_INTENT_BYTES) {
      return null;
    }
    const value = JSON.parse(encoded) as DesktopCloseIntentV1;
    const identifierIsValid = (candidate: unknown) =>
      typeof candidate === "string" &&
      candidate.length > 0 &&
      new TextEncoder().encode(candidate).byteLength <=
        MAX_IDENTIFIER_BYTES;
    const panelIds = Array.isArray(value.expectedPanes)
      ? value.expectedPanes.map((pane) => pane?.panelId)
      : [];
    if (
      value.schemaVersion !== 1 ||
      !identifierIsValid(value.operationId) ||
      !identifierIsValid(value.desktopId) ||
      typeof value.expectedLayoutRevision !== "string" ||
      !Array.isArray(value.expectedPanes) ||
      value.expectedPanes.length > MAX_PANES_PER_INTENT ||
      new Set(panelIds).size !== panelIds.length ||
      value.expectedPanes.some(
        (pane) =>
          !pane ||
          typeof pane !== "object" ||
          !identifierIsValid(pane.panelId) ||
          !isExactPaneBindingSnapshot(pane.binding) ||
          !["not_required", "pending", "started", "processed"].includes(
            pane.departureState,
          ),
      ) ||
      storageKey !== desktopCloseIntentStorageKey(value.desktopId) ||
      !["prepared", "departure_processed"].includes(value.phase)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function desktopCloseCrossedPaneIds(
  layout: unknown,
  intent: DesktopCloseIntentV1,
): ReadonlySet<string> {
  const current = new Map(
    panelsFromLayout(layout).map((panel) => [panel.id, panel.params]),
  );
  return new Set(
    intent.expectedPanes
      .filter(
        (pane) =>
          (pane.departureState === "started" ||
            pane.departureState === "processed") &&
          current.has(pane.panelId) &&
          matchesExactPaneBinding(current.get(pane.panelId), pane.binding),
      )
      .map((pane) => pane.panelId),
  );
}

/** Finish only the exact desktop generation whose departures completed. */
export function replayDesktopCloseIntents(): void {
  const intents: Array<{ key: string; intent: DesktopCloseIntentV1 }> = [];
  try {
    for (
      let index = 0;
      index < localStorage.length && intents.length < MAX_INTENTS;
      index += 1
    ) {
      const key = localStorage.key(index);
      if (!key?.startsWith(KEY_PREFIX)) continue;
      const intent = parseIntent(key);
      if (intent) intents.push({ key, intent });
    }
  } catch {
    return;
  }

  for (const { key, intent } of intents) {
    try {
      const state = useStore.getState();
      const exists = state.spaces.some(
        (desktop) => desktop.id === intent.desktopId,
      );
      if (
        intent.phase === "departure_processed" &&
        exists &&
        exactLayoutStillMatches(state.layouts[intent.desktopId], intent)
      ) {
        state.removeSpace(intent.desktopId);
      } else if (exists) {
        const layout = state.layouts[intent.desktopId];
        const crossed = desktopCloseCrossedPaneIds(layout, intent);
        if (crossed.size > 0) {
          state.saveLayout(
            intent.desktopId,
            removePanelIdsFromLayout(layout, crossed),
          );
        }
      }
      // A moved, new, or retargeted pane is a newer desktop generation and
      // must survive. The stale close intent has no further authority.
      localStorage.removeItem(key);
    } catch {
      // Keep exact removal authority for a later startup if persistence faults.
    }
  }
}
