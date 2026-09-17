const LIVE_SNAPSHOT_OVERRIDE = "VITE_DURE_NATIVE_MEDIA_SNAPSHOT_OVERRIDE";

/**
 * Build the native runner environment without allowing an ambient live
 * snapshot to cross into a fixture capture. The caller must opt in by passing
 * the exact snapshot for this run.
 */
export function nativeMediaRunnerEnvironment({
  baseEnvironment,
  durationMs,
  fps,
  output,
  plan,
  proof,
  replayRequired = false,
  scenarioId,
  snapshotOverride,
}) {
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(
      ([key]) => key !== LIVE_SNAPSHOT_OVERRIDE,
    ),
  );
  return {
    ...environment,
    DURE_NATIVE_MEDIA_DURATION_MS: String(durationMs),
    DURE_NATIVE_MEDIA_FPS: String(fps),
    DURE_NATIVE_MEDIA_OUTPUT: output,
    DURE_NATIVE_MEDIA_PROOF: proof,
    DURE_NATIVE_MEDIA_REPLAY_REQUIRED: replayRequired ? "1" : "0",
    DURE_NATIVE_MEDIA_SCENARIO: scenarioId,
    DURE_QA_WINDOW_PLAN_JSON: JSON.stringify(plan),
    // An explicit empty value outranks Vite's .env files. Omitting this key
    // would let stale local live-session data cross into a fixture capture.
    [LIVE_SNAPSHOT_OVERRIDE]: snapshotOverride ?? "",
  };
}
