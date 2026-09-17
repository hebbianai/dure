import { agentPlacementWindows } from "./agent-placement.mjs";

export function requiredLiveStillSessionIds(
  scenario,
  untilMs = scenario.stillAtMs,
) {
  let activeDesktopId = scenario.fixture.activeDesktopId;
  let headlessSpawnDesktopId;
  const applyAction = (action) => {
    if (action.action === "activateDesktop") {
      activeDesktopId = action.desktopId;
    } else if (action.action === "productTour" && action.gesture.startsWith("space-")) {
      activeDesktopId = `desk-${action.gesture.slice(6)}`;
    } else if (action.action === "productTour" && action.gesture === "github") {
      activeDesktopId = "desk-review";
    } else if (action.action === "headlessSpawn") {
      headlessSpawnDesktopId = action.desktopId;
    }
  };
  scenario.setup.forEach(applyAction);
  scenario.timeline
    .filter(({ atMs }) => atMs <= untilMs)
    .forEach(applyAction);

  const liveSessionIds = new Set(scenario.liveProviderSessionIds ?? []);
  const opened = scenario.fixture.agents
    .filter(
      (agent) =>
        liveSessionIds.has(agent.sessionId) &&
        agentPlacementWindows(scenario, agent.id).some(
          ({ desktopId, startMs, endMs }) =>
            desktopId === activeDesktopId && startMs <= untilMs && untilMs < endMs,
        ),
    )
    .map(({ sessionId }) => sessionId);
  const headlessTarget = scenario.fixture.headlessSpawn?.providerTarget;
  if (
    headlessTarget &&
    liveSessionIds.has(headlessTarget.sessionId) &&
    headlessSpawnDesktopId === activeDesktopId
  ) {
    opened.push(headlessTarget.sessionId);
  }
  for (const target of scenario.fixture.productTour?.providerTargets ?? []) {
    const window = target.visibleWindows.filter(({ startMs }) => startMs <= untilMs).at(-1);
    if (window && (window.desktopId ?? target.desktopId) === activeDesktopId && liveSessionIds.has(target.id) && !opened.includes(target.id)) opened.push(target.id);
  }
  return opened;
}

function liveSnapshotsForScenario(scenario) {
  const requiredSessionIds = new Set(requiredLiveStillSessionIds(scenario));
  return (scenario.liveProviderSessionIds ?? []).map((id) => {
    const screen = scenario.fixture.terminalSnapshots[id];
    const geometry = scenario.fixture.terminalSnapshotGeometry?.[id];
    const agent = scenario.fixture.agents.find(
      (candidate) => candidate.sessionId === id,
    );
    const headlessTarget = scenario.fixture.headlessSpawn?.providerTarget;
    const sessionKind =
      agent?.sessionKind ?? scenario.fixture.productTour?.providerTargets?.find(target => target.id === id)?.kind ??
      (headlessTarget?.sessionId === id ? headlessTarget.sessionKind : undefined);
    if (
      typeof screen !== "string" ||
      !Number.isInteger(geometry?.columns) ||
      !Number.isInteger(geometry?.rows) ||
      !sessionKind
    ) {
      throw new Error(`live still snapshot is incomplete: ${id}`);
    }
    return {
      id,
      kind: sessionKind,
      repaintBase64: Buffer.from(`\u001b[3J${screen}`, "utf8").toString(
        "base64",
      ),
      columns: geometry.columns,
      rows: geometry.rows,
      required: requiredSessionIds.has(id),
    };
  });
}

export async function repaintVisibleLiveTerminals(page, scenario) {
  const snapshots = liveSnapshotsForScenario(scenario);
  if (snapshots.length === 0) return [];
  const publications = await page.evaluate(async (terminalSnapshots) => {
    const mock = window.__DURE_MEDIA_CAPTURE_MOCK__;
    const activeDesktopId = window.__DURE_STORE__?.getState?.().activeDesktopId;
    const activeDesktop = document.getElementById(
      `desktop-panel-${activeDesktopId}`,
    );
    return Promise.all(
      terminalSnapshots.map(async (snapshot) => {
        const terminalId =
          mock.resolveTerminalSessionId?.(snapshot.id) ?? snapshot.id;
        const host = [
          ...document.querySelectorAll("[data-dure-media-session-id]"),
        ].find((candidate) => {
          if (
            candidate.dataset.dureMediaSessionId !== terminalId ||
            !activeDesktop?.contains(candidate)
          ) {
            return false;
          }
          const bounds = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.right > 0 &&
            bounds.bottom > 0 &&
            bounds.left < window.innerWidth &&
            bounds.top < window.innerHeight &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        });
        const visible = Boolean(host);
        if (!visible) {
          return {
            id: snapshot.id,
            rendered: false,
            required: snapshot.required,
            visible,
          };
        }
        const renderProbe = mock.beginTerminalRenderProbe(terminalId);
        const publication = mock.publishLiveTerminalSnapshot?.({
          ...snapshot,
          id: terminalId,
        }) ??
          mock.publishTerminalSnapshot({
            ...snapshot,
            id: terminalId,
          });
        try {
          if (publication.transport !== "hmux") {
            await mock.waitForTerminalSnapshotResume({
              id: terminalId,
              endOffset: publication.endOffset,
              consumerIds: publication.consumerIds,
              renderProbe,
              timeoutMs: 1_500,
            });
          }
          await mock.waitForTerminalRender(renderProbe, 1_500);
          return {
            id: snapshot.id,
            rendered: true,
            required: snapshot.required,
            visible,
            ...publication,
          };
        } catch (error) {
          mock.cancelTerminalRenderProbe(renderProbe);
          return {
            id: snapshot.id,
            rendered: false,
            required: snapshot.required,
            visible,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }, snapshots);
  const failures = publications.filter(
    ({ required, visible, rendered }) =>
      (required || visible) && !rendered,
  );
  if (failures.length > 0) {
    throw new Error(
      `${scenario.id} live still repaint did not render: ${JSON.stringify(failures)}`,
    );
  }
  return publications;
}
