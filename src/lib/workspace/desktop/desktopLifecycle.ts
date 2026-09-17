import { settleCloseIntentObservers } from "@/lib/workspace/layout/closeIntentObservers";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import {
  panelsFromLayout,
  removePanelIdsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { prepareExplicitHmuxPaneClose } from "@/lib/workspace/pane/paneClose";
import {
	clearDesktopCloseIntent,
	desktopCloseCrossedPaneIds,
	desktopClosePaneIdentities,
	markDesktopCloseDepartureProcessed,
	markDesktopClosePaneProcessed,
	markDesktopClosePaneStarted,
	persistDesktopCloseIntent,
} from "@/lib/workspace/desktop/desktopCloseIntent";
import { enqueueDesktopCloseMutation } from "@/lib/workspace/layout/closeMutationQueue";
import {
  exactLayoutRevision,
  matchesExactPaneBinding,
} from "@/lib/workspace/layout/layoutCloseIdentity";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import {
  type TerminalSessionRef,
  terminalPanesFromLayout,
  terminalSessionsFromLayout,
} from "@/lib/workspace/layout/terminalSessionRefs";
import { nanoid } from "nanoid";
import { useStore } from "@/store";

export interface DesktopRemovalPlan {
  desktopId: string;
  terminate: readonly TerminalSessionRef[];
  preserveShared: readonly TerminalSessionRef[];
}

export function desktopLayoutSnapshot(desktopId: string): unknown {
  const api = getDockview(desktopId);
  if (api) {
    try {
      return api.toJSON();
    } catch {
      // A disposing Dockview can reject serialization; the last durable layout
      // remains a safe fallback for impact calculation.
    }
  }
  return useStore.getState().layouts[desktopId];
}

function sessionKey(ref: TerminalSessionRef): string {
  return `${ref.kind}:${ref.sessionId}`;
}

export function planDesktopRemoval(desktopId: string): DesktopRemovalPlan {
  const state = useStore.getState();
  const targetSessions = terminalSessionsFromLayout(desktopLayoutSnapshot(desktopId));
  const targetPanes = terminalPanesFromLayout(desktopLayoutSnapshot(desktopId));
  const referencedElsewhere = new Set<string>();

  for (const desktop of state.spaces) {
    if (desktop.id === desktopId) continue;
    for (const ref of terminalSessionsFromLayout(desktopLayoutSnapshot(desktop.id))) {
      referencedElsewhere.add(sessionKey(ref));
    }
  }

  return {
    desktopId,
    terminate: targetSessions.filter(
      (ref) => !ref.persistent && !referencedElsewhere.has(sessionKey(ref)),
    ),
    // Explicit Hmux departure is pane-scoped. Never collapse two views of the
    // same session here: the final departure is the one that can arm Host-owned
    // retirement after every sibling view has released its attachment.
    preserveShared: targetPanes.filter(
      (ref) => ref.persistent || referencedElsewhere.has(sessionKey(ref)),
    ),
  };
}

/**
 * Explicit desktop removal is ordered: resolve current impact, clear volatile
 * metadata for owned panes, then remove the durable layout. Non-persistent
 * `plan.terminate` refs are retired-legacy leftovers — their runtime is gone,
 * so removal only forgets their session metadata below.
 */
export async function removeDesktopWithSessions(desktopId: string): Promise<DesktopRemovalPlan> {
  return enqueueDesktopCloseMutation(desktopId, async () => {
  const initialLayout = desktopLayoutSnapshot(desktopId);
  const expectedLayoutRevision = exactLayoutRevision(initialLayout);
  const plan = planDesktopRemoval(desktopId);
  const expectedPanes = desktopClosePaneIdentities(
    initialLayout,
    new Set(plan.preserveShared.map((pane) => pane.panelId)),
  );

  // Everything before this point can still fail while the desktop remains
  // useful. From here onward Hmux departure may arm retirement, so persist the
  // user's exact desktop-close intent before crossing that boundary.
  const exactDesktopStillMatches = () => {
    const layout = desktopLayoutSnapshot(desktopId);
    if (exactLayoutRevision(layout) !== expectedLayoutRevision) return false;
    const panels = new Map(
      panelsFromLayout(layout).map((panel) => [panel.id, panel.params]),
    );
    return (
      panels.size === expectedPanes.length &&
      expectedPanes.every((expected) => {
        const params = panels.get(expected.panelId);
        return (
          params !== undefined &&
          matchesExactPaneBinding(params, expected.binding)
        );
      })
    );
  };
  if (!exactDesktopStillMatches()) {
    throw new PaneCommandError(
      "pane_changed",
      `desktop ${desktopId} changed during terminal teardown`,
    );
  }
  let closeIntent = persistDesktopCloseIntent({
    operationId: nanoid(),
    desktopId,
    expectedLayoutRevision,
    expectedPanes,
  });
  const api = getDockview(desktopId);
  const reconcileCrossedDepartures = () => {
    const layout = desktopLayoutSnapshot(desktopId);
    const crossed = desktopCloseCrossedPaneIds(layout, closeIntent);
    if (crossed.size > 0) {
      const currentApi = getDockview(desktopId);
      if (currentApi) {
        for (const panelId of crossed) {
          const crossedPanel = currentApi.getPanel(panelId);
          if (crossedPanel) currentApi.removePanel(crossedPanel);
        }
        useStore.getState().saveLayout(desktopId, currentApi.toJSON());
      } else {
        useStore
          .getState()
          .saveLayout(
            desktopId,
            removePanelIdsFromLayout(layout, crossed),
          );
      }
    }
    clearDesktopCloseIntent(desktopId);
  };
  if (api) {
    // Departure may irreversibly arm retirement. From here to desktop removal,
    // Hmux adapters are fail-preserving and return typed receipts instead of
    // throwing.
    for (const ref of plan.preserveShared) {
      const panel = api.getPanel(ref.panelId);
      const expected = expectedPanes.find(
        (candidate) => candidate.panelId === ref.panelId,
      );
      if (
        !panel ||
        !expected ||
        !exactDesktopStillMatches() ||
        !matchesExactPaneBinding(panel.params, expected.binding)
      ) {
        const crossed = closeIntent.expectedPanes.some(
          (pane) =>
            pane.departureState === "started" ||
            pane.departureState === "processed",
        );
        if (crossed) reconcileCrossedDepartures();
        else clearDesktopCloseIntent(desktopId);
        throw new PaneCommandError(
          "pane_changed",
          `pane ${ref.panelId} changed before desktop departure`,
        );
      }
      closeIntent = markDesktopClosePaneStarted(
        closeIntent,
        ref.panelId,
      );
      try {
        await settleCloseIntentObservers(desktopId);
        if (
          getDockview(desktopId) !== api ||
          !matchesExactPaneBinding(api.getPanel(ref.panelId)?.params, expected.binding)
        ) {
          throw new PaneCommandError(
            "pane_changed", `pane ${ref.panelId} changed during attachment retirement`,
          );
        }
        await prepareExplicitHmuxPaneClose({
          desktopId,
          panelId: ref.panelId,
          params: panel.params,
        });
        closeIntent = markDesktopClosePaneProcessed(
          closeIntent,
          ref.panelId,
        );
      } catch (error) {
        reconcileCrossedDepartures();
        throw error;
      }
      if (
        !exactDesktopStillMatches() ||
        !api.getPanel(ref.panelId) ||
        !matchesExactPaneBinding(
          api.getPanel(ref.panelId)?.params,
          expected.binding,
        )
      ) {
        reconcileCrossedDepartures();
        throw new PaneCommandError(
          "pane_changed",
          `pane ${ref.panelId} changed while desktop departure was pending`,
        );
      }
		}
	}
	markDesktopCloseDepartureProcessed(closeIntent);
  if (!exactDesktopStillMatches()) {
    reconcileCrossedDepartures();
    throw new PaneCommandError(
      "pane_changed",
      `desktop ${desktopId} changed before removal`,
    );
  }
	const state = useStore.getState();
  state.forgetSessionRuntime(plan.terminate.map((ref) => ref.sessionId));
  state.removeSpace(desktopId);
  clearDesktopCloseIntent(desktopId);
  return plan;
  });
}
