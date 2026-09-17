import {
  HmuxWindowFocusHarness,
  WINDOW_ROLES,
} from "./lib/hmux-window-focus-harness.mjs";

const harness = new HmuxWindowFocusHarness();
const stepCount = readStepCount();

try {
  await harness.phase("connect", "qa_transport", () => harness.connect());
  await harness.phase("runtime_prepare", "qa_runtime_activation", () =>
    harness.prepareRuntime(),
  );
  await harness.phase("start", "qa_startup", () => harness.start("smoke"));
  await harness.phase("focus_ready", "exclusive_os_focus", () =>
    harness.waitReady(),
  );
  const finalStatus = await harness.phase(
    "focus_handoff",
    "exclusive_os_focus",
    async () => {
      let status;
      for (let step = 0; step < stepCount; step += 1) {
        status = await harness.focusedStep(step % 2 === 0 ? "a" : "b");
      }
      for (const marker of status.expectedMarkers) {
        for (const role of WINDOW_ROLES) {
          if (status.windows[role].markerCounts?.[marker] !== 1) {
            const host = await harness.snapshotEvidence().catch((error) => ({
              error: String(error),
            }));
            const evidence = harness.markerPipelineEvidence(
              {
                actionId: "final-exact-once-sweep",
                marker,
                window: role,
              },
              host,
            );
            harness.recordMarkerPipelineEvidence(evidence);
            throw new Error(
              `${marker} was not rendered exactly once in window ${role}; marker pipeline: ${JSON.stringify(evidence)}`,
            );
          }
        }
      }
      return status;
    },
  );
  console.log(
    `hmux window focus smoke: ${finalStatus.expectedMarkers.length} markers rendered once in both windows`,
  );
} finally {
  await harness.phase("cleanup", "qa_cleanup", () => harness.finish()).catch(
    (error) => {
      console.error(`hmux window focus smoke cleanup failed: ${error}`);
      process.exitCode = 1;
    },
  );
}

function readStepCount() {
  const raw = process.env.HMUX_WINDOW_FOCUS_HANDOFF_STEPS ?? "4";
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 64) {
    throw new Error(
      "HMUX_WINDOW_FOCUS_HANDOFF_STEPS must be an integer between 1 and 64",
    );
  }
  return value;
}
