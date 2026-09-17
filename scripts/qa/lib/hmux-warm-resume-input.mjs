const WINDOW_ROLES = ["a", "b"];
const DEFAULT_TIMEOUT_MS = 30_000;

export const WARM_RESUME_INPUT_DEFAULTS = Object.freeze({
  actionToInputBudgetMs: 100,
  hostReceiptBudgetMs: 100,
  echoPaintBudgetMs: 200,
});

export async function runWarmResumeInputScenario({
  harness,
  initialStatus,
  options = {},
}) {
  const config = { ...WARM_RESUME_INPUT_DEFAULTS, ...options };
  const baseline = resumeBaseline(initialStatus);
  const initialHost = await harness.snapshotEvidence();
  const warmInput = await harness.measuredFocusedStep("a");

  await harness.setPresentation("hidden");
  await harness.waitHiddenSurfaceRelease();

  const hiddenOutput = await harness.inject();
  const hiddenHost = await waitForHostMarker(harness, hiddenOutput);

  const coldInput = await harness.measuredFocusedStep("a", {
    requiredRoles: ["a"],
  });
  await harness.setPresentation("visible");
  const finalProjection = await harness.waitForMarker(coldInput.action, {
    unfocusedRoles: [],
  });
  const finalHost = await harness.snapshotEvidence();

  return assertWarmResumeInput({
    baseline,
    initialHost,
    hiddenHost,
    hiddenOutput,
    warmInput,
    coldInput,
    finalStatus: finalProjection.status,
    finalHost,
    config,
  });
}

export function assertWarmResumeInput({
  baseline,
  initialHost,
  hiddenHost,
  hiddenOutput,
  warmInput,
  coldInput,
  finalStatus,
  finalHost,
  config = WARM_RESUME_INPUT_DEFAULTS,
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

  const warmInputMarker = warmInput.action.marker;
  const coldInputMarker = coldInput.action.marker;
  for (const marker of [hiddenOutput.marker, warmInputMarker, coldInputMarker]) {
    if (finalHost.markerCounts?.[marker] !== 1) {
      throw new Error(
        `resumed Host did not retain ${marker} exactly once: ${JSON.stringify(finalHost)}`,
      );
    }
  }

  const observation = coldInput.hostReceiptObservation;
  if (
    !observation ||
    observation.concealed ||
    !observation.atBottom ||
    observation.visibleFrameViolations !== baseline.a.visibleFrameViolations
  ) {
    throw new Error(
      `foreground viewport was not ready at the Host receipt: ${JSON.stringify({ baseline, observation })}`,
    );
  }
  assertAtMost(
    "warm action to input",
    warmInput.timing.actionToInputStartMs,
    config.actionToInputBudgetMs,
  );
  assertAtMost(
    "cold reveal to input",
    coldInput.timing.actionToInputStartMs,
    config.actionToInputBudgetMs,
  );
  assertAtMost(
    "warm-resume input to Host receipt",
    coldInput.timing.inputToHostReceiptMs,
    config.hostReceiptBudgetMs,
  );
  assertAtMost(
    "warm-resume input to echo paint",
    coldInput.timing.inputToEchoPaintMs,
    config.echoPaintBudgetMs,
  );

  const warmAttachment = splitAttachmentIdentity(
    warmInput.attachmentIdentity,
  );
  const coldAttachment = splitAttachmentIdentity(
    coldInput.attachmentIdentity,
  );
  if (warmAttachment.attachmentId === coldAttachment.attachmentId) {
    throw new Error("cold reveal did not replace its attachment");
  }
  if (warmAttachment.terminalEpoch !== coldAttachment.terminalEpoch) {
    throw new Error("cold reveal changed terminal epoch");
  }
  const coldReport = coldInput.status?.windows?.a;
  if (coldReport?.webviewInstanceId !== baseline.a.webviewInstanceId) {
    throw new Error("cold reveal replaced its WebView");
  }
  if (
    !Number.isFinite(coldReport?.synchronizationCount) ||
    coldReport.synchronizationCount <= baseline.a.synchronizationCount
  ) {
    throw new Error("cold reveal did not synchronize a remounted surface");
  }

  for (const role of WINDOW_ROLES) {
    const report = finalStatus.windows?.[role];
    if (
      finalStatus.nativeWindows?.[role]?.visible !== true ||
      report?.mounted !== true ||
      report.webviewInstanceId !== baseline[role].webviewInstanceId ||
      !Number.isFinite(report.synchronizationCount) ||
      report.synchronizationCount <= baseline[role].synchronizationCount ||
      report?.visibleFrameViolations !== baseline[role].visibleFrameViolations
    ) {
      throw new Error(
        `window ${role.toUpperCase()} did not resume one complete visible surface`,
      );
    }
    for (const marker of [
      hiddenOutput.marker,
      warmInputMarker,
      coldInputMarker,
    ]) {
      if (report.markerCounts?.[marker] !== 1) {
        throw new Error(
          `window ${role.toUpperCase()} did not render ${marker} exactly once`,
        );
      }
    }
  }

  return {
    hiddenOutputSequence: hiddenHost.sequenceThrough,
    warmActionToInputStartMs: warmInput.timing.actionToInputStartMs,
    coldActionToInputStartMs: coldInput.timing.actionToInputStartMs,
    inputToHostReceiptMs: coldInput.timing.inputToHostReceiptMs,
    inputToEchoPaintMs: coldInput.timing.inputToEchoPaintMs,
    hostReceiptToProjectionCommitMs:
      coldInput.timing.hostReceiptToProjectionCommitMs,
    projectionCommitToEchoPaintMs:
      coldInput.timing.projectionCommitToEchoPaintMs,
  };
}

function resumeBaseline(status) {
  return Object.fromEntries(
    WINDOW_ROLES.map((role) => {
      const report = status.windows?.[role];
      if (
        report?.mounted !== true ||
        report.synchronized !== true ||
        typeof report.webviewInstanceId !== "string" ||
        report.webviewInstanceId.length === 0 ||
        !Number.isFinite(report.synchronizationCount) ||
        !Number.isFinite(report.visibleFrameViolations)
      ) {
        throw new Error(
          `window ${role.toUpperCase()} is not ready before warm resume`,
        );
      }
      return [
        role,
        {
          visibleFrameViolations: report.visibleFrameViolations,
          webviewInstanceId: report.webviewInstanceId,
          synchronizationCount: report.synchronizationCount,
        },
      ];
    }),
  );
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

function assertAtMost(label, actual, budget) {
  if (!Number.isFinite(actual) || actual > budget) {
    throw new Error(`${label} ${actual}ms exceeds ${budget}ms`);
  }
}

function splitAttachmentIdentity(value) {
  if (typeof value !== "string") {
    throw new Error(`invalid attachment identity: ${value}`);
  }
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid attachment identity: ${value}`);
  }
  return {
    attachmentId: value.slice(0, separator),
    terminalEpoch: value.slice(separator + 1),
  };
}

function numericSequence(value) {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`invalid Host output sequence: ${value}`);
  }
}
