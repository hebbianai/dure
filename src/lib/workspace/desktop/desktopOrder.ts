export type DesktopDropPosition = "before" | "after";

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
