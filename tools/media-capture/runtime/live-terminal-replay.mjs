import { performance } from "node:perf_hooks";
import { terminalGeometryFitsViewport } from "../providers/terminal-geometry.mjs";
import {
  TERMINAL_SURFACE_SELECTORS,
  terminalViewportGeometryFromSurface,
} from "./terminal-surface.mjs";

function replayTimes(count, durationMs, visibleWindows) {
  if (count === 0) return [];
  const windows =
    visibleWindows?.length > 0
      ? visibleWindows
      : [{ startMs: 250, endMs: durationMs * 0.85 }];
  const durations = windows.map(({ startMs, endMs }) => endMs - startMs);
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  if (totalDuration <= 0) {
    throw new Error("live terminal replay has no positive visibility window");
  }
  return Array.from({ length: count }, (_, index) => {
    let position = (totalDuration * (index + 0.5)) / count;
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      if (
        position <= durations[windowIndex] ||
        windowIndex === windows.length - 1
      ) {
        return Math.round(windows[windowIndex].startMs + position);
      }
      position -= durations[windowIndex];
    }
    throw new Error("live terminal replay position escaped its visibility window");
  });
}

function selectedReplayFrames(frames, visibleWindows, durationMs) {
  if (frames.length === 1) return frames;
  const changedFrames = frames.slice(1);
  const visibleDuration = (visibleWindows?.length > 0
    ? visibleWindows
    : [{ startMs: 250, endMs: durationMs * 0.85 }]
  ).reduce((sum, { startMs, endMs }) => sum + endMs - startMs, 0);
  const limit = Math.max(2, Math.min(6, Math.floor(visibleDuration / 500)));
  if (changedFrames.length <= limit) return changedFrames;
  const selectedIndexes = new Set(
    Array.from({ length: limit }, (_, index) =>
      Math.round((index * (changedFrames.length - 1)) / (limit - 1)),
    ),
  );
  return [...selectedIndexes].map((index) => changedFrames[index]);
}

export function liveReplaySteps(replayBySession, durationMs) {
  const steps = [];
  for (const [id, replay] of Object.entries(replayBySession)) {
    const frames = replay.frames ?? [];
    const changedFrames = selectedReplayFrames(
      frames,
      replay.visibleWindows,
      durationMs,
    );
    const times = replayTimes(
      changedFrames.length,
      durationMs,
      replay.visibleWindows,
    );
    for (const [index, frame] of changedFrames.entries()) {
      steps.push({
        atMs: times[index],
        id,
        kind: replay.kind,
        desktopId: replay.visibleWindows?.find(
          ({ startMs, endMs }) => times[index] >= startMs && times[index] <= endMs,
        )?.desktopId ?? replay.desktopId,
        columns: frame.columns,
        rows: frame.rows,
        repaintBase64: frame.repaintBase64,
        sequenceThrough: frame.sequenceThrough,
      });
    }
  }
  return steps.sort(
    (left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id),
  );
}

export function unrenderedLatestSessions(replayBySession, publications) {
  return Object.keys(replayBySession).filter((id) => {
    const latest = publications
      .filter((publication) => publication.id === id)
      .sort((left, right) => right.atMs - left.atMs)[0];
    return !latest?.rendered;
  });
}

export function unrenderedReplayPublications(publications) {
  return publications.filter(({ rendered }) => !rendered);
}

export async function playLiveTerminalReplay(
  page,
  replayBySession,
  durationMs,
  {
    startedAt = performance.now(),
    deadlineAt = startedAt + durationMs + 1_000,
  } = {},
) {
  const steps = liveReplaySteps(replayBySession, durationMs);
  const publications = [];
  const groups = [];
  for (const step of steps) {
    const current = groups.at(-1);
    if (current?.atMs === step.atMs) current.steps.push(step);
    else groups.push({ atMs: step.atMs, steps: [step] });
  }
  for (const group of groups) {
    const remaining = group.atMs - (performance.now() - startedAt);
    if (remaining > 0) await page.waitForTimeout(remaining);
    const timeoutMs = Math.floor(deadlineAt - performance.now());
    if (timeoutMs <= 0) {
      throw new Error("live terminal replay exceeded the recording deadline");
    }
    const results = await page.evaluate(
      async ({ snapshots, terminalSurfaceSelectors, timeoutMs: groupTimeoutMs }) =>
        Promise.all(
          snapshots.map(async (snapshot) => {
            const groupDeadline = performance.now() + groupTimeoutMs;
            const mock = window.__DURE_MEDIA_CAPTURE_MOCK__;
            const terminalId =
              mock.resolveTerminalSessionId?.(snapshot.id) ?? snapshot.id;
            let host;
            let renderTargetVisible = false;
            const targetDeadline = Math.min(
              groupDeadline,
              performance.now() + 750,
            );
            do {
              const activeDesktopId = window.__DURE_STORE__?.getState?.().activeDesktopId;
              host = [
                ...document.querySelectorAll("[data-dure-media-session-id]"),
              ].find(
                (candidate) =>
                  candidate.dataset.dureMediaSessionId === terminalId && candidate.closest('[id^="desktop-panel-"]')?.id === `desktop-panel-${activeDesktopId}`,
              );
              const bounds = host?.getBoundingClientRect();
              const style = host ? getComputedStyle(host) : null;
              const desktop = host?.closest('[id^="desktop-panel-"]');
              const belongsToActiveDesktop =
                desktop?.id === `desktop-panel-${activeDesktopId}` &&
                (!snapshot.desktopId || snapshot.desktopId === activeDesktopId);
              renderTargetVisible = Boolean(
                host &&
                  belongsToActiveDesktop &&
                  (mock.terminalConsumerCount?.(terminalId) ??
                    mock.diagnostics().outputConsumers[terminalId] ??
                    0) > 0 &&
                  bounds &&
                  bounds.width > 0 &&
                  bounds.height > 0 &&
                  bounds.right > 0 &&
                  bounds.bottom > 0 &&
                  bounds.left < window.innerWidth &&
                  bounds.top < window.innerHeight &&
                  style?.display !== "none" &&
                  style?.visibility !== "hidden",
              );
              if (!renderTargetVisible) {
                await new Promise((resolveFrame) =>
                  requestAnimationFrame(resolveFrame),
                );
              }
            } while (
              !renderTargetVisible &&
              performance.now() < targetDeadline
            );
            const renderProbe = renderTargetVisible
              ? mock.beginTerminalRenderProbe(terminalId)
              : null;
            const publication = mock.publishLiveTerminalSnapshot?.({
              ...snapshot,
              id: terminalId,
            }) ??
              mock.publishTerminalSnapshot({
                ...snapshot,
                id: terminalId,
              });
            let renderError = null;
            let rendered = false;
            if (renderProbe) {
              try {
                if (publication.transport !== "hmux") {
                  await mock.waitForTerminalSnapshotResume({
                    id: terminalId,
                    endOffset: publication.endOffset,
                    consumerIds: publication.consumerIds,
                    renderProbe,
                    timeoutMs: Math.max(
                      1,
                      Math.min(750, groupDeadline - performance.now()),
                    ),
                  });
                }
                await mock.waitForTerminalRender(
                  renderProbe,
                  Math.max(
                    1,
                    Math.min(750, groupDeadline - performance.now()),
                  ),
                );
                rendered = true;
              } catch (error) {
                mock.cancelTerminalRenderProbe(renderProbe);
                renderError =
                  error instanceof Error ? error.message : String(error);
              }
            }
            const presentation = host?.querySelector(
              terminalSurfaceSelectors.presentation,
            );
            const viewport = host?.querySelector(
              terminalSurfaceSelectors.viewport,
            );
            const gridDiagnostics = {
              canonicalColumns:
                presentation?.dataset.terminalCanonicalColumns ?? null,
              hostHeight: host?.clientHeight ?? null,
              hostWidth: host?.clientWidth ?? null,
              projectionRevision:
                viewport?.dataset.projectionRevision ?? null,
              renderedRowCount:
                viewport?.querySelectorAll(terminalSurfaceSelectors.row)
                  .length ?? 0,
              viewportRows:
                presentation?.dataset.terminalViewportRows ?? null,
            };
            return {
              ...publication,
              terminalId,
              gridDiagnostics,
              renderTargetVisible,
              renderError,
              rendered,
            };
          }),
        ),
      {
        snapshots: group.steps,
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
        timeoutMs,
      },
    );
    for (const [index, result] of results.entries()) {
      const step = group.steps[index];
      const renderedViewportGeometry = terminalViewportGeometryFromSurface(
        result.gridDiagnostics,
      );
      const viewportGeometry =
        renderedViewportGeometry ?? result.viewportGeometry;
      if (result.rendered) {
        const { sourceGeometry } = result;
        if (
          !terminalGeometryFitsViewport(sourceGeometry, viewportGeometry, {
            closeFit: true,
          })
        ) {
          throw new Error(
            `live terminal ${step.id} does not closely fit its rendered viewport: ${JSON.stringify({ sourceGeometry, viewportGeometry, gridDiagnostics: result.gridDiagnostics })}`,
          );
        }
      }
      publications.push({
        id: step.id,
        atMs: step.atMs,
        sequenceThrough: step.sequenceThrough,
        ...result,
        viewportGeometry,
      });
    }
  }
  const unrenderedSessions = unrenderedLatestSessions(
    replayBySession,
    publications,
  );
  const unrenderedPublications = unrenderedReplayPublications(publications);
  if (unrenderedPublications.length > 0) {
    throw new Error(
      `live terminal replay frame did not render: ${JSON.stringify(
        unrenderedPublications.map(
          ({ id, atMs, renderTargetVisible, renderError }) => ({
            id,
            atMs,
            renderTargetVisible,
            renderError,
          }),
        ),
      )}`,
    );
  }
  if (unrenderedSessions.length > 0) {
    throw new Error(
      `latest live terminal frame did not render in a visible structured terminal pane for: ${unrenderedSessions.join(", ")}`,
    );
  }
  return publications;
}
