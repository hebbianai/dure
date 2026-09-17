import { settleCloseIntentObservers } from "@/lib/workspace/layout/closeIntentObservers";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { nanoid } from "nanoid";
import { enqueueDesktopCloseMutation } from "@/lib/workspace/layout/closeMutationQueue";
import {
  dockviewRegistry as registry,
  movingPanels,
  runDockviewProjectionOnly,
} from "@/lib/workspace/dock/dockRegistry";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import {
  exactPaneBindingSnapshot,
  matchesPersistedLayoutRevision,
  matchesExactPaneBinding,
  persistedLayoutRevision,
} from "@/lib/workspace/layout/layoutCloseIdentity";
import {
  panelsFromLayout,
  removePanelIdsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { publishLayoutPush } from "@/lib/workspace/layout/layoutPushChannel";
import { prepareExplicitHmuxPaneClose } from "@/lib/workspace/pane/paneClose";
import {
  clearPaneCloseIntent,
  markPaneCloseIntent,
  paneCloseCrossedPanelIds,
  persistPaneCloseIntent,
  type PaneCloseIntentV1,
} from "@/lib/workspace/pane/paneCloseIntent";
import { removePanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { HmuxPaneDepartureReceipt } from "@/lib/ipc";
import { useStore } from "@/store";

export interface ClosePanelReceipt {
  desktopId: string;
  mode: "live" | "persisted";
  departure?: HmuxPaneDepartureReceipt;
}

/**
 * Close one mounted pane generation with a durable before/after journal.
 * Layout siblings are deliberately not part of the final CAS: they may split,
 * move, or reorder while the Host departure is pending.
 */
async function closeMountedPanel(
  desktopId: string,
  panelId: string,
): Promise<ClosePanelReceipt | null> {
  const api = registry.get(desktopId);
  if (!api) return null;
  const panel = api.getPanel(panelId);
  if (!panel) return null;

  return enqueueDesktopCloseMutation(desktopId, async () => {
    if (registry.get(desktopId) !== api || api.getPanel(panelId) !== panel) {
      throw new PaneCommandError(
        "pane_changed",
        `pane ${panelId} changed before close started`,
      );
    }
    const originalLayout = api.toJSON();
    const removedLayout = removePanelIdsFromLayout(
      originalLayout,
      new Set([panelId]),
    );
    let intent: PaneCloseIntentV1 = {
      schemaVersion: 1,
      operationId: nanoid(),
      desktopId,
      panelId,
      expectedLayoutRevision: persistedLayoutRevision(originalLayout),
      removedLayoutRevision: persistedLayoutRevision(removedLayout),
      expectedBinding: exactPaneBindingSnapshot(panel.params),
      originalLayout,
      removedLayout,
      phase: "prepared",
    };
    persistPaneCloseIntent(intent);
    useStore.getState().saveLayout(desktopId, removedLayout);
    publishLayoutPush([desktopId]);

    const preDepartureStillExact = () =>
      registry.get(desktopId) === api &&
      api.getPanel(panelId) === panel &&
      matchesExactPaneBinding(panel.params, intent.expectedBinding) &&
      matchesPersistedLayoutRevision(
        api.toJSON(),
        intent.originalLayout,
        intent.expectedLayoutRevision,
      ) &&
      matchesPersistedLayoutRevision(
        useStore.getState().layouts[desktopId],
        intent.removedLayout,
        intent.removedLayoutRevision,
      );
    const preserveCurrentLayout = () => {
      useStore.getState().saveLayout(desktopId, api.toJSON());
      publishLayoutPush([desktopId]);
      clearPaneCloseIntent(intent);
    };

    if (!preDepartureStillExact()) {
      preserveCurrentLayout();
      throw new PaneCommandError(
        "pane_changed",
        `pane ${panelId} changed before graceful departure`,
      );
    }
    try {
      intent = markPaneCloseIntent(intent, "departure_started");
    } catch (error) {
      preserveCurrentLayout();
      throw error;
    }
    await settleCloseIntentObservers(desktopId);
    if (
      registry.get(desktopId) !== api || api.getPanel(panelId) !== panel ||
      !matchesExactPaneBinding(panel.params, intent.expectedBinding)
    ) {
      preserveCurrentLayout();
      throw new PaneCommandError(
        "pane_changed", `pane ${panelId} changed during attachment retirement`,
      );
    }
    const departure = await prepareExplicitHmuxPaneClose({
      desktopId,
      panelId,
      params: panel.params,
    });
    intent = markPaneCloseIntent(intent, "departure_processed");
    const targetStillExact =
      registry.get(desktopId) === api &&
      api.getPanel(panelId) === panel &&
      matchesExactPaneBinding(panel.params, intent.expectedBinding);
    if (!targetStillExact) {
      preserveCurrentLayout();
      throw new PaneCommandError(
        "pane_changed",
        `pane ${panelId} changed while graceful departure was pending`,
      );
    }

    const currentLayout = api.toJSON();
    const crossed = paneCloseCrossedPanelIds(currentLayout, intent);
    const reconciledLayout = removePanelIdsFromLayout(
      currentLayout,
      crossed,
    );
    useStore.getState().saveLayout(desktopId, reconciledLayout);
    publishLayoutPush([desktopId]);
    removePanePreservingSizes(api, panel);
    clearPaneCloseIntent(intent);
    return {
      desktopId,
      mode: "live" as const,
      ...(departure ? { departure } : {}),
    };
  });
}

async function closePersistedPanel(
  desktopId: string,
  panelId: string,
): Promise<ClosePanelReceipt | null> {
  return enqueueDesktopCloseMutation(desktopId, async () => {
    const current = useStore.getState().layouts[desktopId];
    const currentEntry = panelsFromLayout(current).find(
      (candidate) => candidate.id === panelId,
    );
    if (!currentEntry) return null;
    // Removing a persisted pane never terminates a session: Hmux sessions are
    // Host-owned and survive their views, and retired legacy panes own no
    // session at all (legacy runtime retirement, 2026-08-16).
    useStore
      .getState()
      .saveLayout(
        desktopId,
        removePanelIdsFromLayout(current, new Set([panelId])),
      );
    return { desktopId, mode: "persisted" as const };
  });
}

/** Find a panel by durable identity and close exactly its current generation. */
export async function closePanelById(
  panelId: string,
  targetDesktopId?: string,
): Promise<ClosePanelReceipt | null> {
  const mountedDesktopIds = targetDesktopId
    ? [targetDesktopId]
    : [...registry.keys()];
  for (const desktopId of mountedDesktopIds) {
    const receipt = await closeMountedPanel(desktopId, panelId);
    if (receipt) return receipt;
  }

  const layouts = useStore.getState().layouts;
  const persistedDesktopIds = targetDesktopId
    ? [targetDesktopId]
    : Object.keys(layouts);
  for (const desktopId of persistedDesktopIds) {
    if (
      !panelsFromLayout(useStore.getState().layouts[desktopId]).some(
        (panel) => panel.id === panelId,
      )
    ) {
      continue;
    }
    return closePersistedPanel(desktopId, panelId);
  }
  return null;
}

export interface KillPanelsReceipt {
  closed: number;
  failed: { panelId: string; error: unknown }[];
}

/**
 * 여러 pane을 순서대로 닫는다. 하나가 실패해도(다른 pane이 하이드레이션을
 * 끝내며 pane_changed를 던지는 등) 나머지는 계속 닫고, 실패 목록을 영수증으로
 * 돌려준다 — 호출자가 사용자에게 부분 실패를 알릴 책임을 진다.
 */
export async function killPanels(
  items: readonly { panelId: string; desktopId: string }[],
): Promise<KillPanelsReceipt> {
  const receipt: KillPanelsReceipt = { closed: 0, failed: [] };
  for (const item of items) {
    try {
      await closePanelById(item.panelId, item.desktopId);
      receipt.closed += 1;
    } catch (error) {
      receipt.failed.push({ panelId: item.panelId, error });
    }
  }
  return receipt;
}

/**
 * Remove UI references after their runtime has already been terminated. The
 * moving lock prevents Workspace's normal close handler from killing twice.
 */
export function removePanelsWithoutSessionTeardown(
  panelIds: readonly string[],
): void {
  const ids = new Set(panelIds);
  if (ids.size === 0) return;
	removeMountedPanelsWithoutSessionTeardown(panelIds);

	const state = useStore.getState();
	for (const [desktopId, layout] of Object.entries(state.layouts)) {
		state.saveLayout(desktopId, removePanelIdsFromLayout(layout, ids));
	}
}

function removeMountedPaneWithoutSessionTeardown(
	api: DockviewApi,
	panel: IDockviewPanel,
): void {
	movingPanels.add(panel.id);
	try {
		removePanePreservingSizes(api, panel);
	} finally {
		movingPanels.delete(panel.id);
	}
}

/** Capture one view generation for creation compensation. Losing or retargeting
 * this optional view never grants authority over another view or its process. */
export function preparePaneProjectionRemoval(
	desktopId: string,
	api: DockviewApi,
	panel: IDockviewPanel,
): () => boolean {
	const binding = exactPaneBindingSnapshot(panel.params);
	return () => {
		if (
			registry.get(desktopId) !== api ||
			api.getPanel(panel.id) !== panel ||
			!matchesExactPaneBinding(panel.params, binding)
		) return false;
		return commitExplicitDockviewMutation({
			desktopId,
			api,
			mutate: () => {
				runDockviewProjectionOnly(api, () =>
					removeMountedPaneWithoutSessionTeardown(api, panel),
				);
				return true;
			},
			targetChangedError: () =>
				new PaneCommandError(
					"pane_changed",
					"pane owner changed during creation compensation",
				),
		});
	};
}

/** Remove already-stopped mounted views without writing the durable layout. */
export function removeMountedPanelsWithoutSessionTeardown(
	panelIds: readonly string[],
): void {
	const ids = new Set(panelIds);
	if (ids.size === 0) return;

	for (const api of registry.values()) {
		runDockviewProjectionOnly(api, () => {
			for (const id of ids) {
				const panel = api.getPanel(id);
				if (!panel) continue;
				removeMountedPaneWithoutSessionTeardown(api, panel);
			}
		});
	}
}
