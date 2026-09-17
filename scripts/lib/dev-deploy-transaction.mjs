import { basename, dirname, isAbsolute, resolve } from "node:path";

export const DEV_DEPLOY_TRANSACTION_SCHEMA_VERSION = 1;
export const DEV_DEPLOY_APPLICATION_RECEIPT_VERSION = 3;

const TARGET_AUTHORITIES = new Set([
  "origin/main",
  "exact-local-candidate",
]);
const IMPACT_KINDS = new Set([
  "frontend_reload",
  "backend_rebuild",
  "child_restart",
  "parent_reload",
]);
const PARENT_STRATEGIES = new Set(["exec_handoff", "cold_bootstrap"]);
const CONTENT_GENERATION = /^[0-9a-f]{64}$/;
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const APPLICATION_RECEIPT_VERSIONS = new Set([
  2,
  DEV_DEPLOY_APPLICATION_RECEIPT_VERSION,
]);

export function isDevDeployApplicationReceiptVersion(value) {
  return APPLICATION_RECEIPT_VERSIONS.has(value);
}

export function parseDevDeployExecutorGeneration(
  value,
  label = "dev deploy executor generation",
) {
  if (!CONTENT_GENERATION.test(value ?? "")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function parseDevDeployExecutor(
  value,
  label = "dev deploy executor",
) {
  const entrypoint =
    typeof value?.entrypoint === "string"
      ? resolve(value.entrypoint)
      : undefined;
  const scriptsDirectory = entrypoint ? dirname(entrypoint) : undefined;
  const generationDirectory = scriptsDirectory
    ? dirname(scriptsDirectory)
    : undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !CONTENT_GENERATION.test(value.generation ?? "") ||
    typeof value.entrypoint !== "string" ||
    /[\0\r\n]/.test(value.entrypoint) ||
    !isAbsolute(value.entrypoint) ||
    entrypoint !== value.entrypoint ||
    basename(entrypoint) !== "deploy-dev-app.mjs" ||
    basename(scriptsDirectory) !== "scripts" ||
    basename(generationDirectory) !== value.generation ||
    basename(dirname(generationDirectory)) !== "executors-v1"
  ) {
    throw new Error(`${label} is invalid`);
  }
  return {
    generation: parseDevDeployExecutorGeneration(
      value.generation,
      `${label} generation`,
    ),
    entrypoint,
  };
}

function boundedText(value, label, limit = 4_096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > limit ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function parseDevDeployImpact(value, label = "deploy impact") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !IMPACT_KINDS.has(value.kind) ||
    typeof value.backendChanged !== "boolean" ||
    !Number.isSafeInteger(value.changedPathCount) ||
    value.changedPathCount < 0
  ) {
    throw new Error(`${label} is invalid`);
  }
  if (
    value.kind === "parent_reload" &&
    !PARENT_STRATEGIES.has(value.parentStrategy)
  ) {
    throw new Error(`${label} parent strategy is invalid`);
  }
  if (
    value.kind !== "parent_reload" &&
    (value.parentStrategy !== undefined ||
      value.childRestartRequired !== undefined)
  ) {
    throw new Error(`${label} has unexpected parent lifecycle fields`);
  }
  if (
    value.childRestartRequired !== undefined &&
    typeof value.childRestartRequired !== "boolean"
  ) {
    throw new Error(`${label} child restart requirement is invalid`);
  }
  if (
    value.hmuxRuntimeChanged !== undefined &&
    typeof value.hmuxRuntimeChanged !== "boolean"
  ) {
    throw new Error(`${label} Hmux runtime requirement is invalid`);
  }
  if (
    value.controlPlanePayloadChanged !== undefined &&
    typeof value.controlPlanePayloadChanged !== "boolean"
  ) {
    throw new Error(`${label} control-plane payload requirement is invalid`);
  }
  return {
    kind: value.kind,
    backendChanged: value.backendChanged,
    changedPathCount: value.changedPathCount,
    ...(value.hmuxRuntimeChanged === true
      ? { hmuxRuntimeChanged: true }
      : {}),
    ...(value.controlPlanePayloadChanged === true
      ? { controlPlanePayloadChanged: true }
      : {}),
    ...(value.parentStrategy ? { parentStrategy: value.parentStrategy } : {}),
    ...(value.childRestartRequired === true
      ? { childRestartRequired: true }
      : {}),
  };
}

export function parseDevDeployTransaction(
  value,
  label = "deploy transaction",
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_DEPLOY_TRANSACTION_SCHEMA_VERSION ||
    !TARGET_AUTHORITIES.has(value.targetAuthority)
  ) {
    throw new Error(`${label} is invalid`);
  }
  const targetHead = boundedText(value.targetHead, `${label} target head`, 256);
  if (!FULL_COMMIT_SHA.test(targetHead)) {
    throw new Error(`${label} target head is not an exact commit identity`);
  }
  const executor = parseDevDeployExecutor(value.executor, `${label} executor`);
  let selection;
  if (value.selection !== undefined) {
    if (
      !value.selection ||
      typeof value.selection !== "object" ||
      Array.isArray(value.selection)
    ) {
      throw new Error(`${label} selection is invalid`);
    }
    selection = {
      sourceHead: boundedText(
        value.selection.sourceHead,
        `${label} source head`,
        256,
      ),
      impact: parseDevDeployImpact(
        value.selection.impact,
        `${label} selected impact`,
      ),
    };
    if (!FULL_COMMIT_SHA.test(selection.sourceHead)) {
      throw new Error(`${label} source head is not an exact commit identity`);
    }
  }
  return {
    schemaVersion: DEV_DEPLOY_TRANSACTION_SCHEMA_VERSION,
    targetHead,
    targetAuthority: value.targetAuthority,
    executor,
    ...(selection ? { selection } : {}),
  };
}

export function newDevDeployTransaction({
  targetHead,
  targetAuthority,
  executor,
  selection,
}) {
  return parseDevDeployTransaction({
    schemaVersion: DEV_DEPLOY_TRANSACTION_SCHEMA_VERSION,
    targetHead,
    targetAuthority,
    executor,
    ...(selection !== undefined ? { selection } : {}),
  });
}

export function sameDevDeployTransaction(left, right) {
  try {
    const expected = parseDevDeployTransaction(left, "expected transaction");
    const observed = parseDevDeployTransaction(right, "observed transaction");
    return JSON.stringify(expected) === JSON.stringify(observed);
  } catch {
    return false;
  }
}

function parseReceiptBinding(receipt, expected) {
  const observed = parseDevDeployTransaction(
    receipt?.transaction,
    "receipt deploy transaction",
  );
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error("receipt deploy transaction does not match the attempt");
  }
  if (
    receipt.targetAuthority !== undefined &&
    receipt.targetAuthority !== expected.targetAuthority
  ) {
    throw new Error("receipt target authority does not match the transaction");
  }
  if (receipt.action === "defer") {
    if (
      receipt.targetHead !== undefined &&
      receipt.targetHead !== expected.targetHead
    ) {
      throw new Error("defer receipt target does not match the transaction");
    }
    return { transaction: expected };
  }
  if (receipt?.targetHead !== expected.targetHead) {
    throw new Error("receipt target does not match the deploy transaction");
  }
  if (receipt.action === "skip" && receipt.currentHead !== expected.targetHead) {
    throw new Error("skip receipt is not current at the transaction target");
  }
  let impact;
  const legacyParentReconciliation =
    !isDevDeployApplicationReceiptVersion(receipt.deployReceiptVersion) &&
    receipt.action === "skip" &&
    receipt.reconciliation?.kind === "parent_generation" &&
    receipt.reconciliation.targetHead === expected.targetHead;
  const appliedTargetSkip =
    receipt.action === "skip" &&
    isDevDeployApplicationReceiptVersion(receipt.deployReceiptVersion);
  if (expected.selection && !legacyParentReconciliation) {
    impact = parseDevDeployImpact(receipt.impact);
    if (
      (!appliedTargetSkip &&
        receipt.currentHead !== expected.selection.sourceHead) ||
      JSON.stringify(impact) !== JSON.stringify(expected.selection.impact)
    ) {
      throw new Error("receipt selection does not match the deploy transaction");
    }
  }
  return {
    transaction: expected,
    ...(impact ? { impact } : {}),
  };
}

export function parseDevDeployReceiptBinding(receipt, transaction) {
  return parseReceiptBinding(
    receipt,
    parseDevDeployTransaction(transaction, "expected deploy transaction"),
  );
}

export function bindParsedDevDeployTransactionSelection(
  transaction,
  receipt,
  impact,
) {
  if (transaction.selection) return transaction;
  if (
    receipt?.targetHead !== transaction.targetHead ||
    typeof receipt.currentHead !== "string" ||
    receipt.currentHead.length === 0
  ) {
    return transaction;
  }
  try {
    return parseDevDeployTransaction({
      ...transaction,
      selection: {
        sourceHead: receipt.currentHead,
        impact,
      },
    });
  } catch {
    return transaction;
  }
}
