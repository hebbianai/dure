import {
  backendTransportErrorReport,
  performBackendProfileRequest,
} from "./backend-transport.mjs";
import { collectSessionQuery } from "./session-query.mjs";

export const WORKFLOW_COMPLETION_SCHEMA_VERSION = 1;
export const WORKFLOW_COMPLETION_API_VERSION = "dure.workflow/v1";
export const DEFAULT_WORKFLOW_COMPLETION_DEADLINE_MS = 2_500;

const MAX_ID_BYTES = 160;
const MAX_RESULT_BYTES = 16 * 1024;
const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const UNSAFE_RESULT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const SESSION_ENVIRONMENT_FIELDS = Object.freeze([
  ["sessionId", "HMUX_SESSION_ID"],
  ["workspaceId", "HMUX_WORKSPACE_ID"],
  ["runnerPrincipal", "HMUX_RUNNER_PRINCIPAL"],
  ["runnerInstance", "HMUX_RUNNER_INSTANCE"],
  ["channelEpoch", "HMUX_CHANNEL_EPOCH"],
  ["hostInstanceId", "HMUX_HOST_INSTANCE_ID"],
  ["terminalEpoch", "HMUX_TERMINAL_EPOCH"],
]);
const SESSION_FIELDS = Object.freeze([
  "sessionId",
  "workspaceId",
  "providerId",
  "runnerPrincipal",
  "runnerInstance",
  "channelEpoch",
  "hostInstanceId",
  "terminalEpoch",
]);
const WORKFLOW_DISPATCH_STATES = new Set([
  "starting",
  "active",
  "start_failed",
  "completed",
]);

const MESSAGES = Object.freeze({
  workflow_done_backend_local_required:
    "workflow completion requires the managed local backend",
  workflow_done_environment_invalid:
    "the current process does not identify one exact Hmux Session generation",
  workflow_done_receipt_invalid:
    "the backend returned an invalid workflow completion receipt",
  workflow_done_request_invalid: "the workflow completion request is invalid",
  workflow_done_session_mismatch:
    "the live Hmux Session does not match the current worker generation",
  workflow_done_session_unavailable:
    "the current Hmux Session could not be verified",
  workflow_show_backend_invalid: "workflow inspection requires a backend profile",
  workflow_show_receipt_invalid:
    "the backend returned an invalid delegated workflow receipt",
  workflow_show_request_invalid: "the workflow inspection request is invalid",
});

export class WorkflowCompletionError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] ?? "workflow completion failed", options);
    this.code = code;
    this.details = options.details;
    this.name = "WorkflowCompletionError";
  }
}

function fail(code, details) {
  throw new WorkflowCompletionError(code, { details });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function domainId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES &&
    DOMAIN_ID.test(value)
  );
}

function workflowId(value, prefix) {
  return domainId(value) && value.startsWith(`${prefix}.`);
}

function workflowResult(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_RESULT_BYTES &&
    !UNSAFE_RESULT_CONTROL.test(value)
  );
}

function dispatchGeneration(value) {
  const source = typeof value === "number" ? String(value) : value;
  if (
    typeof source !== "string" ||
    !POSITIVE_DECIMAL.test(source) ||
    source.length > 16
  ) {
    return null;
  }
  const parsed = Number(source);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function currentHmuxSessionGeneration(environment = process.env) {
  const generation = {};
  for (const [field, variable] of SESSION_ENVIRONMENT_FIELDS) {
    const value = environment[variable];
    if (!domainId(value)) {
      fail("workflow_done_environment_invalid", { variable });
    }
    generation[field] = value;
  }
  return generation;
}

function exactSession(left, right) {
  return SESSION_FIELDS.every((field) => left[field] === right[field]);
}

function verifiedLiveSession(report, environmentSession) {
  if (report?.kind === "dure.sessions.error") {
    fail("workflow_done_session_unavailable", {
      sessionErrorCode: report.error?.code,
    });
  }
  const session = report?.session;
  const generation = session?.runtime?.generation;
  const candidate = {
    sessionId: session?.sessionId,
    workspaceId: session?.workspaceId,
    providerId: session?.provider?.id,
    runnerPrincipal: generation?.runnerPrincipal,
    runnerInstance: generation?.runnerInstance,
    channelEpoch: generation?.channelEpoch,
    hostInstanceId: generation?.hostInstanceId,
    terminalEpoch: generation?.terminalEpoch,
  };
  if (
    report?.kind !== "dure.sessions.show" ||
    report.complete !== true ||
    session?.runtime?.source !== "hmux_host" ||
    session.runtime.sessionClass !== "managed" ||
    session?.liveness?.state !== "alive" ||
    session.liveness.health !== "healthy" ||
    session.liveness.exactGeneration !== true ||
    session.liveness.manifestLifecycle !== "ready" ||
    session.liveness.effectiveLifecycle !== "ready" ||
    !SESSION_FIELDS.every((field) => domainId(candidate[field])) ||
    !exactSession(candidate, {
      ...environmentSession,
      providerId: candidate.providerId,
    })
  ) {
    fail("workflow_done_session_mismatch");
  }
  return candidate;
}

function verifiedIdentityReceipt(result, expected, invalidCode) {
  const receipt = result?.receipt;
  if (
    !record(result) ||
    result.schemaVersion !== WORKFLOW_COMPLETION_SCHEMA_VERSION ||
    !record(receipt) ||
    receipt.schemaVersion !== WORKFLOW_COMPLETION_SCHEMA_VERSION ||
    receipt.taskId !== expected.taskId ||
    receipt.dispatchId !== expected.dispatchId ||
    receipt.generation !== expected.generation ||
    !WORKFLOW_DISPATCH_STATES.has(receipt.status) ||
    (receipt.result !== undefined && !workflowResult(receipt.result)) ||
    (receipt.status !== "completed" && receipt.result !== undefined)
  ) {
    fail(invalidCode);
  }
  return receipt;
}

function verifiedCompletionReceipt(result, expected) {
  const receipt = verifiedIdentityReceipt(
    result,
    expected,
    "workflow_done_receipt_invalid",
  );
  if (
    receipt.status !== "completed" ||
    !record(receipt.session) ||
    !exactSession(receipt.session, expected.session) ||
    receipt.result !== expected.result
  ) {
    fail("workflow_done_receipt_invalid");
  }
  return receipt;
}

export async function completeDelegatedWorkflow({
  taskId,
  dispatchId,
  generation,
  result,
  environment = process.env,
  backend,
  deadlineMs = DEFAULT_WORKFLOW_COMPLETION_DEADLINE_MS,
  collectSession = collectSessionQuery,
  requestBackend = performBackendProfileRequest,
} = {}) {
  const normalizedGeneration = dispatchGeneration(generation);
  if (
    !workflowId(taskId, "task") ||
    !workflowId(dispatchId, "dispatch") ||
    normalizedGeneration === null ||
    (result !== undefined && !workflowResult(result)) ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 10_000
  ) {
    fail("workflow_done_request_invalid");
  }
  if (!backend?.managedLocal || !record(backend.profile)) {
    fail("workflow_done_backend_local_required");
  }

  const environmentSession = currentHmuxSessionGeneration(environment);
  const sessionReport = await collectSession({
    action: "show",
    sessionId: environmentSession.sessionId,
    workspaceId: environmentSession.workspaceId,
    registry: {
      state: "absent",
      clientId: null,
      updatedAtMs: null,
      agents: [],
    },
    deadlineMs,
    backend: {
      profile: backend.profile,
      transportOptions: backend.transportOptions,
    },
  });
  const session = verifiedLiveSession(sessionReport, environmentSession);
  const response = await requestBackend(
    backend.profile,
    {
      body: {
        schemaVersion: WORKFLOW_COMPLETION_SCHEMA_VERSION,
        taskId,
        dispatchId,
        generation: normalizedGeneration,
        session,
        ...(result === undefined ? {} : { result }),
      },
      operation: "workflow.delegate_once.complete",
      requiredCapabilities: ["workflow.delegate_once.complete"],
    },
    {
      ...backend.transportOptions,
      deadlineMs,
    },
  );
  const receipt = verifiedCompletionReceipt(response?.result, {
    taskId,
    dispatchId,
    generation: normalizedGeneration,
    session,
    result,
  });
  return {
    schemaVersion: WORKFLOW_COMPLETION_SCHEMA_VERSION,
    apiVersion: WORKFLOW_COMPLETION_API_VERSION,
    kind: "dure.workflow.done",
    profile: {
      id: backend.profile.id,
      transport: backend.profile.transport?.kind,
    },
    taskId,
    dispatchId,
    generation: normalizedGeneration,
    session,
    receipt,
  };
}

export async function readDelegatedWorkflow({
  taskId,
  dispatchId,
  generation,
  backend,
  deadlineMs = DEFAULT_WORKFLOW_COMPLETION_DEADLINE_MS,
  requestBackend = performBackendProfileRequest,
} = {}) {
  const normalizedGeneration = dispatchGeneration(generation);
  if (
    !workflowId(taskId, "task") ||
    !workflowId(dispatchId, "dispatch") ||
    normalizedGeneration === null ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 10_000
  ) {
    fail("workflow_show_request_invalid");
  }
  if (!record(backend?.profile)) {
    fail("workflow_show_backend_invalid");
  }
  const response = await requestBackend(
    backend.profile,
    {
      body: {
        schemaVersion: WORKFLOW_COMPLETION_SCHEMA_VERSION,
        taskId,
        dispatchId,
        generation: normalizedGeneration,
      },
      operation: "workflow.delegate_once.show",
      requiredCapabilities: ["workflow.delegate_once.show"],
    },
    {
      ...backend.transportOptions,
      deadlineMs,
    },
  );
  const receipt = verifiedIdentityReceipt(
    response?.result,
    { taskId, dispatchId, generation: normalizedGeneration },
    "workflow_show_receipt_invalid",
  );
  return {
    schemaVersion: WORKFLOW_COMPLETION_SCHEMA_VERSION,
    apiVersion: WORKFLOW_COMPLETION_API_VERSION,
    kind: "dure.workflow.show",
    profile: {
      id: backend.profile.id,
      transport: backend.profile.transport?.kind,
    },
    taskId,
    dispatchId,
    generation: normalizedGeneration,
    receipt,
  };
}

export function workflowCompletionErrorReport(error, profile) {
  if (!(error instanceof WorkflowCompletionError)) {
    return backendTransportErrorReport(error, profile);
  }
  return {
    schemaVersion: WORKFLOW_COMPLETION_SCHEMA_VERSION,
    apiVersion: WORKFLOW_COMPLETION_API_VERSION,
    kind: "dure.workflow.error",
    profile: record(profile)
      ? { id: profile.id, transport: profile.transport?.kind }
      : null,
    error: {
      code: error.code,
      message: error.message,
      ...(record(error.details) ? error.details : {}),
    },
  };
}

export function formatWorkflowCompletion(report) {
  return `\x1b[32m✓\x1b[0m ${report.taskId} completed (${report.dispatchId}, generation ${report.generation})`;
}

export function formatWorkflowReceipt(report) {
  const header = `${report.taskId} ${report.receipt.status} (${report.dispatchId}, generation ${report.generation})`;
  return report.receipt.result === undefined
    ? header
    : `${header}\n${report.receipt.result}`;
}
