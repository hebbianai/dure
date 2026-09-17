import {
  HmuxWindowFocusHarness,
  sleep,
  WINDOW_ROLES,
} from "./lib/hmux-window-focus-harness.mjs";
import {
  percentile,
  sampleProcessTree,
  summarizeProcessSamples,
} from "./lib/process-tree-metrics.mjs";

const durationMs = readPositiveInteger(
  "HMUX_WINDOW_FOCUS_SOAK_DURATION_MS",
  30 * 60 * 1_000,
);
const intervalMs = readPositiveInteger(
  "HMUX_WINDOW_FOCUS_SOAK_INTERVAL_MS",
  30_000,
);
const presentationCycleEvery = readPositiveInteger(
  "HMUX_WINDOW_FOCUS_SOAK_PRESENTATION_EVERY",
  10,
);
if (presentationCycleEvery === 1) {
  throw new Error(
    "HMUX_WINDOW_FOCUS_SOAK_PRESENTATION_EVERY must be greater than 1",
  );
}
const hiddenHoldMs = readPositiveInteger(
  "HMUX_WINDOW_FOCUS_SOAK_HIDDEN_HOLD_MS",
  1_000,
);
const rootPid = readPositiveInteger("HEBBIAN_QA_ROOT_PID");
const markerLimit = Math.ceil(durationMs / intervalMs);
if (markerLimit > 64) {
  throw new Error(
    `soak would issue ${markerLimit} markers; increase the interval to stay within 64`,
  );
}

const budgets = {
  visibleP95Ms: readPositiveNumber("HMUX_WINDOW_FOCUS_VISIBLE_P95_MS", 2_000),
  visibleMaxMs: readPositiveNumber("HMUX_WINDOW_FOCUS_VISIBLE_MAX_MS", 5_000),
  resumeMaxMs: readPositiveNumber("HMUX_WINDOW_FOCUS_RESUME_MAX_MS", 10_000),
  heartbeatLagMs: readPositiveNumber(
    "HMUX_WINDOW_FOCUS_HEARTBEAT_LAG_MS",
    2_000,
  ),
  averageCpuPercent: readPositiveNumber(
    "HMUX_WINDOW_FOCUS_AVERAGE_CPU_PERCENT",
    60,
  ),
  peakCpuPercent: readPositiveNumber(
    "HMUX_WINDOW_FOCUS_PEAK_CPU_PERCENT",
    200,
  ),
  peakRssMiB: readPositiveNumber("HMUX_WINDOW_FOCUS_PEAK_RSS_MIB", 2_048),
  minHeartbeatHz: readPositiveNumber(
    "HMUX_WINDOW_FOCUS_MIN_HEARTBEAT_HZ",
    0.5,
  ),
  maxHeartbeatHz: readPositiveNumber(
    "HMUX_WINDOW_FOCUS_MAX_HEARTBEAT_HZ",
    3,
  ),
};

const harness = new HmuxWindowFocusHarness();
const visibleLatencies = [];
const resumeLatencies = [];
const processSamples = [];
let initialStatus;
let finalStatus;
let markerCount = 0;

try {
  await harness.connect();
  await harness.prepareRuntime();
  await harness.start("soak");
  await harness.waitReady();

  // A owns control after priming; B is the continuously unfocused observer.
  // The runner never steals focus again during ordinary visible markers.
  initialStatus = await harness.status();

  const startedAt = Date.now();
  let nextMarkerAt = startedAt;
  while (Date.now() - startedAt < durationMs) {
    markerCount += 1;
    assertSurfaceCount(await harness.status());
    const cyclesPresentation =
      markerCount % presentationCycleEvery === 0;
    const presentation =
      markerCount % (presentationCycleEvery * 2) === 0
        ? "hidden"
        : "minimized";
    if (cyclesPresentation) {
      await harness.setPresentation(presentation);
      await sleep(hiddenHoldMs);
    }

    const action = await harness.inject();
    if (cyclesPresentation) {
      await sleep(hiddenHoldMs);
      await harness.setPresentation("visible");
    }
    const observed = await harness.waitForMarker(action, {
      unfocusedRoles: cyclesPresentation ? [] : ["b"],
    });
    assertSurfaceCount(observed.status);
    const target = cyclesPresentation ? resumeLatencies : visibleLatencies;
    target.push(
      observed.firstSeenAtMs[cyclesPresentation ? "a" : "b"] - action.issuedAtMs,
    );
    processSamples.push(sampleProcessTree(rootPid));

    if (markerCount === 1 || markerCount % 5 === 0) {
      console.log(
        `hmux window focus soak: ${markerCount}/${markerLimit} markers, ${Math.round(
          (Date.now() - startedAt) / 1_000,
        )}s elapsed`,
      );
    }
    nextMarkerAt += intervalMs;
    await sleep(Math.max(0, nextMarkerAt - Date.now()));
  }

  finalStatus = await harness.status();
  const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1_000);
  const heartbeatRates = Object.fromEntries(
    WINDOW_ROLES.map((role) => [
      role,
      (finalStatus.windows[role].heartbeatCount -
        initialStatus.windows[role].heartbeatCount) /
        elapsedSeconds,
    ]),
  );
  const processSummary = summarizeProcessSamples(processSamples);
  const result = {
    durationSeconds: elapsedSeconds,
    markers: markerCount,
    visibleLatencyMs: {
      samples: visibleLatencies.length,
      p95: percentile(visibleLatencies, 0.95),
      max: Math.max(...visibleLatencies),
    },
    resumeLatencyMs:
      resumeLatencies.length > 0
        ? {
            samples: resumeLatencies.length,
            max: Math.max(...resumeLatencies),
          }
        : { samples: 0, max: 0 },
    heartbeat: {
      ratesHz: heartbeatRates,
      maxLagMs: Math.max(
        ...WINDOW_ROLES.map(
          (role) => finalStatus.windows[role].maxHeartbeatLagMs,
        ),
      ),
    },
    processTree: processSummary,
  };

  console.log(`hmux window focus soak metrics: ${JSON.stringify(result)}`);

  assertAtMost(
    "visible marker p95 latency",
    result.visibleLatencyMs.p95,
    budgets.visibleP95Ms,
  );
  assertAtMost(
    "visible marker max latency",
    result.visibleLatencyMs.max,
    budgets.visibleMaxMs,
  );
  assertAtMost(
    "presentation resume max latency",
    result.resumeLatencyMs.max,
    budgets.resumeMaxMs,
  );
  assertAtMost(
    "WebView heartbeat max lag",
    result.heartbeat.maxLagMs,
    budgets.heartbeatLagMs,
  );
  for (const [role, rate] of Object.entries(heartbeatRates)) {
    assertAtLeast(
      `window ${role.toUpperCase()} heartbeat rate`,
      rate,
      budgets.minHeartbeatHz,
    );
    assertAtMost(
      `window ${role.toUpperCase()} heartbeat rate`,
      rate,
      budgets.maxHeartbeatHz,
    );
  }
  assertAtMost(
    "runner process-tree average CPU",
    processSummary.averageCpuPercent,
    budgets.averageCpuPercent,
  );
  assertAtMost(
    "runner process-tree peak CPU",
    processSummary.peakCpuPercent,
    budgets.peakCpuPercent,
  );
  assertAtMost(
    "runner process-tree peak RSS",
    processSummary.peakRssMiB,
    budgets.peakRssMiB,
  );

  console.log(`hmux window focus soak passed: ${JSON.stringify(result)}`);
} finally {
  await harness.finish().catch((error) => {
    console.error(`hmux window focus soak cleanup failed: ${error}`);
    process.exitCode = 1;
  });
}

function assertSurfaceCount(status) {
  if (status.terminalSurfaceCount !== WINDOW_ROLES.length) {
    throw new Error(
      `expected exactly ${WINDOW_ROLES.length} terminal surfaces, found ${status.terminalSurfaceCount}`,
    );
  }
}

function readPositiveInteger(name, fallback) {
  const value = process.env[name] ?? fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readPositiveNumber(name, fallback) {
  const value = process.env[name] ?? fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function assertAtMost(name, actual, budget) {
  if (actual > budget) {
    throw new Error(`${name} ${actual.toFixed(2)} exceeded ${budget}`);
  }
}

function assertAtLeast(name, actual, budget) {
  if (actual < budget) {
    throw new Error(`${name} ${actual.toFixed(2)} was below ${budget}`);
  }
}
