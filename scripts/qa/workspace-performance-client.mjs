import fs from "node:fs";
import path from "node:path";
import { evaluateWorkspacePerformanceSlo } from "./lib/workspace-performance-slo.mjs";
import { sampleMachineProcessContext } from "./lib/process-tree-metrics.mjs";
import {
  nativeWorkspacePerformanceReadiness,
  nativeWorkspacePerformanceResourceFailures,
  nativeWorkspacePerformanceSloProfile,
} from "./lib/workspace-performance-native.mjs";
import { readWorkspacePerformanceDescriptor } from "./lib/workspace-performance-descriptor.mjs";
import { readWorkspacePerformanceProviderFixture } from "./lib/workspace-performance-provider-fixture.mjs";

const TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 250;
const home = process.env.HOME;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
const evidenceDirectory = process.env.DURE_QA_EVIDENCE_DIR;
const descriptorPath = process.env.DURE_QA_SERVER_DESCRIPTOR;
const scenarioId = process.env.DURE_QA_PERFORMANCE_SCENARIO ?? "baseline_15";
const phase = process.env.DURE_QA_PERFORMANCE_PHASE ?? "full";
if (!home || !stateRoot || !evidenceDirectory) {
  throw new Error("workspace performance QA isolation is incomplete");
}

const descriptor = await waitForDescriptor({ descriptorPath, home, stateRoot });
const deadline = Date.now() + TIMEOUT_MS;
let report;
let providerFixture = readWorkspacePerformanceProviderFixture(stateRoot, scenarioId);
let readiness = { ready: false, missing: ["report not available"] };
let lastError;
let qaFailure;
while (Date.now() < deadline) {
  try {
    report = await readPerformanceReport(descriptor);
    providerFixture = readWorkspacePerformanceProviderFixture(stateRoot, scenarioId);
    if (report.qaStatus?.state === "failed") {
      qaFailure = report.qaStatus;
      writeEvidence({ providerFixture, qaFailure, report });
      break;
    }
    readiness = nativeWorkspacePerformanceReadiness(report, scenarioId, phase);
    if (providerFixture.ready && readiness.ready) {
      report = attachExecutionContext(report);
      writeEvidence({ providerFixture, readiness, report });
      break;
    }
    writeEvidence({ providerFixture, readiness, report });
  } catch (error) {
    lastError = error;
  }
  await sleep(POLL_INTERVAL_MS);
}
if (qaFailure) {
  throw new Error(
    `native workspace performance workload failed in ${qaFailure.phase}: ${qaFailure.error ?? "unknown error"}`,
  );
}
if (!report || !providerFixture.ready || !readiness.ready) {
  throw new Error(
    `timed out waiting for native workspace performance evidence: provider fixture ${providerFixture.observed}/${providerFixture.expected}; ${providerFixture.invalid.join(", ") || providerFixture.missing.join(", ")}; samples ${readiness.missing.join(", ")}${lastError ? `; ${lastError}` : ""}`,
  );
}

const sloProfile = nativeWorkspacePerformanceSloProfile(
  scenarioId,
  phase,
  report,
);
const slo = evaluateWorkspacePerformanceSlo(report, sloProfile);
const failures = [
  ...slo.failures,
  ...nativeWorkspacePerformanceResourceFailures(report, scenarioId),
];
writeEvidence({ providerFixture, readiness, slo, failures, report });
if (failures.length > 0) {
  throw new Error(`native workspace performance SLO failed: ${failures.join("; ")}`);
}
console.log(
  `native workspace performance SLO passed: ${JSON.stringify({
    journeys: report.journeys,
    paneFocus: report.paneFocus,
    terminalInput: report.terminalInput,
    cache: report.switchPaintByCache,
    totals: report.totals,
  })}`,
);

async function waitForDescriptor(options) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = readWorkspacePerformanceDescriptor(options);
    if (value) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for the isolated app descriptor");
}

async function readPerformanceReport(descriptor) {
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/perf/report`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${descriptor.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  const receipt = await response.json();
  if (!response.ok || receipt.ok !== true || !receipt.report) {
    throw new Error(receipt?.error?.message ?? `perf report returned ${response.status}`);
  }
  return {
    ...receipt.report,
    frameBudget: receipt.frameBudget ?? null,
    multiWindow: receipt.multiWindow ?? null,
    qaStatus: receipt.qaStatus ?? null,
  };
}

function writeEvidence(value) {
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const destination = path.join(evidenceDirectory, "last-status.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, destination);
}

function attachExecutionContext(value) {
  const rootPid = Number(process.env.DURE_QA_ROOT_PID);
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return value;
  return {
    ...value,
    executionContext: sampleMachineProcessContext(rootPid),
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
