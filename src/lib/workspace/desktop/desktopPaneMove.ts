import {
  appendPanelToLayout,
  isSerializedDockviewLayout,
  panelDefinitionFromLayout,
  panelsFromLayout,
  removePanelIdsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";

export interface DesktopPaneMoveItem {
  panelId: string;
  fromDesktopId: string;
}

export interface DesktopPaneMovePlan {
  updates: Record<string, unknown>;
  movedPanelIds: string[];
  alreadyAtTargetPanelIds: string[];
  missingPanelIds: string[];
  touchedDesktopIds: string[];
  error?: {
    code:
      | "invalid_source_layout"
      | "invalid_target_layout"
      | "layout_snapshot_failed"
      | "target_projection_failed"
      | "target_snapshot_failed"
      | "persistence_failed"
      | "move_execution_failed";
    desktopId: string;
  };
}

function emptyLayoutFrom(template: unknown): unknown | null {
  if (!isSerializedDockviewLayout(template)) return null;
  const panelIds = new Set(panelsFromLayout(template).map((panel) => panel.id));
  const empty = removePanelIdsFromLayout(template, panelIds);
  return isSerializedDockviewLayout(empty) ? empty : null;
}

function emptyPlan(): DesktopPaneMovePlan {
  return {
    updates: {},
    movedPanelIds: [],
    alreadyAtTargetPanelIds: [],
    missingPanelIds: [],
    touchedDesktopIds: [],
  };
}

/**
 * Produce one write-through layout transaction. Mounted Dockviews are supplied
 * to this function as fresh serialized snapshots by the caller; unmounted
 * spaces use their persisted layout. The result never mutates its inputs.
 */
export function planDesktopPaneMove(
  layouts: Readonly<Record<string, unknown>>,
  items: readonly DesktopPaneMoveItem[],
  targetDesktopId: string,
): DesktopPaneMovePlan {
  const result = emptyPlan();
  const targetLayout = layouts[targetDesktopId];
  if (targetLayout !== undefined && !isSerializedDockviewLayout(targetLayout)) {
    result.error = {
      code: "invalid_target_layout",
      desktopId: targetDesktopId,
    };
    return result;
  }

  const uniqueItems: DesktopPaneMoveItem[] = [];
  const requestedIds = new Set<string>();
  for (const item of items) {
    const panelId = item.panelId.trim();
    const fromDesktopId = item.fromDesktopId.trim();
    if (
      !panelId ||
      !fromDesktopId ||
      fromDesktopId === targetDesktopId ||
      requestedIds.has(panelId)
    ) {
      continue;
    }
    requestedIds.add(panelId);
    uniqueItems.push({ panelId, fromDesktopId });
  }

  const working: Record<string, unknown> = { ...layouts };
  const updates: Record<string, unknown> = {};
  let nextTarget = targetLayout;

  for (const item of uniqueItems) {
    const source = working[item.fromDesktopId];
    if (source !== undefined && !isSerializedDockviewLayout(source)) {
      return {
        ...emptyPlan(),
        error: {
          code: "invalid_source_layout",
          desktopId: item.fromDesktopId,
        },
      };
    }

    const definition = panelDefinitionFromLayout(source, item.panelId);
    const alreadyAtTarget =
      panelDefinitionFromLayout(nextTarget, item.panelId) !== undefined;
    if (definition === undefined) {
      if (alreadyAtTarget) result.alreadyAtTargetPanelIds.push(item.panelId);
      else result.missingPanelIds.push(item.panelId);
      continue;
    }

    for (const [desktopId, layout] of Object.entries(working)) {
      if (desktopId === targetDesktopId) continue;
      if (panelDefinitionFromLayout(layout, item.panelId) === undefined) continue;
      if (!isSerializedDockviewLayout(layout)) {
        return {
          ...emptyPlan(),
          error: {
            code: "invalid_source_layout",
            desktopId,
          },
        };
      }
      const cleaned = removePanelIdsFromLayout(layout, new Set([item.panelId]));
      working[desktopId] = cleaned;
      updates[desktopId] = cleaned;
    }

    if (!alreadyAtTarget) {
      const base = nextTarget ?? emptyLayoutFrom(source);
      if (!base) {
        return {
          ...emptyPlan(),
          error: {
            code: "invalid_source_layout",
            desktopId: item.fromDesktopId,
          },
        };
      }
      const appended = appendPanelToLayout(base, item.panelId, definition);
      if (!appended) {
        return {
          ...emptyPlan(),
          error: {
            code: "invalid_target_layout",
            desktopId: targetDesktopId,
          },
        };
      }
      nextTarget = appended;
      working[targetDesktopId] = appended;
      updates[targetDesktopId] = appended;
    }
    result.movedPanelIds.push(item.panelId);
  }

  result.updates = updates;
  result.touchedDesktopIds = Object.keys(updates);
  return result;
}

export interface MovePanelsToDesktopReceipt extends DesktopPaneMovePlan {
  projectedDesktopIds: string[];
  projectionFailedDesktopIds: string[];
}

export function moveFailure(
  code: NonNullable<DesktopPaneMovePlan["error"]>["code"],
  desktopId: string,
): MovePanelsToDesktopReceipt {
  return {
    updates: {},
    movedPanelIds: [],
    alreadyAtTargetPanelIds: [],
    missingPanelIds: [],
    touchedDesktopIds: [],
    projectedDesktopIds: [],
    projectionFailedDesktopIds: [],
    error: { code, desktopId },
  };
}

/** persisted 레이아웃 위에 live dockview 상태를 덮어 스냅샷한다.
 *  liveDockviews: 이 창에 mount된 desktopId → api (dock.ts registry 주입). */
export function snapshotAffectedLayouts(
  persistedLayouts: Record<string, unknown>,
  items: readonly DesktopPaneMoveItem[],
  targetDesktopId: string,
  liveDockviews: ReadonlyMap<string, { toJSON(): unknown }>,
): { layouts: Record<string, unknown> } | { errorDesktopId: string } {
  const layouts = { ...persistedLayouts };
  const affectedDesktopIds = new Set([
    targetDesktopId,
    ...items.map((item) => item.fromDesktopId),
  ]);
  for (const desktopId of affectedDesktopIds) {
    const api = liveDockviews.get(desktopId);
    if (!api) continue;
    try {
      layouts[desktopId] = api.toJSON();
    } catch {
      return { errorDesktopId: desktopId };
    }
  }
  return { layouts };
}
