export async function runSpacesPaneMoveAction(
  page,
  action,
  { captureKind, probeLiveSessions } = {},
) {
  if (action.action !== "moveSpacesPane") return false;
  const { panelId, fromDesktopId, toDesktopId } = action;
  const before = await page.evaluate(({ panelId, fromDesktopId, toDesktopId }) => {
    const state = window.__DURE_STORE__.getState();
    const source = window.__DURE_DOCK__.getDockview(fromDesktopId);
    const target = window.__DURE_DOCK__.getDockview(toDesktopId);
    const sessionId = state.agents.find(({ id }) => `agent:${id}` === panelId)?.sessionId;
    if (!source?.getPanel(panelId) || !target || target.getPanel(panelId) || !sessionId) {
      throw new Error("Spaces move requires a source pane and an empty target slot");
    }
    return {
      source: source.panels.map(({ id }) => id).sort(),
      target: target.panels.map(({ id }) => id).sort(),
      sessionId,
      gitStatus: state.gitStatuses[panelId.slice("agent:".length)],
    };
  }, action);
  const source = page.locator(`[data-space-key="${panelId}"]`);
  const target = page.locator(`[data-space-desktop-section="${toDesktopId}"] [data-desktop-id="${toDesktopId}"]`).first();
  await source.waitFor({ state: "visible" });
  await target.waitFor({ state: "visible" });

  // Exercise the original event ordering without changing production cleanup
  // or synthesizing a drop. This listener and its bounded counters live only
  // for this one drag in the isolated capture page.
  await page.evaluate(async () => {
    const { endSpacesRowDrag } = await import("/src/lib/spaces/spacesDrag.ts");
    const counts = { dragstart: 0, drop: 0 };
    const observe = (event) => {
      counts[event.type] += 1;
      if (event.type === "drop") endSpacesRowDrag();
    };
    window.addEventListener("dragstart", observe, true);
    window.addEventListener("drop", observe, true);
    window.__DURE_MEDIA_SPACES_DRAG__ = {
      counts,
      cleanup() {
        window.removeEventListener("dragstart", observe, true);
        window.removeEventListener("drop", observe, true);
        endSpacesRowDrag();
      },
    };
  });
  try {
    await probeLiveSessions?.({ captureKind, phase: "before" });
    await source.dragTo(target);
    await page.waitForFunction(({ panelId, fromDesktopId, toDesktopId, before }) => {
      const state = window.__DURE_STORE__.getState();
      const source = window.__DURE_DOCK__.getDockview(fromDesktopId);
      const target = window.__DURE_DOCK__.getDockview(toDesktopId);
      const expectedSource = before.source.filter((id) => id !== panelId);
      const expectedTarget = [...before.target, panelId].sort();
      const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const ids = (layout) => Object.keys(layout?.panels ?? {}).sort();
      return (
        equal(source?.panels.map(({ id }) => id).sort(), expectedSource) &&
        equal(target?.panels.map(({ id }) => id).sort(), expectedTarget) &&
        equal(ids(state.layouts[fromDesktopId]), expectedSource) &&
        equal(ids(state.layouts[toDesktopId]), expectedTarget) &&
        equal(state.gitStatuses[panelId.slice("agent:".length)], before.gitStatus) &&
        state.agents.find(({ id }) => `agent:${id}` === panelId)?.sessionId === before.sessionId
      );
    }, { panelId, fromDesktopId, toDesktopId, before }, { timeout: 5_000 });
    const counts = await page.evaluate(() => window.__DURE_MEDIA_SPACES_DRAG__.counts);
    if (counts.dragstart !== 1 || counts.drop !== 1) {
      throw new Error(`Spaces mouse drag was not exactly once: ${JSON.stringify(counts)}`);
    }
    await probeLiveSessions?.({ captureKind, phase: "after" });
    process.stderr.write(`[media-capture] Spaces move verified: ${panelId} ${fromDesktopId} -> ${toDesktopId}; layouts and session preserved\n`);
  } catch (error) {
    const observation = await page.evaluate(({ panelId, fromDesktopId, toDesktopId }) => ({
      events: window.__DURE_MEDIA_SPACES_DRAG__.counts,
      sourcePresent: Boolean(window.__DURE_DOCK__.getDockview(fromDesktopId)?.getPanel(panelId)),
      targetPresent: Boolean(window.__DURE_DOCK__.getDockview(toDesktopId)?.getPanel(panelId)),
      storedSourcePresent: Boolean(window.__DURE_STORE__.getState().layouts[fromDesktopId]?.panels?.[panelId]),
      storedTargetPresent: Boolean(window.__DURE_STORE__.getState().layouts[toDesktopId]?.panels?.[panelId]),
    }), action);
    process.stderr.write(`[media-capture] Spaces move failed: ${JSON.stringify(observation)}\n`);
    throw error;
  } finally {
    await page.evaluate(() => {
      window.__DURE_MEDIA_SPACES_DRAG__?.cleanup();
      delete window.__DURE_MEDIA_SPACES_DRAG__;
    });
  }
  return true;
}
