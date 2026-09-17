import { agentPlacementWindows } from "../runtime/agent-placement.mjs";

function desktopWindows(scenario) {
  const initialDesktop =
    [...scenario.setup]
      .reverse()
      .find(({ action }) => action === "activateDesktop")?.desktopId ??
    scenario.fixture.activeDesktopId;
  const windows = [];
  let desktopId = initialDesktop;
  let startMs = 0;
  for (const step of scenario.timeline) {
    if (step.action !== "activateDesktop" || step.desktopId === desktopId) {
      continue;
    }
    windows.push({ desktopId, startMs, endMs: step.atMs });
    desktopId = step.desktopId;
    startMs = step.atMs;
  }
  windows.push({ desktopId, startMs, endMs: scenario.durationMs });
  return windows;
}

function subtractVisibilityWindow(windows, exclusion) {
  return windows.flatMap((window) => {
    if (
      exclusion.endMs <= window.startMs ||
      exclusion.startMs >= window.endMs
    ) {
      return [window];
    }
    return [
      { ...window, endMs: exclusion.startMs },
      { ...window, startMs: exclusion.endMs },
    ].filter(({ startMs, endMs }) => endMs > startMs);
  });
}

export function replayVisibility(scenario, sessionId) {
  const tourTarget = scenario.fixture.productTour?.providerTargets?.find(({ id }) => id === sessionId);
  if (tourTarget) return { desktopId: tourTarget.desktopId, visibleWindows: tourTarget.visibleWindows };
  const transitionMarginMs = 1_000;
  const agent = scenario.fixture.agents.find(
    (candidate) => candidate.sessionId === sessionId,
  );
  const headlessTarget = scenario.fixture.headlessSpawn?.providerTarget;
  const isHeadlessTarget = headlessTarget?.sessionId === sessionId;
  if (!agent && !isHeadlessTarget) {
    throw new Error(`capture agent session is missing: ${sessionId}`);
  }
  const opening = isHeadlessTarget
    ? scenario.timeline.find((step) => step.action === "headlessSpawn")
    : [...scenario.setup, ...scenario.timeline].find(
        (step) => step.action === "openAgent" && step.agentId === agent.id,
      );
  if (!opening) {
    throw new Error(
      isHeadlessTarget
        ? `headless capture target is never spawned: ${sessionId}`
        : `capture agent is never opened: ${agent.id}`,
    );
  }
  const openedAtMs = scenario.setup.includes(opening) ? 0 : opening.atMs;
  const placements = isHeadlessTarget
    ? [{ desktopId: opening.desktopId, startMs: openedAtMs, endMs: scenario.durationMs }]
    : agentPlacementWindows(scenario, agent.id);
  let visibleWindows = desktopWindows(scenario)
    .flatMap((window) => placements
      .filter(({ desktopId }) => desktopId === window.desktopId)
      .map((placement) => ({
        startMs: Math.max(window.startMs, placement.startMs) + transitionMarginMs,
        endMs: Math.min(window.endMs, placement.endMs) - transitionMarginMs,
        ...(placement.desktopId !== opening.desktopId
          ? { desktopId: placement.desktopId } : {}),
      })))
    .filter(({ startMs, endMs }) => endMs > startMs);
  const reconnects = scenario.timeline.filter(
    (step) =>
      step.action === "reloadAppClient" && step.sessionId === sessionId,
  );
  for (const reconnect of reconnects) {
    visibleWindows = subtractVisibilityWindow(visibleWindows, {
      startMs: Math.max(0, reconnect.atMs - 250),
      endMs: reconnect.reconnectReadyAtMs + 500,
    });
  }
  if (visibleWindows.length === 0) {
    throw new Error(`capture agent has no visible replay window: ${agent.id}`);
  }
  return { desktopId: opening.desktopId, visibleWindows };
}

export function floatingReplayVisibility(scenario, target) {
  const floating = [...scenario.setup, ...scenario.timeline].find(
    (step) =>
      step.action === "floatAgent" && step.agentId === target.agentId,
  );
  if (!floating) return null;
  const floatedAtMs = scenario.setup.includes(floating) ? 0 : floating.atMs;
  if (!Number.isFinite(floatedAtMs)) {
    throw new Error(
      `capture floating agent has no execution time: ${target.agentId}`,
    );
  }
  const desktopWindow = desktopWindows(scenario).find(
    ({ desktopId, startMs, endMs }) =>
      desktopId === floating.desktopId &&
      startMs <= floatedAtMs &&
      endMs > floatedAtMs,
  );
  if (!desktopWindow) {
    throw new Error(
      `capture floating agent is outside its desktop window: ${target.agentId}`,
    );
  }
  const startMs = floatedAtMs + 100;
  const endMs = Math.min(desktopWindow.endMs, startMs + 100);
  if (endMs <= startMs) {
    throw new Error(
      `capture floating agent has no repaint window: ${target.agentId}`,
    );
  }
  return {
    desktopId: floating.desktopId,
    visibleWindows: [{ startMs, endMs }],
  };
}
