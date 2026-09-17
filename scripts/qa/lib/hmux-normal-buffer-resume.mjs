const WINDOW_ROLES = ["a", "b"];
const DEFAULT_TIMEOUT_MS = 30_000;

export const NORMAL_BUFFER_RESUME_DEFAULTS = Object.freeze({
  hiddenHoldMs: 150,
  hostReceiptBudgetMs: 100,
  echoPaintBudgetMs: 200,
});

export async function runNormalBufferResumeScenario({
  harness,
  initialStatus,
  scrollbackMarker,
  options = {},
}) {
  const config = { ...NORMAL_BUFFER_RESUME_DEFAULTS, ...options };
  const initialHost = await harness.snapshotEvidence();
  assertHealthyNormalBuffer(
    initialStatus.windows?.a,
    scrollbackMarker,
    "baseline window A",
  );

  await harness.setPresentation("hidden");
  await harness.waitFor(
    "both normal-buffer QA windows to become hidden",
    DEFAULT_TIMEOUT_MS,
    async () => {
      const status = await harness.status();
      return status.presentation === "hidden" &&
        WINDOW_ROLES.every(
          (role) =>
            status.nativeWindows?.[role]?.visible === false &&
            status.windows?.[role]?.documentFocused === false,
        )
        ? status
        : undefined;
    },
  );
  await sleep(config.hiddenHoldMs);

  const hiddenOutput = await harness.inject();
  const hiddenHost = await waitForHostMarker(harness, hiddenOutput);

  await harness.setPresentation("visible");
  const immediateInput = await harness.measuredFocusedStep("a");
  await harness.waitForMarker(hiddenOutput, { unfocusedRoles: [] });
  const finalStatus = await waitForHealthyNormalBuffer(
    harness,
    scrollbackMarker,
  );

  return assertNormalBufferResume({
    initialHost,
    hiddenHost,
    hiddenOutput,
    immediateInput,
    finalStatus,
    scrollbackMarker,
    config,
  });
}

export function assertNormalBufferResume({
  initialHost,
  hiddenHost,
  hiddenOutput,
  immediateInput,
  finalStatus,
  scrollbackMarker,
  config = NORMAL_BUFFER_RESUME_DEFAULTS,
}) {
  if (
    hiddenHost.markerCounts?.[hiddenOutput.marker] !== 1 ||
    numericSequence(hiddenHost.sequenceThrough) <=
      numericSequence(initialHost.sequenceThrough)
  ) {
    throw new Error(
      `hidden output did not advance the Host exactly once: ${JSON.stringify({ initialHost, hiddenHost, hiddenOutput })}`,
    );
  }

  const observation = immediateInput.hostReceiptObservation;
  const timing = immediateInput.timing;
  if (!observation) {
    throw new Error("immediate input is missing Host-receipt presentation evidence");
  }
  if (
    observation.concealed ||
    !observation.atBottom ||
    observation.visibleScrollbackMarker !== scrollbackMarker
  ) {
    throw new Error(
      `foreground viewport was not ready at the Host receipt: ${JSON.stringify(observation)}`,
    );
  }
  assertAtMost(
    "normal-buffer input to Host receipt",
    timing.inputToHostReceiptMs,
    config.hostReceiptBudgetMs,
  );
  assertAtMost(
    "normal-buffer input to echo paint",
    timing.inputToEchoPaintMs,
    config.echoPaintBudgetMs,
  );

  for (const role of WINDOW_ROLES) {
    const report = finalStatus.windows?.[role];
    assertHealthyNormalBuffer(
      report,
      scrollbackMarker,
      `window ${role.toUpperCase()}`,
    );
    for (const marker of [hiddenOutput.marker, immediateInput.action.marker]) {
      if (report.markerCounts?.[marker] !== 1) {
        throw new Error(
          `window ${role.toUpperCase()} did not render ${marker} exactly once`,
        );
      }
    }
  }

  return {
    hiddenOutputSequence: hiddenHost.sequenceThrough,
    inputToHostReceiptMs: timing.inputToHostReceiptMs,
    inputToEchoPaintMs: timing.inputToEchoPaintMs,
    finalRowsFromTail: finalStatus.windows.a.bufferState.viewportY,
  };
}

async function waitForHostMarker(harness, action) {
  return harness.waitFor(
    `${action.marker} in the Host canonical model while hidden`,
    DEFAULT_TIMEOUT_MS,
    async () => {
      const snapshot = await harness.snapshotEvidence();
      return snapshot.markerCounts?.[action.marker] === 1
        ? snapshot
        : undefined;
    },
  );
}

async function waitForHealthyNormalBuffer(
  harness,
  scrollbackMarker,
) {
  return harness.waitFor(
    "normal-buffer history and immediate input to finish foreground catch-up",
    DEFAULT_TIMEOUT_MS,
    async () => {
      const status = await harness.status();
      return WINDOW_ROLES.every((role) =>
        isHealthyNormalBuffer(
          status.windows?.[role],
          scrollbackMarker,
        ),
      )
        ? status
        : undefined;
    },
  );
}

function assertHealthyNormalBuffer(report, marker, label) {
  if (!isHealthyNormalBuffer(report, marker)) {
    throw new Error(
      `${label} does not retain the normal-buffer history at the bottom: ${JSON.stringify(report?.bufferState)}`,
    );
  }
}

function isHealthyNormalBuffer(report, marker) {
  const state = report?.bufferState;
  return (
    report?.hydrating === false &&
    state?.concealed === false &&
    state.atBottom === true &&
    state.viewportY === 0 &&
    state.bufferLength > 0 &&
    state.scrollbackRows >= 1 &&
    state.visibleScrollbackMarker === marker
  );
}

function assertAtMost(label, actual, budget) {
  if (!Number.isFinite(actual) || actual > budget) {
    throw new Error(`${label} ${actual}ms exceeds ${budget}ms`);
  }
}

function numericSequence(value) {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`invalid Host output sequence: ${value}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
