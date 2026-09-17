import { HmuxWindowFocusHarness } from "./lib/hmux-window-focus-harness.mjs";

const harness = new HmuxWindowFocusHarness();
const markerCount = readMarkerCount();

try {
  await harness.phase("connect", "qa_transport", () => harness.connect());
  await harness.phase("runtime_prepare", "qa_runtime_activation", () =>
    harness.prepareRuntime(),
  );
  await harness.phase("start", "qa_startup", () =>
    harness.start("background"),
  );
  await harness.phase("background_hidden_release", "background_streaming", () =>
    harness.waitHiddenSurfaceRelease(),
  );
  const baselineSnapshot = await harness.phase(
    "background_geometry_baseline",
    "background_geometry",
    () => harness.snapshotEvidence(),
  );
  assertCanonicalGeometry(baselineSnapshot, {
    rows: 30,
    columns: 100,
    description: "initial background Host geometry",
  });
  const actions = await harness.phase(
    "hidden_host_delivery",
    "background_streaming",
    async () => {
      const actions = [];
      for (let index = 0; index < markerCount; index += 1) {
        const action = await harness.inject();
        await harness.waitForHostMarker(action);
        actions.push(action);
      }
      return actions;
    },
  );
  const finalStatus = await harness.phase(
    "background_final_release",
    "background_streaming",
    () => harness.waitHiddenSurfaceRelease(),
  );
  const finalSnapshot = await harness.phase(
    "background_geometry_final",
    "background_geometry",
    () => harness.snapshotEvidence(),
  );
  assertCanonicalGeometry(finalSnapshot, {
    rows: baselineSnapshot.rows,
    columns: baselineSnapshot.columns,
    description: "final background Host geometry",
  });
  for (const action of actions) {
    if (finalSnapshot.markerCounts?.[action.marker] !== 1) {
      throw new Error(
        `${action.marker} was not retained exactly once by the Host while every surface was released`,
      );
    }
  }
  console.log(
    `hmux background window smoke: ${finalStatus.expectedMarkers.length} markers were retained exactly once at ${finalSnapshot.columns}x${finalSnapshot.rows} while both hidden surfaces stayed released`,
  );
} finally {
  await harness.phase("cleanup", "qa_cleanup", () => harness.finish()).catch(
    (error) => {
      console.error(`hmux background window smoke cleanup failed: ${error}`);
      process.exitCode = 1;
    },
  );
}

function readMarkerCount() {
  const raw = process.env.HMUX_WINDOW_BACKGROUND_MARKERS ?? "4";
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 64) {
    throw new Error(
      "HMUX_WINDOW_BACKGROUND_MARKERS must be an integer between 1 and 64",
    );
  }
  return value;
}

function assertCanonicalGeometry(snapshot, expected) {
  if (
    snapshot.rows !== expected.rows ||
    snapshot.columns !== expected.columns
  ) {
    throw new Error(
      `${expected.description} changed: expected ${expected.columns}x${expected.rows}, received ${snapshot.columns}x${snapshot.rows}`,
    );
  }
}
