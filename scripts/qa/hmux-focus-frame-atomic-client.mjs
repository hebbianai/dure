import {
  HmuxWindowFocusHarness,
  WINDOW_ROLES,
} from "./lib/hmux-window-focus-harness.mjs";

const MIN_SCROLLBACK_ROWS = 500;
const harness = new HmuxWindowFocusHarness();

try {
  await harness.connect();
  await harness.prepareRuntime();
  const started = await harness.start("scrollback");
  await harness.waitReady();
  await harness.waitForBufferState(
    "a",
    "atomic normal-buffer presentation",
    (_state, candidate) =>
      WINDOW_ROLES.every((role) =>
        hasAtomicNormalBuffer(
          candidate.windows?.[role],
          started.scrollbackMarker,
        ),
      ),
  );
  await harness.prime("b");
  const focused = await harness.waitForBufferState(
    "b",
    "focused atomic normal-buffer presentation",
    (_state, candidate) =>
      candidate.windows?.b?.documentFocused === true &&
      candidate.nativeWindows?.b?.focused === true &&
      WINDOW_ROLES.every((role) =>
        hasAtomicNormalBuffer(
          candidate.windows?.[role],
          started.scrollbackMarker,
        ),
      ),
  );
  const evidence = {
    synchronizationCounts: roleEvidence(
      focused,
      (report) => report.synchronizationCount,
    ),
    visibleFrameViolations: roleEvidence(
      focused,
      (report) => report.visibleFrameViolations,
    ),
    scrollbackRows: roleEvidence(
      focused,
      (report) => report.bufferState.scrollbackRows,
    ),
  };

  console.log(
    `hmux focus frame atomic smoke: focused Codex normal-buffer recovery stayed concealed through its renderer barrier ${JSON.stringify(evidence)}`,
  );
} finally {
  await harness.finish().catch((error) => {
    console.error(`hmux focus frame atomic smoke cleanup failed: ${error}`);
    process.exitCode = 1;
  });
}

function roleEvidence(status, select) {
  return Object.fromEntries(
    WINDOW_ROLES.map((role) => [role, select(status.windows[role])]),
  );
}

function hasAtomicNormalBuffer(report, marker) {
  const state = report?.bufferState;
  return (
    report?.synchronized === true &&
    report.hydrating === false &&
    (report.synchronizationCount ?? 0) >= 2 &&
    report.visibleFrameCount >= 1 &&
    report.visibleFrameViolations === 0 &&
    report.markerCounts?.[marker] === 1 &&
    state?.concealed === false &&
    state.atBottom === true &&
    state.verticalScrollbar?.atBottom === true &&
    state.scrollbackRows >= MIN_SCROLLBACK_ROWS &&
    state.visibleScrollbackMarker === marker &&
    state.logicalScrollbackMarkerPresent === true &&
    state.styledScrollbackMarkerPresent === true
  );
}
