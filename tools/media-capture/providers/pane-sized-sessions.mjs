import { sessionTargetsForProvider } from "./specs.mjs";
import { terminalCaptureSize } from "./terminal-geometry.mjs";

function sameCanonicalFrame(left, right) {
  return (
    left?.sequenceThrough === right?.sequenceThrough &&
    left?.repaintBase64 === right?.repaintBase64
  );
}

export function providerScreenFillsColumns(screen, columns, tolerance = 2) {
  const minimum = Math.max(1, columns - tolerance);
  return screen.split(/\r?\n/u).some((line) => {
    const visibleColumns = [...line.replace(/\s+$/u, "")].length;
    return visibleColumns >= minimum;
  });
}

export function paneSizedFrameHasRedrawn({
  before,
  candidate,
  targetSize,
  visibleText,
  ready,
}) {
  if (
    candidate?.columns !== targetSize.columns ||
    candidate?.rows !== targetSize.rows ||
    candidate?.sequenceThrough === before?.sequenceThrough ||
    sameCanonicalFrame(before, candidate)
  ) {
    return false;
  }
  const screen = visibleText(candidate);
  return (
    screen.trim().length >= 20 &&
    ready(screen) &&
    providerScreenFillsColumns(screen, targetSize.columns)
  );
}

export async function waitForStablePaneSizedFrame({
  before,
  readFrame,
  ready,
  sleep,
  targetSize,
  visibleText,
  attempts = 16,
  intervalMs = 250,
}) {
  let stableObservations = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(intervalMs);
    const candidate = await readFrame();
    if (
      paneSizedFrameHasRedrawn({
        before,
        candidate,
        targetSize,
        visibleText,
        ready,
      })
    ) {
      stableObservations += 1;
      if (stableObservations >= 2) return candidate;
    } else {
      stableObservations = 0;
    }
  }
  throw new Error(
    `provider TUI did not stably redraw at ${targetSize.columns}x${targetSize.rows}`,
  );
}

export function framesForSessionTarget(providerCapture, sessionId) {
  if (Array.isArray(providerCapture)) return providerCapture;
  return providerCapture.framesBySession?.[sessionId] ?? providerCapture.frames;
}

export function dedicatedTargetsForProvider(scenario, provider) {
  return sessionTargetsForProvider(scenario, provider).filter(
    ({ id }) => scenario.liveSessionTerminalSizes?.[id] !== undefined || scenario.fixture.productTour?.providerTargets.some(target => target.id === id),
  );
}

export function primaryTerminalSize(scenario, provider, measuredSizes) {
  const targets = sessionTargetsForProvider(scenario, provider);
  const target =
    targets.find(
      ({ id }) => scenario.liveSessionTerminalSizes?.[id] === undefined,
    ) ?? targets[0];
  return terminalCaptureSize(
    scenario,
    provider,
    target?.id,
    measuredSizes,
  );
}

export async function capturePaneSizedFrames({
  excludedSessionIds = new Set(),
  frames,
  liveSessionId,
  measuredSizes,
  provider,
  readFrame,
  resize,
  scenario,
  sleep,
  visibleText,
  ready,
}) {
  const framesBySession = {};
  const primarySize = primaryTerminalSize(scenario, provider, measuredSizes);
  for (const target of sessionTargetsForProvider(scenario, provider)) {
    if (excludedSessionIds.has(target.id)) continue;
    const targetSize = terminalCaptureSize(
      scenario,
      provider,
      target.id,
      measuredSizes,
    );
    if (
      targetSize.columns === primarySize.columns &&
      targetSize.rows === primarySize.rows
    ) {
      framesBySession[target.id] = frames;
      continue;
    }
    const before = frames.at(-1);
    await resize(liveSessionId, targetSize);
    const targetFrame = await waitForStablePaneSizedFrame({
      before,
      readFrame: () => readFrame(liveSessionId),
      ready,
      sleep,
      targetSize,
      visibleText,
      intervalMs: provider === "claude" ? 400 : 250,
    });
    framesBySession[target.id] = [
      { ...targetFrame, atMs: frames.at(-1)?.atMs ?? 0 },
    ];
  }
  return { frames, framesBySession };
}
