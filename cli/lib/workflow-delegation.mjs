import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { agentDisplayName } from "./client-registry.mjs";
import { PROVIDERS } from "./contracts/provider-catalog.mjs";
import { collectSessionQuery } from "./session-query.mjs";
import {
  WORKFLOW_COMPLETION_API_VERSION,
  WORKFLOW_COMPLETION_SCHEMA_VERSION,
  WorkflowCompletionError,
  currentLiveHmuxSession,
  workflowCompletionErrorReport,
} from "./workflow-completion.mjs";

/** The bundled core workflow contribution the app's Delegate task action uses. */
export const DELEGATE_ONCE_CONTRIBUTION_ID = "dure.core.delegate-once";
/** Starting a worker launches a provider and delivers its prompt; the backend
 * finishes that journaled effect within its 180 s workflow deadline. */
export const DEFAULT_WORKFLOW_DELEGATE_DEADLINE_MS = 185_000;
export const MAX_TASK_INSTRUCTIONS_BYTES = 16 * 1024;

const BINDING_DEADLINE_MS = 20_000;
const SESSION_DEADLINE_MS = 2_500;
const MAX_SUMMARY_BYTES = 512;
const MAX_ID_BYTES = 160;
const MAX_RESULT_BYTES = 16 * 1024;
const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
// The key carries its creation time, so one token replays the exact request:
// the backend derives the task identity from every request field.
const IDEMPOTENCY_KEY = /^delegate-once-([1-9][0-9]{0,15})-[0-9a-f]{16}$/u;
const WORKFLOW_ID = /^(run|task|dispatch)\.([0-9a-f]{64})$/u;
const DELEGATED_WORKER_AGENT = /^agent-workflow-/u;
// Rust's char::is_control: C0, DEL and C1.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const INSTRUCTION_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const RECEIPT_STATES = new Set(["starting", "active", "start_failed", "completed"]);
const GENERATION_FIELDS = Object.freeze([
  "runnerPrincipal",
  "runnerInstance",
  "channelEpoch",
  "hostInstanceId",
  "terminalEpoch",
]);

function fail(code, details) {
  throw new WorkflowCompletionError(code, { details });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function domainId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= MAX_ID_BYTES &&
    DOMAIN_ID.test(value)
  );
}

function token(value) {
  return typeof value === "string" && TOKEN.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** A backend failure after the request was formed. It keeps the idempotency
 * key so the caller can replay the same request after an uncertain outcome. */
export class WorkflowDelegationFailure extends Error {
  constructor(cause, idempotencyKey) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "WorkflowDelegationFailure";
    this.idempotencyKey = idempotencyKey;
  }
}

/** Trim both fields and fold CRLF line endings; the backend admits only
 * newline and tab controls in instructions and none in the summary. */
export function normalizeDelegatedTask({ summary, instructions }) {
  const normalizedSummary = typeof summary === "string" ? summary.trim() : "";
  if (
    normalizedSummary.length === 0 ||
    utf8Bytes(normalizedSummary) > MAX_SUMMARY_BYTES ||
    CONTROL.test(normalizedSummary)
  ) {
    fail("workflow_delegate_summary_invalid");
  }
  const normalizedInstructions =
    typeof instructions === "string"
      ? instructions.replace(/\r\n?/gu, "\n").trim()
      : "";
  if (
    normalizedInstructions.length === 0 ||
    utf8Bytes(normalizedInstructions) > MAX_TASK_INSTRUCTIONS_BYTES ||
    INSTRUCTION_CONTROL.test(normalizedInstructions)
  ) {
    fail("workflow_delegate_instructions_invalid");
  }
  return { summary: normalizedSummary, instructions: normalizedInstructions };
}

export function delegationIdempotency(
  idempotencyKey,
  { now = Date.now, random = () => randomBytes(8).toString("hex") } = {},
) {
  if (idempotencyKey === undefined) {
    const createdAtMs = now();
    return {
      idempotencyKey: `delegate-once-${createdAtMs}-${random()}`,
      createdAtMs,
    };
  }
  const match =
    typeof idempotencyKey === "string" ? IDEMPOTENCY_KEY.exec(idempotencyKey) : null;
  const createdAtMs = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(createdAtMs)) {
    fail("workflow_delegate_request_invalid", { field: "idempotencyKey" });
  }
  return { idempotencyKey, createdAtMs };
}

/** The app's Agent record names the coordinator. The registry only selects
 * the Agent; the environment and the live Session remain the generation
 * authority, and the backend binding verifies both. */
export function registryCoordinator(registry, session) {
  const agents =
    (registry?.state === "available" || registry?.state === "truncated") &&
    Array.isArray(registry.agents)
      ? registry.agents
      : [];
  const matches = agents.filter((agent) => {
    const binding = agent?.runtimeBinding;
    return (
      binding?.runtime === "hmux_managed_v1" &&
      binding.source === "local" &&
      binding.sessionId === session.sessionId &&
      binding.workspaceId === session.workspaceId
    );
  });
  if (matches.length === 0) {
    fail("workflow_delegate_coordinator_unregistered", {
      registryState: registry?.state ?? "absent",
    });
  }
  if (matches.length > 1) {
    fail("workflow_delegate_coordinator_ambiguous", { matches: matches.length });
  }
  const [agent] = matches;
  if (typeof agent.id === "string" && DELEGATED_WORKER_AGENT.test(agent.id)) {
    fail("workflow_delegate_nested_unsupported");
  }
  const displayName = agentDisplayName(agent);
  if (
    !domainId(agent.id) ||
    typeof displayName !== "string" ||
    displayName.length === 0 ||
    utf8Bytes(displayName) > MAX_SUMMARY_BYTES ||
    CONTROL.test(displayName) ||
    typeof agent.worktree !== "string" ||
    !isAbsolute(agent.worktree) ||
    utf8Bytes(agent.worktree) > 4096 ||
    CONTROL.test(agent.worktree)
  ) {
    fail("workflow_delegate_coordinator_invalid");
  }
  return { agentId: agent.id, displayName, worktreePath: agent.worktree };
}

export function delegationProvider(requested, coordinatorProvider) {
  const providerId = requested ?? coordinatorProvider;
  if (
    typeof providerId !== "string" ||
    !Object.hasOwn(PROVIDERS, providerId) ||
    PROVIDERS[providerId].workflowDelegate !== true
  ) {
    fail("workflow_delegate_provider_unsupported", {
      providerId: typeof providerId === "string" ? providerId : null,
      supported: Object.keys(PROVIDERS).filter(
        (id) => PROVIDERS[id].workflowDelegate === true,
      ),
    });
  }
  return providerId;
}

function verifiedBinding(result, expected) {
  const identity = result?.identity;
  if (
    !record(result) ||
    result.schemaVersion !== 1 ||
    !record(identity) ||
    identity.agentId !== expected.agentId ||
    identity.sessionId !== expected.sessionId ||
    !positiveInteger(identity.bindingGeneration)
  ) {
    fail("workflow_delegate_receipt_invalid", { stage: "binding" });
  }
  return identity.bindingGeneration;
}

function workerSession(value) {
  if (
    !record(value) ||
    !token(value.sessionId) ||
    !token(value.workspaceId) ||
    !domainId(value.providerId) ||
    !GENERATION_FIELDS.every((field) => domainId(value[field]))
  ) {
    return null;
  }
  return {
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
    providerId: value.providerId,
    ...Object.fromEntries(GENERATION_FIELDS.map((field) => [field, value[field]])),
  };
}

function verifiedDelegateReceipt(result, expected) {
  const receipt = result?.receipt;
  const identities = [receipt?.runId, receipt?.taskId, receipt?.dispatchId].map(
    (identity) => (typeof identity === "string" ? WORKFLOW_ID.exec(identity) : null),
  );
  const session =
    receipt?.session === undefined ? undefined : workerSession(receipt.session);
  const started = receipt?.status === "active" || receipt?.status === "completed";
  if (
    !record(result) ||
    result.schemaVersion !== 1 ||
    !record(receipt) ||
    receipt.schemaVersion !== 1 ||
    receipt.idempotencyKey !== expected.idempotencyKey ||
    identities.some((identity) => !identity) ||
    identities[0][1] !== "run" ||
    identities[1][1] !== "task" ||
    identities[2][1] !== "dispatch" ||
    new Set(identities.map((identity) => identity[2])).size !== 1 ||
    !positiveInteger(receipt.generation) ||
    !RECEIPT_STATES.has(receipt.status) ||
    session === null ||
    (started &&
      (!session ||
        session.providerId !== expected.providerId ||
        session.workspaceId !== expected.workspaceId)) ||
    (receipt.status === "start_failed" && !token(receipt.startErrorCode)) ||
    (receipt.result !== undefined &&
      (receipt.status !== "completed" ||
        typeof receipt.result !== "string" ||
        utf8Bytes(receipt.result) > MAX_RESULT_BYTES))
  ) {
    fail("workflow_delegate_receipt_invalid", { stage: "delegate" });
  }
  return { ...receipt, ...(session ? { session } : {}) };
}

/**
 * Start one delegate-once worker for the Agent this process runs in — the same
 * backend effect as the app's Delegate task action. The worker receives the
 * task in its own Session and finishes with `dure workflow done`; the caller
 * reads the result with `dure wait --task` or `dure workflow show`.
 */
export async function delegateWorkflowTask({
  summary,
  instructions,
  providerId,
  idempotencyKey,
  environment = process.env,
  backend,
  registry,
  deadlineMs = DEFAULT_WORKFLOW_DELEGATE_DEADLINE_MS,
  now,
  random,
  collectSession = collectSessionQuery,
  requestBackend = performBackendProfileRequest,
} = {}) {
  const task = normalizeDelegatedTask({ summary, instructions });
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000) {
    fail("workflow_delegate_request_invalid", { field: "deadlineMs" });
  }
  const identity = delegationIdempotency(idempotencyKey, { now, random });
  if (!backend?.managedLocal || !record(backend.profile)) {
    fail("workflow_delegate_backend_local_required");
  }
  const session = await currentLiveHmuxSession({
    environment,
    backend,
    deadlineMs: SESSION_DEADLINE_MS,
    collectSession,
    scope: "workflow_delegate",
  });
  const coordinator = registryCoordinator(registry, session);
  const workerProvider = delegationProvider(providerId, session.providerId);
  const transportOptions = backend.transportOptions ?? {};

  let bindingGeneration;
  let receipt;
  try {
    const binding = await requestBackend(
      backend.profile,
      {
        body: {
          schemaVersion: 1,
          agentId: coordinator.agentId,
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          displayName: coordinator.displayName,
          worktreePath: coordinator.worktreePath,
          stopFence: Object.fromEntries(
            GENERATION_FIELDS.map((field) => [field, session[field]]),
          ),
        },
        operation: "agent_checkpoint.binding.ensure",
        requiredCapabilities: ["agent_checkpoint.binding.ensure"],
      },
      { ...transportOptions, deadlineMs: Math.min(deadlineMs, BINDING_DEADLINE_MS) },
    );
    bindingGeneration = verifiedBinding(binding?.result, {
      agentId: coordinator.agentId,
      sessionId: session.sessionId,
    });
    const response = await requestBackend(
      backend.profile,
      {
        body: {
          schemaVersion: 1,
          contributionId: DELEGATE_ONCE_CONTRIBUTION_ID,
          coordinator: {
            agentId: coordinator.agentId,
            sessionId: session.sessionId,
            bindingGeneration,
          },
          task,
          providerId: workerProvider,
          runtimeKindId: "runtime.hmux",
          targetReference: "backend-profile:local",
          idempotencyKey: identity.idempotencyKey,
          createdAtMs: identity.createdAtMs,
        },
        operation: "workflow.delegate_once",
        requiredCapabilities: ["workflow.delegate_once"],
      },
      { ...transportOptions, deadlineMs },
    );
    receipt = verifiedDelegateReceipt(response?.result, {
      idempotencyKey: identity.idempotencyKey,
      providerId: workerProvider,
      workspaceId: session.workspaceId,
    });
    if (receipt.status === "start_failed") {
      fail("workflow_delegate_start_failed", {
        taskId: receipt.taskId,
        startErrorCode: receipt.startErrorCode,
        disposition: "terminal",
      });
    }
    if (receipt.status === "starting") {
      fail("workflow_delegate_start_uncertain", {
        taskId: receipt.taskId,
        disposition: "retry_same",
      });
    }
  } catch (error) {
    throw new WorkflowDelegationFailure(error, identity.idempotencyKey);
  }

  return {
    schemaVersion: WORKFLOW_COMPLETION_SCHEMA_VERSION,
    apiVersion: WORKFLOW_COMPLETION_API_VERSION,
    kind: "dure.workflow.delegate",
    profile: {
      id: backend.profile.id,
      transport: backend.profile.transport?.kind,
    },
    idempotencyKey: identity.idempotencyKey,
    coordinator: {
      agentId: coordinator.agentId,
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      bindingGeneration,
    },
    providerId: workerProvider,
    runId: receipt.runId,
    taskId: receipt.taskId,
    dispatchId: receipt.dispatchId,
    generation: receipt.generation,
    status: receipt.status,
    worker: receipt.session,
    receipt,
  };
}

function taskArguments(report) {
  return `--task ${report.taskId} --dispatch ${report.dispatchId} --generation ${report.generation}`;
}

export function formatWorkflowDelegation(report) {
  return [
    `\x1b[32m✓\x1b[0m ${report.taskId} delegated to a new ${report.providerId} worker (${report.status})`,
    `worker\t${report.worker.sessionId} (workspace ${report.worker.workspaceId})`,
    `wait\tdure wait ${taskArguments(report)}`,
    `result\tdure workflow show ${taskArguments(report)}`,
    `watch\tdure read ${report.worker.sessionId} --workspace ${report.worker.workspaceId}`,
  ].join("\n");
}

export function workflowDelegationErrorReport(error, profile) {
  const failure = error instanceof WorkflowDelegationFailure ? error : null;
  const report = workflowCompletionErrorReport(failure ? failure.cause : error, profile);
  return failure
    ? { ...report, error: { ...report.error, idempotencyKey: failure.idempotencyKey } }
    : report;
}

export function formatWorkflowDelegationError(report) {
  const { code, message, remoteCode, disposition, idempotencyKey, startErrorCode } =
    report.error;
  const detail = remoteCode ?? startErrorCode;
  const lines = [`${code}: ${message}${detail ? ` (${detail})` : ""}`];
  if (idempotencyKey && disposition !== "terminal") {
    lines.push(
      `To retry the same request, run the same command with --idempotency-key ${idempotencyKey}`,
    );
  }
  return lines.join("\n");
}
