import { normalizeFrontendRuntimeObservation } from "../../../src/contracts/frontendRuntimeObservation.mjs";

const params = new URLSearchParams(location.search);
const label = params.get("label") ?? "";
const desktopId = params.get("desktop") ?? "";
const proof = params.get("proof") ?? "";
const scenarioId = params.get("scenario") ?? "";
const surface = params.get("surface") ?? "";
const snapshotOverride =
  params.get("snapshotOverride") ??
  import.meta.env.VITE_DURE_NATIVE_MEDIA_SNAPSHOT_OVERRIDE;

function publish(state, error) {
  parent.postMessage(
    {
      schemaVersion: 1,
      state,
      desktopId,
      label,
      proof,
      ...(error ? { error } : {}),
    },
    location.origin,
  );
}

async function currentApplicationBuild() {
  const response = await fetch("/__app_build_info", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`native media build identity failed: ${response.status}`);
  }
  const observation = normalizeFrontendRuntimeObservation(await response.json());
  if (!observation) {
    throw new Error("native media build identity is invalid");
  }
  return observation;
}

async function boot() {
  if (window.top === window || window.__TAURI_INTERNALS__) {
    throw new Error("native media fixture did not receive an IPC-isolated child frame");
  }
  const [catalog, runtime, snapshot, applicationBuild] = await Promise.all([
    import("../scenarios.mjs"),
    import("./scenario-runtime.mjs"),
    import("./snapshot-override.mjs"),
    currentApplicationBuild(),
  ]);
  const { scenarioById, validateScenario } = catalog;
  const {
    applyNativeMediaFixture,
    installNativeMediaFixtureConfig,
    nativeCenterHitTest,
    nativeTerminalReplayStepsForSurface,
    playNativeScenarioTimeline,
    playNativeTerminalReplay,
    waitForNativeTerminalReplayStart,
  } = runtime;
  const { applyNativeSnapshotOverride } = snapshot;
  const catalogScenario = scenarioById(scenarioId);
  if (!catalogScenario) {
    throw new Error(`native media scenario is missing: ${scenarioId}`);
  }
  const scenario = snapshotOverride
    ? applyNativeSnapshotOverride(catalogScenario, snapshotOverride)
    : catalogScenario;
  const validationErrors = validateScenario(scenario);
  if (validationErrors.length > 0) {
    throw new Error(`native media scenario is invalid: ${validationErrors.join("; ")}`);
  }
  installNativeMediaFixtureConfig({
    applicationBuild,
    proof,
    scenario,
    surface,
    windowLabel: label,
  });
  await import("../tauri-mock.js");
  await import("/src/main.tsx");
  await applyNativeMediaFixture(scenario, { desktopId, surface });
  if (!nativeCenterHitTest()) {
    throw new Error("native media fixture center is not DOM hit-testable");
  }
  publish("ready");
  const replaySteps = nativeTerminalReplayStepsForSurface(scenario, {
    desktopId,
    surface,
  });
  document.documentElement.dataset.dureNativeReplaySteps = String(
    replaySteps.length,
  );
  if (replaySteps.length > 0) {
    void waitForNativeTerminalReplayStart({
      controlUrl: scenario.nativeTerminalReplay.controlUrl,
      proof,
    })
      .then(async (receipt) => {
        const now = () => performance.timeOrigin + performance.now();
        const [publications, timelineActions] = await Promise.all([
          playNativeTerminalReplay(replaySteps, {
            initialDelayMs: 100,
            now,
            startedAtMs: receipt.startedAtUnixMs,
          }),
          playNativeScenarioTimeline(
            scenario,
            { desktopId, surface },
            { now, startedAtMs: receipt.startedAtUnixMs },
          ),
        ]);
        document.documentElement.dataset.dureNativeReplayRendered = String(
          publications.length,
        );
        document.documentElement.dataset.dureNativeTimelineActions = String(
          timelineActions.length,
        );
        publish("replay-complete");
      })
      .catch((error) => {
        document.documentElement.dataset.dureNativeReplayError = String(error);
        publish("error", `native replay or timeline failed: ${String(error)}`);
        console.error(error);
      });
  }
}

boot().catch((error) => {
  document.body.innerHTML = "";
  const failure = document.createElement("main");
  failure.style.cssText =
    "display:grid;height:100vh;place-items:center;background:#0b0e14;color:#f87171;font:14px ui-monospace;padding:32px";
  failure.textContent = `Native media fixture failed:\n${String(error)}\n${error?.stack ?? ""}`;
  document.body.append(failure);
  publish("error", String(error));
  console.error(error);
});
