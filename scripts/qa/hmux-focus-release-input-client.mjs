import { HmuxWindowFocusHarness } from "./lib/hmux-window-focus-harness.mjs";

const harness = new HmuxWindowFocusHarness();

try {
  await harness.phase("connect", "qa_transport", () => harness.connect());
  await harness.phase("runtime_prepare", "qa_runtime_activation", () =>
    harness.prepareRuntime(),
  );
  await harness.phase("start", "qa_startup", () =>
    harness.start("external_input"),
  );
  await harness.phase("focus_ready", "exclusive_os_focus", () =>
    harness.waitReady({ primeRoles: ["a"] }),
  );
  const evidence = await harness.phase(
    "focus_release_input",
    "exclusive_os_focus",
    () => harness.focusReleaseInputStep("a"),
  );
  console.log(
    `hmux terminal/search focus handoff smoke: ${evidence.action.marker} stayed blocked under Sessions search and rendered once after terminal refocus`,
  );
} finally {
  await harness.phase("cleanup", "qa_cleanup", () => harness.finish()).catch(
    (error) => {
      console.error(`hmux focus-release external input cleanup failed: ${error}`);
      process.exitCode = 1;
    },
  );
}
