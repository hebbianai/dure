import {
  finiteNonNegative,
  nestedGridHasGeometryHole,
  repairNestedGridGeometry,
} from "@/lib/workspace/layout/layoutGridGeometry";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { normalizePersistedPaneDefinition, paneContentComponent } from "@/lib/workspace/layout/persistedPaneLayout";

export interface SerializedPanelRef {
  id: string;
  component?: string;
  params: Record<string, unknown>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The stable subset of Dockview's serialized-layout contract used by moves and convergence. */
export function isSerializedDockviewLayout(value: unknown): boolean {
  const layout = plainRecord(value);
  const grid = plainRecord(layout?.grid);
  const root = plainRecord(grid?.root);
  return (
    !!plainRecord(layout?.panels) &&
    root?.type === "branch" &&
    Array.isArray(root.data)
  );
}

export function panelDefinitionFromLayout(
  layout: unknown,
  panelId: string,
): unknown {
  const panels = plainRecord(plainRecord(layout)?.panels);
  return panels && Object.getOwnPropertyDescriptor(panels, panelId)
    ? panels[panelId]
    : undefined;
}

function containsPanelPlacement(value: unknown, panelId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsPanelPlacement(entry, panelId));
  }
  const record = plainRecord(value);
  if (!record) return false;
  for (const [key, entry] of Object.entries(record)) {
    if (
      (key === "views" || key === "panelIds") &&
      Array.isArray(entry) &&
      entry.includes(panelId)
    ) {
      return true;
    }
    if (containsPanelPlacement(entry, panelId)) return true;
  }
  return false;
}

/** Whether Dockview's group tree places the panel, not merely catalogs it. */
export function panelIsPlacedInLayout(layout: unknown, panelId: string): boolean {
  const record = plainRecord(layout);
  return [
    record?.grid,
    record?.floatingGroups,
    record?.popoutGroups,
    record?.edgeGroups,
  ].some((placement) => containsPanelPlacement(placement, panelId));
}

export function panelsFromLayout(layout: unknown): readonly SerializedPanelRef[] {
  const panels = recordOf(recordOf(layout)?.panels);
  if (!panels) return [];
  return Object.entries(panels).map(([id, value]) => {
    const panel = recordOf(normalizePersistedPaneDefinition(id, value));
    return {
      id,
      component: paneContentComponent(panel),
      params: recordOf(panel?.params) ?? {},
    };
  });
}

function cleanGroupState(value: unknown, panelIds: ReadonlySet<string>): boolean {
  const group = recordOf(value);
  if (!group || !Array.isArray(group.views)) return true;
  const views = group.views as unknown[];
  const remainingViews = views.filter((id) => typeof id !== "string" || !panelIds.has(id));
  group.views = remainingViews;
  if (typeof group.activeView === "string" && panelIds.has(group.activeView)) {
    if (remainingViews.length > 0) group.activeView = remainingViews[remainingViews.length - 1];
    else delete group.activeView;
  }
  if (Array.isArray(group.tabGroups)) {
    group.tabGroups = group.tabGroups
      .map((entry) => {
        const tabGroup = recordOf(entry);
        if (!tabGroup || !Array.isArray(tabGroup.panelIds)) return entry;
        tabGroup.panelIds = tabGroup.panelIds.filter(
          (id) => typeof id !== "string" || !panelIds.has(id),
        );
        return tabGroup;
      })
      .filter((entry) => {
        const tabGroup = recordOf(entry);
        return !tabGroup || !Array.isArray(tabGroup.panelIds) || tabGroup.panelIds.length > 0;
      });
  }
  return remainingViews.length > 0;
}

function cleanGridNode(nodeValue: unknown, panelIds: ReadonlySet<string>): boolean {
  const node = recordOf(nodeValue);
  if (!node) return true;
  if (node.type === "leaf") return cleanGroupState(node.data, panelIds);
  if (node.type !== "branch" || !Array.isArray(node.data)) return true;
  const children = (node.data as unknown[]).filter((child) => cleanGridNode(child, panelIds));
  node.data = children;
  return children.length > 0;
}

function cleanNestedGrid(gridValue: unknown, panelIds: ReadonlySet<string>): boolean {
  const grid = recordOf(gridValue);
  const root = recordOf(grid?.root);
  if (!root) return true;
  if (root.type === "branch" && Array.isArray(root.data)) {
    const children = (root.data as unknown[]).filter((child) =>
      cleanGridNode(child, panelIds),
    );
    root.data = children;
    return children.length > 0;
  }
  return cleanGridNode(root, panelIds);
}

function cleanFloatingGroups(value: unknown, panelIds: ReadonlySet<string>): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter((entry) => {
    const group = recordOf(entry);
    if (!group) return true;
    if (group.grid) return cleanNestedGrid(group.grid, panelIds);
    return cleanGroupState(group.data, panelIds);
  });
}

function floatingGroupsNeedRepair(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const group = recordOf(entry);
    if (!group) return false;
    if (group.grid) {
      return (
        nestedGridNeedsStructuralRepair(group.grid) ||
        nestedGridHasGeometryHole(group.grid)
      );
    }
    const data = recordOf(group.data);
    return Array.isArray(data?.views) && data.views.length === 0;
  });
}

function repairFloatingGroupGeometry(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    const grid = recordOf(entry)?.grid;
    if (grid) repairNestedGridGeometry(grid);
  }
}

/** An empty group, an empty branch, or a single-child wrapper branch below
 *  the root — every shape repairNestedGridGeometry rewrites. */
function gridNodeNeedsStructuralRepair(nodeValue: unknown): boolean {
  const node = recordOf(nodeValue);
  if (!node) return false;
  if (node.type === "leaf") {
    const group = recordOf(node.data);
    return Array.isArray(group?.views) && group.views.length === 0;
  }
  if (node.type !== "branch" || !Array.isArray(node.data)) return false;
  return node.data.length <= 1 || node.data.some(gridNodeNeedsStructuralRepair);
}

function nestedGridNeedsStructuralRepair(gridValue: unknown): boolean {
  const root = recordOf(recordOf(gridValue)?.root);
  if (!root) return false;
  if (root.type === "branch" && Array.isArray(root.data)) {
    return root.data.some(gridNodeNeedsStructuralRepair);
  }
  return gridNodeNeedsStructuralRepair(root);
}

/**
 * Repair incomplete Dockview snapshots captured during panel removal. Empty
 * branches are pruned, single-child wrapper branches collapse into their
 * parent, and a large unassigned grid extent is redistributed to its surviving
 * siblings. Normal configured splitter gaps remain untouched.
 * The root empty branch remains valid for an empty workspace.
 */
export function pruneEmptyDockviewGroups(layout: unknown): unknown {
  const source = recordOf(layout);
  if (
    !source ||
    (!nestedGridNeedsStructuralRepair(source.grid) &&
      !nestedGridHasGeometryHole(source.grid) &&
      !floatingGroupsNeedRepair(source.floatingGroups) &&
      !floatingGroupsNeedRepair(source.popoutGroups))
  ) {
    return layout;
  }

  let next: Record<string, unknown>;
  try {
    next = JSON.parse(JSON.stringify(layout)) as Record<string, unknown>;
  } catch {
    return layout;
  }
  cleanNestedGrid(next.grid, new Set<string>());
  next.floatingGroups = cleanFloatingGroups(next.floatingGroups, new Set<string>());
  next.popoutGroups = cleanFloatingGroups(next.popoutGroups, new Set<string>());
  repairNestedGridGeometry(next.grid);
  repairFloatingGroupGeometry(next.floatingGroups);
  repairFloatingGroupGeometry(next.popoutGroups);
  return next;
}

/**
 * Remove panel definitions and every Dockview group reference while preserving
 * unrelated groups. The root remains a branch even when the layout becomes
 * empty, matching Dockview's serialized-layout contract.
 */
export function removePanelIdsFromLayout(
  layout: unknown,
  panelIds: ReadonlySet<string>,
): unknown {
  if (panelIds.size === 0) return layout;
  let next: Record<string, unknown>;
  try {
    next = JSON.parse(JSON.stringify(layout)) as Record<string, unknown>;
  } catch {
    return layout;
  }

  const panels = recordOf(next.panels);
  if (panels) {
    for (const id of panelIds) delete panels[id];
  }

  cleanNestedGrid(next.grid, panelIds);
  next.floatingGroups = cleanFloatingGroups(next.floatingGroups, panelIds);
  next.popoutGroups = cleanFloatingGroups(next.popoutGroups, panelIds);
  repairNestedGridGeometry(next.grid);
  repairFloatingGroupGeometry(next.floatingGroups);
  repairFloatingGroupGeometry(next.popoutGroups);

  const edgeGroups = recordOf(next.edgeGroups);
  if (edgeGroups) {
    for (const [position, edgeValue] of Object.entries(edgeGroups)) {
      const edge = recordOf(edgeValue);
      if (edge?.group && !cleanGroupState(edge.group, panelIds)) delete edgeGroups[position];
    }
  }

  if (typeof next.activeGroup === "string") {
    const stillPresent = panelsFromLayout(next).some((panel) => panel.id === next.activeGroup);
    if (!stillPresent) delete next.activeGroup;
  }
  return next;
}

function groupIdsIn(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) groupIdsIn(entry, ids);
    return;
  }
  const record = plainRecord(value);
  if (!record) return;
  if (typeof record.id === "string" && Array.isArray(record.views)) {
    ids.add(record.id);
  }
  for (const entry of Object.values(record)) groupIdsIn(entry, ids);
}

function uniqueAppendedGroupId(layout: unknown, panelId: string): string {
  const used = new Set<string>();
  groupIdsIn(layout, used);
  const base = `moved:${panelId}`;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}:${suffix}`)) suffix++;
  return `${base}:${suffix}`;
}

function appendedRootChildSize(layout: Record<string, unknown>): number {
  const grid = plainRecord(layout.grid);
  const root = plainRecord(grid?.root);
  const children = root && Array.isArray(root.data) ? root.data : [];
  const sizes = children.flatMap((child) => {
    const size = plainRecord(child)?.size;
    return typeof size === "number" && Number.isFinite(size) && size > 0
      ? [size]
      : [];
  });
  if (sizes.length > 0) {
    return Math.max(
      1,
      Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length),
    );
  }
  const available = grid?.orientation === "VERTICAL" ? grid.height : grid?.width;
  return typeof available === "number" && Number.isFinite(available) && available > 0
    ? Math.max(1, Math.round(available / Math.max(1, children.length + 1)))
    : 1;
}

function panelGroup(groupId: string, panelId: string): Record<string, unknown> {
  return {
    id: groupId,
    views: [panelId],
    activeView: panelId,
    locked: true,
  };
}

function panelLeaf(groupId: string, panelId: string): Record<string, unknown> {
  return {
    type: "leaf",
    data: panelGroup(groupId, panelId),
  };
}

function referencedGroupId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const group = plainRecord(value);
  return typeof group?.id === "string" ? group.id : undefined;
}

interface GridLeafLocation {
  readonly children: unknown[];
  readonly index: number;
  readonly depth: number;
  readonly group: Record<string, unknown>;
}

function findGridLeaf(
  nodeValue: unknown,
  referenceGroupId: string | undefined,
  referencePanelId: string | undefined,
  children: unknown[],
  index: number,
  depth: number,
): GridLeafLocation | undefined {
  const node = plainRecord(nodeValue);
  if (!node) return undefined;
  if (node.type === "leaf") {
    const group = plainRecord(node.data);
    const views = group?.views;
    if (
      group &&
      ((referenceGroupId !== undefined && group.id === referenceGroupId) ||
        (referencePanelId !== undefined &&
          Array.isArray(views) &&
          views.includes(referencePanelId)))
    ) {
      return { children, index, depth, group };
    }
    return undefined;
  }
  if (node.type !== "branch" || !Array.isArray(node.data)) return undefined;
  for (let childIndex = 0; childIndex < node.data.length; childIndex++) {
    const found = findGridLeaf(
      node.data[childIndex],
      referenceGroupId,
      referencePanelId,
      node.data,
      childIndex,
      depth + 1,
    );
    if (found) return found;
  }
  return undefined;
}

type SplitAxis = "HORIZONTAL" | "VERTICAL";

function directionAxis(direction: string | undefined): SplitAxis | undefined {
  if (direction === "left" || direction === "right") return "HORIZONTAL";
  if (direction === "above" || direction === "below") return "VERTICAL";
  return undefined;
}

function alternateAxis(axis: SplitAxis): SplitAxis {
  return axis === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL";
}

function axisAtDepth(rootAxis: SplitAxis, depth: number): SplitAxis {
  return depth % 2 === 0 ? rootAxis : alternateAxis(rootAxis);
}

function directionIsBefore(direction: string | undefined): boolean {
  return direction === "left" || direction === "above";
}

function splitNodeSize(
  existing: Record<string, unknown>,
  added: Record<string, unknown>,
): void {
  if (
    typeof existing.size !== "number" ||
    !Number.isFinite(existing.size) ||
    existing.size <= 0
  ) {
    return;
  }
  const total = existing.size;
  const addedSize = total / 2;
  existing.size = total - addedSize;
  added.size = addedSize;
}

function placeFloatingPanel(
  layout: Record<string, unknown>,
  groupId: string,
  panelId: string,
  floating: NonNullable<PanelPosition["floating"]>,
): void {
  const groups = Array.isArray(layout.floatingGroups)
    ? layout.floatingGroups
    : [];
  groups.push({
    data: panelGroup(groupId, panelId),
    position: {
      left: floating.x,
      top: floating.y,
      width: floating.width ?? 560,
      height: floating.height ?? 420,
    },
  });
  layout.floatingGroups = groups;
}

function placeGridPanel(
  layout: Record<string, unknown>,
  groupId: string,
  panelId: string,
  position: PanelPosition | undefined,
): string {
  const grid = plainRecord(layout.grid);
  const root = plainRecord(grid?.root);
  if (!grid || !root || !Array.isArray(root.data)) return groupId;
  const rootAxis: SplitAxis =
    grid.orientation === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";
  const referenceGroupId = referencedGroupId(position?.referenceGroup);
  const location =
    referenceGroupId || position?.referencePanel
      ? root.data
          .map((node, index) =>
            findGridLeaf(
              node,
              referenceGroupId,
              position?.referencePanel,
              root.data as unknown[],
              index,
              0,
            ),
          )
          .find((candidate) => candidate !== undefined)
      : undefined;

  if (position?.direction === "within" && location) {
    const views = Array.isArray(location.group.views)
      ? location.group.views
      : [];
    if (!views.includes(panelId)) views.push(panelId);
    location.group.views = views;
    location.group.activeView = panelId;
    const activeGroupId =
      typeof location.group.id === "string" ? location.group.id : groupId;
    location.group.id = activeGroupId;
    return activeGroupId;
  }

  const requestedAxis = directionAxis(position?.direction);
  const added = panelLeaf(groupId, panelId);
  if (location && requestedAxis) {
    const parentAxis = axisAtDepth(rootAxis, location.depth);
    const existing = plainRecord(location.children[location.index]);
    if (!existing) return groupId;
    if (parentAxis === requestedAxis) {
      splitNodeSize(existing, added);
      location.children.splice(
        location.index + (directionIsBefore(position?.direction) ? 0 : 1),
        0,
        added,
      );
      return groupId;
    }

    const outerSize = existing.size;
    const nestedExisting = { ...existing };
    delete nestedExisting.size;
    const nestedAdded = { ...added };
    const nestedChildren = directionIsBefore(position?.direction)
      ? [nestedAdded, nestedExisting]
      : [nestedExisting, nestedAdded];
    location.children[location.index] = {
      type: "branch",
      data: nestedChildren,
      ...(outerSize === undefined ? {} : { size: outerSize }),
    };
    return groupId;
  }

  if (root.data.length === 0 || !requestedAxis || requestedAxis === rootAxis) {
    added.size = appendedRootChildSize(layout);
    root.data.splice(
      directionIsBefore(position?.direction) ? 0 : root.data.length,
      0,
      added,
    );
    return groupId;
  }

  const existingBranch: Record<string, unknown> = {
    type: "branch",
    data: root.data,
  };
  const axisSize =
    requestedAxis === "HORIZONTAL" ? grid.width : grid.height;
  if (typeof axisSize === "number" && Number.isFinite(axisSize) && axisSize > 0) {
    existingBranch.size = axisSize / 2;
    added.size = axisSize / 2;
  }
  root.data = directionIsBefore(position?.direction)
    ? [added, existingBranch]
    : [existingBranch, added];
  grid.orientation = requestedAxis;
  return groupId;
}

/**
 * Add one serialized panel to a valid layout. Placement is committed here so
 * mounted Dockview is only a projection of the durable writer.
 */
export function appendPanelToLayout(
  destination: unknown,
  panelId: string,
  definition: unknown,
  position?: PanelPosition,
): unknown | null {
  const cleaned = removePanelIdsFromLayout(destination, new Set([panelId]));
  let next: Record<string, unknown>;
  try {
    next = JSON.parse(JSON.stringify(cleaned)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!isSerializedDockviewLayout(next)) return null;

  const panels = plainRecord(next.panels);
  const grid = plainRecord(next.grid);
  const root = plainRecord(grid?.root);
  let clonedDefinition: unknown;
  try {
    clonedDefinition = JSON.parse(JSON.stringify(definition));
  } catch {
    return null;
  }
  if (!panels || !grid || !root || !Array.isArray(root.data)) return null;
  if (!plainRecord(clonedDefinition)) return null;

  const groupId = uniqueAppendedGroupId(next, panelId);
  panels[panelId] = clonedDefinition;
  let activeGroupId = groupId;
  if (position?.floating) {
    placeFloatingPanel(next, groupId, panelId, position.floating);
  } else {
    activeGroupId = placeGridPanel(next, groupId, panelId, position);
    // The no-reference root fallback wraps the old root in a branch of its
    // own; only the collapse keeps that a shape Dockview can later remove from.
    repairNestedGridGeometry(next.grid);
  }
  delete grid.maximizedNode;
  next.activeGroup = activeGroupId;
  return next;
}

function rewriteGroupIds(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) rewriteGroupIds(entry, replacements);
    return;
  }
  const record = plainRecord(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    if (key === "id" && typeof entry === "string" && replacements.has(entry)) {
      record[key] = replacements.get(entry);
    } else {
      rewriteGroupIds(entry, replacements);
    }
  }
}

function mergeEdgeGroup(destination: unknown, source: unknown): boolean {
  const destinationGroup = plainRecord(plainRecord(destination)?.group);
  const sourceGroup = plainRecord(plainRecord(source)?.group);
  const destinationViews = destinationGroup?.views;
  const sourceViews = sourceGroup?.views;
  if (
    !destinationGroup ||
    !sourceGroup ||
    !Array.isArray(destinationViews) ||
    !Array.isArray(sourceViews)
  ) {
    return false;
  }
  destinationGroup.views = [
    ...destinationViews,
    ...sourceViews.filter((id) => !destinationViews.includes(id)),
  ];
  if (sourceGroup.activeView !== undefined) {
    destinationGroup.activeView = sourceGroup.activeView;
  }
  return true;
}

/** Replace selected pane placements with their isolated source placements. */
export function graftPanelIdsFromLayout(
  destination: unknown,
  source: unknown,
  panelIds: ReadonlySet<string>,
): unknown | null {
  const fragmentValue = extractPanelIdsFromLayout(source, panelIds);
  if (!fragmentValue) return null;
  const cleaned = removePanelIdsFromLayout(destination, panelIds);
  let next: Record<string, unknown>;
  let fragment: Record<string, unknown>;
  try {
    next = JSON.parse(JSON.stringify(cleaned)) as Record<string, unknown>;
    fragment = JSON.parse(JSON.stringify(fragmentValue)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    !isSerializedDockviewLayout(next) ||
    !isSerializedDockviewLayout(fragment)
  ) {
    return null;
  }

  const usedGroupIds = new Set<string>();
  const fragmentGroupIds = new Set<string>();
  groupIdsIn(next, usedGroupIds);
  groupIdsIn(fragment, fragmentGroupIds);
  const replacements = new Map<string, string>();
  for (const id of fragmentGroupIds) {
    if (!usedGroupIds.has(id)) {
      usedGroupIds.add(id);
      continue;
    }
    let suffix = 2;
    let replacement = `${id}:graft`;
    while (usedGroupIds.has(replacement)) {
      replacement = `${id}:graft:${suffix++}`;
    }
    replacements.set(id, replacement);
    usedGroupIds.add(replacement);
  }
  if (replacements.size > 0) {
    rewriteGroupIds(fragment.grid, replacements);
    rewriteGroupIds(fragment.floatingGroups, replacements);
    rewriteGroupIds(fragment.popoutGroups, replacements);
    rewriteGroupIds(fragment.edgeGroups, replacements);
    if (typeof fragment.activeGroup === "string") {
      fragment.activeGroup =
        replacements.get(fragment.activeGroup) ?? fragment.activeGroup;
    }
  }

  const panels = plainRecord(next.panels);
  const sourcePanels = plainRecord(fragment.panels);
  if (!panels || !sourcePanels) return null;
  for (const panelId of panelIds) {
    if (Object.getOwnPropertyDescriptor(sourcePanels, panelId)) {
      panels[panelId] = sourcePanels[panelId];
    }
  }

  const nextGrid = plainRecord(next.grid);
  const fragmentGrid = plainRecord(fragment.grid);
  const nextGridRoot = plainRecord(nextGrid?.root);
  const fragmentGridRoot = plainRecord(fragmentGrid?.root);
  if (
    nextGrid &&
    fragmentGrid &&
    nextGridRoot &&
    fragmentGridRoot &&
    Array.isArray(nextGridRoot.data) &&
    Array.isArray(fragmentGridRoot.data)
  ) {
    const nextAxis =
      nextGrid.orientation === "HORIZONTAL" || nextGrid.orientation === "VERTICAL"
        ? nextGrid.orientation
        : undefined;
    const fragmentAxis =
      fragmentGrid.orientation === "HORIZONTAL" ||
      fragmentGrid.orientation === "VERTICAL"
        ? fragmentGrid.orientation
        : undefined;
    if (nextGridRoot.data.length === 0) {
      nextGridRoot.data.push(...fragmentGridRoot.data);
      if (fragmentAxis) nextGrid.orientation = fragmentAxis;
    } else if (
      fragmentGridRoot.data.length > 0 &&
      nextAxis &&
      fragmentAxis &&
      nextAxis !== fragmentAxis
    ) {
      const nested: Record<string, unknown> = {
        type: "branch",
        data: fragmentGridRoot.data,
      };
      const sibling = [...nextGridRoot.data]
        .reverse()
        .map(plainRecord)
        .find((node) => node?.visible !== false);
      if (sibling) splitNodeSize(sibling, nested);
      if (!finiteNonNegative(nested.size) || nested.size === 0) {
        nested.size = appendedRootChildSize(next);
      }
      nextGridRoot.data.push(nested);
    } else {
      nextGridRoot.data.push(...fragmentGridRoot.data);
    }
    repairNestedGridGeometry(next.grid);
  }
  for (const key of ["floatingGroups", "popoutGroups"] as const) {
    const additions = fragment[key];
    if (!Array.isArray(additions) || additions.length === 0) continue;
    const current = Array.isArray(next[key]) ? next[key] : [];
    next[key] = [...current, ...additions];
  }
  const edgeGroups = plainRecord(next.edgeGroups);
  const sourceEdgeGroups = plainRecord(fragment.edgeGroups);
  if (sourceEdgeGroups) {
    const target = edgeGroups ?? {};
    for (const [position, edge] of Object.entries(sourceEdgeGroups)) {
      if (!Object.getOwnPropertyDescriptor(target, position)) {
        target[position] = edge;
      }
      else if (!mergeEdgeGroup(target[position], edge)) return null;
    }
    next.edgeGroups = target;
  }

  let grafted: unknown = next;
  for (const panelId of panelIds) {
    if (panelIsPlacedInLayout(grafted, panelId)) continue;
    const definition = sourcePanels[panelId];
    const appended = appendPanelToLayout(grafted, panelId, definition);
    if (!appended) return null;
    grafted = appended;
  }
  return grafted;
}

/**
 * Keep only the requested panels — the complement of removePanelIdsFromLayout,
 * so the extracted layout preserves Dockview's serialized shape (top-level
 * fields, panel records, grid structure) instead of being rebuilt by hand.
 * Returns null when none of the requested panels exist in the layout.
 */
export function extractPanelIdsFromLayout(
  layout: unknown,
  keepIds: ReadonlySet<string>,
): unknown | null {
  const allIds = panelsFromLayout(layout).map((panel) => panel.id);
  if (!allIds.some((id) => keepIds.has(id))) return null;
  const removeIds = new Set(allIds.filter((id) => !keepIds.has(id)));
  if (removeIds.size > 0) return removePanelIdsFromLayout(layout, removeIds);
  // 전부 keep이면 제거 경로가 원본을 그대로 돌려주므로, 두 데스크탑이 같은
  // 레이아웃 객체를 공유하지 않도록 복제해서 반환한다.
  try {
    return JSON.parse(JSON.stringify(layout));
  } catch {
    return null;
  }
}
