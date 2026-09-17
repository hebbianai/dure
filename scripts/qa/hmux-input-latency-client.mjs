import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  parseMacosProcessIdentity,
  processMemberSnapshots,
} from "../lib/process-identity.mjs";
import { armExclusiveNativeInput } from "./lib/exclusive-native-input.mjs";
import { HmuxWindowFocusHarness } from "./lib/hmux-window-focus-harness.mjs";
import {
  assertAppGenerationFence,
  assertDirectInputEvidence,
  assertFocusedWindowFence,
  assertNativeKeydownEvidence,
  captureAppGenerationFence,
  captureFocusedWindowFence,
  completedKeydownDelta,
} from "./lib/hmux-input-latency-evidence.mjs";
import { readWorkspacePerformanceDescriptor } from "./lib/workspace-performance-descriptor.mjs";

const samples = readPositiveInteger("HMUX_INPUT_LATENCY_SAMPLES", 20, 64);
const budgets = {
  hostReceiptP95Ms: readPositiveNumber("HMUX_INPUT_HOST_P95_MS", 100),
  echoPaintP95Ms: readPositiveNumber("HMUX_INPUT_ECHO_P95_MS", 60),
};
const stateRoot = requiredEnvironment("DURE_QA_STATE_ROOT");
const home = requiredEnvironment("HOME");
const descriptorPath = requiredEnvironment("DURE_QA_SERVER_DESCRIPTOR");
const swiftCompiler = requiredEnvironment("DURE_QA_SWIFTC_BIN");
const exclusiveInputRequest = requiredEnvironment(
  "DURE_QA_EXCLUSIVE_INPUT_REQUEST",
);
const exclusiveInputAck = requiredEnvironment("DURE_QA_EXCLUSIVE_INPUT_ACK");
const processGroupId = readPositiveInteger("DURE_QA_ROOT_PID", undefined);
const minimumIdleMs = readNonNegativeInteger(
  "HEBBIAN_QA_EXCLUSIVE_MIN_IDLE_MS",
  15_000,
  3_600_000,
);
const nativeHelper = path.resolve(
  "scripts/qa/hmux-input-latency-keydown.swift",
);
const nativeBinary = path.join(stateRoot, "hmux-input-latency-keydown");
const harness = new HmuxWindowFocusHarness();
const timings = [];

try {
  compileNativeKeydownHelper();
  await harness.phase("connect", "qa_transport", () => harness.connect());
  const runtime = await harness.phase(
    "runtime_prepare",
    "qa_runtime_activation",
    () => harness.prepareRuntime(),
  );
  const started = await harness.phase("start", "qa_startup", () =>
    harness.start("smoke"),
  );
  await harness.phase("focus_ready", "exclusive_os_focus", () =>
    harness.waitReady(),
  );
  const labels = {
    target: started.windows?.a,
    sibling: started.windows?.b,
  };
  if (!labels.target || !labels.sibling || labels.target === labels.sibling) {
    throw new Error("Hmux input latency fixture returned invalid window labels");
  }
  const initialDescriptor = readRequiredDescriptor();
  const appFence = captureAppGenerationFence({
    descriptor: initialDescriptor,
    ping: await harness.ping(),
    processGroupId,
    processIdentity: readExactProcessGeneration(initialDescriptor.processId),
  });
  const beforeDirect = await readCompletePerformanceReport();
  await harness.phase("input_latency", "input_latency", async () => {
    for (let index = 0; index < samples; index += 1) {
      // Leave A's per-terminal sampler untouched so its one native keydown is
      // deterministic without a delay or a sampling bypass.
      const measured = await harness.measuredFocusedStep("b");
      timings.push(measured.timing);
    }
  });
  const afterDirect = await readCompletePerformanceReport();
  const directEvidence = assertDirectInputEvidence(
    beforeDirect,
    afterDirect,
    labels,
  );

  const focused = await harness.phase(
    "native_focus",
    "exclusive_os_focus",
    () => harness.prime("a"),
  );
  const windowFence = captureFocusedWindowFence(focused, "a");
  const beforeNative = await readCompletePerformanceReport();
  const freshDescriptor = readRequiredDescriptor();
  const freshPing = await harness.ping();
  assertAppGenerationFence(
    appFence,
    freshDescriptor,
    freshPing,
    readExactProcessGeneration(freshDescriptor.processId),
  );

  await harness.phase("native_admission", "exclusive_user_activity", () =>
    armExclusiveNativeInput({
      stateRoot,
      requestPath: exclusiveInputRequest,
      acknowledgementPath: exclusiveInputAck,
    }),
  );
  const admittedDescriptor = readRequiredDescriptor();
  assertAppGenerationFence(
    appFence,
    admittedDescriptor,
    await harness.ping(),
    readExactProcessGeneration(admittedDescriptor.processId),
  );
  const admittedFocus = await harness.prime("a");
  assertFocusedWindowFence(windowFence, admittedFocus);
  const native = await harness.phase(
    "native_keydown",
    "native_keydown",
    () => postNativeKeydown(appFence),
  );
  const afterNative = await harness.waitFor(
    "one complete native keydown input trace",
    30_000,
    async () => {
      const receipt = await harness.performanceReport();
      return receipt.report.complete === true &&
        completedKeydownDelta(beforeNative, receipt, labels.target) > 0
        ? receipt
        : undefined;
    },
  );
  const nativeSample = assertNativeKeydownEvidence(
    beforeNative,
    afterNative,
    labels,
  );
  assertFocusedWindowFence(windowFence, await harness.status());
  const finalDescriptor = readRequiredDescriptor();
  assertAppGenerationFence(
    appFence,
    finalDescriptor,
    await harness.ping(),
    readExactProcessGeneration(finalDescriptor.processId),
  );

  const result = {
    samples: timings.length,
    sourceEvidence: {
      directCompletedInputSamples: directEvidence.completedInputSamples,
      nativeCompletedKeydownSamples: 1,
    },
    hmuxBuildId: runtime.buildId,
    inputToHostReceiptMs: summarize(
      timings.map((timing) => timing.inputToHostReceiptMs),
    ),
    inputToEchoPaintMs: summarize(
      timings.map((timing) => timing.inputToEchoPaintMs),
    ),
    hostReceiptToEchoPaintMs: summarize(
      timings.map((timing) => timing.hostReceiptToEchoPaintMs),
    ),
    inputToProjectionCommitMs: summarize(
      timings.map((timing) => timing.inputToProjectionCommitMs),
    ),
    hostReceiptToProjectionCommitMs: summarize(
      timings.map((timing) => timing.hostReceiptToProjectionCommitMs),
    ),
    projectionCommitToEchoPaintMs: summarize(
      timings.map((timing) => timing.projectionCommitToEchoPaintMs),
    ),
    nativeKeydown: {
      app: appFence,
      window: windowFence,
      post: native,
      trace: nativeSample,
    },
  };
  harness.writeEvidence("input-latency.json", result);
  console.log(`hmux input latency metrics: ${JSON.stringify(result)}`);
  assertAtMost(
    "input to Host receipt p95",
    result.inputToHostReceiptMs.p95,
    budgets.hostReceiptP95Ms,
  );
  assertAtMost(
    "input to echo paint p95",
    result.inputToEchoPaintMs.p95,
    budgets.echoPaintP95Ms,
  );
  console.log(`hmux input latency passed: ${JSON.stringify(result)}`);
} finally {
  await harness.phase("cleanup", "qa_cleanup", () => harness.finish()).catch(
    (error) => {
      console.error(`hmux input latency cleanup failed: ${error}`);
      process.exitCode = 1;
    },
  );
}

async function readCompletePerformanceReport() {
  return harness.waitFor(
    "complete multi-window performance report",
    30_000,
    async () => {
      const receipt = await harness.performanceReport();
      return receipt.report.complete === true ? receipt : undefined;
    },
  );
}

function readRequiredDescriptor() {
  const descriptor = readWorkspacePerformanceDescriptor({
    descriptorPath,
    home,
    stateRoot,
  });
  if (!descriptor) {
    throw new Error("isolated app descriptor disappeared during input measurement");
  }
  return descriptor;
}

function postNativeKeydown(appFence) {
  const processIdentity = parseMacosProcessIdentity(appFence.processIdentity);
  if (!processIdentity) {
    throw new Error("isolated native keydown process identity is invalid");
  }
  const result = spawnSync(
    nativeBinary,
    [
      String(appFence.processId),
      String(appFence.processGroupId),
      processIdentity.uniqueId,
      "Dure Hmux QA A",
      "Dure Hmux QA B",
      String(minimumIdleMs),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `isolated native keydown failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("isolated native keydown returned invalid JSON", {
      cause: error,
    });
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.processId !== appFence.processId ||
    receipt.processGroupId !== appFence.processGroupId ||
    receipt.postedEventCount !== 2 ||
    !Number.isSafeInteger(receipt.idleMillisecondsAtPost) ||
    receipt.idleMillisecondsAtPost < minimumIdleMs
  ) {
    throw new Error(
      `isolated native keydown receipt is invalid: ${JSON.stringify(receipt)}`,
    );
  }
  return receipt;
}

function compileNativeKeydownHelper() {
  fs.accessSync(swiftCompiler, fs.constants.X_OK);
  try {
    fs.lstatSync(nativeBinary);
    throw new Error("isolated native keydown binary already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const result = spawnSync(
    swiftCompiler,
    [nativeHelper, "-o", nativeBinary],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `isolated native keydown compile failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  const metadata = fs.lstatSync(nativeBinary);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o100) === 0
  ) {
    throw new Error("isolated native keydown binary is not an exact executable");
  }
}

function readExactProcessGeneration(processId) {
  const observation = processMemberSnapshots([processId]);
  const member = observation.status === "complete"
    ? observation.members.find((candidate) => candidate.pid === processId)
    : undefined;
  if (
    observation.status !== "complete" ||
    !member ||
    member.state !== "live" ||
    member.groupId !== processGroupId ||
    !parseMacosProcessIdentity(member.processIdentity)
  ) {
    throw new Error("isolated app process generation is not exact");
  }
  return member.processIdentity;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(sorted.length * quantile));
  return sorted[Math.min(sorted.length, rank) - 1];
}

function assertAtMost(label, value, budget) {
  if (value === null || value > budget) {
    throw new Error(`${label} ${value}ms exceeds ${budget}ms`);
  }
}

function readPositiveInteger(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function readNonNegativeInteger(name, fallback, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
