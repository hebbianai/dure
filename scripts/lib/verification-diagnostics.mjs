import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PUSH_GATE_ORDER } from "./push-gate-contract.mjs";

export const VERIFICATION_DIAGNOSTICS_SCHEMA =
  "dure-verification-diagnostics/v1";
export const VERIFICATION_PROGRESS_SCHEMA = "dure-verification-progress/v1";
export const VERIFICATION_PROGRESS_PATH_ENV =
  "HEBBIAN_VERIFICATION_PROGRESS_PATH";

const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;
const ADMISSION_PHASES = new Set([
  "host_resource_wait",
  "running",
  "completed",
  "failed",
  "timed_out",
  "interrupted",
]);
const GATE_KINDS = new Set(["frontend", "full", "scoped"]);
const OWNER_STATES = new Set(["active", "queued", "unknown"]);
const PRIORITIES = new Set(["ci", "local"]);
const RESOURCE_DIGEST = /^[a-f0-9]{64}$/;
const CI_PHASES = Object.freeze([
  "workflow_concurrency",
  "runner_wait",
  "host_resource_wait",
  "running",
]);

function nonNegativeMilliseconds(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer${nullable ? " or null" : ""}`);
  }
  return value;
}

function boundedString(value, label, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function normalizeGate(gate) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    throw new Error("verification diagnostic gate must be an object");
  }
  if (!Number.isSafeInteger(gate.pid) || gate.pid <= 0) {
    throw new Error("verification diagnostic gate pid must be positive");
  }
  if (!GATE_KINDS.has(gate.kind)) {
    throw new Error("verification diagnostic gate kind is unsupported");
  }
  if (!PRIORITIES.has(gate.priority)) {
    throw new Error("verification diagnostic gate priority is unsupported");
  }
  const normalized = {
    kind: gate.kind,
    pid: gate.pid,
    priority: gate.priority,
    worktree: boundedString(
      gate.worktree,
      "verification diagnostic gate worktree",
      4096,
    ),
  };
  if (gate.resource !== undefined) {
    if (
      typeof gate.resource !== "string" ||
      !RESOURCE_DIGEST.test(gate.resource)
    ) {
      throw new Error("verification diagnostic gate resource is invalid");
    }
    normalized.resource = gate.resource;
  }
  return normalized;
}

function normalizeBlocker(blockedBy) {
  if (blockedBy === null || blockedBy === undefined) return null;
  const blocker = normalizeGate(blockedBy);
  if (!OWNER_STATES.has(blockedBy.state)) {
    throw new Error("verification diagnostic blocker state is unsupported");
  }
  return { ...blocker, state: blockedBy.state };
}

function normalizeCiIdentity(ci) {
  if (ci === null || ci === undefined) return null;
  if (!ci || typeof ci !== "object" || Array.isArray(ci)) {
    throw new Error("verification diagnostic CI identity must be an object");
  }
  const runId = String(ci.runId ?? "");
  const runAttempt = String(ci.runAttempt ?? "");
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new Error("verification diagnostic CI run identity is invalid");
  }
  return {
    jobName: boundedString(
      ci.jobName,
      "verification diagnostic CI job name",
      256,
    ),
    runAttempt,
    runId,
  };
}

function normalizeUpdatedAt(updatedAt) {
  const value = boundedString(
    updatedAt,
    "verification diagnostic updatedAt",
    64,
  );
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("verification diagnostic updatedAt must be an ISO timestamp");
  }
  return value;
}

function normalizeProgressScopes(scopes, label, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(scopes) ||
    (!allowEmpty && scopes.length === 0) ||
    scopes.some(
      (scope) => typeof scope !== "string" || !PUSH_GATE_ORDER.includes(scope),
    )
  ) {
    throw new Error(`${label} must contain known push gate scopes`);
  }
  const selected = new Set(scopes);
  const canonical = PUSH_GATE_ORDER.filter((scope) => selected.has(scope));
  if (
    canonical.length !== scopes.length ||
    canonical.some((scope, index) => scope !== scopes[index])
  ) {
    throw new Error(`${label} must be a unique canonical scope sequence`);
  }
  return canonical;
}

export function createVerificationProgress({
  completedScopes,
  currentScope,
  plannedScopes,
  updatedAt = new Date().toISOString(),
}) {
  const planned = normalizeProgressScopes(
    plannedScopes,
    "verification progress plan",
  );
  const completed = normalizeProgressScopes(
    completedScopes,
    "verification progress completed scopes",
    { allowEmpty: true },
  );
  if (
    completed.some((scope, index) => scope !== planned[index]) ||
    completed.length > planned.length
  ) {
    throw new Error("verification progress must complete a prefix of its plan");
  }
  const expectedCurrent = planned[completed.length] ?? null;
  if (currentScope !== expectedCurrent) {
    throw new Error("verification progress current scope must follow its completed prefix");
  }
  return {
    completedScopes: completed,
    currentScope,
    plannedScopes: planned,
    schema: VERIFICATION_PROGRESS_SCHEMA,
    updatedAt: normalizeUpdatedAt(updatedAt),
  };
}

export function ciIdentityFromEnvironment(environment = process.env) {
  const runId = environment.GITHUB_RUN_ID;
  const runAttempt = environment.GITHUB_RUN_ATTEMPT;
  const jobName = environment.GITHUB_JOB;
  if (!runId && !runAttempt && !jobName) return null;
  return normalizeCiIdentity({ jobName, runAttempt, runId });
}

export function createAdmissionDiagnostic({
  blockedBy = null,
  ci = null,
  executionMs = null,
  gate,
  phase,
  queueMs,
  updatedAt = new Date().toISOString(),
}) {
  if (!ADMISSION_PHASES.has(phase)) {
    throw new Error("verification diagnostic admission phase is unsupported");
  }
  const normalizedBlocker = normalizeBlocker(blockedBy);
  if (phase === "host_resource_wait" && !normalizedBlocker) {
    throw new Error("host resource wait diagnostics require a blocker");
  }
  return {
    blockedBy: normalizedBlocker,
    blockerKind:
      phase === "host_resource_wait" ? "host_resource_wait" : null,
    ci: normalizeCiIdentity(ci),
    executionMs: nonNegativeMilliseconds(
      executionMs,
      "verification diagnostic executionMs",
      { nullable: true },
    ),
    gate: normalizeGate(gate),
    phase,
    queueMs: nonNegativeMilliseconds(
      queueMs,
      "verification diagnostic queueMs",
    ),
    schema: VERIFICATION_DIAGNOSTICS_SCHEMA,
    updatedAt: normalizeUpdatedAt(updatedAt),
  };
}

export function normalizeVerificationTiming(timing) {
  if (timing === undefined) return undefined;
  if (!timing || typeof timing !== "object" || Array.isArray(timing)) {
    throw new Error("verification timing must be an object");
  }
  return {
    executionMs: nonNegativeMilliseconds(
      timing.executionMs,
      "verification timing executionMs",
    ),
    queueMs: nonNegativeMilliseconds(
      timing.queueMs,
      "verification timing queueMs",
    ),
  };
}

function normalizePhaseDuration(entry, expectedPhase) {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    entry.phase !== expectedPhase
  ) {
    throw new Error(`verification diagnostics phase order requires ${expectedPhase}`);
  }
  return {
    durationMs: nonNegativeMilliseconds(
      entry.durationMs,
      `verification diagnostics ${expectedPhase} durationMs`,
      { nullable: true },
    ),
    phase: expectedPhase,
  };
}

export function createCompletedVerificationDiagnostics({
  blockedBy = null,
  ci,
  executionMs,
  hostResourceWaitMs,
  runnerWaitMs,
  unavailable = [],
  workflowConcurrencyMs,
}) {
  const phases = [
    { durationMs: workflowConcurrencyMs, phase: "workflow_concurrency" },
    { durationMs: runnerWaitMs, phase: "runner_wait" },
    { durationMs: hostResourceWaitMs, phase: "host_resource_wait" },
    { durationMs: executionMs, phase: "running" },
  ].map((entry, index) => normalizePhaseDuration(entry, CI_PHASES[index]));
  if (
    !Array.isArray(unavailable) ||
    unavailable.some(
      (entry) =>
        typeof entry !== "string" || entry.length === 0 || entry.length > 128,
    )
  ) {
    throw new Error("verification diagnostics unavailable reasons are invalid");
  }
  const queueDurations = phases.slice(0, 3).map((entry) => entry.durationMs);
  const queueMs = queueDurations.every((value) => value !== null)
    ? queueDurations.reduce((total, value) => total + value, 0)
    : null;
  return {
    blockedBy: normalizeBlocker(blockedBy),
    blockerKind: null,
    ci: normalizeCiIdentity(ci),
    executionMs: phases[3].durationMs,
    phase: "completed",
    phases,
    queueMs,
    schema: VERIFICATION_DIAGNOSTICS_SCHEMA,
    unavailable: [...new Set(unavailable)].sort(),
  };
}

export function parseCompletedVerificationDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verification diagnostics must be an object");
  }
  if (
    value.schema !== VERIFICATION_DIAGNOSTICS_SCHEMA ||
    value.phase !== "completed" ||
    value.blockerKind !== null ||
    !Array.isArray(value.phases) ||
    value.phases.length !== CI_PHASES.length
  ) {
    throw new Error("verification diagnostics completed payload is invalid");
  }
  const durations = Object.fromEntries(
    value.phases.map((entry, index) => [
      CI_PHASES[index],
      normalizePhaseDuration(entry, CI_PHASES[index]).durationMs,
    ]),
  );
  const parsed = createCompletedVerificationDiagnostics({
    blockedBy: value.blockedBy,
    ci: value.ci,
    executionMs: durations.running,
    hostResourceWaitMs: durations.host_resource_wait,
    runnerWaitMs: durations.runner_wait,
    unavailable: value.unavailable,
    workflowConcurrencyMs: durations.workflow_concurrency,
  });
  if (value.queueMs !== parsed.queueMs || value.executionMs !== parsed.executionMs) {
    throw new Error("verification diagnostics aggregate durations do not match");
  }
  return parsed;
}

function assertPrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`verification diagnostics directory is unsafe: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function writePrivateJson(outputPath, value, label) {
  const directory = path.dirname(path.resolve(outputPath));
  assertPrivateDirectory(directory);
  const target = path.resolve(outputPath);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${label} file is unsafe: ${target}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    const completedDescriptor = descriptor;
    descriptor = undefined;
    fs.closeSync(completedDescriptor);
    fs.renameSync(temporaryPath, target);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function readPrivateJson(inputPath, label) {
  const target = path.resolve(inputPath);
  const stat = fs.lstatSync(target);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size > MAXIMUM_DIAGNOSTIC_BYTES ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} file is unsafe: ${target}`);
  }
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

export function writeAdmissionDiagnostic(outputPath, diagnostic) {
  if (!outputPath) return;
  writePrivateJson(
    outputPath,
    createAdmissionDiagnostic(diagnostic),
    "verification diagnostics",
  );
}

export function readAdmissionDiagnostic(inputPath) {
  const parsed = readPrivateJson(inputPath, "verification diagnostics");
  if (parsed?.schema !== VERIFICATION_DIAGNOSTICS_SCHEMA) {
    throw new Error("verification diagnostics schema is unsupported");
  }
  return createAdmissionDiagnostic(parsed);
}

export function writeVerificationProgress(outputPath, progress) {
  if (!outputPath) return;
  writePrivateJson(
    outputPath,
    createVerificationProgress(progress),
    "verification progress",
  );
}

export function readVerificationProgress(inputPath) {
  const parsed = readPrivateJson(inputPath, "verification progress");
  if (parsed?.schema !== VERIFICATION_PROGRESS_SCHEMA) {
    throw new Error("verification progress schema is unsupported");
  }
  return createVerificationProgress(parsed);
}

export function deriveGithubQueueDurations({
  jobCreatedAt,
  jobStartedAt,
  runCreatedAt,
  runStartedAt,
}) {
  const created = Date.parse(runCreatedAt);
  const runStarted = Date.parse(runStartedAt);
  const jobCreated = Date.parse(jobCreatedAt);
  const jobStarted = Date.parse(jobStartedAt);
  const unavailable = [];
  let workflowConcurrencyMs = null;
  let runnerWaitMs = null;
  const runBoundaryValid =
    Number.isFinite(created) &&
    Number.isFinite(runStarted) &&
    runStarted >= created;
  const jobBoundaryValid =
    runBoundaryValid &&
    Number.isFinite(jobCreated) &&
    jobCreated >= runStarted;
  if (
    jobBoundaryValid
  ) {
    workflowConcurrencyMs = jobCreated - created;
  } else if (runBoundaryValid && !Number.isFinite(jobCreated)) {
    workflowConcurrencyMs = runStarted - created;
  } else {
    unavailable.push("workflow_concurrency_timing_unavailable");
  }
  if (
    jobBoundaryValid &&
    Number.isFinite(jobStarted) &&
    jobStarted >= jobCreated
  ) {
    runnerWaitMs = jobStarted - jobCreated;
  } else {
    unavailable.push("runner_wait_timing_unavailable");
  }
  return { runnerWaitMs, unavailable, workflowConcurrencyMs };
}
