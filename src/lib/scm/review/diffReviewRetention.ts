import { reviewIdsFromLayouts } from "@/lib/scm/review/diffReviewTarget";
import { reconcileDiffReviewTargets } from "@/lib/ipc";
import { useStore } from "@/store";

interface PendingReconciliation {
  readonly activeReviewIds: readonly string[];
  readonly observedAtMs: number;
}

let lastObservedAtMs = 0;
let pending: PendingReconciliation | undefined;
let draining = false;

function nextObservedAtMs(now: number): number {
  lastObservedAtMs = Math.max(now, lastObservedAtMs + 1);
  return lastObservedAtMs;
}

async function drainReconciliations(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending) {
      const current = pending;
      pending = undefined;
      try {
        await reconcileDiffReviewTargets(
          current.activeReviewIds,
          current.observedAtMs,
        );
      } catch (error) {
        // Reconciliation is deliberately fail-safe: a missed sweep leaks old
        // inactive rows, while a later layout write or app launch retries.
        console.warn("[diff review retention]", error);
      }
    }
  } finally {
    draining = false;
  }
}

function scheduleReconciliation(
  layouts: Readonly<Record<string, unknown>>,
  now: number = Date.now(),
): void {
  pending = {
    activeReviewIds: reviewIdsFromLayouts(layouts),
    observedAtMs: nextObservedAtMs(now),
  };
  void drainReconciliations();
}

/** Reconcile immediately after a target create that may race the layout save. */
export function syncCurrentDiffReviewTargets(): void {
  scheduleReconciliation(useStore.getState().layouts);
}

/**
 * Keep SQLite review roots aligned with the globally persisted Dock layouts.
 * Every update sends a complete root snapshot; the backend serializes marking
 * and sweeping in one transaction and rejects older per-target observations.
 */
export function startDiffReviewTargetRetention(): () => void {
  scheduleReconciliation(useStore.getState().layouts);
  return useStore.subscribe((state, previous) => {
    if (state.layouts !== previous.layouts) {
      scheduleReconciliation(state.layouts);
    }
  });
}
