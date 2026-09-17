import { worktreeDevIdentity } from "./app-channel.mjs";
import { parseDevControlPlaneActivationProof } from "./dev-control-plane-activation.mjs";
import { parseDevHmuxActivationProof } from "./dev-hmux-tool.mjs";
import {
  parseDevLaunchGeneration,
  parseDevLaunchHmuxProviderIdentity,
  parseDevLaunchIdentity,
  parseDevLaunchRestartReceipt,
  parseDevLaunchV2Envelope,
  sameDevLaunchIdentity,
} from "./dev-launch-contract.mjs";
import {
  DEV_DEPLOY_APPLICATION_RECEIPT_VERSION,
  bindParsedDevDeployTransactionSelection,
  isDevDeployApplicationReceiptVersion,
  parseDevDeployReceiptBinding,
  parseDevDeployImpact,
} from "./dev-deploy-transaction.mjs";
import {
  devDeployRequiresChildRestart,
  devDeployRequiresControlPlaneActivation,
} from "./dev-launch-impact.mjs";

function boundedText(value, limit = 8_192) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, limit);
}

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer timestamp`);
  }
  return value;
}

function requireNonEmptyText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function deploymentRuntime(value, label = "deployment runtime") {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw new Error(`${label} pid is invalid`);
  }
  requireNonEmptyText(value.processIdentity, `${label} processIdentity`);
  requireTimestamp(value.observedAtMs, `${label} observedAtMs`);
  const buildId = boundedText(value.buildId, 256);
  const generation = boundedText(value.generation, 256);
  return {
    pid: value.pid,
    processIdentity: value.processIdentity,
    observedAtMs: value.observedAtMs,
    ...(buildId ? { buildId } : {}),
    ...(generation ? { generation } : {}),
  };
}

function exactApplicationRuntime(
  value,
  { channel, targetHead, activatedLaunch },
) {
  let runtime;
  let launch;
  try {
    runtime = deploymentRuntime(value);
    launch = parseDevLaunchIdentity(value?.launch, "deployment runtime launch");
  } catch {
    return null;
  }
  if (
    value?.state !== "ready" ||
    value.channel !== channel ||
    value.targetHead !== targetHead ||
    !runtime?.buildId ||
    runtime.buildId !== value.buildId ||
    !runtime.generation ||
    !runtime.buildId.endsWith(`+${targetHead.slice(0, 12)}`) ||
    !Number.isSafeInteger(value.startedAtUnixMs) ||
    value.startedAtUnixMs < 0 ||
    value.startedAtUnixMs > runtime.observedAtMs ||
    value.compatibility?.state !== "available" ||
    value.compatibility.mode !== "current" ||
    !sameDevLaunchIdentity(launch, activatedLaunch)
  ) {
    return null;
  }
  return {
    ...runtime,
    state: "ready",
    channel,
    targetHead,
    startedAtUnixMs: value.startedAtUnixMs,
    launch,
    compatibility: { state: "available", mode: "current" },
  };
}

export function successfulDeployment(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("last successful deployment is invalid");
  }
  requireNonEmptyText(value.sourceHead, "last successful sourceHead");
  if (value.backendHead !== undefined) {
    requireNonEmptyText(value.backendHead, "last successful backendHead");
  }
  if (value.controlPlaneActivation !== undefined) {
    parseDevControlPlaneActivationProof(
      value.controlPlaneActivation,
      value.backendHead,
      "last successful control-plane activation",
    );
  }
  if (value.hmuxActivation !== undefined) {
    parseDevHmuxActivationProof(
      value.hmuxActivation,
      {},
      "last successful Hmux activation",
    );
  }
  requireTimestamp(
    value.appliedAtMs ?? value.verifiedAtMs,
    "last successful settlement timestamp",
  );
  deploymentRuntime(value.runtime, "last successful runtime");
  deploymentParentGeneration(
    value.parentGeneration,
    "last successful parent generation",
  );
  return value;
}

export function parentReconciliationRequest(
  value,
  label = "parent reconciliation",
) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.kind !== "parent_generation" ||
    typeof value.targetHead !== "string" ||
    value.targetHead.length === 0 ||
    value.targetHead.length > 256
  ) {
    throw new Error(`${label} is invalid`);
  }
  return { kind: value.kind, targetHead: value.targetHead };
}

export function parentReconciliationAfter({
  request,
  priorFailure,
  deployed,
  observed,
  activationImpact,
  receipt,
  terminalReceipt,
  settlementProof,
}) {
  if (
    settlementProof?.kind === "deployment" &&
    settlementProof.authority === "application"
  ) {
    return undefined;
  }
  const failedReceipt = priorFailure?.receipt;
  const settlementImpact =
    settlementProof?.kind === "deployment"
      ? settlementProof.activation.impact
      : settlementProof?.transaction?.selection?.impact;
  const effectiveActivationImpact =
    settlementImpact ??
    activationImpact ??
    request?.transaction?.selection?.impact;
  let reconciliation;
  if (
    failedReceipt?.deployed === true &&
    (failedReceipt?.impact?.kind === "parent_reload" ||
      failedReceipt?.impact?.kind === "launcher_restart") &&
    typeof failedReceipt.targetHead === "string"
  ) {
    reconciliation = {
      kind: "parent_generation",
      targetHead: failedReceipt.targetHead,
    };
  } else if (request?.reconciliation) {
    reconciliation = parentReconciliationRequest(request.reconciliation);
  } else if (
    typeof observed?.currentHead === "string" &&
    observed.currentHead === observed.targetHead &&
    effectiveActivationImpact?.kind === "parent_reload" &&
    deployed?.sourceHead !== observed.currentHead
  ) {
    reconciliation = {
      kind: "parent_generation",
      targetHead: observed.currentHead,
    };
  }
  if (reconciliation && settlementProof?.kind === "parent_reconciliation") {
    return undefined;
  }
  if (settledParentGeneration(settlementProof)) {
    return undefined;
  }
  if (
    reconciliation &&
    receipt?.action === "deploy" &&
    receipt.deployed === true &&
    typeof receipt.targetHead === "string"
  ) {
    return { kind: "parent_generation", targetHead: receipt.targetHead };
  }
  const terminalSkipTarget =
    terminalReceipt?.action === "skip" &&
    typeof terminalReceipt.currentHead === "string" &&
    terminalReceipt.currentHead === terminalReceipt.targetHead
      ? terminalReceipt.targetHead
      : undefined;
  const parentFallbackAllowed =
    effectiveActivationImpact === undefined ||
    effectiveActivationImpact.kind === "parent_reload";
  if (
    !reconciliation &&
    parentFallbackAllowed &&
    terminalSkipTarget &&
    (deployed?.sourceHead !== terminalSkipTarget || !deployed.parentGeneration)
  ) {
    return { kind: "parent_generation", targetHead: terminalSkipTarget };
  }
  if (
    !reconciliation &&
    parentFallbackAllowed &&
    deployed?.sourceHead &&
    !deployed.parentGeneration
  ) {
    return { kind: "parent_generation", targetHead: deployed.sourceHead };
  }
  return reconciliation;
}

function settledParentGeneration(proof) {
  if (proof?.kind !== "deployment") return undefined;
  if (proof.activation.parentGeneration) {
    return proof.activation.parentGeneration;
  }
  const lifecycle = proof.activation.activation;
  const activatedGeneration = lifecycle?.activatedGeneration;
  if (
    !activatedGeneration ||
    (lifecycle.kind !== "parent_reload" && lifecycle.kind !== "cold_bootstrap")
  ) {
    return undefined;
  }
  return activatedGeneration;
}

export function requestWithParentReconciliation(request, reconciliation) {
  const next = { ...request };
  delete next.reconciliation;
  if (reconciliation) next.reconciliation = reconciliation;
  return next;
}

function sameProcessGeneration(left, right) {
  try {
    return sameDevLaunchIdentity(
      parseDevLaunchIdentity(left, "left process generation"),
      parseDevLaunchIdentity(right, "right process generation"),
    );
  } catch {
    return false;
  }
}

function deploymentParentGeneration(value, label = "parent generation") {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  try {
    return {
      sourceGeneration: parseDevLaunchGeneration(
        value.sourceGeneration,
        `${label} source generation`,
      ),
      supervisor: parseDevLaunchIdentity(
        value.supervisor,
        `${label} supervisor`,
      ),
      launch: parseDevLaunchIdentity(value.launch, `${label} launch`),
    };
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function exactParentGenerationReceipt(
  value,
  expectedSourceGeneration,
  worktree,
  channel,
) {
  try {
    parseDevLaunchV2Envelope(value, {
      type: "parent_generation_receipt",
      worktreeRoot: worktree,
      channel,
    });
    if (
      (expectedSourceGeneration !== undefined &&
        value.sourceGeneration !== expectedSourceGeneration) ||
      !Number.isSafeInteger(value.observedAtMs) ||
      value.observedAtMs <= 0
    ) {
      return null;
    }
    return deploymentParentGeneration(value);
  } catch {
    return null;
  }
}

function exactChildRestartTransition(transition, worktree, channel) {
  let proof;
  try {
    proof = parseDevLaunchRestartReceipt(transition?.receipt, {
      worktreeRoot: worktree,
      channel,
    });
    if (
      transition?.kind !== "child_restart" ||
      transition.relaunchDispatched !== true ||
      transition.restartRequestId !== proof.requestId ||
      proof.previousLaunch.generation === proof.launch.generation
    ) {
      return null;
    }
    return {
      kind: "child_restart",
      requestId: proof.requestId,
      supervisor: proof.supervisor,
      previousLaunch: proof.previousLaunch,
      launch: proof.launch,
      ...(proof.previousFrontend
        ? { previousFrontend: proof.previousFrontend }
        : {}),
      ...(proof.frontend ? { frontend: proof.frontend } : {}),
    };
  } catch {
    return null;
  }
}

function applicationParentReloadTransition(receipt, worktree, channel) {
  const transition = receipt.plannedTransition;
  const proof = transition?.receipt;
  try {
    const sourceGeneration = parseDevLaunchGeneration(
      receipt.expectedParentSourceGeneration,
      "expected parent source generation",
    );
    if (transition?.state === "converged") {
      const activeGeneration = exactParentGenerationReceipt(
        proof,
        sourceGeneration,
        worktree,
        channel,
      );
      const hasResidualTransition = receipt.residualTransition !== undefined;
      const residualTransition = hasResidualTransition
        ? exactChildRestartTransition(
            receipt.residualTransition,
            worktree,
            channel,
          )
        : undefined;
      const finalGeneration = residualTransition
        ? {
            sourceGeneration,
            supervisor: residualTransition.supervisor,
            launch: residualTransition.launch,
          }
        : activeGeneration;
      return transition.kind === "parent_reload" &&
        transition.attempted === false &&
        transition.destructiveBoundaryCrossed === false &&
        transition.relaunchDispatched === false &&
        transition.reason === "dev_launch_parent_generation_already_active" &&
        activeGeneration &&
        (!hasResidualTransition ||
          (residualTransition &&
            sameDevLaunchIdentity(
              activeGeneration.supervisor,
              residualTransition.supervisor,
            ) &&
            sameDevLaunchIdentity(
              activeGeneration.launch,
              residualTransition.previousLaunch,
            )))
        ? {
            kind: "parent_reload",
            activatedGeneration: finalGeneration,
            proof,
            ...(residualTransition ? { residualTransition } : {}),
          }
        : null;
    }
    parseDevLaunchV2Envelope(proof, {
      type: "parent_reload_receipt",
      worktreeRoot: worktree,
      channel,
    });
    parseDevLaunchGeneration(proof.requestId, "parent reload request id");
    const previousSupervisor = parseDevLaunchIdentity(
      proof.previousSupervisor,
      "previous supervisor",
    );
    const supervisor = parseDevLaunchIdentity(proof.supervisor, "supervisor");
    const previousLaunch = parseDevLaunchIdentity(
      proof.previousLaunch,
      "previous launch",
    );
    const launch = parseDevLaunchIdentity(proof.launch, "launch");
    const activatedGeneration = { sourceGeneration, supervisor, launch };
    return (
      transition?.kind === "parent_reload" &&
      receipt.residualTransition === undefined &&
      transition.relaunchDispatched === true &&
      transition.parentReloadRequestId === proof.requestId &&
      proof.sourceGeneration === sourceGeneration &&
      previousSupervisor.pid === supervisor.pid &&
      previousSupervisor.processIdentity === supervisor.processIdentity &&
      previousSupervisor.generation !== supervisor.generation &&
      previousLaunch.generation !== launch.generation &&
      Number.isSafeInteger(proof.activatedAtMs) &&
      proof.activatedAtMs > 0
    )
      ? { kind: "parent_reload", activatedGeneration, proof }
      : null;
  } catch {
    return null;
  }
}

function exactParentReloadTransition(receipt, worktree, channel) {
  const activation = applicationParentReloadTransition(
    receipt,
    worktree,
    channel,
  );
  if (!activation) return null;
  try {
    const verified = deploymentParentGeneration(
      receipt.verification.activatedGeneration,
    );
    return verified.sourceGeneration ===
      activation.activatedGeneration.sourceGeneration &&
      sameDevLaunchIdentity(
        verified.supervisor,
        activation.activatedGeneration.supervisor,
      ) &&
      sameDevLaunchIdentity(
        verified.launch,
        activation.activatedGeneration.launch,
      )
      ? activation
      : null;
  } catch {
    return null;
  }
}

function coldBootstrapTransition(receipt) {
  const candidates = [
    receipt.plannedTransition,
    receipt.verification?.recovery,
  ].filter((transition) => transition?.kind === "cold_bootstrap");
  if (candidates.length === 0) return undefined;
  return candidates.length === 1 ? candidates[0] : null;
}

function exactApplicationColdBootstrapTransition(
  transition,
  worktree,
  channel,
  expectedSourceGeneration,
) {
  const proof = transition?.receipt;
  try {
    const sourceGeneration = parseDevLaunchGeneration(
      proof?.parentGeneration?.sourceGeneration,
      "cold bootstrap source generation",
    );
    const boundSourceGeneration = expectedSourceGeneration === undefined
      ? sourceGeneration
      : parseDevLaunchGeneration(
          expectedSourceGeneration,
          "expected parent source generation",
        );
    const hmux = parseDevLaunchHmuxProviderIdentity(proof?.hmux);
    const parentGeneration = exactParentGenerationReceipt(
      proof?.parentGeneration,
      boundSourceGeneration,
      worktree,
      channel,
    );
    return transition?.kind === "cold_bootstrap" &&
      transition.state === "restarted" &&
      transition.relaunchDispatched === true &&
      proof?.schemaVersion === 1 &&
      proof.type === "cold_bootstrap_receipt" &&
      /^[a-f0-9]{32}$/.test(proof.requestGeneration ?? "") &&
      hmux &&
      parentGeneration
      ? {
          kind: "cold_bootstrap",
          requestGeneration: proof.requestGeneration,
          hmux,
          activatedGeneration: parentGeneration,
        }
      : null;
  } catch {
    return null;
  }
}

function exactApplicationLifecycleTransition({
  receipt,
  impact,
  parentActivationRequired,
  worktree,
  channel,
}) {
  const transition = receipt.plannedTransition;
  if (!transition) return undefined;
  if (transition.kind === "cold_bootstrap") {
    const expectedSourceGeneration = parentActivationRequired
      ? receipt.expectedParentSourceGeneration
      : undefined;
    return parentActivationRequired && expectedSourceGeneration === undefined
      ? null
      : exactApplicationColdBootstrapTransition(
          transition,
          worktree,
          channel,
          expectedSourceGeneration,
        );
  }
  if (transition.kind === "parent_reload") {
    if (!parentActivationRequired) return null;
    const activation = applicationParentReloadTransition(
      receipt,
      worktree,
      channel,
    );
    return activation &&
      transition.state === "converged" &&
      devDeployRequiresChildRestart(impact) &&
      !activation.residualTransition
      ? null
      : activation;
  }
  if (transition.kind === "child_restart") {
    return !parentActivationRequired && devDeployRequiresChildRestart(impact)
      ? exactChildRestartTransition(transition, worktree, channel)
      : null;
  }
  return undefined;
}

function exactColdBootstrapTransition(
  receipt,
  transition,
  worktree,
  channel,
) {
  try {
    const activation = exactApplicationColdBootstrapTransition(
      transition,
      worktree,
      channel,
    );
    const expectedSourceGeneration = parseDevLaunchGeneration(
      receipt.expectedParentSourceGeneration ??
        activation?.activatedGeneration?.sourceGeneration,
      "expected parent source generation",
    );
    const activatedGeneration = deploymentParentGeneration(
      receipt.verification.activatedGeneration,
    );
    return activation &&
      activation.activatedGeneration.sourceGeneration ===
        expectedSourceGeneration &&
      activatedGeneration.sourceGeneration === expectedSourceGeneration &&
      sameDevLaunchIdentity(
        activation.activatedGeneration.supervisor,
        activatedGeneration.supervisor,
      ) &&
      sameDevLaunchIdentity(
        activation.activatedGeneration.launch,
        activatedGeneration.launch,
      )
      ? activation
      : null;
  } catch {
    return null;
  }
}

function exactTargetParentReconciliation(
  receipt,
  reconciliationRequest,
  priorFailure,
  worktree,
) {
  const failedReceipt = priorFailure?.receipt;
  const targetHead = reconciliationRequest?.targetHead;
  if (
    receipt?.action !== "skip" ||
    reconciliationRequest?.kind !== "parent_generation" ||
    receipt.reconciliation?.kind !== "parent_generation" ||
    receipt.reconciliation.targetHead !== targetHead ||
    receipt.currentHead !== targetHead ||
    receipt.targetHead !== targetHead ||
    receipt.verification?.status !== "ok"
  ) {
    return null;
  }
  if (
    failedReceipt &&
    (failedReceipt.action !== "deploy" ||
      failedReceipt.deployed !== true ||
      (priorFailure.failure?.code !== "parent_reconciliation_required" &&
        failedReceipt.impact?.kind !== "parent_reload" &&
        failedReceipt.impact?.kind !== "launcher_restart") ||
      failedReceipt.targetHead !== targetHead)
  ) {
    return null;
  }
  let expectedSourceGeneration;
  try {
    expectedSourceGeneration = parseDevLaunchGeneration(
      receipt.expectedParentSourceGeneration,
      "reconciled target parent source generation",
    );
    if (
      failedReceipt?.impact?.kind === "parent_reload" &&
      parseDevLaunchGeneration(
        failedReceipt.expectedParentSourceGeneration,
        "failed target parent source generation",
      ) !== expectedSourceGeneration
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const { channel } = worktreeDevIdentity(worktree);
  const parentGeneration = exactParentGenerationReceipt(
    receipt.parentGeneration,
    expectedSourceGeneration,
    worktree,
    channel,
  );
  let runtime;
  let controlPlaneActivation;
  try {
    runtime = deploymentRuntime(receipt.runtime);
    if (
      failedReceipt?.backendChanged === true ||
      devDeployRequiresControlPlaneActivation(failedReceipt?.impact)
    ) {
      controlPlaneActivation = parseDevControlPlaneActivationProof(
        receipt.verification.controlPlaneActivation,
        targetHead,
      );
    }
  } catch {
    return null;
  }
  if (
    !parentGeneration ||
    !runtime?.generation ||
    receipt.verification.activatedAppServerGeneration !== runtime.generation
  ) {
    return null;
  }
  return {
    parentGeneration,
    runtime,
    ...(controlPlaneActivation ? { controlPlaneActivation } : {}),
  };
}

function exactDeploymentActivation(receipt, worktree, transaction, boundImpact) {
  if (receipt.deployed !== true) return null;
  const { channel } = worktreeDevIdentity(worktree);
  let impact;
  let runtime;
  let controlPlaneActivation;
  let hmuxActivation;
  try {
    impact = boundImpact ?? parseDevDeployImpact(receipt.impact);
    runtime = deploymentRuntime(receipt.runtime);
    if (devDeployRequiresControlPlaneActivation(impact)) {
      controlPlaneActivation = parseDevControlPlaneActivationProof(
        receipt.verification?.controlPlaneActivation,
        transaction.targetHead,
      );
    }
    if (impact.hmuxRuntimeChanged) {
      hmuxActivation = parseDevHmuxActivationProof(
        receipt.verification?.hmuxActivation,
        { sourceRevision: transaction.targetHead, channel },
      );
    }
  } catch {
    return null;
  }
  const bootstrapTransition = coldBootstrapTransition(receipt);
  const coldBootstrap = bootstrapTransition
    ? exactColdBootstrapTransition(
        receipt,
        bootstrapTransition,
        worktree,
        channel,
      )
    : bootstrapTransition;
  if (coldBootstrap === null) return null;
  if (coldBootstrap) {
    if (
      !runtime?.generation ||
      receipt.verification.activatedAppServerGeneration !== runtime.generation
    ) {
      return null;
    }
    return {
      targetHead: transaction.targetHead,
      impact,
      runtime,
      activation: coldBootstrap,
      ...(controlPlaneActivation ? { controlPlaneActivation } : {}),
      ...(hmuxActivation ? { hmuxActivation } : {}),
    };
  }
  if (impact.kind === "frontend_reload") {
    return impact.backendChanged === false
      ? {
          targetHead: transaction.targetHead,
          impact,
          runtime,
          ...(controlPlaneActivation ? { controlPlaneActivation } : {}),
        }
      : null;
  }
  if (impact.kind === "backend_rebuild") {
    return impact.backendChanged === true
      ? {
          targetHead: transaction.targetHead,
          impact,
          runtime,
          controlPlaneActivation,
          ...(hmuxActivation ? { hmuxActivation } : {}),
        }
      : null;
  }
  const activation =
    impact.kind === "child_restart"
      ? exactChildRestartTransition(receipt.plannedTransition, worktree, channel)
      : exactParentReloadTransition(receipt, worktree, channel);
  if (
    !activation ||
    !runtime?.generation ||
    receipt.verification.activatedAppServerGeneration !== runtime.generation
  ) {
    return null;
  }
  return {
    targetHead: transaction.targetHead,
    impact,
    runtime,
    activation,
    ...(controlPlaneActivation ? { controlPlaneActivation } : {}),
    ...(hmuxActivation ? { hmuxActivation } : {}),
  };
}

export function reduceDevDeploySettlementProof({
  receipt,
  worktree,
  transaction,
  reconciliationRequest,
  priorFailure,
}) {
  if (isDevDeployApplicationReceiptVersion(receipt?.deployReceiptVersion)) {
    if (
      receipt.action !== "defer" &&
      receipt.action !== "deploy" &&
      receipt.action !== "skip"
    ) {
      return { kind: "invalid_receipt" };
    }
    let binding;
    try {
      binding = parseDevDeployReceiptBinding(receipt, transaction);
    } catch {
      return { kind: "transaction_mismatch" };
    }
    if (receipt.action === "defer") {
      return { kind: "defer", transaction: binding.transaction };
    }
    const { channel } = worktreeDevIdentity(worktree);
    let impact;
    let controlPlaneActivation;
    let hmuxActivation;
    try {
      impact = binding.impact ?? parseDevDeployImpact(receipt.impact);
      if (devDeployRequiresControlPlaneActivation(impact)) {
        controlPlaneActivation = parseDevControlPlaneActivationProof(
          receipt.controlPlaneActivation,
          binding.transaction.targetHead,
        );
      }
      if (impact.hmuxRuntimeChanged) {
        hmuxActivation = parseDevHmuxActivationProof(
          receipt.hmuxActivation,
          { sourceRevision: binding.transaction.targetHead, channel },
        );
      }
    } catch {
      return {
        kind:
          receipt.action === "deploy"
            ? "unverified_deployment"
            : "unverified_skip",
        transaction: binding.transaction,
      };
    }
    const selectedTransaction = bindParsedDevDeployTransactionSelection(
      binding.transaction,
      receipt,
      impact,
    );
    const plannedTransitionKind = receipt.plannedTransition?.kind;
    const parentActivationRequired =
      impact.kind === "parent_reload" || Boolean(reconciliationRequest);
    const applicationActivationRequired =
      parentActivationRequired ||
      devDeployRequiresChildRestart(impact) ||
      plannedTransitionKind === "cold_bootstrap";
    const applicationActivation = exactApplicationLifecycleTransition({
      receipt,
      impact,
      parentActivationRequired,
      worktree,
      channel,
    });
    const parentGeneration = exactParentGenerationReceipt(
      receipt.parentGeneration,
      receipt.parentGeneration?.sourceGeneration,
      worktree,
      channel,
    );
    const activatedLaunch =
      applicationActivation?.kind === "child_restart"
        ? applicationActivation.launch
        : applicationActivation?.activatedGeneration?.launch;
    const freshRuntimeRequired =
      receipt.deployReceiptVersion ===
        DEV_DEPLOY_APPLICATION_RECEIPT_VERSION &&
      impact.backendChanged === true;
    const runtime = freshRuntimeRequired
      ? exactApplicationRuntime(receipt.runtime, {
          channel,
          targetHead: binding.transaction.targetHead,
          activatedLaunch,
        })
      : undefined;
    const requiredActivationAccepted =
      !applicationActivationRequired || Boolean(applicationActivation);
    const frontendRuntimeAccepted =
      receipt.frontendTransition?.status !== "dispatched" ||
      Boolean(parentGeneration || applicationActivation?.activatedGeneration);
    const applied =
      receipt.liveWorktree === worktree &&
      requiredActivationAccepted &&
      (!freshRuntimeRequired || Boolean(runtime)) &&
      frontendRuntimeAccepted &&
      (receipt.action === "skip" ||
        (receipt.deployed === true && receipt.dispatchAccepted === true));
    return applied
      ? {
          kind: "deployment",
          authority: "application",
          activation: {
            targetHead: binding.transaction.targetHead,
            impact,
            ...(applicationActivation
              ? { activation: applicationActivation }
              : {}),
            ...(parentGeneration ? { parentGeneration } : {}),
            ...(runtime ? { runtime } : {}),
            ...(controlPlaneActivation ? { controlPlaneActivation } : {}),
            ...(hmuxActivation ? { hmuxActivation } : {}),
          },
          transaction: selectedTransaction,
        }
      : {
          kind:
            receipt.action === "deploy"
              ? "unverified_deployment"
              : "unverified_skip",
          transaction: selectedTransaction,
        };
  }
  if (
    !receipt ||
    (receipt.action !== "defer" &&
      receipt.action !== "deploy" &&
      receipt.action !== "skip")
  ) {
    return { kind: "invalid_receipt" };
  }
  let binding;
  try {
    binding = parseDevDeployReceiptBinding(receipt, transaction);
  } catch {
    return { kind: "transaction_mismatch" };
  }
  if (receipt.action === "defer") {
    let transaction = binding.transaction;
    try {
      transaction = bindParsedDevDeployTransactionSelection(
        transaction,
        receipt,
        binding.impact ?? parseDevDeployImpact(receipt.impact),
      );
    } catch {
      // Lock contention may defer before the executor has classified a target.
    }
    return { kind: "defer", transaction };
  }
  let impact;
  try {
    impact = binding.impact ?? parseDevDeployImpact(receipt.impact);
  } catch {
    return {
      kind:
        receipt.action === "deploy"
          ? "unverified_deployment"
          : "unverified_skip",
      transaction: binding.transaction,
    };
  }
  const selectedTransaction = bindParsedDevDeployTransactionSelection(
    binding.transaction,
    receipt,
    impact,
  );
  if (
    receipt.liveWorktree !== worktree ||
    receipt.verification?.status !== "ok" ||
    receipt.liveVerified !== true
  ) {
    return {
      kind:
        receipt.action === "deploy"
          ? "unverified_deployment"
          : "unverified_skip",
      transaction: selectedTransaction,
    };
  }
  if (receipt.action === "deploy") {
    const activation = exactDeploymentActivation(
      receipt,
      worktree,
      binding.transaction,
      impact,
    );
    return activation
      ? { kind: "deployment", activation, transaction: selectedTransaction }
      : { kind: "unverified_deployment", transaction: selectedTransaction };
  }
  const reconciliation = exactTargetParentReconciliation(
    receipt,
    reconciliationRequest,
    priorFailure,
    worktree,
  );
  return reconciliation
    ? {
        kind: "parent_reconciliation",
        reconciliation,
        transaction: selectedTransaction,
      }
    : { kind: "unverified_skip", transaction: selectedTransaction };
}

export function successfulDeploymentFromReceipt(
  receipt,
  previous,
  settledAtMs,
  worktree,
  transaction,
) {
  const proof = reduceDevDeploySettlementProof({
    receipt,
    worktree,
    transaction,
  });
  return successfulDeploymentFromProof(proof, previous, settledAtMs);
}

function successfulDeploymentFromProof(proof, previous, settledAtMs) {
  if (proof?.kind !== "deployment") return previous;
  const { activation } = proof;
  const { impact, runtime, targetHead: sourceHead } = activation;
  const lifecycleActivation = activation.activation;
  let parentGeneration = previous?.parentGeneration;
  const activatedParent = settledParentGeneration(proof);
  if (activatedParent) {
    parentGeneration = activatedParent;
  } else if (lifecycleActivation?.kind === "child_restart") {
    parentGeneration =
      parentGeneration &&
      sameProcessGeneration(
        lifecycleActivation.supervisor,
        parentGeneration.supervisor,
      )
        ? {
            sourceGeneration: parentGeneration.sourceGeneration,
            supervisor: lifecycleActivation.supervisor,
            launch: lifecycleActivation.launch,
          }
        : undefined;
  }
  return {
    sourceHead,
    ...(devDeployRequiresControlPlaneActivation(impact)
      ? {
          backendHead: sourceHead,
          controlPlaneActivation: activation.controlPlaneActivation,
        }
      : previous?.backendHead
        ? {
            backendHead: previous.backendHead,
            ...(previous.controlPlaneActivation
              ? { controlPlaneActivation: previous.controlPlaneActivation }
              : {}),
          }
        : {}),
    ...(impact.hmuxRuntimeChanged === true
      ? { hmuxActivation: activation.hmuxActivation }
      : previous?.hmuxActivation
        ? { hmuxActivation: previous.hmuxActivation }
        : {}),
    ...(proof.authority === "application"
      ? { appliedAtMs: settledAtMs }
      : { verifiedAtMs: settledAtMs }),
    ...(runtime ? { runtime } : {}),
    ...(parentGeneration ? { parentGeneration } : {}),
  };
}

export function settledDeploymentProjection({
  request,
  priorFailure,
  previousDeployment,
  receipt,
  settledAtMs,
  settlementProof,
}) {
  const reconciliationRequest = request.reconciliation;
  const parentReconciliation =
    settlementProof?.kind === "parent_reconciliation" && reconciliationRequest
      ? settlementProof.reconciliation
      : null;
  const failedReceipt = priorFailure?.receipt;
  const deployed = parentReconciliation
    ? {
        sourceHead: reconciliationRequest.targetHead,
        ...(
          failedReceipt?.backendChanged === true ||
          devDeployRequiresControlPlaneActivation(failedReceipt?.impact)
          ? { backendHead: reconciliationRequest.targetHead }
          : previousDeployment?.backendHead
            ? { backendHead: previousDeployment.backendHead }
            : {}
        ),
        ...(previousDeployment?.hmuxActivation
          ? { hmuxActivation: previousDeployment.hmuxActivation }
          : {}),
        verifiedAtMs: settledAtMs,
        runtime: parentReconciliation.runtime,
        parentGeneration: parentReconciliation.parentGeneration,
      }
    : successfulDeploymentFromProof(
        settlementProof,
        previousDeployment,
        settledAtMs,
      );
  const settledFailure =
    parentReconciliation || settlementProof?.kind === "deployment"
      ? undefined
      : priorFailure;
  return {
    request: requestWithParentReconciliation(
      request,
      parentReconciliationAfter({
        request,
        priorFailure: settledFailure,
        deployed,
        receipt,
        settlementProof,
      }),
    ),
    priorFailure: settledFailure,
    deployed,
    parentReconciliation,
  };
}
