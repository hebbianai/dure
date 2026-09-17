// The capture timeline owns pane placement for both replay and still evidence.
export function agentPlacementWindows(scenario, agentId) {
  const open = new Map();
  const windows = [];
  const close = (desktopId, endMs) => {
    const startMs = open.get(desktopId);
    if (startMs !== undefined && endMs > startMs) {
      windows.push({ desktopId, startMs, endMs });
    }
    open.delete(desktopId);
  };
  for (const step of [
    ...scenario.setup.map((action) => ({ ...action, atMs: 0 })),
    ...scenario.timeline,
  ]) {
    if (step.action === "openAgent" && step.agentId === agentId) {
      if (!open.has(step.desktopId)) open.set(step.desktopId, step.atMs);
    } else if (
      step.action === "moveSpacesPane" && step.panelId === `agent:${agentId}`
    ) {
      close(step.fromDesktopId, step.atMs);
      open.set(step.toDesktopId, step.atMs);
    }
  }
  for (const desktopId of open.keys()) close(desktopId, scenario.durationMs);
  return windows.sort((left, right) => left.startMs - right.startMs);
}
