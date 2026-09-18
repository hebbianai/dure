import fs from "node:fs";
import path from "node:path";
import { readWorkspacePerformanceDescriptor } from "./lib/workspace-performance-descriptor.mjs";
import { readWorkspacePerformanceProviderFixture } from "./lib/workspace-performance-provider-fixture.mjs";
import { captureRetentionFootprint, retentionProfile, validateRetentionEvidence } from "./lib/workspace-retention-evidence.mjs";

const home = process.env.HOME;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const evidenceDirectory = process.env.DURE_QA_EVIDENCE_DIR;
const descriptorPath = process.env.DURE_QA_SERVER_DESCRIPTOR;
const scenario = process.env.DURE_QA_PERFORMANCE_SCENARIO ?? "baseline_15";
if (!home || !stateRoot || !evidenceDirectory) throw new Error("retention QA isolation incomplete");
const profile = process.env.DURE_QA_RETENTION_PROFILE ?? "short";
const plan = retentionProfile(profile);
const deadline = Date.now() + plan.clientTimeoutMs;
const points = new Map();
let report;
let providerFixture;
let summary;
let measurementError;
let startupError;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = () => {
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const destination = path.join(evidenceDirectory, "last-status.json");
  fs.writeFileSync(`${destination}.tmp`, `${JSON.stringify({ report, providerFixture,
    points: [...points.values()], summary, measurementError, startupError }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${destination}.tmp`, destination);
};
async function readReport(descriptor) {
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/perf/report`, {
    method: "POST", headers: { Authorization: `Bearer ${descriptor.token}`, "Content-Type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(10_000),
  });
  const receipt = await response.json();
  if (!response.ok || !receipt.ok || !receipt.report) {
    throw Object.assign(new Error(`retention performance report unavailable (${response.status}): ${receipt.error?.code ?? "unknown"}: ${receipt.error?.message ?? "no report"}`), {
      beforeReady: response.status === 504 && receipt.error?.code === "frontend_timeout",
    });
  }
  return { ...receipt.report, qaStatus: receipt.qaStatus, multiWindow: receipt.multiWindow };
}
try {
  while (Date.now() < deadline) {
    const descriptor = readWorkspacePerformanceDescriptor({ descriptorPath, home, stateRoot });
    if (!descriptor) { await sleep(250); continue; }
    // The native descriptor precedes the WebView's CLI listener. As in the
    // existing performance client, wait for that listener before measuring.
    // Once observations start, a transport failure invalidates the run.
    try {
      report = await readReport(descriptor);
    } catch (error) {
      if (report || !error.beforeReady) throw error;
      startupError = error instanceof Error ? error.message : String(error);
      save();
      await sleep(250);
      continue;
    }
    providerFixture = readWorkspacePerformanceProviderFixture(stateRoot, scenario);
    save();
    const status = report.qaStatus;
    if (status?.state === "failed") throw new Error(`retention failed in ${status.phase}: ${status.error}`);
    if (status?.state === "complete") {
      if (!providerFixture.ready) throw new Error("isolated fake-provider evidence incomplete");
      summary = validateRetentionEvidence({ status, points: [...points.values()].sort((a, b) => a.ordinal - b.ordinal),
        terminalCount: providerFixture.expected, profile });
      save();
      console.log(`native retention observation completed: ${JSON.stringify(summary)}`);
      break;
    }
    const match = status?.phase.match(/^retention_sample:(\d+)$/u);
    if (match && !points.has(Number(match[1]))) {
      const ordinal = Number(match[1]);
      const point = await captureRetentionFootprint(descriptor.processId, points.get(0)?.members);
      const after = await readReport(descriptor);
      if (after.qaStatus?.phase === status.phase && after.qaStatus?.state === "running") {
        points.set(ordinal, { ordinal, ...point });
        save();
      }
    }
    const latest = status?.retention?.samples.at(-1);
    // During idle, leave the app alone until the next planned measurement.
    // The final sample still proceeds directly to normal cleanup observation.
    const idleDelay = latest?.phase === "idle" && points.has(latest.ordinal)
      && latest.ordinal < status.retention.expectedSamples - 1
      ? latest.atMs + plan.idleIntervalMs - Date.now() : 0;
    await sleep(Math.max(250, idleDelay));
  }
  if (!summary) throw new Error("retention workload timed out");
} catch (error) {
  measurementError = error instanceof Error ? error.message : String(error);
  save();
  throw error;
}
