import { HmuxWindowFocusHarness } from "./lib/hmux-window-focus-harness.mjs";
import { runWarmResumeInputScenario } from "./lib/hmux-warm-resume-input.mjs";

const harness = new HmuxWindowFocusHarness();

try {
  await harness.phase("connect", "qa_transport", () => harness.connect());
  await harness.phase("runtime_prepare", "qa_runtime_activation", () =>
    harness.prepareRuntime(),
  );
  await harness.phase("start", "qa_startup", () => harness.start("soak"));
  const initialStatus = await harness.phase(
    "focus_ready",
    "exclusive_os_focus",
    () => harness.waitReady(),
  );
  const result = await harness.phase(
    "warm_resume_input",
    "input_latency",
    () => runWarmResumeInputScenario({ harness, initialStatus }),
  );

  console.log(`hmux warm resume input passed: ${JSON.stringify(result)}`);
} finally {
  await harness.phase("cleanup", "qa_cleanup", () => harness.finish()).catch(
    (error) => {
      console.error(`hmux warm resume input cleanup failed: ${error}`);
      process.exitCode = 1;
    },
  );
}
