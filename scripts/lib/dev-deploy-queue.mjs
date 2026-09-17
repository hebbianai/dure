import { randomBytes } from "node:crypto";
import { worktreeDevIdentity } from "./app-channel.mjs";
import { sameDevLaunchIdentity } from "./dev-launch-contract.mjs";
import {
  parseDevDeployExecutorGeneration,
  parseDevDeployImpact,
  parseDevDeployTransaction,
  sameDevDeployTransaction,
} from "./dev-deploy-transaction.mjs";
import {
  coldBootstrapSessionName,
  createColdBootstrapOperation,
  parseColdBootstrapOperation,
  parseColdBootstrapOperationId,
  V4_COLD_BOOTSTRAP_TERMINAL_SIZE,
} from "./dev-cold-bootstrap-operation.mjs";
import {
  DEV_HMUX_STANDALONE_OPERATION_MODE,
  parseDevHmuxStandaloneCommand,
  parseDevHmuxStandaloneAcknowledgement,
  parseDevHmuxStandaloneOperationBinding,
  parseDevHmuxStandaloneOperationMode,
  parseDevHmuxStandaloneRetirement,
} from "./dev-hmux-operation-contract.mjs";
import { parseDevHmuxBuildId } from "./dev-hmux-tool.mjs";
import {
  parseDevDeployRunnerGeneration,
} from "./dev-deploy-runner-generation.mjs";
import {
  parentReconciliationAfter,
  parentReconciliationRequest,
  reduceDevDeploySettlementProof,
  requestWithParentReconciliation,
  settledDeploymentProjection,
  successfulDeployment,
  successfulDeploymentFromReceipt,
} from "./dev-deploy-queue-proof.mjs";

export const DEV_DEPLOY_QUEUE_SCHEMA_VERSION = 5;
const LEGACY_DEV_DEPLOY_QUEUE_SCHEMA_VERSION = 2;
const RECEIPTLESS_DEV_DEPLOY_QUEUE_SCHEMA_VERSION = 3;
const PRE_RETIREMENT_ACK_QUEUE_SCHEMA_VERSION = 4;

export const DEV_DEPLOY_QUEUE_STATUS = Object.freeze({
  PENDING: "pending",
  ATTEMPTING: "attempting",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  EXPIRED: "expired",
  CANCELED: "canceled",
});

const ACTIVE_STATUSES = new Set([
  DEV_DEPLOY_QUEUE_STATUS.PENDING,
  DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING,
]);
const TERMINAL_STATUSES = new Set([
  DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
  DEV_DEPLOY_QUEUE_STATUS.FAILED,
  DEV_DEPLOY_QUEUE_STATUS.EXPIRED,
  DEV_DEPLOY_QUEUE_STATUS.CANCELED,
]);
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_BYTES = 4_096;
const MAX_RECEIPT_TEXT_BYTES = 8_192;
const ATTEMPT_ID = /^[a-f0-9]{32}$/;
const EXECUTION_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "PATH",
  "DURE_HOME",
  "HMUX_DISCOVERY_ROOT",
]);

function ensureColdBootstrapOperation(request) {
  const operation =
    request.coldBootstrapOperationId === undefined
      ? createColdBootstrapOperation()
      : parseColdBootstrapOperation({
          operationId: request.coldBootstrapOperationId,
          initialRows: request.coldBootstrapInitialRows,
          initialColumns: request.coldBootstrapInitialColumns,
        });
  return {
    ...request,
    coldBootstrapOperationId: operation.operationId,
    coldBootstrapInitialRows: operation.initialRows,
    coldBootstrapInitialColumns: operation.initialColumns,
  };
}

function boundedText(value, limit = MAX_RECEIPT_TEXT_BYTES) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, limit);
}

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer timestamp`);
  }
  return value;
}

function requirePositiveDuration(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer duration`);
  }
  return value;
}

function parseAttemptProcess(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.processIdentity !== "string" ||
    !value.processIdentity
  ) {
    throw new Error(`${label} is invalid`);
  }
  requireTimestamp(value.observedAtMs, `${label}.observedAtMs`);
  return value;
}

function parseColdBootstrapAttempt(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    parseColdBootstrapOperationId(value.operationId) !== value.operationId
  ) {
    throw new Error(`${label} is invalid`);
  }
  parseColdBootstrapOperation(value);
  const mode =
    value.mode === undefined
      ? undefined
      : parseDevHmuxStandaloneOperationMode(value.mode);
  if (
    mode ===
    DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET
  ) {
    throw new Error(`${label}.mode cannot acknowledge a retirement`);
  }
  if (value.submittedAtMs !== undefined) {
    requireTimestamp(value.submittedAtMs, `${label}.submittedAtMs`);
    parseDevHmuxStandaloneCommand(value.command);
    if (value.hmuxBuildId !== undefined) {
      parseDevHmuxBuildId(value.hmuxBuildId);
    } else if (mode === DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE) {
      throw new Error(`${label} has no submitted Hmux build identity`);
    }
  } else if (value.command !== undefined) {
    throw new Error(`${label} has a command before submission`);
  } else if (value.hmuxBuildId !== undefined) {
    throw new Error(`${label} has an Hmux build identity before submission`);
  }
  if (
    mode !== undefined &&
    mode !== DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE &&
    value.submittedAtMs === undefined
  ) {
    throw new Error(`${label} cannot ${mode} before submission`);
  }
  return value;
}

function parseColdBootstrapRetirementAcknowledgement(value, worktree) {
  const expectedKeys = [
    "operationId",
    "sessionName",
    "command",
    "initialRows",
    "initialColumns",
    "retirement",
    ...(value?.hmuxBuildId === undefined ? [] : ["hmuxBuildId"]),
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")
  ) {
    throw new Error("cold-bootstrap retirement acknowledgement is invalid");
  }
  const binding = parseDevHmuxStandaloneOperationBinding({
    operationId: value.operationId,
    sessionName: value.sessionName,
    command: value.command,
    initialRows: value.initialRows,
    initialColumns: value.initialColumns,
  });
  const { channel } = worktreeDevIdentity(worktree);
  if (
    binding.sessionName !==
    coldBootstrapSessionName({
      root: worktree,
      channel,
      operationId: binding.operationId,
    })
  ) {
    throw new Error("cold-bootstrap retirement acknowledgement is unbound");
  }
  return Object.freeze({
    ...binding,
    ...(value.hmuxBuildId === undefined
      ? {}
      : { hmuxBuildId: parseDevHmuxBuildId(value.hmuxBuildId) }),
    retirement: parseDevHmuxStandaloneRetirement(
      value.retirement,
      binding,
    ),
  });
}

function parseDurableAttempt(activeAttempt, worktree) {
  if (
    typeof activeAttempt.attemptId !== "string" ||
    !ATTEMPT_ID.test(activeAttempt.attemptId)
  ) {
    throw new Error("dev deploy queue attempt id is invalid");
  }
  if (activeAttempt.executor !== undefined) {
    parseAttemptProcess(activeAttempt.executor, "activeAttempt.executor");
  }
  if (activeAttempt.coldBootstrap !== undefined) {
    parseColdBootstrapAttempt(
      activeAttempt.coldBootstrap,
      "activeAttempt.coldBootstrap",
    );
  }
  if (activeAttempt.coldBootstrapRetirementAcknowledgement !== undefined) {
    parseColdBootstrapRetirementAcknowledgement(
      activeAttempt.coldBootstrapRetirementAcknowledgement,
      worktree,
    );
  }
  if (activeAttempt.phase !== undefined) {
    if (
      !activeAttempt.executor ||
      !activeAttempt.phase ||
      activeAttempt.phase.kind !== "target_applied" ||
      activeAttempt.phase.targetHead !== activeAttempt.transaction.targetHead
    ) {
      throw new Error("dev deploy queue attempt phase is invalid");
    }
    requireTimestamp(
      activeAttempt.phase.observedAtMs,
      "activeAttempt.phase.observedAtMs",
    );
  }
  if (activeAttempt.result !== undefined) {
    const result = activeAttempt.result;
    if (
      !activeAttempt.executor ||
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !Number.isInteger(result.exitCode) ||
      (result.receipt !== undefined &&
        (!result.receipt ||
          typeof result.receipt !== "object" ||
          Array.isArray(result.receipt))) ||
      (result.stderr !== undefined &&
        (typeof result.stderr !== "string" ||
          result.stderr.length > MAX_RECEIPT_TEXT_BYTES))
    ) {
      throw new Error("dev deploy queue attempt result is invalid");
    }
    requireTimestamp(
      result.completedAtMs,
      "activeAttempt.result.completedAtMs",
    );
  }
  return activeAttempt;
}

function parseSubmittedColdBootstrapAuthority(state) {
  const active =
    state.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING
      ? state.activeAttempt
      : undefined;
  const activeSubmission = active?.coldBootstrap?.submittedAtMs;
  const previous = state.lastAttempt;
  const previousSubmission = previous?.coldBootstrap?.submittedAtMs;
  const attemptOwnsCarriedSubmission = (attempt) =>
    Boolean(
      attempt?.executor &&
        (attempt.phase ||
          attempt.coldBootstrap?.mode ===
            DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET ||
          attempt.coldBootstrap?.mode ===
            DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET),
    );
  for (const attempt of [active, previous]) {
    const operation = attempt?.coldBootstrap;
    if (
      operation &&
      operation.operationId === state.request.coldBootstrapOperationId &&
      (operation.initialRows !== state.request.coldBootstrapInitialRows ||
        operation.initialColumns !==
          state.request.coldBootstrapInitialColumns)
    ) {
      throw new Error(
        "cold-bootstrap attempt dimensions do not match its operation",
      );
    }
  }
  if (
    previousSubmission !== undefined &&
    !attemptOwnsCarriedSubmission(previous)
  ) {
    throw new Error(
      "submitted cold bootstrap requires exact executor lifecycle authority",
    );
  }
  if (
    activeSubmission !== undefined &&
    !attemptOwnsCarriedSubmission(active) &&
    !(
      previousSubmission !== undefined &&
      previous.coldBootstrap.operationId === active.coldBootstrap.operationId &&
      previous.coldBootstrap.initialRows === active.coldBootstrap.initialRows &&
      previous.coldBootstrap.initialColumns ===
        active.coldBootstrap.initialColumns &&
      previous.coldBootstrap.submittedAtMs ===
        active.coldBootstrap.submittedAtMs &&
      JSON.stringify(previous.coldBootstrap.command) ===
        JSON.stringify(active.coldBootstrap.command) &&
      previous.coldBootstrap.hmuxBuildId ===
        active.coldBootstrap.hmuxBuildId
    )
  ) {
    throw new Error(
      "submitted cold bootstrap requires exact current or previous lifecycle authority",
    );
  }
  const requestedAcknowledgement =
    state.request.coldBootstrapRetirementAcknowledgement;
  const activeAcknowledgement =
    active?.coldBootstrapRetirementAcknowledgement;
  if (
    active &&
    (JSON.stringify(activeAcknowledgement) !==
      JSON.stringify(requestedAcknowledgement) ||
      (requestedAcknowledgement !== undefined &&
        active.coldBootstrap !== undefined))
  ) {
    throw new Error(
      "cold-bootstrap retirement acknowledgement attempt is invalid",
    );
  }
}

function parseReceiptlessLastAttempt(lastAttempt, queueGeneration) {
  const identity = lastAttempt.attemptIdentity;
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).length !== 2 ||
    identity.kind !== "unavailable" ||
    identity.sourceSchemaVersion !==
      RECEIPTLESS_DEV_DEPLOY_QUEUE_SCHEMA_VERSION ||
    lastAttempt.attemptId !== undefined ||
    lastAttempt.startedAtMs !== undefined ||
    lastAttempt.executor !== undefined ||
    lastAttempt.phase !== undefined ||
    !Number.isSafeInteger(lastAttempt.generation) ||
    lastAttempt.generation < 1 ||
    lastAttempt.generation > queueGeneration ||
    !Number.isInteger(lastAttempt.exitCode) ||
    (lastAttempt.receipt !== undefined &&
      (!lastAttempt.receipt ||
        typeof lastAttempt.receipt !== "object" ||
        Array.isArray(lastAttempt.receipt))) ||
    (lastAttempt.stderr !== undefined &&
      (typeof lastAttempt.stderr !== "string" ||
        lastAttempt.stderr.length > MAX_RECEIPT_TEXT_BYTES))
  ) {
    throw new Error("receiptless last attempt identity is invalid");
  }
  requireTimestamp(lastAttempt.completedAtMs, "lastAttempt.completedAtMs");
  return lastAttempt;
}

function normalizeQueuedDeployArguments(args) {
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) {
    throw new Error(`queued deploy accepts at most ${MAX_ARGUMENTS} arguments`);
  }
  const normalized = args.filter((argument) => argument !== "--json");
  for (const argument of normalized) {
    if (
      typeof argument !== "string" ||
      Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES ||
      /[\0\r\n]/.test(argument)
    ) {
      throw new Error("queued deploy argument is unsafe");
    }
  }
  return normalized;
}

export function isActiveQueuedDeploy(state) {
  return Boolean(state && ACTIVE_STATUSES.has(state.status));
}

export function isTerminalQueuedDeploy(state) {
  return Boolean(state && TERMINAL_STATUSES.has(state.status));
}

function upgradePreRetirementAcknowledgementState(value) {
  if (value.schemaVersion !== PRE_RETIREMENT_ACK_QUEUE_SCHEMA_VERSION) {
    return value;
  }
  if (
    value.request?.coldBootstrapRetirementAcknowledgement !== undefined ||
    value.activeAttempt?.coldBootstrapRetirementAcknowledgement !== undefined ||
    value.lastAttempt?.coldBootstrapRetirementAcknowledgement !== undefined
  ) {
    throw new Error(
      "cold-bootstrap retirement acknowledgement requires queue schema v5",
    );
  }
  const upgradeAttempt = (attempt) =>
    attempt?.coldBootstrap
      ? {
          ...attempt,
          coldBootstrap: {
            ...attempt.coldBootstrap,
            ...V4_COLD_BOOTSTRAP_TERMINAL_SIZE,
          },
        }
      : attempt;
  return {
    ...value,
    schemaVersion: DEV_DEPLOY_QUEUE_SCHEMA_VERSION,
    request: value.request?.coldBootstrapOperationId
      ? {
          ...value.request,
          coldBootstrapInitialRows:
            V4_COLD_BOOTSTRAP_TERMINAL_SIZE.initialRows,
          coldBootstrapInitialColumns:
            V4_COLD_BOOTSTRAP_TERMINAL_SIZE.initialColumns,
        }
      : value.request,
    ...(value.activeAttempt
      ? { activeAttempt: upgradeAttempt(value.activeAttempt) }
      : {}),
    ...(value.lastAttempt
      ? { lastAttempt: upgradeAttempt(value.lastAttempt) }
      : {}),
  };
}

export function parseQueuedDeployState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dev deploy queue state must be an object");
  }
  const legacy = value.schemaVersion === LEGACY_DEV_DEPLOY_QUEUE_SCHEMA_VERSION;
  const receiptless =
    value.schemaVersion === RECEIPTLESS_DEV_DEPLOY_QUEUE_SCHEMA_VERSION;
  const preRetirementAck =
    value.schemaVersion === PRE_RETIREMENT_ACK_QUEUE_SCHEMA_VERSION;
  if (
    !legacy &&
    !receiptless &&
    !preRetirementAck &&
    value.schemaVersion !== DEV_DEPLOY_QUEUE_SCHEMA_VERSION
  ) {
    throw new Error("unsupported dev deploy queue schema");
  }
  value = upgradePreRetirementAcknowledgementState(value);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error("dev deploy queue generation is invalid");
  }
  if (typeof value.worktree !== "string" || !value.worktree.startsWith("/")) {
    throw new Error("dev deploy queue worktree must be absolute");
  }
  if (!ACTIVE_STATUSES.has(value.status) && !TERMINAL_STATUSES.has(value.status)) {
    throw new Error("dev deploy queue status is invalid");
  }
  requireTimestamp(value.firstQueuedAtMs, "firstQueuedAtMs");
  requireTimestamp(value.requestedAtMs, "requestedAtMs");
  requireTimestamp(value.expiresAtMs, "expiresAtMs");
  if (value.expiresAtMs <= value.firstQueuedAtMs) {
    throw new Error("dev deploy queue expiry must follow its first request");
  }
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0) {
    throw new Error("dev deploy queue attempts is invalid");
  }
  if (!value.request || typeof value.request !== "object") {
    throw new Error("dev deploy queue request is missing");
  }
  normalizeQueuedDeployArguments(value.request.attemptArgs);
  parentReconciliationRequest(value.request.reconciliation);
  if (legacy) {
    if (
      typeof value.request.executorPath !== "string" ||
      !value.request.executorPath.startsWith("/")
    ) {
      throw new Error("legacy dev deploy executor path must be absolute");
    }
  } else {
    parseDevDeployTransaction(value.request.transaction);
  }
  if (value.request.coldBootstrapOperationId !== undefined) {
    parseColdBootstrapOperation({
      operationId: value.request.coldBootstrapOperationId,
      initialRows: value.request.coldBootstrapInitialRows,
      initialColumns: value.request.coldBootstrapInitialColumns,
    });
  } else if (
    value.request.coldBootstrapInitialRows !== undefined ||
    value.request.coldBootstrapInitialColumns !== undefined
  ) {
    throw new Error("cold-bootstrap operation dimensions are unbound");
  }
  if (value.request.coldBootstrapRetirementAcknowledgement !== undefined) {
    if (value.schemaVersion !== DEV_DEPLOY_QUEUE_SCHEMA_VERSION) {
      throw new Error(
        "cold-bootstrap retirement acknowledgement requires queue schema v5",
      );
    }
    const acknowledgement = parseColdBootstrapRetirementAcknowledgement(
      value.request.coldBootstrapRetirementAcknowledgement,
      value.worktree,
    );
    if (
      acknowledgement.operationId ===
      value.request.coldBootstrapOperationId
    ) {
      throw new Error(
        "cold-bootstrap successor must differ from its retirement acknowledgement",
      );
    }
  }
  if (
    !value.request.executionEnvironment ||
    typeof value.request.executionEnvironment !== "object" ||
    Array.isArray(value.request.executionEnvironment)
  ) {
    throw new Error("dev deploy execution environment is invalid");
  }
  for (const [key, environmentValue] of Object.entries(
    value.request.executionEnvironment,
  )) {
    if (
      !EXECUTION_ENVIRONMENT_KEYS.has(key) ||
      typeof environmentValue !== "string" ||
      Buffer.byteLength(environmentValue) > 32_768 ||
      /[\0\r\n]/.test(environmentValue)
    ) {
      throw new Error("dev deploy execution environment is unsafe");
    }
  }
  if (
    value.request.observed !== undefined &&
    (!value.request.observed ||
      typeof value.request.observed !== "object" ||
      Array.isArray(value.request.observed))
  ) {
    throw new Error("dev deploy queue observation is invalid");
  }
  if (value.status === DEV_DEPLOY_QUEUE_STATUS.PENDING) {
    requireTimestamp(value.nextAttemptAtMs, "nextAttemptAtMs");
  }
  if (value.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING) {
    if (
      !value.activeAttempt ||
      !Number.isSafeInteger(value.activeAttempt.generation) ||
      value.activeAttempt.generation < 1 ||
      value.activeAttempt.generation > value.generation
    ) {
      throw new Error("dev deploy queue active attempt is invalid");
    }
    requireTimestamp(value.activeAttempt.startedAtMs, "activeAttempt.startedAtMs");
    if (!legacy) {
      parseDevDeployTransaction(
        value.activeAttempt.transaction,
        "active attempt transaction",
      );
    }
    if (preRetirementAck || value.schemaVersion === DEV_DEPLOY_QUEUE_SCHEMA_VERSION) {
      parseDurableAttempt(value.activeAttempt, value.worktree);
    }
  }
  if (value.worker !== undefined) {
    if (
      !value.worker ||
      !Number.isSafeInteger(value.worker.pid) ||
      value.worker.pid < 1
    ) {
      throw new Error("dev deploy queue worker is invalid");
    }
    requireTimestamp(value.worker.startedAtMs, "worker.startedAtMs");
    if (
      value.worker.processIdentity !== undefined &&
      (typeof value.worker.processIdentity !== "string" ||
        !value.worker.processIdentity)
    ) {
      throw new Error("dev deploy queue worker process identity is invalid");
    }
    if (value.worker.executorGeneration !== undefined) {
      parseDevDeployExecutorGeneration(
        value.worker.executorGeneration,
        "dev deploy queue worker executor generation",
      );
    }
    parseDevDeployRunnerGeneration(
      value.worker.processGeneration,
      "dev deploy queue worker",
    );
  }
  if (
    value.priorFailure !== undefined &&
    (!value.priorFailure ||
      typeof value.priorFailure !== "object" ||
      !value.priorFailure.failure ||
      typeof value.priorFailure.failure !== "object")
  ) {
    throw new Error("dev deploy queue prior failure is invalid");
  }
  if (!legacy && value.priorFailure?.transaction) {
    parseDevDeployTransaction(
      value.priorFailure.transaction,
      "prior failure transaction",
    );
  }
  successfulDeployment(value.lastSuccessfulDeployment);
  if (!legacy && value.lastAttempt !== undefined) {
    parseDevDeployTransaction(
      value.lastAttempt.transaction,
      "last attempt transaction",
    );
    if (preRetirementAck || value.schemaVersion === DEV_DEPLOY_QUEUE_SCHEMA_VERSION) {
      if (value.lastAttempt.attemptIdentity !== undefined) {
        parseReceiptlessLastAttempt(value.lastAttempt, value.generation);
      } else {
        if (
          !Number.isSafeInteger(value.lastAttempt.generation) ||
          value.lastAttempt.generation < 1 ||
          !ATTEMPT_ID.test(value.lastAttempt.attemptId ?? "")
        ) {
          throw new Error("last attempt identity is invalid");
        }
        requireTimestamp(
          value.lastAttempt.startedAtMs,
          "lastAttempt.startedAtMs",
        );
        parseDurableAttempt(value.lastAttempt, value.worktree);
      }
    }
  }
  if (preRetirementAck || value.schemaVersion === DEV_DEPLOY_QUEUE_SCHEMA_VERSION) {
    parseSubmittedColdBootstrapAuthority(value);
  }
  return value;
}

function upgradeReceiptlessPendingState(state) {
  if (
    !state ||
    state.schemaVersion !== RECEIPTLESS_DEV_DEPLOY_QUEUE_SCHEMA_VERSION ||
    state.status !== DEV_DEPLOY_QUEUE_STATUS.PENDING
  ) {
    return state;
  }
  const current = {
    ...state,
    schemaVersion: DEV_DEPLOY_QUEUE_SCHEMA_VERSION,
    ...(state.lastAttempt
      ? {
          lastAttempt: {
            ...state.lastAttempt,
            attemptIdentity: {
              kind: "unavailable",
              sourceSchemaVersion:
                RECEIPTLESS_DEV_DEPLOY_QUEUE_SCHEMA_VERSION,
            },
          },
        }
      : {}),
  };
  if (current.lastAttempt) {
    parseReceiptlessLastAttempt(current.lastAttempt, current.generation);
  }
  return current;
}

function observedRequest(receipt, previous) {
  const observed = {};
  for (const key of ["currentHead", "targetHead", "pendingCommits", "impact"]) {
    if (receipt?.[key] !== undefined) observed[key] = receipt[key];
    else if (previous?.[key] !== undefined) observed[key] = previous[key];
  }
  return observed;
}

function priorFailureFor(current, worktree) {
  if (!current || current.worktree !== worktree) return undefined;
  if (current.status === DEV_DEPLOY_QUEUE_STATUS.FAILED) {
    const latestReceipt =
      current.lastAttempt?.generation === current.generation
        ? current.lastAttempt.receipt
        : undefined;
    if (latestReceipt?.action === "deploy" && latestReceipt.deployed === true) {
      return {
        failure: current.failure,
        receipt: latestReceipt,
        ...(current.lastAttempt?.transaction
          ? { transaction: current.lastAttempt.transaction }
          : {}),
      };
    }
    if (current.failure?.code !== "prior_deploy_failure_unresolved") {
      return {
        failure: current.failure,
        ...(latestReceipt ? { receipt: latestReceipt } : {}),
        ...(current.lastAttempt?.transaction
          ? { transaction: current.lastAttempt.transaction }
          : {}),
        ...(current.lastAttempt?.evidence
          ? { evidence: current.lastAttempt.evidence }
          : {}),
      };
    }
  }
  return current.priorFailure;
}

export function lastSuccessfulDeploymentFor(state) {
  if (!state) return undefined;
  if (state.lastSuccessfulDeployment) return state.lastSuccessfulDeployment;
  if (state.status !== DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED) return undefined;
  return successfulDeploymentFromReceipt(
    state.finalReceipt,
    undefined,
    state.completedAtMs,
    state.worktree,
    state.request?.transaction ?? state.lastAttempt?.transaction,
  );
}

export function assertLiveWorktreeSelection(
  state,
  requestedLiveWorktree,
  runtimeLiveness,
) {
  const current = state ? parseQueuedDeployState(state) : null;
  if (!current || current.worktree === requestedLiveWorktree) return;
  if (runtimeLiveness !== "active") return;
  throw new Error(
    `live_worktree_mismatch: ${current.worktree} owns the active daily-driver runtime; ` +
      `pass --live-worktree ${current.worktree}`,
  );
}

function sameDeployTargetAndExecutor(left, right) {
  return (
    left?.targetHead === right.targetHead &&
    left?.executor?.generation === right.executor.generation &&
    left?.executor?.entrypoint === right.executor.entrypoint
  );
}

function coldBootstrapPort(attemptArgs) {
  const index = attemptArgs.indexOf("--port");
  if (index < 0) return undefined;
  const port = Number(attemptArgs[index + 1]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? port
    : null;
}

function sameColdBootstrapIntent(
  state,
  { worktree, transaction, attemptArgs, executionEnvironment },
) {
  const operationId = state?.request?.coldBootstrapOperationId;
  const submitted = submittedColdBootstrap(state, operationId);
  return Boolean(
    state?.schemaVersion === DEV_DEPLOY_QUEUE_SCHEMA_VERSION &&
      state.worktree === worktree &&
      sameDevDeployTransaction(state.request.transaction, transaction) &&
      coldBootstrapPort(state.request.attemptArgs) ===
        coldBootstrapPort(attemptArgs) &&
      state.request.executionEnvironment.HOME === executionEnvironment.HOME &&
      state.request.executionEnvironment.DURE_HOME ===
        executionEnvironment.DURE_HOME &&
      (submitted ||
        state.request.executionEnvironment.PATH === executionEnvironment.PATH),
  );
}

function submittedColdBootstrap(state, operationId) {
  return [state?.activeAttempt, state?.lastAttempt]
    .map((attempt) => attempt?.coldBootstrap)
    .find(
      (coldBootstrap) =>
        coldBootstrap?.operationId === operationId &&
        coldBootstrap?.submittedAtMs !== undefined,
    );
}

function coldBootstrapWasRefused(state, operationId) {
  return (
    state?.lastAttempt?.coldBootstrap?.operationId === operationId &&
    sameDevDeployTransaction(
      state.lastAttempt.transaction,
      state.request.transaction,
    ) &&
    state?.lastAttempt?.receipt?.plannedTransition?.hmuxOutcome === "refused"
  );
}

function unresolvedSubmittedColdBootstrap(state) {
  const operationId = state?.request?.coldBootstrapOperationId;
  const submitted = submittedColdBootstrap(state, operationId);
  return submitted && !coldBootstrapWasRefused(state, operationId)
    ? submitted
    : undefined;
}

function pendingColdBootstrapRetirementAcknowledgement(state) {
  return state?.request?.coldBootstrapRetirementAcknowledgement;
}

function protectedColdBootstrapLifecycle(state) {
  return (
    pendingColdBootstrapRetirementAcknowledgement(state) ??
    unresolvedSubmittedColdBootstrap(state)
  );
}

export function nextDevDeployWakeAtMs(state) {
  return protectedColdBootstrapLifecycle(state)
    ? state.nextAttemptAtMs
    : Math.min(state.nextAttemptAtMs, state.expiresAtMs);
}

function exactSuccessfulDeploymentStillActive({
  current,
  transaction,
  receipt,
  runtimeLiveness,
  attemptArgs,
  executionEnvironment,
}) {
  if (
    current?.status !== DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED ||
    current.schemaVersion === LEGACY_DEV_DEPLOY_QUEUE_SCHEMA_VERSION ||
    current.priorFailure ||
    current.request.reconciliation ||
    current.finalReceipt?.action !== "deploy" ||
    current.request.executionEnvironment.HOME !== executionEnvironment.HOME ||
    current.request.executionEnvironment.DURE_HOME !==
      executionEnvironment.DURE_HOME ||
    current.lastAttempt?.generation !== current.generation ||
    runtimeLiveness !== "active" ||
    attemptArgs.includes("--force") ||
    receipt?.currentHead !== transaction.targetHead ||
    receipt.targetHead !== transaction.targetHead ||
    receipt.pendingCommits !== 0 ||
    !sameDeployTargetAndExecutor(
      current.lastAttempt.transaction,
      transaction,
    )
  ) {
    return false;
  }
  const deployed = lastSuccessfulDeploymentFor(current);
  if (
    deployed?.sourceHead !== transaction.targetHead ||
    !deployed.runtime
  ) {
    return false;
  }
  const proof = reduceDevDeploySettlementProof({
    receipt: current.finalReceipt,
    worktree: current.worktree,
    transaction: current.lastAttempt.transaction,
  });
  return (
    proof.kind === "deployment" &&
    proof.activation.targetHead === transaction.targetHead &&
    JSON.stringify(proof.activation.runtime) === JSON.stringify(deployed.runtime)
  );
}

export function enqueueDevDeploy({
  existing = null,
  worktree,
  attemptArgs,
  transaction,
  executionEnvironment,
  receipt,
  runtimeLiveness,
  targetDescendsFrom,
  nowMs = Date.now(),
  maxWaitMs,
  pollMs,
}) {
  requireTimestamp(nowMs, "nowMs");
  requirePositiveDuration(maxWaitMs, "maxWaitMs");
  requirePositiveDuration(pollMs, "pollMs");
  if (typeof worktree !== "string" || !worktree.startsWith("/")) {
    throw new Error("queued deploy worktree must be absolute");
  }
  const parsedTransaction = parseDevDeployTransaction(transaction);
  if (!executionEnvironment || typeof executionEnvironment !== "object") {
    throw new Error("queued deploy execution environment is required");
  }
  const normalizedArgs = normalizeQueuedDeployArguments(attemptArgs);
  const current = existing
    ? upgradeReceiptlessPendingState(parseQueuedDeployState(existing))
    : null;
  if (
    current?.schemaVersion === LEGACY_DEV_DEPLOY_QUEUE_SCHEMA_VERSION &&
    isActiveQueuedDeploy(current)
  ) {
    throw new Error(
      "active schema-v2 deploy has no bound target transaction; cancel or let its existing owner settle before re-enqueueing",
    );
  }
  if (
    current?.schemaVersion === RECEIPTLESS_DEV_DEPLOY_QUEUE_SCHEMA_VERSION &&
    current.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING
  ) {
    throw new Error(
      "active schema-v3 deploy has no durable executor receipt; let one recovery owner preserve its interrupted evidence before re-enqueueing",
    );
  }
  if (
    exactSuccessfulDeploymentStillActive({
      current,
      transaction: parsedTransaction,
      receipt,
      runtimeLiveness,
      attemptArgs: normalizedArgs,
      executionEnvironment,
    })
  ) {
    return current;
  }
  const currentColdBootstrapSubmitted =
    unresolvedSubmittedColdBootstrap(current);
  const retainedSuccessfulColdBootstrap =
    current?.status === DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED
      ? currentColdBootstrapSubmitted
      : undefined;
  const currentRetirementAcknowledgement =
    pendingColdBootstrapRetirementAcknowledgement(current);
  const pendingExpired =
    current?.status === DEV_DEPLOY_QUEUE_STATUS.PENDING &&
    nowMs >= current.expiresAtMs &&
    !currentColdBootstrapSubmitted;
  const currentOwnsQueue =
    (isActiveQueuedDeploy(current) && !pendingExpired) ||
    Boolean(protectedColdBootstrapLifecycle(current));
  if (currentOwnsQueue && current.worktree !== worktree) {
    throw new Error(
      `another live worktree already owns the deploy queue: ${current.worktree}`,
    );
  }
  const continuing = currentOwnsQueue && current.worktree === worktree;
  const sameTransaction =
    continuing &&
    current.schemaVersion !== LEGACY_DEV_DEPLOY_QUEUE_SCHEMA_VERSION &&
    sameDevDeployTransaction(current.request.transaction, parsedTransaction);
  if (
    current?.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING &&
    sameTransaction
  ) {
    return current;
  }
  const sameColdBootstrap = sameColdBootstrapIntent(current, {
    worktree,
    transaction: parsedTransaction,
    attemptArgs: normalizedArgs,
    executionEnvironment,
  });
  if (
    currentOwnsQueue &&
    currentColdBootstrapSubmitted &&
    !sameColdBootstrap &&
    !retainedSuccessfulColdBootstrap
  ) {
    throw new Error(
      "a submitted cold-bootstrap operation must settle before its target can change",
    );
  }
  const reusableColdBootstrapOperationId =
    (sameColdBootstrap || retainedSuccessfulColdBootstrap) &&
    !coldBootstrapWasRefused(
      current,
      current.request.coldBootstrapOperationId,
    )
      ? current.request.coldBootstrapOperationId
      : undefined;
  const replayingSubmittedColdBootstrap = submittedColdBootstrap(
    current,
    reusableColdBootstrapOperationId,
  );
  const inheritsForce =
    continuing &&
    current.request.attemptArgs.includes("--force") &&
    !normalizedArgs.includes("--force") &&
    typeof targetDescendsFrom === "function" &&
    targetDescendsFrom(
      current.request.transaction.targetHead,
      parsedTransaction.targetHead,
    );
  const mergedArgs = inheritsForce
    ? ["--force", ...normalizedArgs]
    : normalizedArgs;
  const history = current?.worktree === worktree ? current : null;
  const priorFailure = priorFailureFor(history, worktree);
  const lastSuccessfulDeployment = lastSuccessfulDeploymentFor(history);
  const firstQueuedAtMs = continuing ? current.firstQueuedAtMs : nowMs;
  const observed = observedRequest(
    receipt,
    sameTransaction ? current.request.observed : null,
  );
  const reconciliation = parentReconciliationAfter({
    request: history?.request,
    priorFailure,
    deployed: lastSuccessfulDeployment,
    observed,
    activationImpact: parsedTransaction.selection?.impact,
    terminalReceipt:
      history?.status === DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED
        ? history.finalReceipt
        : undefined,
  });
  return {
    schemaVersion: DEV_DEPLOY_QUEUE_SCHEMA_VERSION,
    generation: (current?.generation ?? 0) + 1,
    worktree,
    status:
      continuing && current.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING
        ? DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING
        : DEV_DEPLOY_QUEUE_STATUS.PENDING,
    firstQueuedAtMs,
    requestedAtMs: nowMs,
    expiresAtMs: firstQueuedAtMs + maxWaitMs,
    attempts: continuing ? current.attempts : 0,
    nextAttemptAtMs: nowMs,
    request: ensureColdBootstrapOperation({
      attemptArgs: mergedArgs,
      transaction: parsedTransaction,
      executionEnvironment: {
        ...(replayingSubmittedColdBootstrap
          ? current.request.executionEnvironment
          : executionEnvironment),
      },
      observed,
      ...(reusableColdBootstrapOperationId
        ? {
            coldBootstrapOperationId: reusableColdBootstrapOperationId,
            coldBootstrapInitialRows:
              current.request.coldBootstrapInitialRows,
            coldBootstrapInitialColumns:
              current.request.coldBootstrapInitialColumns,
          }
        : {}),
      ...(currentRetirementAcknowledgement
        ? {
            coldBootstrapRetirementAcknowledgement:
              currentRetirementAcknowledgement,
          }
        : {}),
      ...(reconciliation ? { reconciliation } : {}),
    }),
    ...(continuing && current.activeAttempt
      ? { activeAttempt: current.activeAttempt }
      : {}),
    ...(continuing && current.lastAttempt
      ? { lastAttempt: current.lastAttempt }
      : {}),
    ...(continuing && current.worker ? { worker: current.worker } : {}),
    ...(priorFailure ? { priorFailure } : {}),
    ...(lastSuccessfulDeployment ? { lastSuccessfulDeployment } : {}),
  };
}

export function refreshPendingDevDeploySelection(
  state,
  { transaction, receipt },
) {
  const current = parseQueuedDeployState(state);
  if (current.status !== DEV_DEPLOY_QUEUE_STATUS.PENDING) return current;
  const parsedTransaction = parseDevDeployTransaction(transaction);
  const deployed = lastSuccessfulDeploymentFor(current);
  if (
    !parsedTransaction.selection ||
    !sameDeployTargetAndExecutor(
      current.request.transaction,
      parsedTransaction,
    ) ||
    deployed?.sourceHead !== parsedTransaction.selection.sourceHead ||
    receipt?.currentHead !== parsedTransaction.selection.sourceHead ||
    receipt.targetHead !== parsedTransaction.targetHead ||
    JSON.stringify(parseDevDeployImpact(receipt.impact)) !==
      JSON.stringify(parsedTransaction.selection.impact)
  ) {
    throw new Error(
      "pending deploy selection must come from its latest exact deployment observation",
    );
  }
  return {
    ...current,
    request: {
      ...current.request,
      transaction: parsedTransaction,
      observed: observedRequest(receipt, current.request.observed),
    },
  };
}

export function attachDeployQueueWorker(state, worker) {
  const current = parseQueuedDeployState(state);
  if (!isActiveQueuedDeploy(current)) return current;
  if (
    !worker ||
    !Number.isSafeInteger(worker.pid) ||
    worker.pid < 1 ||
    !Number.isSafeInteger(worker.startedAtMs)
  ) {
    throw new Error("dev deploy queue worker identity is invalid");
  }
  if (
    worker.processIdentity !== undefined &&
    (typeof worker.processIdentity !== "string" || !worker.processIdentity)
  ) {
    throw new Error("dev deploy queue worker process identity is invalid");
  }
  if (worker.executorGeneration !== undefined) {
    parseDevDeployExecutorGeneration(
      worker.executorGeneration,
      "dev deploy queue worker executor generation",
    );
  }
  parseDevDeployRunnerGeneration(
    worker.processGeneration,
    "dev deploy queue worker",
  );
  return { ...current, worker };
}

function coldBootstrapModeForAttempt(current, request, operation) {
  const previousAttempt = current.lastAttempt;
  const previous = previousAttempt?.coldBootstrap;
  if (
    previous?.operationId !== operation.operationId ||
    previous.submittedAtMs === undefined
  ) {
    return DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE;
  }
  if (
    previous.mode ===
    DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET
  ) {
    return DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET;
  }
  return previousAttempt.transaction.targetHead ===
    request.transaction.targetHead
    ? DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET
    : DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET;
}

export function beginDevDeployAttempt(state, nowMs = Date.now()) {
  const current = upgradeReceiptlessPendingState(parseQueuedDeployState(state));
  requireTimestamp(nowMs, "nowMs");
  if (current.status !== DEV_DEPLOY_QUEUE_STATUS.PENDING) {
    throw new Error(`cannot begin deploy from ${current.status}`);
  }
  if (current.schemaVersion !== DEV_DEPLOY_QUEUE_SCHEMA_VERSION) {
    throw new Error(
      `schema-v${current.schemaVersion} deploy has no durable attempt receipt and cannot execute`,
    );
  }
  if (
    nowMs >= current.expiresAtMs &&
    !protectedColdBootstrapLifecycle(current)
  ) {
    return expireDevDeploy(current, nowMs);
  }
  const request = ensureColdBootstrapOperation(current.request);
  const previousColdBootstrap = current.lastAttempt?.coldBootstrap;
  const coldBootstrapOperation = parseColdBootstrapOperation({
    operationId: request.coldBootstrapOperationId,
    initialRows: request.coldBootstrapInitialRows,
    initialColumns: request.coldBootstrapInitialColumns,
  });
  const retirementAcknowledgement =
    request.coldBootstrapRetirementAcknowledgement;
  return {
    ...current,
    request,
    status: DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING,
    attempts: current.attempts + 1,
    activeAttempt: {
      generation: current.generation,
      attemptId: randomBytes(16).toString("hex"),
      startedAtMs: nowMs,
      transaction: request.transaction,
      ...(retirementAcknowledgement
        ? {
            coldBootstrapRetirementAcknowledgement:
              retirementAcknowledgement,
          }
        : coldBootstrapOperation.operationId
        ? {
            coldBootstrap: {
              ...coldBootstrapOperation,
              mode: coldBootstrapModeForAttempt(
                current,
                request,
                coldBootstrapOperation,
              ),
              ...(previousColdBootstrap?.operationId ===
                coldBootstrapOperation.operationId &&
              previousColdBootstrap.submittedAtMs !== undefined
                  ? {
                    submittedAtMs: previousColdBootstrap.submittedAtMs,
                    command: previousColdBootstrap.command,
                    ...(previousColdBootstrap.hmuxBuildId === undefined
                      ? {}
                      : {
                          hmuxBuildId: previousColdBootstrap.hmuxBuildId,
                        }),
                  }
                : {}),
            },
          }
        : {}),
    },
  };
}

function exactActiveAttempt(state, input) {
  const current = parseQueuedDeployState(state);
  if (
    current.schemaVersion !== DEV_DEPLOY_QUEUE_SCHEMA_VERSION ||
    current.status !== DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING ||
    current.activeAttempt.attemptId !== input.attemptId ||
    current.activeAttempt.generation !== input.attemptGeneration ||
    !sameDevDeployTransaction(
      current.activeAttempt.transaction,
      input.transaction,
    )
  ) {
    throw new Error("queued deploy attempt no longer owns its exact transaction");
  }
  return current;
}

export function attachDevDeployAttemptExecutor(state, input) {
  const current = exactActiveAttempt(state, input);
  const executor = parseAttemptProcess(
    input.executor,
    "queued deploy executor",
  );
  const existing = current.activeAttempt.executor;
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(executor)) {
      throw new Error("queued deploy attempt already has another executor");
    }
    return current;
  }
  return {
    ...current,
    activeAttempt: { ...current.activeAttempt, executor },
  };
}

export function recordDevDeployAttemptPhase(state, input) {
  const current = exactActiveAttempt(state, input);
  if (!current.activeAttempt.executor) {
    throw new Error("queued deploy attempt has no attached executor");
  }
  const phase = {
    kind: "target_applied",
    targetHead: current.activeAttempt.transaction.targetHead,
    observedAtMs: requireTimestamp(input.observedAtMs, "phase observedAtMs"),
  };
  const existing = current.activeAttempt.phase;
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(phase)) {
      throw new Error("queued deploy attempt phase cannot move backwards");
    }
    return current;
  }
  return {
    ...current,
    activeAttempt: { ...current.activeAttempt, phase },
  };
}

export function recordDevDeployColdBootstrapSubmission(state, input) {
  const current = exactActiveAttempt(state, input);
  const coldBootstrap = current.activeAttempt.coldBootstrap;
  const command = parseDevHmuxStandaloneCommand(input.command);
  const hmuxBuildId = parseDevHmuxBuildId(input.hmuxBuildId);
  if (
    !coldBootstrap ||
    coldBootstrap.operationId !==
      parseColdBootstrapOperationId(input.operationId)
  ) {
    throw new Error("queued deploy cold bootstrap no longer owns its exact operation");
  }
  if (coldBootstrap.submittedAtMs !== undefined) {
    if (JSON.stringify(coldBootstrap.command) !== JSON.stringify(command)) {
      throw new Error("queued deploy cold bootstrap command cannot change");
    }
    if (
      coldBootstrap.hmuxBuildId !== undefined &&
      coldBootstrap.hmuxBuildId !== hmuxBuildId
    ) {
      throw new Error("queued deploy cold bootstrap Hmux build cannot change");
    }
    if (coldBootstrap.hmuxBuildId !== undefined) return current;
    const previousColdBootstrap = current.lastAttempt?.coldBootstrap;
    const previousCarriesSubmission = Boolean(
      previousColdBootstrap?.operationId === coldBootstrap.operationId &&
        previousColdBootstrap.initialRows === coldBootstrap.initialRows &&
        previousColdBootstrap.initialColumns ===
          coldBootstrap.initialColumns &&
        previousColdBootstrap.submittedAtMs === coldBootstrap.submittedAtMs &&
        JSON.stringify(previousColdBootstrap.command) ===
          JSON.stringify(coldBootstrap.command) &&
        previousColdBootstrap.hmuxBuildId === undefined,
    );
    return {
      ...current,
      ...(previousCarriesSubmission
        ? {
            lastAttempt: {
              ...current.lastAttempt,
              coldBootstrap: {
                ...previousColdBootstrap,
                hmuxBuildId,
              },
            },
          }
        : {}),
      activeAttempt: {
        ...current.activeAttempt,
        coldBootstrap: { ...coldBootstrap, hmuxBuildId },
      },
    };
  }
  if (current.activeAttempt.phase?.kind !== "target_applied") {
    throw new Error("queued deploy cold bootstrap target is not applied");
  }
  const submittedAtMs = requireTimestamp(
    input.submittedAtMs,
    "cold bootstrap submittedAtMs",
  );
  if (submittedAtMs < current.activeAttempt.startedAtMs) {
    throw new Error("cold bootstrap submission predates its deploy attempt");
  }
  return {
    ...current,
    activeAttempt: {
      ...current.activeAttempt,
      coldBootstrap: {
        ...coldBootstrap,
        submittedAtMs,
        command,
        hmuxBuildId,
      },
    },
  };
}

export function recordDevDeployAttemptResult(state, input) {
  const current = exactActiveAttempt(state, input);
  if (!current.activeAttempt.executor) {
    throw new Error("queued deploy attempt has no attached executor");
  }
  if (!Number.isInteger(input.exitCode)) {
    throw new Error("queued deploy result exit code is invalid");
  }
  const result = {
    completedAtMs: requireTimestamp(input.completedAtMs, "result completedAtMs"),
    exitCode: input.exitCode,
    ...(input.receipt ? { receipt: input.receipt } : {}),
    ...(boundedText(input.stderr) ? { stderr: boundedText(input.stderr) } : {}),
  };
  const existing = current.activeAttempt.result;
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(result)) {
      throw new Error("queued deploy attempt already has another result");
    }
    return current;
  }
  return {
    ...current,
    activeAttempt: { ...current.activeAttempt, result },
  };
}

function attemptReceipt({
  activeAttempt,
  exitCode,
  receipt,
  stderr,
  nowMs,
}) {
  const durableIdentity = ATTEMPT_ID.test(activeAttempt.attemptId ?? "");
  return {
    generation: activeAttempt.generation,
    ...(durableIdentity
      ? {
          attemptId: activeAttempt.attemptId,
          startedAtMs: activeAttempt.startedAtMs,
        }
      : {}),
    transaction: activeAttempt.transaction,
    completedAtMs: activeAttempt.result?.completedAtMs ?? nowMs,
    exitCode,
    ...(durableIdentity && activeAttempt.executor
      ? { executor: activeAttempt.executor }
      : {}),
    ...(durableIdentity && activeAttempt.phase
      ? { phase: activeAttempt.phase }
      : {}),
    ...(durableIdentity && activeAttempt.coldBootstrap
      ? { coldBootstrap: activeAttempt.coldBootstrap }
      : {}),
    ...(durableIdentity &&
    activeAttempt.coldBootstrapRetirementAcknowledgement
      ? {
          coldBootstrapRetirementAcknowledgement:
            activeAttempt.coldBootstrapRetirementAcknowledgement,
        }
      : {}),
    ...(receipt ? { receipt } : {}),
    ...(boundedText(stderr) ? { stderr: boundedText(stderr) } : {}),
  };
}

function completedColdBootstrapRetirement(current, receipt, settlementProof) {
  const coldBootstrap = current.activeAttempt?.coldBootstrap;
  const transition = receipt?.plannedTransition;
  const proof = transition?.receipt;
  if (
    settlementProof.kind !== "defer" ||
    !coldBootstrap?.submittedAtMs ||
    coldBootstrap.operationId !== current.request.coldBootstrapOperationId ||
    transition?.kind !== "cold_bootstrap" ||
    transition.state !== "pending" ||
    transition.hmuxOutcome !== "retired" ||
    transition.destructiveBoundaryCrossed !== true ||
    transition.relaunchDispatched !== false ||
    proof?.schemaVersion !== 1 ||
    proof.type !== "cold_bootstrap_target_retired" ||
    !/^[a-f0-9]{32}$/.test(proof.requestGeneration ?? "")
  ) {
    return false;
  }
  try {
    const { channel } = worktreeDevIdentity(current.worktree);
    return parseDevHmuxStandaloneRetirement(proof.hmux, {
      operationId: coldBootstrap.operationId,
      sessionName: coldBootstrapSessionName({
        root: current.worktree,
        channel,
        operationId: coldBootstrap.operationId,
      }),
    });
  } catch {
    return undefined;
  }
}

function completedColdBootstrapRetirementAcknowledgement(
  current,
  receipt,
  settlementProof,
) {
  const acknowledgement =
    current.activeAttempt?.coldBootstrapRetirementAcknowledgement;
  const transition = receipt?.plannedTransition;
  const proof = transition?.receipt;
  if (
    settlementProof.kind !== "defer" ||
    !acknowledgement ||
    transition?.kind !== "cold_bootstrap_retirement_acknowledgement" ||
    transition.state !== "converged" ||
    transition.attempted !== true ||
    transition.destructiveBoundaryCrossed !== true ||
    transition.acknowledgementDispatched !== true ||
    transition.hmuxOutcome !== "acknowledged" ||
    proof?.schemaVersion !== 1 ||
    proof.type !== "cold_bootstrap_retirement_acknowledged" ||
    !/^[a-f0-9]{32}$/.test(proof.requestGeneration ?? "")
  ) {
    return undefined;
  }
  try {
    return parseDevHmuxStandaloneAcknowledgement(proof.hmux, {
      operationId: acknowledgement.operationId,
    });
  } catch {
    return undefined;
  }
}

function deployAttemptFailure(receipt, stderr, exitCode) {
  return {
    code: "deploy_attempt_failed",
    reason:
      boundedText(receipt?.verification?.reason) ??
      boundedText(receipt?.reason) ??
      boundedText(stderr) ??
      `deploy attempt exited ${exitCode}`,
  };
}

function invalidDeployReceiptFailure() {
  return {
    code: "invalid_deploy_receipt",
    reason: "deploy attempt did not return deploy, skip, or defer",
  };
}

function unverifiedDeployReceiptFailure() {
  return {
    code: "unverified_deploy_receipt",
    reason: "deploy receipt lacks the activation evidence required by its impact",
  };
}

function unverifiedSkipReceiptFailure() {
  return {
    code: "unverified_skip_receipt",
    reason:
      "skip did not prove the exact target's required live activation state",
  };
}

export function settleDevDeployAttempt(
  state,
  {
    attemptGeneration,
    exitCode,
    receipt,
    stderr,
    settlementFailure,
    nowMs = Date.now(),
    pollMs,
  },
) {
  const current = parseQueuedDeployState(state);
  requireTimestamp(nowMs, "nowMs");
  requirePositiveDuration(pollMs, "pollMs");
  if (!Number.isSafeInteger(attemptGeneration) || attemptGeneration < 1) {
    throw new Error("attempt generation is invalid");
  }
  if (!Number.isInteger(exitCode)) {
    throw new Error("attempt exit code is invalid");
  }
  if (
    settlementFailure !== undefined &&
    (!settlementFailure ||
      typeof settlementFailure !== "object" ||
      typeof settlementFailure.code !== "string" ||
      !settlementFailure.code ||
      typeof settlementFailure.reason !== "string" ||
      !settlementFailure.reason)
  ) {
    throw new Error("attempt settlement failure is invalid");
  }
  if (current.status === DEV_DEPLOY_QUEUE_STATUS.CANCELED) return current;
  if (current.status !== DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING) {
    throw new Error(`cannot settle deploy from ${current.status}`);
  }
  if (current.activeAttempt.generation !== attemptGeneration) {
    throw new Error("attempt generation does not match the active transaction");
  }
  const attemptedTransaction = current.activeAttempt.transaction;
  const lastAttempt = attemptReceipt({
    activeAttempt: current.activeAttempt,
    exitCode,
    receipt,
    stderr,
    nowMs,
  });
  const settlementProof = reduceDevDeploySettlementProof({
    receipt,
    worktree: current.worktree,
    transaction: attemptedTransaction,
    reconciliationRequest: current.request.reconciliation,
    priorFailure: current.priorFailure,
  });
  const acceptedSettlementProof =
    exitCode === 0 && !settlementFailure
      ? settlementProof
      : { kind: "invalid_receipt" };
  const predecessorRetired = completedColdBootstrapRetirement(
    current,
    receipt,
    acceptedSettlementProof,
  );
  const predecessorAcknowledged =
    completedColdBootstrapRetirementAcknowledgement(
      current,
      receipt,
      acceptedSettlementProof,
    );
  const predecessorRefused = coldBootstrapWasRefused(
    { ...current, lastAttempt },
    current.request.coldBootstrapOperationId,
  );
  const submittedSettlementAccepted =
    exitCode === 0 &&
    !settlementFailure &&
    (settlementProof.kind === "defer" ||
      settlementProof.kind === "deployment" ||
      settlementProof.kind === "parent_reconciliation");
  const acknowledgementRefused =
    current.activeAttempt?.coldBootstrapRetirementAcknowledgement &&
    receipt?.plannedTransition?.kind ===
      "cold_bootstrap_retirement_acknowledgement" &&
    receipt.plannedTransition.hmuxOutcome === "refused";
  if (
    (current.activeAttempt?.coldBootstrapRetirementAcknowledgement &&
      !predecessorAcknowledged &&
      !acknowledgementRefused) ||
    (unresolvedSubmittedColdBootstrap(current) &&
      !predecessorRetired &&
      !predecessorRefused &&
      !submittedSettlementAccepted)
  ) {
    return pendingInterruptedAttempt(
      current,
      current.activeAttempt,
      {
        code: "cold_bootstrap_settlement_pending",
        reason:
          "the submitted cold-bootstrap operation has no exact terminal settlement and must be reconciled",
      },
      lastAttempt,
      nowMs,
      pollMs,
    );
  }
  const transactionMatches =
    settlementProof.kind !== "transaction_mismatch";
  const transactionMismatchFailure = {
    code: "deploy_transaction_mismatch",
    reason:
      "deploy receipt does not match the attempted target and executor generation",
  };
  const desiredTransactionMatchesAttempt = sameDevDeployTransaction(
    current.request.transaction,
    attemptedTransaction,
  );
  if (
    !transactionMatches &&
    current.generation !== attemptGeneration
  ) {
    return {
      ...current,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      nextAttemptAtMs: nowMs + pollMs,
      lastAttempt,
      activeAttempt: undefined,
      priorFailure: {
        failure: transactionMismatchFailure,
        ...(receipt ? { receipt } : {}),
        transaction: attemptedTransaction,
      },
    };
  }
  if (!transactionMatches) {
    return {
      ...current,
      status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
      completedAtMs: nowMs,
      failure: transactionMismatchFailure,
      lastAttempt,
      activeAttempt: undefined,
    };
  }
  const successorOperation = predecessorRetired
    ? createColdBootstrapOperation()
    : undefined;
  const observedState = {
    ...current,
    ...(predecessorRetired
      ? {
          firstQueuedAtMs: nowMs,
          requestedAtMs: nowMs,
          expiresAtMs:
            nowMs + (current.expiresAtMs - current.firstQueuedAtMs),
        }
      : {}),
    request: (() => {
      const request = {
        ...current.request,
        ...(successorOperation
          ? {
              coldBootstrapOperationId: successorOperation.operationId,
              coldBootstrapInitialRows: successorOperation.initialRows,
              coldBootstrapInitialColumns: successorOperation.initialColumns,
              coldBootstrapRetirementAcknowledgement: {
                operationId: predecessorRetired.operationId,
                sessionName: predecessorRetired.sessionName,
                command: current.activeAttempt.coldBootstrap.command,
                ...(current.activeAttempt.coldBootstrap.hmuxBuildId === undefined
                  ? {}
                  : {
                      hmuxBuildId:
                        current.activeAttempt.coldBootstrap.hmuxBuildId,
                    }),
                initialRows: current.activeAttempt.coldBootstrap.initialRows,
                initialColumns:
                  current.activeAttempt.coldBootstrap.initialColumns,
                retirement: predecessorRetired,
              },
            }
          : {}),
        transaction:
          desiredTransactionMatchesAttempt && settlementProof.transaction
            ? settlementProof.transaction
            : current.request.transaction,
        observed: observedRequest(receipt, current.request.observed),
      };
      if (predecessorAcknowledged) {
        delete request.coldBootstrapRetirementAcknowledgement;
      }
      return request;
    })(),
  };
  const requestAfterSettlement = ({
    request,
    priorFailure,
    deployed,
  }) =>
    requestWithParentReconciliation(
      request,
      parentReconciliationAfter({
        request,
        priorFailure,
        deployed,
        receipt,
        settlementProof: acceptedSettlementProof,
      }),
    );
  if (
    current.generation !== attemptGeneration &&
    !desiredTransactionMatchesAttempt
  ) {
    const supersedingRequest = { ...current.request };
    if (predecessorAcknowledged) {
      delete supersedingRequest.coldBootstrapRetirementAcknowledgement;
    }
    let priorFailure = current.priorFailure;
    if (exitCode !== 0 || settlementFailure) {
      priorFailure = {
        failure:
          settlementFailure ?? deployAttemptFailure(receipt, stderr, exitCode),
        ...(receipt ? { receipt } : {}),
        transaction: attemptedTransaction,
      };
    } else if (
      settlementProof.kind === "deployment" ||
      settlementProof.kind === "parent_reconciliation"
    ) {
      priorFailure = undefined;
    } else if (settlementProof.kind === "unverified_deployment") {
      priorFailure = {
        failure: unverifiedDeployReceiptFailure(),
        receipt,
        transaction: attemptedTransaction,
      };
    } else if (settlementProof.kind === "unverified_skip") {
      priorFailure = {
        failure: unverifiedSkipReceiptFailure(),
        receipt,
        transaction: attemptedTransaction,
      };
    } else if (settlementProof.kind === "invalid_receipt") {
      priorFailure = {
        failure: invalidDeployReceiptFailure(),
        ...(receipt ? { receipt } : {}),
        transaction: attemptedTransaction,
      };
    }
    const projection = settledDeploymentProjection({
      request: supersedingRequest,
      priorFailure,
      previousDeployment: current.lastSuccessfulDeployment,
      receipt,
      settledAtMs: nowMs,
      settlementProof: acceptedSettlementProof,
    });
    return {
      ...current,
      request: projection.request,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      nextAttemptAtMs: nowMs + pollMs,
      lastAttempt,
      activeAttempt: undefined,
      priorFailure: projection.priorFailure,
      ...(projection.deployed
        ? { lastSuccessfulDeployment: projection.deployed }
        : {}),
    };
  }
  if (exitCode !== 0 || settlementFailure) {
    const priorFailure = {
      failure:
        settlementFailure ?? deployAttemptFailure(receipt, stderr, exitCode),
      ...(receipt ? { receipt } : {}),
    };
    return {
      ...observedState,
      request: requestAfterSettlement({
        request: observedState.request,
        priorFailure,
        deployed: observedState.lastSuccessfulDeployment,
      }),
      status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
      completedAtMs: nowMs,
      failure: priorFailure.failure,
      lastAttempt,
      activeAttempt: undefined,
    };
  }
  if (receipt?.action === "defer") {
    return {
      ...observedState,
      request: requestAfterSettlement({
        request: observedState.request,
        priorFailure: observedState.priorFailure,
        deployed: observedState.lastSuccessfulDeployment,
      }),
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      nextAttemptAtMs: nowMs + pollMs,
      lastAttempt,
      activeAttempt: undefined,
    };
  }
  if (receipt?.action === "deploy" || receipt?.action === "skip") {
    if (
      receipt.action === "deploy" &&
      settlementProof.kind !== "deployment"
    ) {
      const priorFailure = {
        failure: unverifiedDeployReceiptFailure(),
        receipt,
      };
      return {
        ...observedState,
        request: requestAfterSettlement({
          request: observedState.request,
          priorFailure,
          deployed: observedState.lastSuccessfulDeployment,
        }),
        status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
        completedAtMs: nowMs,
        failure: priorFailure.failure,
        lastAttempt,
        activeAttempt: undefined,
      };
    }
    const reconciliationRequest = observedState.request.reconciliation;
    const projection = settledDeploymentProjection({
      request: observedState.request,
      priorFailure: observedState.priorFailure,
      previousDeployment: observedState.lastSuccessfulDeployment,
      receipt,
      settledAtMs: nowMs,
      settlementProof,
    });
    if (
      reconciliationRequest &&
      receipt.action === "deploy" &&
      projection.request.reconciliation
    ) {
      return {
        ...observedState,
        request: projection.request,
        status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
        nextAttemptAtMs: nowMs,
        lastAttempt,
        activeAttempt: undefined,
        priorFailure: projection.priorFailure,
        ...(projection.deployed
          ? { lastSuccessfulDeployment: projection.deployed }
          : {}),
      };
    }
    if (
      reconciliationRequest &&
      receipt.action === "skip" &&
      !projection.parentReconciliation &&
      settlementProof.kind !== "deployment"
    ) {
      return {
        ...observedState,
        request: projection.request,
        status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
        completedAtMs: nowMs,
        failure: {
          code: "unverified_parent_reconciliation",
          reason:
            "the exact target parent, app runtime, and server generation were not proven",
        },
        lastAttempt,
        activeAttempt: undefined,
      };
    }
    if (
      !projection.parentReconciliation &&
      observedState.priorFailure &&
      settlementProof.kind !== "deployment"
    ) {
      return {
        ...observedState,
        request: projection.request,
        status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
        completedAtMs: nowMs,
        failure: {
          code: "prior_deploy_failure_unresolved",
          reason:
            "the worktree is current but the prior deploy failure still requires recovery",
        },
        lastAttempt,
        activeAttempt: undefined,
      };
    }
    if (
      receipt.action === "skip" &&
      !projection.parentReconciliation &&
      settlementProof.kind !== "deployment"
    ) {
      return {
        ...observedState,
        request: projection.request,
        status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
        completedAtMs: nowMs,
        failure: unverifiedSkipReceiptFailure(),
        lastAttempt,
        activeAttempt: undefined,
      };
    }
    return {
      ...observedState,
      request: projection.request,
      status: DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
      completedAtMs: nowMs,
      finalReceipt: receipt,
      lastAttempt,
      activeAttempt: undefined,
      priorFailure: projection.priorFailure,
      ...(projection.deployed
        ? { lastSuccessfulDeployment: projection.deployed }
        : {}),
    };
  }
  return {
    ...observedState,
    request: requestAfterSettlement({
      request: observedState.request,
      priorFailure: {
        failure: invalidDeployReceiptFailure(),
        ...(receipt ? { receipt } : {}),
      },
      deployed: observedState.lastSuccessfulDeployment,
    }),
    status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
    completedAtMs: nowMs,
    failure: invalidDeployReceiptFailure(),
    lastAttempt,
    activeAttempt: undefined,
  };
}

function interruptedAttemptEvidence(activeAttempt) {
  return {
    ...(activeAttempt.attemptId
      ? { attemptId: activeAttempt.attemptId }
      : {}),
    ...(activeAttempt.executor
      ? { executor: activeAttempt.executor }
      : {}),
    ...(activeAttempt.phase ? { phase: activeAttempt.phase } : {}),
    ...(activeAttempt.coldBootstrap
      ? { coldBootstrap: activeAttempt.coldBootstrap }
      : {}),
    ...(activeAttempt.coldBootstrapRetirementAcknowledgement
      ? {
          coldBootstrapRetirementAcknowledgement:
            activeAttempt.coldBootstrapRetirementAcknowledgement,
        }
      : {}),
  };
}

function interruptedAttemptRecord(activeAttempt, nowMs) {
  const result = activeAttempt.result;
  const evidence = interruptedAttemptEvidence(activeAttempt);
  return {
    ...attemptReceipt({
      activeAttempt,
      nowMs: result?.completedAtMs ?? nowMs,
      exitCode: result?.exitCode ?? 1,
      receipt: result?.receipt,
      stderr: result?.stderr,
    }),
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
  };
}

function pendingInterruptedAttempt(
  current,
  activeAttempt,
  failure,
  lastAttempt,
  nowMs,
  pollMs,
) {
  const evidence = lastAttempt.evidence;
  return {
    ...current,
    status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
    nextAttemptAtMs: nowMs + pollMs,
    lastAttempt,
    activeAttempt: undefined,
    priorFailure: {
      failure,
      transaction: activeAttempt.transaction,
      ...(evidence ? { evidence } : {}),
    },
  };
}

function interruptedDevDeployAttempt(current, nowMs, pollMs) {
  const failure = {
    code: "deploy_attempt_interrupted",
    reason:
      "the runner disappeared during a deploy attempt; inspect the live app before retrying",
  };
  const activeAttempt = current.activeAttempt;
  const lastAttempt = interruptedAttemptRecord(activeAttempt, nowMs);
  if (protectedColdBootstrapLifecycle(current)) {
    return pendingInterruptedAttempt(
      current,
      activeAttempt,
      failure,
      lastAttempt,
      nowMs,
      pollMs,
    );
  }
  if (
    current.generation !== activeAttempt.generation &&
    !sameDevDeployTransaction(
      current.request.transaction,
      activeAttempt.transaction,
    )
  ) {
    return pendingInterruptedAttempt(
      current,
      activeAttempt,
      failure,
      lastAttempt,
      nowMs,
      pollMs,
    );
  }
  return {
    ...current,
    status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
    completedAtMs: nowMs,
    failure,
    lastAttempt,
    activeAttempt: undefined,
  };
}

function sameRuntimeAuthority(expected, observed) {
  return Boolean(
    expected?.generation &&
      observed?.generation &&
      expected.pid === observed.pid &&
      expected.processIdentity === observed.processIdentity &&
      expected.generation === observed.generation &&
      (expected.buildId === undefined || expected.buildId === observed.buildId),
  );
}

function sameParentAuthority(expected, observed) {
  return Boolean(
    expected &&
      observed &&
      expected.sourceGeneration === observed.sourceGeneration &&
      sameDevLaunchIdentity(expected.supervisor, observed.supervisor) &&
      sameDevLaunchIdentity(expected.launch, observed.launch) &&
      (expected.frontend === undefined ||
        sameDevLaunchIdentity(expected.frontend, observed.frontend)),
  );
}

function recoveredAttemptAuthorityFailure(activeAttempt, authority) {
  const expectedAttempt = {
    attemptId: activeAttempt.attemptId,
    generation: activeAttempt.generation,
    targetHead: activeAttempt.transaction.targetHead,
    executorGeneration: activeAttempt.transaction.executor.generation,
  };
  const observedAttempt = authority?.queuedAttempt;
  return !observedAttempt ||
    observedAttempt.attemptId !== expectedAttempt.attemptId ||
    observedAttempt.generation !== expectedAttempt.generation ||
    observedAttempt.targetHead !== expectedAttempt.targetHead ||
    observedAttempt.executorGeneration !== expectedAttempt.executorGeneration
    ? "the authority snapshot was not serialized for the exact attempt"
    : null;
}

function receiptlessAttemptRecoveryFailure(current, authority, nowMs) {
  const activeAttempt = current.activeAttempt;
  const bindingFailure = recoveredAttemptAuthorityFailure(
    activeAttempt,
    authority,
  );
  if (bindingFailure) return bindingFailure;
  if (
    current.generation !== activeAttempt.generation ||
    !sameDevDeployTransaction(
      current.request.transaction,
      activeAttempt.transaction,
    )
  ) {
    return "the interrupted attempt is not the current desired generation";
  }
  if (activeAttempt.coldBootstrapRetirementAcknowledgement) return null;
  if (
    current.request.attemptArgs.includes("--adopt-integrated-target") ||
    current.request.attemptArgs.includes("--retire-preserved-live-head")
  ) {
    return "an explicit head transition cannot be replayed without its durable receipt";
  }
  const selection = activeAttempt.transaction.selection;
  if (!selection) {
    return "the interrupted attempt has no exact pre-deploy checkout selection";
  }
  if (
    authority.currentHead !== selection.sourceHead &&
    authority.currentHead !== activeAttempt.transaction.targetHead
  ) {
    return "the live checkout matches neither side of the interrupted fast-forward";
  }
  if (
    activeAttempt.phase &&
    authority.currentHead !== activeAttempt.transaction.targetHead
  ) {
    return "the live checkout does not match the recorded target-applied phase";
  }
  if (unresolvedSubmittedColdBootstrap(current)) return null;
  if (nowMs >= current.expiresAtMs) {
    return "the interrupted attempt reached its absolute retry deadline";
  }
  const devChain = authority.devChain;
  if (
    devChain?.state !== "absent" ||
    devChain.worktreeRoot !== current.worktree ||
    !Number.isSafeInteger(devChain.port) ||
    devChain.port < 1 ||
    devChain.port > 65_535 ||
    !Number.isSafeInteger(devChain.observedAtMs) ||
    devChain.observedAtMs < activeAttempt.startedAtMs ||
    devChain.observedAtMs > nowMs
  ) {
    return "the exact live dev chain was not proven absent after the attempt began";
  }
  return null;
}

function recoveredDeploymentAuthorityFailure(activeAttempt, settled, authority) {
  const bindingFailure = recoveredAttemptAuthorityFailure(
    activeAttempt,
    authority,
  );
  if (bindingFailure) return bindingFailure;
  const deployed = lastSuccessfulDeploymentFor(settled);
  if (!deployed || deployed.sourceHead !== authority.currentHead) {
    return "the live checkout no longer matches the completed attempt target";
  }
  if (!sameRuntimeAuthority(deployed.runtime, authority.runtime)) {
    return "the current app descriptor does not match the completed attempt runtime generation";
  }
  if (!authority.parentGeneration) {
    return "the current parent endpoint did not prove an authenticated generation";
  }
  if (
    deployed.parentGeneration &&
    !sameParentAuthority(
      deployed.parentGeneration,
      authority.parentGeneration,
    )
  ) {
    return "the current parent descriptor does not match the completed attempt generation";
  }
  return null;
}

export function reconcileDevDeployAttempt(
  state,
  {
    executorLiveness,
    authority,
    nowMs = Date.now(),
    pollMs,
  },
) {
  const current = parseQueuedDeployState(state);
  requireTimestamp(nowMs, "nowMs");
  requirePositiveDuration(pollMs, "pollMs");
  if (current.status !== DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING) return current;
  if (current.schemaVersion !== DEV_DEPLOY_QUEUE_SCHEMA_VERSION) {
    return interruptedDevDeployAttempt(current, nowMs, pollMs);
  }
  if (executorLiveness !== "stale") return current;
  const result = current.activeAttempt.result;
  if (!result) {
    if (!receiptlessAttemptRecoveryFailure(current, authority, nowMs)) {
      return pendingInterruptedAttempt(
        current,
        current.activeAttempt,
        {
          code: "deploy_attempt_interrupted",
          reason:
            "the exact executor disappeared; checkout and dev-chain absence were proven before bounded same-generation retry",
        },
        interruptedAttemptRecord(current.activeAttempt, nowMs),
        nowMs,
        pollMs,
      );
    }
    return interruptedDevDeployAttempt(current, nowMs, pollMs);
  }
  const settlementProof = reduceDevDeploySettlementProof({
    receipt: result.receipt,
    worktree: current.worktree,
    transaction: current.activeAttempt.transaction,
    reconciliationRequest: current.request.reconciliation,
    priorFailure: current.priorFailure,
  });
  const settled = settleDevDeployAttempt(current, {
    attemptGeneration: current.activeAttempt.generation,
    exitCode: result.exitCode,
    receipt: result.receipt,
    stderr: result.stderr,
    nowMs,
    pollMs,
  });
  if (
    result.exitCode !== 0 ||
    (settlementProof.kind !== "deployment" &&
      settlementProof.kind !== "parent_reconciliation")
  ) {
    return settled;
  }
  if (settlementProof.authority === "application") return settled;
  const authorityFailure = recoveredDeploymentAuthorityFailure(
    current.activeAttempt,
    settled,
    authority,
  );
  return authorityFailure
    ? settleDevDeployAttempt(current, {
        attemptGeneration: current.activeAttempt.generation,
        exitCode: result.exitCode,
        receipt: result.receipt,
        stderr: result.stderr,
        settlementFailure: {
          code: "deploy_attempt_recovery_authority_mismatch",
          reason: authorityFailure,
        },
        nowMs,
        pollMs,
      })
    : settled;
}

export function expireDevDeploy(state, nowMs = Date.now()) {
  const current = parseQueuedDeployState(state);
  requireTimestamp(nowMs, "nowMs");
  if (!isActiveQueuedDeploy(current)) return current;
  if (current.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING) {
    throw new Error("cannot expire an in-flight deploy attempt");
  }
  if (protectedColdBootstrapLifecycle(current)) {
    throw new Error("cannot expire unresolved cold-bootstrap lifecycle work");
  }
  return {
    ...current,
    status: DEV_DEPLOY_QUEUE_STATUS.EXPIRED,
    completedAtMs: nowMs,
    failure: {
      code: "deploy_wait_expired",
      reason: "the deferred deploy never reached a safe idle boundary",
    },
  };
}

export function cancelDevDeploy(state, nowMs = Date.now()) {
  const current = parseQueuedDeployState(state);
  requireTimestamp(nowMs, "nowMs");
  if (current.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING) {
    throw new Error("cannot cancel a deploy attempt after it has started");
  }
  if (current.status !== DEV_DEPLOY_QUEUE_STATUS.PENDING) return current;
  if (protectedColdBootstrapLifecycle(current)) {
    throw new Error("cannot cancel unresolved cold-bootstrap lifecycle work");
  }
  return {
    ...current,
    status: DEV_DEPLOY_QUEUE_STATUS.CANCELED,
    completedAtMs: nowMs,
    failure: {
      code: "deploy_canceled",
      reason: "the pending deploy was canceled before execution",
    },
  };
}
