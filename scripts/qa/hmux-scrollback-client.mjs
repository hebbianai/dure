import {
  HmuxWindowFocusHarness,
  WINDOW_ROLES,
} from "./lib/hmux-window-focus-harness.mjs";
import { runNormalBufferResumeScenario } from "./lib/hmux-normal-buffer-resume.mjs";

const HISTORY_SCROLL_ROWS = 512;
const HISTORY_SCROLL_STEPS = 2;
const MIN_HISTORY_DISTANCE = 500;
const EXPECTED_HISTORY_LINES = 600;
const harness = new HmuxWindowFocusHarness();

function hasCanonicalTail(state, marker) {
  return (
    state?.atBottom === true &&
    state.viewportY === 0 &&
    state.scrollbackRows >= 1 &&
    state.bufferLength > 0 &&
    state.visibleScrollbackMarker === marker
  );
}

function hasCanonicalHistory(state) {
  return (
    state?.atBottom === false &&
    state.viewportY >= MIN_HISTORY_DISTANCE &&
    state.scrollbackRows >= MIN_HISTORY_DISTANCE &&
    state.logicalScrollbackMarkerPresent === true
  );
}

async function waitForCanonicalTails(marker, phase) {
  return harness.waitForBufferState(
    "a",
    `${phase} canonical tail projections`,
    (_state, candidate) =>
      WINDOW_ROLES.every(
        (role) =>
          candidate.windows?.[role]?.hydrating === false &&
          hasCanonicalTail(candidate.windows?.[role]?.bufferState, marker),
      ),
  );
}

function assertHostHistory(host, phase) {
  if (host.scrollbackMarkerPresent !== true) {
    throw new Error(
      `${phase}: Host canonical tail marker is missing: ${JSON.stringify(host)}`,
    );
  }
  if (host.scrollbackHistoryLineCount !== EXPECTED_HISTORY_LINES) {
    throw new Error(
      `${phase}: Host retained ${host.scrollbackHistoryLineCount} numbered history lines; expected ${EXPECTED_HISTORY_LINES}`,
    );
  }
}

function assertCanonicalTails(status, marker, phase) {
  for (const role of WINDOW_ROLES) {
    const report = status.windows?.[role];
    if (!hasCanonicalTail(report?.bufferState, marker)) {
      throw new Error(
        `${phase}: window ${role.toUpperCase()} is not at the canonical tail: ${JSON.stringify(report?.bufferState)}`,
      );
    }
    if (!hasCanonicalTail(report?.firstPresentedBufferState, marker)) {
      throw new Error(
        `${phase}: window ${role.toUpperCase()} did not present the canonical tail first: ${JSON.stringify(report?.firstPresentedBufferState)}`,
      );
    }
    if (report.visibleFrameCount < 1 || report.visibleFrameViolations !== 0) {
      throw new Error(
        `${phase}: window ${role.toUpperCase()} exposed ${report.visibleFrameViolations} incomplete projections across ${report.visibleFrameCount} samples`,
      );
    }
  }
}

async function proveIndependentHistoryProjection(role, otherRole, marker) {
  for (let step = 0; step < HISTORY_SCROLL_STEPS; step += 1) {
    await harness.scrollRows(role, HISTORY_SCROLL_ROWS);
  }
  let status = await harness.waitForBufferState(
    role,
    `window ${role.toUpperCase()} retained Host history`,
    (state, candidate) =>
      hasCanonicalHistory(state) &&
      hasCanonicalTail(candidate.windows?.[otherRole]?.bufferState, marker),
  );
  const historyDistance = status.windows[role].bufferState.viewportY;
  if (status.windows[role].visibleFrameViolations !== 0) {
    throw new Error(
      `window ${role.toUpperCase()} classified a complete history projection as invalid: ${JSON.stringify(status.windows[role])}`,
    );
  }

  for (let step = 0; step < HISTORY_SCROLL_STEPS; step += 1) {
    await harness.scrollRows(role, -HISTORY_SCROLL_ROWS);
  }
  status = await waitForCanonicalTails(
    marker,
    `window ${role.toUpperCase()} tail return`,
  );
  return { historyDistance, status };
}

async function resizeAtTail(role, size, marker) {
  const before = await harness.status();
  const beforeNativeSize = before.nativeWindows?.[role]?.innerPhysicalSize;
  const beforeVisibleFrames = before.windows?.[role]?.visibleFrameCount ?? 0;
  await harness.resize(role, size);
  const status = await harness.waitForBufferState(
    role,
    `${size} native resize with canonical tail`,
    (state, candidate) => {
      const nativeSize = candidate.nativeWindows?.[role]?.innerPhysicalSize;
      const nativeSizeChanged =
        size === "compact"
          ? nativeSize?.width < beforeNativeSize?.width &&
            nativeSize?.height < beforeNativeSize?.height
          : nativeSize?.width > beforeNativeSize?.width &&
            nativeSize?.height > beforeNativeSize?.height;
      return (
        nativeSizeChanged &&
        candidate.windows?.[role]?.mounted === true &&
        (candidate.windows?.[role]?.visibleFrameCount ?? 0) >
          beforeVisibleFrames &&
        hasCanonicalTail(state, marker) &&
        WINDOW_ROLES.every((candidateRole) =>
          hasCanonicalTail(
            candidate.windows?.[candidateRole]?.bufferState,
            marker,
          ),
        )
      );
    },
  );
  assertCanonicalTails(status, marker, `${size} resize`);
  return status;
}

try {
  await harness.connect();
  await harness.prepareRuntime();
  const started = await harness.start("scrollback");
  await harness.waitReady();
  let status = await waitForCanonicalTails(
    started.scrollbackMarker,
    "initial attach",
  );
  assertCanonicalTails(status, started.scrollbackMarker, "initial attach");

  const windowA = await proveIndependentHistoryProjection(
    "a",
    "b",
    started.scrollbackMarker,
  );
  const windowB = await proveIndependentHistoryProjection(
    "b",
    "a",
    started.scrollbackMarker,
  );
  assertHostHistory(await harness.snapshotEvidence(), "history projection");

  status = await resizeAtTail(
    "a",
    "compact",
    started.scrollbackMarker,
  );
  status = await resizeAtTail("a", "wide", started.scrollbackMarker);

  const resume = await runNormalBufferResumeScenario({
    harness,
    initialStatus: status,
    scrollbackMarker: started.scrollbackMarker,
  });

  console.log(
    `hmux scrollback smoke: Host retained ${EXPECTED_HISTORY_LINES} lines; independent WebViews reached ${windowA.historyDistance}/${windowB.historyDistance} rows from tail and returned to ${started.scrollbackMarker}; compact/wide resize and normal-buffer resume ${JSON.stringify(resume)}`,
  );
} finally {
  await harness.finish().catch((error) => {
    console.error(`hmux scrollback smoke cleanup failed: ${error}`);
    process.exitCode = 1;
  });
}
