import {
  HmuxWindowFocusHarness,
  WINDOW_ROLES,
} from "./lib/hmux-window-focus-harness.mjs";

const harness = new HmuxWindowFocusHarness();

try {
  await harness.phase("connect", "qa_transport", () => harness.connect());
  await harness.phase("runtime_prepare", "qa_runtime_activation", () =>
    harness.prepareRuntime(),
  );
  await harness.phase("start", "qa_startup", () =>
    harness.start("smoke"),
  );
  const ready = await harness.phase(
    "visible_ready",
    "exclusive_focus_streaming",
    () => harness.waitReady(),
  );
  assertVisibleObservers(ready);

  const before = await harness.phase(
    "recovery_geometry_baseline",
    "exclusive_focus_geometry",
    () => harness.snapshotEvidence(),
  );
  const beforeDelivery = await harness.phase(
    "pre_restart_delivery",
    "exclusive_focus_streaming",
    () => harness.measuredFocusedStep("a"),
  );
  const beforeMarker = beforeDelivery.action;

  const restart = await harness.phase(
    "webview_restart",
    "webview_restart",
    () => harness.restartWebview("a"),
  );
  const fence = await harness.phase(
    "predecessor_fence",
    "webview_recovery",
    () =>
      harness.waitFor(
        "outgoing WebView predecessor fence",
        10_000,
        async () => {
          const status = await harness.status();
          return status.predecessorFence?.outcome
            ? status.predecessorFence
            : undefined;
        },
      ),
  );
  if (
    fence.outcome !== "stale_rejected" ||
    fence.window !== restart.window ||
    fence.instanceId !== restart.previousWebviewInstanceId ||
    fence.armedAfterStartedCount !==
      restart.predecessorFenceArmedAfterStartedCount ||
    fence.attemptedStartedCount <= fence.armedAfterStartedCount
  ) {
    throw new Error(
      `outgoing WebView was not rejected after page-start: ${JSON.stringify(fence)}`,
    );
  }
  const recovery = await harness.phase(
    "webview_recovery",
    "webview_recovery",
    () => harness.waitForWebviewRecovery(restart),
  );
  assertVisibleObservers(recovery.status);
  assertRestoredBuffer(
    recovery.status,
    restart.window,
    beforeMarker.marker,
  );

  await harness.phase(
    "post_restart_delivery",
    "exclusive_focus_streaming",
    () => harness.measuredFocusedStep("a"),
  );
  const after = await harness.phase(
    "recovery_geometry_final",
    "exclusive_focus_geometry",
    () => harness.snapshotEvidence(),
  );
  if (after.rows !== before.rows || after.columns !== before.columns) {
    throw new Error(
      `WebView restart changed Hmux geometry: expected ${before.columns}x${before.rows}, received ${after.columns}x${after.rows}`,
    );
  }
  if (recovery.recoveryMs > 10_000) {
    throw new Error(
      `WebView recovery exceeded 10s: ${recovery.recoveryMs}ms`,
    );
  }
  await harness.phase("surface_hide", "exclusive_focus_streaming", () =>
    harness.setPresentation("hidden"),
  );
  await harness.phase("surface_release", "exclusive_focus_streaming", () =>
    harness.waitHiddenSurfaceRelease(),
  );
  console.log(
    `hmux webview recovery smoke: generation changed in ${recovery.recoveryMs}ms, Host stayed live at ${after.columns}x${after.rows}, and both visible observers resumed before releasing`,
  );
} finally {
  await harness.phase("cleanup", "qa_cleanup", () => harness.finish()).catch(
    (error) => {
      console.error(`hmux webview recovery smoke cleanup failed: ${error}`);
      process.exitCode = 1;
    },
  );
}

function assertVisibleObservers(status) {
  for (const role of WINDOW_ROLES) {
    const report = status.windows?.[role];
    const nativeWindow = status.nativeWindows?.[role];
    if (
      !report?.mounted ||
      !report.listening ||
      !report.synchronized ||
      report.hydrating ||
      nativeWindow?.visible !== true
    ) {
      throw new Error(
        `window ${role.toUpperCase()} is not a synchronized visible observer: ${JSON.stringify(
          { report, nativeWindow },
        )}`,
      );
    }
  }
}

function assertRestoredBuffer(status, role, marker) {
  const report = status.windows?.[role];
  if (
    !report.bufferState ||
    !report.synchronized ||
    report.hydrating ||
    report.markerCounts?.[marker] !== 1
  ) {
    throw new Error(
      `window ${role.toUpperCase()} did not restore its pre-restart complete projection before new terminal activity: ${JSON.stringify(
        { marker, report },
      )}`,
    );
  }
}
