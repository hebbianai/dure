export type DesktopDropPosition = "before" | "after";

export interface DesktopDropTarget {
  id: string;
  position: DesktopDropPosition;
}

/** Resolve the whole strip, including gaps and its empty ends. Call again at
 * drop time: the pointer or scroll offset may have changed since dragover. */
export function desktopDropTargetAt(
  tabs: readonly { id: string; left: number; width: number }[],
  clientX: number,
): DesktopDropTarget | null {
  if (!Number.isFinite(clientX)) return null;
  for (const tab of tabs) {
    if (clientX < tab.left + tab.width / 2) {
      return { id: tab.id, position: "before" };
    }
  }
  const last = tabs[tabs.length - 1];
  return last ? { id: last.id, position: "after" } : null;
}

export function reorderDesktopItems<T extends { id: string }>(
  items: readonly T[],
  sourceId: string,
  targetId: string,
  position: DesktopDropPosition,
): T[] | null {
  if (sourceId === targetId) return null;

  const source = items.find((item) => item.id === sourceId);
  if (!source || !items.some((item) => item.id === targetId)) return null;

  const reordered = items.filter((item) => item.id !== sourceId);
  const targetIndex = reordered.findIndex((item) => item.id === targetId);
  reordered.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);

  return reordered.every((item, index) => item.id === items[index]?.id)
    ? null
    : reordered;
}
