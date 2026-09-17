import { liveReplaySteps } from "../runtime/live-terminal-replay.mjs";

const BLANK_TERMINAL_FRAME = "\u001b[2J\u001b[3J\u001b[H";

export function nativeBlankReplayScenario(scenario, replayBySession) {
  const copy = structuredClone(scenario);
  for (const [sessionId, replay] of Object.entries(replayBySession)) {
    const frame = replay.frames?.[0];
    if (!frame) continue;
    if (!Object.hasOwn(copy.fixture.terminalSnapshots ?? {}, sessionId)) {
      throw new Error("native replay initial frame references an unknown session");
    }
    copy.fixture.terminalSnapshots[sessionId] = BLANK_TERMINAL_FRAME;
    copy.fixture.terminalSnapshotGeometry[sessionId] = {
      columns: frame.columns,
      rows: frame.rows,
    };
  }
  return copy;
}

export function nativeLiveReplaySteps(replayBySession, durationMs) {
  const initialSteps = Object.entries(replayBySession).flatMap(
    ([id, replay]) => {
      const frame = replay.frames?.[0];
      return frame
        ? [
            {
              atMs: 0,
              id,
              kind: replay.kind,
              columns: frame.columns,
              rows: frame.rows,
              repaintBase64: frame.repaintBase64,
              sequenceThrough: frame.sequenceThrough,
            },
          ]
        : [];
    },
  );
  const initialFrames = new Set(
    initialSteps.map(
      ({ id, repaintBase64, sequenceThrough }) =>
        `${id}\0${sequenceThrough}\0${repaintBase64}`,
    ),
  );
  const changedSteps = liveReplaySteps(replayBySession, durationMs).filter(
    ({ id, repaintBase64, sequenceThrough }) =>
      !initialFrames.has(`${id}\0${sequenceThrough}\0${repaintBase64}`),
  );
  return [...initialSteps, ...changedSteps].sort(
    (left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id),
  );
}
