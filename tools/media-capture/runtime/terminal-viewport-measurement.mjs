import { requiredLiveStillSessionIds } from "./live-terminal-still.mjs";
import {
  liveProvidersForScenario,
  sessionTargetsForProvider,
} from "../providers/specs.mjs";
import { terminalCaptureSize } from "../providers/terminal-geometry.mjs";
import {
  TERMINAL_SURFACE_SELECTORS,
  terminalViewportGeometryFromSurface,
} from "./terminal-surface.mjs";

function liveSessionTargets(scenario) {
  return liveProvidersForScenario(scenario).flatMap((provider) =>
    sessionTargetsForProvider(scenario, provider).map(({ id }) => ({
      id,
      provider,
    })),
  );
}

export function declaredTerminalSize(scenario, provider, sessionId) {
  const declared =
    scenario.liveSessionTerminalSizes?.[sessionId] ??
    scenario.liveProviderTerminalSizes?.[provider] ??
    scenario.liveTerminalSize;
  return declared
    ? terminalCaptureSize(scenario, provider, sessionId)
    : undefined;
}

export function resolvedMeasuredTerminalSize(published, gridDiagnostics) {
  return terminalViewportGeometryFromSurface(gridDiagnostics) ?? published;
}

function assertUsableTerminalSizes(sizes) {
  for (const [id, size] of Object.entries(sizes)) {
    if (
      !Number.isInteger(size?.columns) ||
      size.columns < 40 ||
      !Number.isInteger(size?.rows) ||
      size.rows < 12
    ) {
      throw new Error(
        `measured live terminal ${id} is smaller than 40x12: ${JSON.stringify(size)}`,
      );
    }
  }
}

export function unsettledTerminalSessionIds(sessionIds, hostStates) {
  const statesBySession = new Map(
    hostStates.map((state) => [state.sessionId, state]),
  );
  return sessionIds.filter((sessionId) => {
    const state = statesBySession.get(sessionId);
    return !state || state.hydrating || state.fitSettling;
  });
}

export async function measureLiveTerminalSizes({
  baseUrl,
  browser,
  preparePage,
  progress,
  runAction,
  scenario,
  throwPageErrors,
  applicationBuild,
}) {
  progress(`measuring live terminal panes for ${scenario.id}`);
  const { context, page, pageErrors } = await preparePage(
    browser,
    baseUrl,
    scenario,
    applicationBuild,
  );
  try {
    for (const action of scenario.timeline) {
      await runAction(page, action, scenario, { measureOnly: true });
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
      );
    });
    const sessionTargets = liveSessionTargets(scenario);
    const sessionIds = sessionTargets.map(({ id }) => id);
    const deferredSessionIds = new Set(
      scenario.fixture.headlessSpawn?.providerTarget?.sessionId
        ? [scenario.fixture.headlessSpawn.providerTarget.sessionId]
        : [],
    );
    if (scenario.fixture.productTour) {
      const visible = new Set(requiredLiveStillSessionIds({ ...scenario, liveProviderSessionIds: sessionIds }));
      for (const id of sessionIds) if (!visible.has(id)) deferredSessionIds.add(id);
    }
    let declaredFallbackSizes = {};
    try {
      await page.waitForFunction(
        (ids) => {
          const geometry =
            window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics()
              .terminalViewportGeometry;
          return ids.every(
            (id) =>
              Number.isInteger(geometry[id]?.columns) &&
              Number.isInteger(geometry[id]?.rows),
          );
        },
        sessionIds,
        { timeout: 3_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(({ ids, selectors }) => {
        const mock = window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics();
        const terminalGridDiagnostics = Object.fromEntries(
          ids.map((id) => {
            const host = [
              ...(document.getElementById(`desktop-panel-${window.__DURE_STORE__.getState().activeDesktopId}`)?.querySelectorAll("[data-dure-media-session-id]") ?? []),
            ].find((candidate) => candidate.dataset.dureMediaSessionId === id);
            const presentation = host?.querySelector(selectors.presentation);
            const viewport = host?.querySelector(selectors.viewport);
            return [
              id,
              {
                canonicalColumns:
                  presentation?.dataset.terminalCanonicalColumns ?? null,
                projectionRevision:
                  viewport?.dataset.projectionRevision ?? null,
                renderedRowCount:
                  viewport?.querySelectorAll(selectors.row).length ?? 0,
                viewportRows:
                  presentation?.dataset.terminalViewportRows ?? null,
              },
            ];
          }),
        );
        return {
          expectedSessionIds: ids,
          terminalHosts: [
            ...(document.getElementById(`desktop-panel-${window.__DURE_STORE__.getState().activeDesktopId}`)?.querySelectorAll("[data-dure-media-session-id]") ?? []),
          ].map((host) => host.dataset.dureMediaSessionId),
          terminalViewportGeometry: mock.terminalViewportGeometry,
          terminalSnapshotGeometry: mock.terminalSnapshotGeometry,
          terminalGridDiagnostics,
          outputConsumers: mock.outputConsumers,
          hmuxClientSessions: mock.hmuxClientSessions,
        };
      }, { ids: sessionIds, selectors: TERMINAL_SURFACE_SELECTORS });
      const missingTargets = sessionTargets.filter(
        ({ id }) => diagnostics.terminalViewportGeometry[id] === undefined,
      );
      const renderedSizes = Object.fromEntries(
        missingTargets.flatMap(({ id }) => {
          const size = terminalViewportGeometryFromSurface(
            diagnostics.terminalGridDiagnostics[id],
          );
          return size ? [[id, size]] : [];
        }),
      );
      const declaredSizes = Object.fromEntries(
        missingTargets.flatMap(({ id, provider }) => {
          const size = declaredTerminalSize(scenario, provider, id);
          return size ? [[id, size]] : [];
        }),
      );
      declaredFallbackSizes = { ...declaredSizes, ...renderedSizes };
      const undeclared = missingTargets
        .map(({ id }) => id)
        .filter((id) => declaredFallbackSizes[id] === undefined);
      if (undeclared.length > 0) {
        throw new Error(
          `${scenario.id} live terminal geometry was not published: ${JSON.stringify({ ...diagnostics, undeclared })}`,
          { cause: error },
        );
      }
      progress(
        `using rendered or declared terminal geometry after missing resize evidence: ${missingTargets.map(({ id }) => id).join(", ")}`,
      );
    }
    let previous;
    let lastUnsettled = sessionIds;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sample = await page.evaluate(({ fallbackSizes, ids, selectors }) => {
        const geometry = window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics()
          .terminalViewportGeometry;
        const hosts = [
          ...(document.getElementById(`desktop-panel-${window.__DURE_STORE__.getState().activeDesktopId}`)?.querySelectorAll("[data-dure-media-session-id]") ?? []),
        ];
        const resolveId = (id) => window.__DURE_MEDIA_CAPTURE_MOCK__.resolveTerminalSessionId?.(id) ?? id;
        const hostStates = ids.flatMap((id) => {
          const host = hosts.find(host => host.dataset.dureMediaSessionId === resolveId(id));
          return host ? [{ sessionId: id, hydrating: host.classList.contains("terminal-hydrating"), fitSettling: host.classList.contains("terminal-fit-settling") }] : [];
        });
        const terminalGridDiagnostics = Object.fromEntries(
          ids.map((id) => {
            const host = hosts.find(
              (candidate) => candidate.dataset.dureMediaSessionId === resolveId(id),
            );
            const presentation = host?.querySelector(selectors.presentation);
            const viewport = host?.querySelector(selectors.viewport);
            return [
              id,
              {
                canonicalColumns:
                  presentation?.dataset.terminalCanonicalColumns ?? null,
                projectionRevision:
                  viewport?.dataset.projectionRevision ?? null,
                renderedRowCount:
                  viewport?.querySelectorAll(selectors.row).length ?? 0,
                viewportRows:
                  presentation?.dataset.terminalViewportRows ?? null,
              },
            ];
          }),
        );
        return {
          hostStates,
          publishedSizes: Object.fromEntries(
            ids.map((id) => [id, geometry[resolveId(id)] ?? fallbackSizes[id]]),
          ),
          terminalGridDiagnostics,
        };
      }, {
        fallbackSizes: declaredFallbackSizes,
        ids: sessionIds,
        selectors: TERMINAL_SURFACE_SELECTORS,
      });
      sample.sizes = Object.fromEntries(
        sessionIds.map((id) => [
          id,
          resolvedMeasuredTerminalSize(sample.publishedSizes[id], sample.terminalGridDiagnostics[id]),
        ]),
      );
      lastUnsettled = unsettledTerminalSessionIds(
        sessionIds,
        sample.hostStates,
      ).filter((sessionId) => !deferredSessionIds.has(sessionId));
      if (lastUnsettled.length > 0) {
        previous = undefined;
        await page.waitForTimeout(100);
        continue;
      }
      if (
        previous &&
        JSON.stringify(previous) === JSON.stringify(sample.sizes)
      ) {
        assertUsableTerminalSizes(sample.sizes);
        throwPageErrors(pageErrors, scenario.id);
        return sample.sizes;
      }
      previous = sample.sizes;
      await page.waitForTimeout(100);
    }
    throw new Error(
      `${scenario.id} live terminal geometry did not settle: ${JSON.stringify({ sizes: previous, unsettled: lastUnsettled })}`,
    );
  } finally {
    await context.close();
  }
}
