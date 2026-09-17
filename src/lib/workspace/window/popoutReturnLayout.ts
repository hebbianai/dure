// Restore pre-popout geometry while retaining current panel records. Replaying
// old params could rebind an exited session or rewind a launch journal.
// A changed panel-id set returns null so the caller keeps its appended layout.
// With the same set, intervening rearrangements yield to the saved geometry;
// current bindings, titles and journal state remain authoritative.

interface LayoutWithPanels {
  panels?: Record<string, unknown>;
}

export function composeReturnLayout(
  returnLayout: unknown,
  currentLayout: unknown,
): unknown | null {
  const snapshot = returnLayout as LayoutWithPanels | null | undefined;
  const current = currentLayout as LayoutWithPanels | null | undefined;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !snapshot.panels ||
    !current ||
    typeof current !== "object" ||
    !current.panels
  ) {
    return null;
  }
  const snapshotIds = Object.keys(snapshot.panels).sort();
  const currentIds = Object.keys(current.panels).sort();
  if (
    snapshotIds.length !== currentIds.length ||
    !snapshotIds.every((id, index) => id === currentIds[index])
  ) {
    return null;
  }
  return { ...snapshot, panels: { ...current.panels } };
}
