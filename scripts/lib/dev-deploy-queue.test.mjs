import { describe, expect, it } from "vitest";
import { worktreeDevIdentity } from "./app-channel.mjs";
import { coldBootstrapSessionName } from "./dev-cold-bootstrap-operation.mjs";
import {
  DEV_HMUX_STANDALONE_OPERATION_MODE,
} from "./dev-hmux-operation-contract.mjs";
import {
  DEV_DEPLOY_QUEUE_STATUS,
  assertLiveWorktreeSelection,
  attachDevDeployAttemptExecutor,
  beginDevDeployAttempt,
  cancelDevDeploy,
  enqueueDevDeploy,
  expireDevDeploy,
  lastSuccessfulDeploymentFor,
  nextDevDeployWakeAtMs,
  parseQueuedDeployState,
  reconcileDevDeployAttempt,
  recordDevDeployColdBootstrapSubmission,
  recordDevDeployAttemptPhase,
  recordDevDeployAttemptResult,
  refreshPendingDevDeploySelection,
  settleDevDeployAttempt as settleDevDeployAttemptState,
} from "./dev-deploy-queue.mjs";

const WORKTREE = "/tmp/dure-live";
const CHANNEL = worktreeDevIdentity(WORKTREE).channel;
const TARGET_A = "a".repeat(40);
const TARGET_B = "b".repeat(40);
const TARGET_C = "c".repeat(40);
const TARGET_X = "d".repeat(40);
const TARGET_Y = "e".repeat(40);
const EXECUTOR_GENERATION = "f".repeat(64);
const COLD_BOOTSTRAP_COMMAND = Object.freeze(["env", "node", "app:dev"]);
const COLD_BOOTSTRAP_HMUX_BUILD_ID =
  "0.1.4+dev.0123456789abcdef.0123456789ab";

function transaction(targetHead = TARGET_B) {
  return {
    schemaVersion: 1,
    targetHead,
    targetAuthority: "origin/main",
    executor: {
      generation: EXECUTOR_GENERATION,
      entrypoint:
        `/tmp/executors-v1/${EXECUTOR_GENERATION}/scripts/deploy-dev-app.mjs`,
    },
  };
}

function completeImpact(impact) {
  if (!impact) return impact;
  return {
    ...impact,
    backendChanged:
      impact.backendChanged ?? impact.kind === "backend_rebuild",
    changedPathCount: impact.changedPathCount ?? 1,
    ...(impact.kind === "parent_reload" && !impact.parentStrategy
      ? { parentStrategy: "exec_handoff" }
      : {}),
  };
}

function settleDevDeployAttempt(state, input) {
  const attempted = state.activeAttempt?.transaction;
  const receipt = input.receipt
    ? {
        ...input.receipt,
        liveWorktree: input.receipt.liveWorktree ?? WORKTREE,
        ...(input.receipt.transaction
          ? {}
          : { transaction: attempted }),
        ...(input.receipt.impact
          ? { impact: completeImpact(input.receipt.impact) }
          : {}),
        ...(input.receipt.action === "deploy" &&
        input.receipt.verification?.status === "ok" &&
        input.receipt.liveVerified === undefined
          ? { liveVerified: true }
          : {}),
      }
    : input.receipt;
  return settleDevDeployAttemptState(state, { ...input, receipt });
}

function attachAttemptExecutor(state, observedAtMs = 2_100) {
  const binding = {
    attemptId: state.activeAttempt.attemptId,
    attemptGeneration: state.activeAttempt.generation,
    transaction: state.activeAttempt.transaction,
  };
  return attachDevDeployAttemptExecutor(state, {
    ...binding,
    executor: {
      pid: 39,
      processIdentity: "executor-39",
      observedAtMs,
    },
  });
}

function submitColdBootstrap(state, observedAtMs = 2_100) {
  const binding = {
    attemptId: state.activeAttempt.attemptId,
    attemptGeneration: state.activeAttempt.generation,
    transaction: state.activeAttempt.transaction,
  };
  const attached = attachAttemptExecutor(state, observedAtMs);
  const applied = recordDevDeployAttemptPhase(attached, {
    ...binding,
    observedAtMs: observedAtMs + 1,
  });
  return recordDevDeployColdBootstrapSubmission(applied, {
    ...binding,
    operationId: applied.activeAttempt.coldBootstrap.operationId,
    command: COLD_BOOTSTRAP_COMMAND,
    hmuxBuildId: COLD_BOOTSTRAP_HMUX_BUILD_ID,
    submittedAtMs: observedAtMs + 2,
  });
}

function retiredColdBootstrapReceipt(
  operationId,
  impact,
  targetHead = TARGET_B,
) {
  return {
    action: "defer",
    currentHead: targetHead,
    targetHead,
    impact,
    plannedTransition: {
      kind: "cold_bootstrap",
      state: "pending",
      attempted: true,
      destructiveBoundaryCrossed: true,
      relaunchDispatched: false,
      hmuxOutcome: "retired",
      receipt: {
        schemaVersion: 1,
        type: "cold_bootstrap_target_retired",
        requestGeneration: "a".repeat(32),
        hmux: {
          outcome: "retired",
          schemaVersion: 1,
          operationId,
          sessionName: coldBootstrapSessionName({
            root: WORKTREE,
            channel: CHANNEL,
            operationId,
          }),
          sessionId: `standalone_${operationId}`,
          workspaceId: "workspace-retired-target",
        },
      },
    },
  };
}

function acknowledgedColdBootstrapRetirementReceipt(operationId) {
  return {
    action: "defer",
    plannedTransition: {
      kind: "cold_bootstrap_retirement_acknowledgement",
      state: "converged",
      attempted: true,
      destructiveBoundaryCrossed: true,
      acknowledgementDispatched: true,
      hmuxOutcome: "acknowledged",
      receipt: {
        schemaVersion: 1,
        type: "cold_bootstrap_retirement_acknowledged",
        requestGeneration: "b".repeat(32),
        hmux: {
          outcome: "acknowledged",
          schemaVersion: 1,
          operationId,
        },
      },
    },
  };
}

const BASE_REQUEST = {
  worktree: WORKTREE,
  attemptArgs: ["--live-worktree", WORKTREE],
  transaction: transaction(),
  executionEnvironment: { HOME: "/tmp/home", PATH: "/usr/bin" },
  receipt: {
    action: "defer",
    currentHead: TARGET_A,
    targetHead: TARGET_B,
    pendingCommits: 2,
    impact: { kind: "backend_rebuild" },
  },
  nowMs: 1_000,
  maxWaitMs: 60_000,
  pollMs: 5_000,
};

function queued(overrides = {}) {
  const receipt = overrides.receipt ?? BASE_REQUEST.receipt;
  return enqueueDevDeploy({
    ...BASE_REQUEST,
    ...overrides,
    transaction:
      overrides.transaction ?? transaction(receipt?.targetHead ?? TARGET_B),
  });
}

function processGeneration(pid, processIdentity, generation) {
  return { pid, processIdentity, generation: generation.repeat(64) };
}

function v2Envelope(type, fields) {
  return {
    schemaVersion: 1,
    protocolVersion: 2,
    type,
    worktreeRoot: WORKTREE,
    channel: CHANNEL,
    ...fields,
  };
}

function childRestartTransition({
  requestId = "8".repeat(64),
  supervisor = processGeneration(10, "parent", "a"),
  previousLaunch = processGeneration(20, "child-old", "b"),
  launch = processGeneration(21, "child-new", "c"),
  restartedAtMs = 6_500,
} = {}) {
  return {
    kind: "child_restart",
    relaunchDispatched: true,
    restartRequestId: requestId,
    receipt: v2Envelope("restart_receipt", {
      requestId,
      supervisor,
      previousLaunch,
      launch,
      restartedAtMs,
    }),
  };
}

function readyApplicationRuntime(launch, targetHead = TARGET_B) {
  return {
    state: "ready",
    channel: CHANNEL,
    targetHead,
    pid: 90,
    processIdentity: "backend-app",
    buildId: `0.1.4+${targetHead.slice(0, 12)}`,
    generation: "backend-app-generation",
    startedAtUnixMs: 6_600,
    observedAtMs: 6_800,
    launch,
    compatibility: { state: "available", mode: "current" },
  };
}

function controlPlaneActivationProof(sourceRevision = TARGET_B) {
  return {
    schemaVersion: 1,
    sourceRevision,
    cliArtifactDigest: "1".repeat(64),
    controlPlaneExecutableSha256: "2".repeat(64),
    claudePayloadDigest: "3".repeat(64),
    backendId: "dure-local",
    backendGeneration: `local-v1-${"4".repeat(32)}`,
  };
}

function hmuxActivationProof(sourceRevision = TARGET_B) {
  return {
    schemaVersion: 1,
    sourceRevision,
    channel: CHANNEL,
    buildId: "0.1.4+dev.0123456789abcdef.0123456789ab",
  };
}

function parentReconciliationReceipt({
  targetHead = TARGET_B,
  sourceGeneration = "7".repeat(64),
  supervisor = processGeneration(30, "cold-parent", "d"),
  launch = processGeneration(31, "cold-child", "e"),
  appServerGeneration = "app-server-generation-1",
} = {}) {
  return {
    action: "skip",
    currentHead: targetHead,
    targetHead,
    impact: completeImpact({ kind: "frontend_reload", changedPathCount: 0 }),
    reconciliation: { kind: "parent_generation", targetHead },
    expectedParentSourceGeneration: sourceGeneration,
    verification: {
      status: "ok",
      activatedAppServerGeneration: appServerGeneration,
    },
    liveVerified: true,
    runtime: {
      pid: 32,
      processIdentity: "cold-app",
      generation: appServerGeneration,
      observedAtMs: 8_500,
    },
    parentGeneration: v2Envelope("parent_generation_receipt", {
      sourceGeneration,
      supervisor,
      launch,
      observedAtMs: 8_500,
    }),
  };
}

function validActivationReceipt(kind) {
  const appServerGeneration = `${kind}-app-generation`;
  const receipt = {
    action: "deploy",
    deployed: true,
    targetHead: TARGET_B,
    impact: {
      kind,
      backendChanged: kind === "backend_rebuild",
      changedPathCount: 1,
      ...(kind === "parent_reload"
        ? { parentStrategy: "exec_handoff" }
        : {}),
    },
    verification: {
      status: "ok",
      activatedAppServerGeneration: appServerGeneration,
      ...(kind === "backend_rebuild"
        ? { controlPlaneActivation: controlPlaneActivationProof() }
        : {}),
    },
    runtime: {
      pid: 90,
      processIdentity: `${kind}-app`,
      generation: appServerGeneration,
      observedAtMs: 6_800,
    },
  };
  if (kind === "child_restart") {
    return { ...receipt, plannedTransition: childRestartTransition() };
  }
  if (kind !== "parent_reload") return receipt;
  const requestId = "4".repeat(64);
  const sourceGeneration = "5".repeat(64);
  const previousSupervisor = processGeneration(40, "proof-parent", "6");
  const supervisor = processGeneration(40, "proof-parent", "7");
  const previousLaunch = processGeneration(41, "proof-child-old", "8");
  const launch = processGeneration(42, "proof-child", "9");
  return {
    ...receipt,
    expectedParentSourceGeneration: sourceGeneration,
    verification: {
      ...receipt.verification,
      activatedGeneration: { sourceGeneration, supervisor, launch },
    },
    plannedTransition: {
      kind: "parent_reload",
      relaunchDispatched: true,
      parentReloadRequestId: requestId,
      receipt: v2Envelope("parent_reload_receipt", {
        requestId,
        previousSupervisor,
        previousLaunch,
        supervisor,
        launch,
        sourceGeneration,
        activatedAtMs: 6_500,
      }),
    },
  };
}

function convergedParentActivationReceipt() {
  const sourceGeneration = "5".repeat(64);
  const supervisor = processGeneration(40, "active-parent", "7");
  const launch = processGeneration(42, "active-child", "9");
  const appServerGeneration = "parent-converged-app-generation";
  const parentGeneration = v2Envelope("parent_generation_receipt", {
    sourceGeneration,
    supervisor,
    launch,
    observedAtMs: 6_500,
  });
  return {
    action: "deploy",
    deployed: true,
    targetHead: TARGET_B,
    impact: {
      kind: "parent_reload",
      backendChanged: true,
      changedPathCount: 2,
      parentStrategy: "exec_handoff",
    },
    expectedParentSourceGeneration: sourceGeneration,
    verification: {
      status: "ok",
      activatedAppServerGeneration: appServerGeneration,
      activatedGeneration: { sourceGeneration, supervisor, launch },
      controlPlaneActivation: controlPlaneActivationProof(),
    },
    runtime: {
      pid: 90,
      processIdentity: "parent-converged-app",
      generation: appServerGeneration,
      observedAtMs: 6_800,
    },
    plannedTransition: {
      kind: "parent_reload",
      state: "converged",
      attempted: false,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: false,
      reason: "dev_launch_parent_generation_already_active",
      receipt: parentGeneration,
    },
  };
}

function convergedParentActivationWithResidualReceipt() {
  const receipt = convergedParentActivationReceipt();
  const activeGeneration = receipt.verification.activatedGeneration;
  const launch = processGeneration(43, "residual-child", "a");
  return {
    ...receipt,
    verification: {
      ...receipt.verification,
      activatedGeneration: {
        sourceGeneration: activeGeneration.sourceGeneration,
        supervisor: activeGeneration.supervisor,
        launch,
      },
    },
    residualTransition: childRestartTransition({
      supervisor: activeGeneration.supervisor,
      previousLaunch: activeGeneration.launch,
      launch,
    }),
  };
}

function coldBootstrapActivationReceipt(
  kind = "parent_reload",
  placement = "planned",
) {
  const sourceGeneration = "5".repeat(64);
  const supervisor = processGeneration(40, "cold-bootstrap-parent", "7");
  const launch = processGeneration(42, "cold-bootstrap-child", "9");
  const receipt = validActivationReceipt(kind);
  const transition = {
    kind: "cold_bootstrap",
    state: "restarted",
    attempted: true,
    destructiveBoundaryCrossed: false,
    relaunchDispatched: true,
    reason: "dev_launch_cold_bootstrap_receipt_verified",
    receipt: {
      schemaVersion: 1,
      type: "cold_bootstrap_receipt",
      requestGeneration: "a".repeat(32),
      hmux: {
        sessionName: "dure-dev-fixture",
        sessionId: "standalone_cold_bootstrap",
        workspaceId: "workspace_cold_bootstrap",
      },
      parentGeneration: v2Envelope("parent_generation_receipt", {
        sourceGeneration,
        supervisor,
        launch,
        observedAtMs: 6_500,
      }),
    },
  };
  const result = {
    ...receipt,
    ...(kind === "parent_reload"
      ? { expectedParentSourceGeneration: sourceGeneration }
      : {}),
    verification: {
      ...receipt.verification,
      activatedGeneration: { sourceGeneration, supervisor, launch },
    },
  };
  if (placement === "recovery") {
    delete result.plannedTransition;
    result.verification = {
      ...result.verification,
      recovery: transition,
      recovered: true,
    };
  } else {
    result.plannedTransition = transition;
  }
  return result;
}

function deployedStateWithParent({
  sourceHead = TARGET_A,
  sourceGeneration = "1".repeat(64),
} = {}) {
  const baseline = settleDevDeployAttempt(
    beginDevDeployAttempt(
      queued({ transaction: transaction(sourceHead) }),
      6_000,
    ),
    {
      attemptGeneration: 1,
      exitCode: 0,
      receipt: {
        action: "deploy",
        deployed: true,
        targetHead: sourceHead,
        impact: { kind: "frontend_reload" },
        verification: { status: "ok" },
      },
      nowMs: 7_000,
      pollMs: 5_000,
    },
  );
  const supervisor = processGeneration(10, "old-parent", "a");
  const launch = processGeneration(20, "old-child", "b");
  const request = { ...baseline.request };
  delete request.reconciliation;
  return {
    sourceGeneration,
    supervisor,
    launch,
    state: parseQueuedDeployState({
      ...baseline,
      request,
      lastSuccessfulDeployment: {
        ...baseline.lastSuccessfulDeployment,
        parentGeneration: { sourceGeneration, supervisor, launch },
      },
    }),
  };
}

function queuedParentObligationWithOldParent({
  targetHead = TARGET_B,
  targetSourceGeneration = "2".repeat(64),
} = {}) {
  const deployed = deployedStateWithParent();
  const attempt = beginDevDeployAttempt(
    queued({
      existing: deployed.state,
      nowMs: 8_000,
      transaction: transaction(targetHead),
      receipt: {
        action: "defer",
        currentHead: deployed.state.lastSuccessfulDeployment.sourceHead,
        targetHead,
        impact: { kind: "parent_reload" },
      },
    }),
    8_000,
  );
  const failed = settleDevDeployAttempt(attempt, {
    attemptGeneration: attempt.generation,
    exitCode: 1,
    receipt: {
      action: "deploy",
      deployed: true,
      targetHead,
      impact: { kind: "parent_reload" },
      expectedParentSourceGeneration: targetSourceGeneration,
      verification: { status: "skew" },
    },
    nowMs: 9_000,
    pollMs: 5_000,
  });
  return {
    ...deployed,
    state: queued({
      existing: failed,
      nowMs: 10_000,
      transaction: transaction(targetHead),
      receipt: {
        action: "defer",
        currentHead: targetHead,
        targetHead,
        impact: { kind: "frontend_reload" },
      },
    }),
  };
}

describe("dev deploy queue state machine", () => {
  it("records one bounded desired deployment", () => {
    const state = queued();
    expect(state).toMatchObject({
      schemaVersion: 5,
      generation: 1,
      worktree: WORKTREE,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      firstQueuedAtMs: 1_000,
      expiresAtMs: 61_000,
      nextAttemptAtMs: 1_000,
      request: {
        attemptArgs: ["--live-worktree", WORKTREE],
        coldBootstrapOperationId: expect.stringMatching(/^[a-f0-9]{64}$/),
        transaction: transaction(),
        observed: {
          targetHead: TARGET_B,
          impact: { kind: "backend_rebuild" },
        },
      },
    });
  });

  it("keeps one cold-bootstrap operation across deferral and same-request coalescing", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const first = queued({
      transaction: selected,
      receipt: {
        action: "defer",
        currentHead: TARGET_A,
        targetHead: TARGET_B,
        impact,
      },
    });
    const operationId = first.request.coldBootstrapOperationId;
    expect(operationId).toMatch(/^[a-f0-9]{64}$/);

    const attempt = submitColdBootstrap(
      beginDevDeployAttempt(first, 2_000),
    );
    expect(attempt.activeAttempt.coldBootstrap).toMatchObject({
      operationId,
      mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
      submittedAtMs: 2_102,
    });
    const deferred = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        action: "defer",
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        impact,
      },
      nowMs: 3_000,
      pollMs: 5_000,
    });
    expect(deferred.request.coldBootstrapOperationId).toBe(operationId);
    expect(deferred.lastAttempt.coldBootstrap.operationId).toBe(operationId);
    const replay = beginDevDeployAttempt(deferred, 8_000);
    expect(replay.request.coldBootstrapOperationId).toBe(operationId);
    expect(replay.activeAttempt.coldBootstrap).toEqual({
      operationId,
      initialRows: 24,
      initialColumns: 80,
      mode:
        DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
      submittedAtMs: 2_102,
      command: COLD_BOOTSTRAP_COMMAND,
      hmuxBuildId: COLD_BOOTSTRAP_HMUX_BUILD_ID,
    });
    expect(parseQueuedDeployState(replay)).toBe(replay);

    const coalesced = queued({
      existing: deferred,
      transaction: selected,
      receipt: {
        action: "defer",
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        impact,
      },
      nowMs: 4_000,
    });
    expect(coalesced.request.coldBootstrapOperationId).toBe(operationId);

    const replayFromAnotherShell = queued({
      existing: deferred,
      transaction: selected,
      executionEnvironment: {
        ...BASE_REQUEST.executionEnvironment,
        PATH: "/another/shell/bin",
      },
      nowMs: 5_000,
    });
    expect(replayFromAnotherShell.request.coldBootstrapOperationId).toBe(
      operationId,
    );
    expect(replayFromAnotherShell.request.executionEnvironment).toEqual(
      deferred.request.executionEnvironment,
    );
    expect(() => queued({
      existing: deferred,
      transaction: selected,
      executionEnvironment: {
        ...BASE_REQUEST.executionEnvironment,
        DURE_HOME: "/different/portable-app",
      },
      nowMs: 5_000,
    })).toThrow(/submitted cold-bootstrap operation must settle/);
    expect(
      beginDevDeployAttempt(replayFromAnotherShell, 8_000).activeAttempt
        .coldBootstrap,
    ).toEqual({
      ...deferred.lastAttempt.coldBootstrap,
      mode:
        DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
    });

    expect(() =>
      queued({
        existing: deferred,
        transaction: {
          ...transaction(TARGET_C),
          selection: { sourceHead: TARGET_B, impact },
        },
        receipt: {
          action: "defer",
          currentHead: TARGET_B,
          targetHead: TARGET_C,
          impact,
        },
        nowMs: 4_000,
      }),
    ).toThrow(/submitted cold-bootstrap operation must settle/);
  });

  it("retires and acknowledges a successful submitted operation before allocating its successor", () => {
    const first = queued();
    const operationId = first.request.coldBootstrapOperationId;
    const created = submitColdBootstrap(
      beginDevDeployAttempt(first, 2_000),
    );
    expect(created.activeAttempt.coldBootstrap.mode).toBe(
      DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
    );
    const succeeded = settleDevDeployAttempt(created, {
      attemptGeneration: first.generation,
      exitCode: 0,
      receipt: coldBootstrapActivationReceipt("backend_rebuild"),
      nowMs: 3_000,
      pollMs: 5_000,
    });
    expect(succeeded.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);

    const impact = completeImpact({ kind: "backend_rebuild" });
    const pending = queued({
      existing: succeeded,
      transaction: transaction(TARGET_C),
      receipt: {
        action: "defer",
        currentHead: TARGET_B,
        targetHead: TARGET_C,
        impact,
      },
      runtimeLiveness: "stale",
      nowMs: 4_000,
    });
    expect(pending.request.coldBootstrapOperationId).toBe(operationId);
    expect(pending.lastAttempt.coldBootstrap).toEqual(
      succeeded.lastAttempt.coldBootstrap,
    );

    const retirementAttempt = attachAttemptExecutor(
      beginDevDeployAttempt(pending, 4_000),
      4_100,
    );
    expect(retirementAttempt.activeAttempt.coldBootstrap).toEqual({
      ...succeeded.lastAttempt.coldBootstrap,
      mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
    });
    const retryPending = settleDevDeployAttempt(retirementAttempt, {
      attemptGeneration: pending.generation,
      exitCode: 0,
      receipt: {
        action: "defer",
        currentHead: TARGET_C,
        targetHead: TARGET_C,
        impact,
      },
      nowMs: 5_000,
      pollMs: 5_000,
    });
    const retirementRetry = attachAttemptExecutor(
      beginDevDeployAttempt(retryPending, 10_000),
      10_100,
    );
    expect(retirementRetry.activeAttempt.coldBootstrap).toEqual({
      ...retryPending.lastAttempt.coldBootstrap,
      mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
    });
    const retired = settleDevDeployAttempt(retirementRetry, {
      attemptGeneration: pending.generation,
      exitCode: 0,
      receipt: retiredColdBootstrapReceipt(
        operationId,
        impact,
        TARGET_C,
      ),
      nowMs: 11_000,
      pollMs: 5_000,
    });
    const successorOperationId = retired.request.coldBootstrapOperationId;
    expect(successorOperationId).not.toBe(operationId);
    expect(retired.request.coldBootstrapRetirementAcknowledgement).toMatchObject({
      operationId,
      command: COLD_BOOTSTRAP_COMMAND,
      hmuxBuildId: COLD_BOOTSTRAP_HMUX_BUILD_ID,
    });

    const acknowledgementAttempt = beginDevDeployAttempt(retired, 16_000);
    expect(
      acknowledgementAttempt.activeAttempt
        .coldBootstrapRetirementAcknowledgement,
    ).toMatchObject({ operationId });
    const acknowledged = settleDevDeployAttempt(acknowledgementAttempt, {
      attemptGeneration: retired.generation,
      exitCode: 0,
      receipt: {
        ...acknowledgedColdBootstrapRetirementReceipt(operationId),
        liveWorktree: WORKTREE,
      },
      nowMs: 17_000,
      pollMs: 5_000,
    });
    expect(
      acknowledged.request.coldBootstrapRetirementAcknowledgement,
    ).toBeUndefined();

    const successorAttempt = beginDevDeployAttempt(acknowledged, 22_000);
    expect(successorAttempt.activeAttempt.coldBootstrap).toEqual({
      operationId: successorOperationId,
      initialRows: acknowledged.request.coldBootstrapInitialRows,
      initialColumns: acknowledged.request.coldBootstrapInitialColumns,
      mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
    });
    expect(
      new Set([
        succeeded.request.coldBootstrapOperationId,
        pending.request.coldBootstrapOperationId,
        retirementAttempt.activeAttempt.coldBootstrap.operationId,
        retirementRetry.activeAttempt.coldBootstrap.operationId,
        retired.request.coldBootstrapRetirementAcknowledgement.operationId,
        acknowledgementAttempt.activeAttempt
          .coldBootstrapRetirementAcknowledgement.operationId,
        retired.request.coldBootstrapOperationId,
        acknowledged.request.coldBootstrapOperationId,
        successorAttempt.activeAttempt.coldBootstrap.operationId,
      ]),
    ).toEqual(new Set([operationId, successorOperationId]));
  });

  it("rejects a new target while an exact bootstrap operation is submitted", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const first = queued({ transaction: selected });
    const active = submitColdBootstrap(beginDevDeployAttempt(first, 2_000));
    const activeOperationId = active.activeAttempt.coldBootstrap.operationId;
    expect(() =>
      queued({
        existing: active,
        transaction: {
          ...transaction(TARGET_C),
          selection: { sourceHead: TARGET_B, impact },
        },
        nowMs: 3_000,
      }),
    ).toThrow(/submitted cold-bootstrap operation must settle/);
    expect(active.activeAttempt.coldBootstrap.operationId).toBe(
      activeOperationId,
    );
  });

  it("does not rewrite an exact in-flight bootstrap envelope", () => {
    const first = queued({
      attemptArgs: ["--live-worktree", WORKTREE, "--port", "1420"],
    });
    const active = submitColdBootstrap(beginDevDeployAttempt(first, 2_000));
    const duplicate = queued({
      existing: active,
      transaction: active.request.transaction,
      attemptArgs: ["--live-worktree", WORKTREE, "--port", "1437"],
      executionEnvironment: {
        HOME: "/different/home",
        PATH: "/different/bin",
        DURE_HOME: "/different/portable-app",
      },
      nowMs: 3_000,
    });

    expect(duplicate).toBe(active);
    expect(duplicate.request.attemptArgs).toContain("1420");
    expect(duplicate.request.executionEnvironment).toEqual(
      active.request.executionEnvironment,
    );
  });

  it.each(["", "/portable-app"])("preserves the explicit app-home selection %j in queue snapshots", (dureHome) => {
    const state = queued({
      executionEnvironment: { ...BASE_REQUEST.executionEnvironment, DURE_HOME: dureHome },
    });
    expect(parseQueuedDeployState(state).request.executionEnvironment.DURE_HOME).toBe(dureHome);
  });

  it("allocates a successor operation after a terminal Hmux refusal", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const first = queued({ transaction: selected });
    const operationId = first.request.coldBootstrapOperationId;
    const failed = settleDevDeployAttempt(
      submitColdBootstrap(beginDevDeployAttempt(first, 2_000)),
      {
        attemptGeneration: first.generation,
        exitCode: 1,
        receipt: {
          action: "deploy",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
          impact,
          plannedTransition: {
            state: "failed",
            hmuxOutcome: "refused",
          },
        },
        nowMs: 3_000,
        pollMs: 5_000,
      },
    );
    const retried = queued({
      existing: failed,
      transaction: selected,
      nowMs: 4_000,
    });

    expect(retried.request.coldBootstrapOperationId).not.toBe(operationId);
  });

  it("queues a fresh operation after exact predecessor retirement without rebinding old dimensions", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const allocated = queued({ transaction: selected });
    const first = {
      ...allocated,
      request: {
        ...allocated.request,
        coldBootstrapInitialRows: 31,
        coldBootstrapInitialColumns: 97,
      },
    };
    const operationId = first.request.coldBootstrapOperationId;
    const attempt = submitColdBootstrap(beginDevDeployAttempt(first, 2_000));
    const pending = settleDevDeployAttempt(attempt, {
      attemptGeneration: first.generation,
      exitCode: 0,
      receipt: retiredColdBootstrapReceipt(operationId, impact),
      nowMs: 3_000,
      pollMs: 5_000,
    });
    const restored = parseQueuedDeployState(
      JSON.parse(JSON.stringify(pending)),
    );

    expect(restored.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(restored.lastAttempt.coldBootstrap.operationId).toBe(operationId);
    expect(restored.request.coldBootstrapOperationId).not.toBe(operationId);
    expect(restored.request.coldBootstrapRetirementAcknowledgement).toEqual({
      operationId,
      sessionName: restored.lastAttempt.receipt.plannedTransition.receipt.hmux
        .sessionName,
      command: COLD_BOOTSTRAP_COMMAND,
      hmuxBuildId: COLD_BOOTSTRAP_HMUX_BUILD_ID,
      initialRows: 31,
      initialColumns: 97,
      retirement: restored.lastAttempt.receipt.plannedTransition.receipt.hmux,
    });

    const acknowledgementAttempt = beginDevDeployAttempt(restored, 8_000);
    expect(acknowledgementAttempt.activeAttempt.coldBootstrap).toBeUndefined();
    expect(
      acknowledgementAttempt.activeAttempt
        .coldBootstrapRetirementAcknowledgement,
    ).toEqual(restored.request.coldBootstrapRetirementAcknowledgement);
    const acknowledged = settleDevDeployAttempt(acknowledgementAttempt, {
      attemptGeneration: restored.generation,
      exitCode: 0,
      receipt: {
        ...acknowledgedColdBootstrapRetirementReceipt(operationId),
        liveWorktree: WORKTREE,
        transaction: acknowledgementAttempt.activeAttempt.transaction,
      },
      nowMs: 9_000,
      pollMs: 5_000,
    });
    expect(
      acknowledged.request.coldBootstrapRetirementAcknowledgement,
    ).toBeUndefined();
    expect(
      beginDevDeployAttempt(acknowledged, 14_000).activeAttempt.coldBootstrap,
    ).toEqual({
      operationId: acknowledged.request.coldBootstrapOperationId,
      initialRows: 24,
      initialColumns: 80,
      mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
    });
  });

  it("does not rotate an operation without an accepted exact retirement", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    for (const scenario of [
      {
        name: "nonzero exit",
        exitCode: 1,
      },
      {
        name: "settlement failure",
        exitCode: 0,
        settlementFailure: { code: "lost_owner", reason: "owner changed" },
      },
      {
        name: "mismatched operation",
        exitCode: 0,
        mutate(receipt) {
          receipt.plannedTransition.receipt.hmux.operationId = "f".repeat(64);
          receipt.plannedTransition.receipt.hmux.sessionId =
            `standalone_${"f".repeat(64)}`;
        },
      },
      {
        name: "malformed workspace",
        exitCode: 0,
        mutate(receipt) {
          receipt.plannedTransition.receipt.hmux.workspaceId = "";
        },
      },
    ]) {
      const first = queued({ transaction: selected });
      const operationId = first.request.coldBootstrapOperationId;
      const receipt = structuredClone(
        retiredColdBootstrapReceipt(operationId, impact),
      );
      scenario.mutate?.(receipt);
      const settled = settleDevDeployAttempt(
        submitColdBootstrap(beginDevDeployAttempt(first, 2_000)),
        {
          attemptGeneration: first.generation,
          exitCode: scenario.exitCode,
          receipt,
          settlementFailure: scenario.settlementFailure,
          nowMs: 3_000,
          pollMs: 5_000,
        },
      );
      expect(
        settled.request.coldBootstrapOperationId,
        scenario.name,
      ).toBe(operationId);
      expect(settled.status, scenario.name).toBe(
        DEV_DEPLOY_QUEUE_STATUS.PENDING,
      );
    }
  });

  it("replays a retirement acknowledgement across both response crash cuts", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const first = queued({ transaction: selected });
    const operationId = first.request.coldBootstrapOperationId;
    const retired = settleDevDeployAttempt(
      submitColdBootstrap(beginDevDeployAttempt(first, 2_000)),
      {
        attemptGeneration: first.generation,
        exitCode: 0,
        receipt: retiredColdBootstrapReceipt(operationId, impact),
        nowMs: 3_000,
        pollMs: 5_000,
      },
    );
    const successorOperationId = retired.request.coldBootstrapOperationId;
    const unrelatedReceipt = coldBootstrapActivationReceipt();
    unrelatedReceipt.impact.parentStrategy = "cold_bootstrap";
    const unrelatedSettlement = settleDevDeployAttempt(
      beginDevDeployAttempt(retired, 7_000),
      {
        attemptGeneration: retired.generation,
        exitCode: 0,
        receipt: unrelatedReceipt,
        nowMs: 7_500,
        pollMs: 5_000,
      },
    );
    expect(unrelatedSettlement).toMatchObject({
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      request: {
        coldBootstrapOperationId: successorOperationId,
        coldBootstrapRetirementAcknowledgement: { operationId },
      },
    });
    const ambiguous = settleDevDeployAttempt(
      beginDevDeployAttempt(retired, 8_000),
      {
        attemptGeneration: retired.generation,
        exitCode: 1,
        receipt: null,
        nowMs: 9_000,
        pollMs: 5_000,
      },
    );

    expect(ambiguous).toMatchObject({
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      request: {
        coldBootstrapOperationId: successorOperationId,
        coldBootstrapRetirementAcknowledgement: { operationId },
      },
      priorFailure: {
        failure: { code: "cold_bootstrap_settlement_pending" },
      },
    });
    expect(() => cancelDevDeploy(ambiguous, 10_000)).toThrow(
      /cold-bootstrap lifecycle work/,
    );
    expect(() => expireDevDeploy(ambiguous, ambiguous.expiresAtMs)).toThrow(
      /cold-bootstrap lifecycle work/,
    );

    const replay = beginDevDeployAttempt(ambiguous, 14_000);
    const binding = {
      attemptId: replay.activeAttempt.attemptId,
      attemptGeneration: replay.activeAttempt.generation,
      transaction: replay.activeAttempt.transaction,
    };
    const attached = attachDevDeployAttemptExecutor(replay, {
      ...binding,
      executor: {
        pid: 81,
        processIdentity: "ack-executor-81",
        observedAtMs: 14_100,
      },
    });
    const completed = recordDevDeployAttemptResult(attached, {
      ...binding,
      completedAtMs: 14_200,
      exitCode: 0,
      receipt: {
        ...acknowledgedColdBootstrapRetirementReceipt(operationId),
        liveWorktree: WORKTREE,
        transaction: replay.activeAttempt.transaction,
      },
    });
    const recovered = reconcileDevDeployAttempt(completed, {
      executorLiveness: "stale",
      nowMs: 14_300,
      pollMs: 5_000,
    });

    expect(recovered.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(recovered.request.coldBootstrapOperationId).toBe(
      successorOperationId,
    );
    expect(
      recovered.request.coldBootstrapRetirementAcknowledgement,
    ).toBeUndefined();
  });

  it("keeps ambiguous submitted work authoritative across a new target", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const first = queued({ transaction: selected });
    const operationId = first.request.coldBootstrapOperationId;
    const pending = settleDevDeployAttempt(
      submitColdBootstrap(beginDevDeployAttempt(first, 2_000)),
      {
        attemptGeneration: first.generation,
        exitCode: 1,
        receipt: null,
        nowMs: 3_000,
        pollMs: 5_000,
      },
    );

    expect(pending).toMatchObject({
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      request: { coldBootstrapOperationId: operationId },
      priorFailure: {
        failure: { code: "cold_bootstrap_settlement_pending" },
      },
    });
    expect(beginDevDeployAttempt(pending, 8_000).activeAttempt.coldBootstrap)
      .toEqual({
        ...pending.lastAttempt.coldBootstrap,
        mode:
          DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
      });
    expect(() =>
      queued({
        existing: pending,
        transaction: {
          ...transaction(TARGET_C),
          selection: { sourceHead: TARGET_B, impact },
        },
        nowMs: 4_000,
      }),
    ).toThrow(/submitted cold-bootstrap operation must settle/);
  });

  it("opens a fresh bounded window only after exact late retirement", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const first = queued({ transaction: selected });
    const operationId = first.request.coldBootstrapOperationId;
    const retiredAtMs = first.expiresAtMs + 9_000;
    const pending = settleDevDeployAttempt(
      submitColdBootstrap(beginDevDeployAttempt(first, 2_000)),
      {
        attemptGeneration: first.generation,
        exitCode: 0,
        receipt: retiredColdBootstrapReceipt(operationId, impact),
        nowMs: retiredAtMs,
        pollMs: 5_000,
      },
    );

    expect(pending.firstQueuedAtMs).toBe(retiredAtMs);
    expect(pending.requestedAtMs).toBe(retiredAtMs);
    expect(pending.expiresAtMs).toBe(retiredAtMs + 60_000);
    expect(pending.request.coldBootstrapOperationId).not.toBe(operationId);
    expect(
      beginDevDeployAttempt(pending, pending.nextAttemptAtMs).status,
    ).toBe(DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING);
  });

  it("keeps the live successor after an older operation was refused", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const first = queued({ transaction: selected });
    const refusedOperationId = first.request.coldBootstrapOperationId;
    const failed = settleDevDeployAttempt(
      submitColdBootstrap(beginDevDeployAttempt(first, 2_000)),
      {
        attemptGeneration: first.generation,
        exitCode: 1,
        receipt: {
          action: "deploy",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
          impact,
          plannedTransition: {
            state: "failed",
            hmuxOutcome: "refused",
          },
        },
        nowMs: 3_000,
        pollMs: 5_000,
      },
    );
    const successor = queued({
      existing: failed,
      transaction: selected,
      nowMs: 4_000,
    });
    const successorOperationId = successor.request.coldBootstrapOperationId;
    const active = submitColdBootstrap(
      beginDevDeployAttempt(successor, 4_100),
      4_200,
    );
    const coalesced = queued({
      existing: active,
      transaction: selected,
      nowMs: 5_000,
    });

    expect(successorOperationId).not.toBe(refusedOperationId);
    expect(coalesced.request.coldBootstrapOperationId).toBe(
      successorOperationId,
    );
    expect(coalesced.activeAttempt.coldBootstrap.operationId).toBe(
      successorOperationId,
    );
  });

  it("rotates the operation when its worktree, port, or bootstrap environment changes", () => {
    const first = queued({
      attemptArgs: ["--live-worktree", WORKTREE, "--port", "1420"],
    });
    const operationId = first.request.coldBootstrapOperationId;
    const portChanged = queued({
      existing: first,
      attemptArgs: ["--live-worktree", WORKTREE, "--port", "1437"],
      nowMs: 2_000,
    });
    const pathChanged = queued({
      existing: first,
      attemptArgs: ["--live-worktree", WORKTREE, "--port", "1420"],
      executionEnvironment: {
        ...BASE_REQUEST.executionEnvironment,
        PATH: "/different/bin",
      },
      nowMs: 2_000,
    });
    const homeChanged = queued({
      existing: first,
      attemptArgs: ["--live-worktree", WORKTREE, "--port", "1420"],
      executionEnvironment: {
        ...BASE_REQUEST.executionEnvironment,
        HOME: "/different/home",
      },
      nowMs: 2_000,
    });
    const appHomeChanged = queued({
      existing: first,
      attemptArgs: ["--live-worktree", WORKTREE, "--port", "1420"],
      executionEnvironment: {
        ...BASE_REQUEST.executionEnvironment,
        DURE_HOME: "/different/portable-app",
      },
      nowMs: 2_000,
    });
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(first, 2_000),
      {
        attemptGeneration: first.generation,
        exitCode: 1,
        receipt: null,
        nowMs: 3_000,
        pollMs: 5_000,
      },
    );
    const otherWorktree = "/tmp/other-live";
    const worktreeChanged = queued({
      existing: failed,
      worktree: otherWorktree,
      attemptArgs: ["--live-worktree", otherWorktree, "--port", "1420"],
      nowMs: 4_000,
    });

    expect(portChanged.request.coldBootstrapOperationId).not.toBe(operationId);
    expect(pathChanged.request.coldBootstrapOperationId).not.toBe(operationId);
    expect(homeChanged.request.coldBootstrapOperationId).not.toBe(operationId);
    expect(appHomeChanged.request.coldBootstrapOperationId).not.toBe(operationId);
    expect(worktreeChanged.request.coldBootstrapOperationId).not.toBe(
      operationId,
    );
  });

  it("routes stale activation history through exact target reconciliation", () => {
    const deployed = deployedStateWithParent({ sourceHead: TARGET_A }).state;
    const parentImpact = completeImpact({ kind: "parent_reload" });
    const next = queued({
      existing: deployed,
      transaction: {
        ...transaction(TARGET_B),
        selection: { sourceHead: TARGET_A, impact: parentImpact },
      },
      receipt: {
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        pendingCommits: 0,
        impact: parentImpact,
      },
      nowMs: 8_000,
    });

    expect(next.request.reconciliation).toEqual({
      kind: "parent_generation",
      targetHead: TARGET_B,
    });
    expect(next.request.transaction.selection?.impact).toEqual(parentImpact);
    expect(next.lastSuccessfulDeployment.sourceHead).toBe(TARGET_A);
  });

  it("settles non-parent activation debt without inventing parent reconciliation", () => {
    const deployedWithParent = deployedStateWithParent({
      sourceHead: TARGET_A,
    }).state;
    const lastSuccessfulDeployment = {
      ...deployedWithParent.lastSuccessfulDeployment,
    };
    delete lastSuccessfulDeployment.parentGeneration;
    const deployed = parseQueuedDeployState({
      ...deployedWithParent,
      lastSuccessfulDeployment,
    });
    const backendImpact = completeImpact({ kind: "backend_rebuild" });
    const next = queued({
      existing: deployed,
      transaction: {
        ...transaction(TARGET_B),
        selection: { sourceHead: TARGET_A, impact: backendImpact },
      },
      receipt: {
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        pendingCommits: 0,
        impact: backendImpact,
      },
      nowMs: 8_000,
    });

    expect(next.request.reconciliation).toBeUndefined();
    expect(next.request.transaction.selection?.impact).toEqual(backendImpact);

    const deferredAttempt = beginDevDeployAttempt(next, 8_500);
    const deferred = settleDevDeployAttempt(deferredAttempt, {
      attemptGeneration: deferredAttempt.generation,
      exitCode: 0,
      receipt: {
        action: "defer",
        currentHead: TARGET_A,
        targetHead: TARGET_B,
        impact: backendImpact,
      },
      nowMs: 9_000,
      pollMs: 5_000,
    });
    expect(deferred.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(deferred.request.reconciliation).toBeUndefined();

    const attempt = beginDevDeployAttempt(deferred, 14_000);
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        ...validActivationReceipt("backend_rebuild"),
        currentHead: TARGET_A,
      },
      nowMs: 15_000,
      pollMs: 5_000,
    });

    expect(settled.status, settled.failure?.code).toBe(
      DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
    );
    expect(settled.finalReceipt).toMatchObject({
      action: "deploy",
      impact: { kind: "backend_rebuild" },
    });
    expect(settled.request.reconciliation).toBeUndefined();
    expect(settled.priorFailure).toBeUndefined();
    expect(settled.lastSuccessfulDeployment).toMatchObject({
      sourceHead: TARGET_B,
      backendHead: TARGET_B,
      runtime: { generation: "backend_rebuild-app-generation" },
    });
    expect(settled.lastSuccessfulDeployment.parentGeneration).toBeUndefined();
  });

  it("rejects an application backend receipt without exact child activation", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 2,
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "backend_rebuild" },
        dispatchAccepted: true,
      },
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_deploy_receipt");
    expect(settled.lastSuccessfulDeployment).toBeUndefined();
  });

  it("rejects an application frontend receipt without a live parent generation", () => {
    const selectedTransaction = {
      ...transaction(),
      selection: {
        sourceHead: TARGET_A,
        impact: completeImpact({ kind: "frontend_reload" }),
      },
    };
    const attempt = beginDevDeployAttempt(
      queued({ transaction: selectedTransaction }),
      6_000,
    );
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 2,
        action: "deploy",
        deployed: true,
        currentHead: TARGET_A,
        targetHead: TARGET_B,
        impact: { kind: "frontend_reload" },
        frontendTransition: { status: "dispatched", reloaded: ["main"] },
        dispatchAccepted: true,
      },
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_deploy_receipt");
    expect(settled.lastSuccessfulDeployment).toBeUndefined();
  });

  it("rejects an application backend receipt without exact control-plane activation", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 2,
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "backend_rebuild" },
        plannedTransition: childRestartTransition(),
        dispatchAccepted: true,
      },
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_deploy_receipt");
    expect(settled.lastSuccessfulDeployment).toBeUndefined();
  });

  it("accepts an application backend receipt with exact payload and child activation", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const controlPlaneActivation = controlPlaneActivationProof();
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 2,
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "backend_rebuild" },
        controlPlaneActivation,
        plannedTransition: childRestartTransition(),
        dispatchAccepted: true,
      },
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status, settled.failure?.code).toBe(
      DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
    );
    expect(settled.lastSuccessfulDeployment).toMatchObject({
      sourceHead: TARGET_B,
      backendHead: TARGET_B,
      controlPlaneActivation,
    });
  });

  it("requires fresh app runtime readiness from receipt v3 backend deploys", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const plannedTransition = childRestartTransition();
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 3,
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "backend_rebuild" },
        controlPlaneActivation: controlPlaneActivationProof(),
        plannedTransition,
        dispatchAccepted: true,
      },
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_deploy_receipt");
  });

  it("accepts a receipt v3 backend only when runtime and launch converge", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const plannedTransition = childRestartTransition();
    const runtime = readyApplicationRuntime(
      plannedTransition.receipt.launch,
    );
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 3,
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "backend_rebuild" },
        controlPlaneActivation: controlPlaneActivationProof(),
        plannedTransition,
        runtime,
        dispatchAccepted: true,
      },
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status, settled.failure?.code).toBe(
      DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
    );
    expect(settled.lastSuccessfulDeployment?.runtime).toEqual(runtime);
  });

  it("rejects an application parent receipt without exact parent activation", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 2,
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "parent_reload" },
        dispatchAccepted: true,
      },
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_deploy_receipt");
  });

  it("projects exact application parent activation over stale history", () => {
    const previous = deployedStateWithParent();
    const pending = queued({
      existing: previous.state,
      nowMs: 8_000,
      receipt: {
        action: "defer",
        currentHead: TARGET_A,
        targetHead: TARGET_B,
        impact: { kind: "parent_reload" },
      },
    });
    const attempt = beginDevDeployAttempt(pending, 8_500);
    const receipt = {
      ...validActivationReceipt("parent_reload"),
      deployReceiptVersion: 2,
      dispatchAccepted: true,
    };
    receipt.plannedTransition = {
      ...receipt.plannedTransition,
      state: "restarted",
      attempted: true,
      destructiveBoundaryCrossed: true,
    };
    delete receipt.verification;
    delete receipt.runtime;
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt,
      nowMs: 9_000,
      pollMs: 5_000,
    });

    expect(settled.status, settled.failure?.code).toBe(
      DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
    );
    expect(settled.lastSuccessfulDeployment.parentGeneration).toEqual({
      sourceGeneration: receipt.expectedParentSourceGeneration,
      supervisor: receipt.plannedTransition.receipt.supervisor,
      launch: receipt.plannedTransition.receipt.launch,
    });
    expect(settled.lastSuccessfulDeployment.parentGeneration).not.toEqual({
      sourceGeneration: previous.sourceGeneration,
      supervisor: previous.supervisor,
      launch: previous.launch,
    });
  });

  it.each([undefined, "6".repeat(64)])(
    "binds application parent cold bootstrap to target generation %s",
    (expectedParentSourceGeneration) => {
      const attempt = beginDevDeployAttempt(queued(), 6_000);
      const receipt = {
        ...coldBootstrapActivationReceipt(),
        deployReceiptVersion: 2,
        dispatchAccepted: true,
        expectedParentSourceGeneration,
      };
      if (expectedParentSourceGeneration === undefined) {
        delete receipt.expectedParentSourceGeneration;
      }
      delete receipt.verification;
      delete receipt.runtime;
      const settled = settleDevDeployAttempt(attempt, {
        attemptGeneration: attempt.generation,
        exitCode: 0,
        receipt,
        nowMs: 7_000,
        pollMs: 5_000,
      });

      expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
      expect(settled.failure.code).toBe("unverified_deploy_receipt");
    },
  );

  it.each(["child_restart", "backend_rebuild"])(
    "projects an exact application %s restart over stale launch history",
    (kind) => {
      const previous = deployedStateWithParent();
      const pending = queued({
        existing: previous.state,
        nowMs: 8_000,
        receipt: {
          action: "defer",
          currentHead: TARGET_A,
          targetHead: TARGET_B,
          impact: { kind },
        },
      });
      const attempt = beginDevDeployAttempt(pending, 8_500);
      const launch = processGeneration(21, "new-child", "c");
      const plannedTransition = childRestartTransition({
        supervisor: previous.supervisor,
        previousLaunch: previous.launch,
        launch,
      });
      plannedTransition.receipt.kind = "parent_reload";
      plannedTransition.receipt.activatedGeneration = {
        sourceGeneration: "9".repeat(64),
        supervisor: processGeneration(99, "forged-parent", "d"),
        launch: processGeneration(100, "forged-child", "e"),
      };
      const settled = settleDevDeployAttempt(attempt, {
        attemptGeneration: attempt.generation,
        exitCode: 0,
        receipt: {
          deployReceiptVersion: 2,
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind },
          ...(kind === "backend_rebuild"
            ? { controlPlaneActivation: controlPlaneActivationProof() }
            : {}),
          plannedTransition,
          dispatchAccepted: true,
        },
        nowMs: 9_000,
        pollMs: 5_000,
      });

      expect(settled.status, settled.failure?.code).toBe(
        DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
      );
      expect(settled.lastSuccessfulDeployment.parentGeneration).toEqual({
        sourceGeneration: previous.sourceGeneration,
        supervisor: previous.supervisor,
        launch,
      });
    },
  );

  it("rejects an application child deploy skipped without activation", () => {
    const previous = deployedStateWithParent();
    const pending = queued({
      existing: previous.state,
      nowMs: 8_000,
      receipt: {
        action: "defer",
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        impact: { kind: "child_restart" },
      },
    });
    const attempt = beginDevDeployAttempt(pending, 8_500);
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 2,
        action: "skip",
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        impact: { kind: "child_restart" },
      },
      nowMs: 9_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_skip_receipt");
    expect(settled.lastSuccessfulDeployment.parentGeneration).toEqual({
      sourceGeneration: previous.sourceGeneration,
      supervisor: previous.supervisor,
      launch: previous.launch,
    });
  });

  it("rejects application parent reconciliation without activation", () => {
    const pending = queued();
    const request = {
      ...pending.request,
      reconciliation: { kind: "parent_generation", targetHead: TARGET_B },
    };
    const attempt = beginDevDeployAttempt({ ...pending, request }, 8_500);
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 2,
        action: "skip",
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        impact: { kind: "frontend_reload", changedPathCount: 0 },
      },
      nowMs: 9_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_parent_reconciliation");
    expect(settled.request.reconciliation).toEqual({
      kind: "parent_generation",
      targetHead: TARGET_B,
    });
  });

  it.each([
    ["child_restart", false],
    ["parent_reload", false],
    ["child_restart", true],
    ["parent_reload", true],
  ])(
    "rejects an application skip that downgrades selected %s impact (legacy reconciliation: %s)",
    (kind, withLegacyReconciliation) => {
      const selectedTransaction = {
        ...transaction(),
        selection: {
          sourceHead: TARGET_A,
          impact: completeImpact({ kind }),
        },
      };
      const attempt = beginDevDeployAttempt(
        queued({ transaction: selectedTransaction }),
        8_500,
      );
      const settled = settleDevDeployAttempt(attempt, {
        attemptGeneration: attempt.generation,
        exitCode: 0,
        receipt: {
          deployReceiptVersion: 2,
          action: "skip",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload", changedPathCount: 0 },
          ...(withLegacyReconciliation
            ? {
                reconciliation: {
                  kind: "parent_generation",
                  targetHead: TARGET_B,
                },
              }
            : {}),
        },
        nowMs: 9_000,
        pollMs: 5_000,
      });

      expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
      expect(settled.failure.code).toBe("deploy_transaction_mismatch");
    },
  );

  it("clears stale parent identity when an exact child restart has a new supervisor", () => {
    const previous = deployedStateWithParent();
    const pending = queued({
      existing: previous.state,
      nowMs: 8_000,
      receipt: {
        action: "defer",
        currentHead: TARGET_A,
        targetHead: TARGET_B,
        impact: { kind: "child_restart" },
      },
    });
    const attempt = beginDevDeployAttempt(pending, 8_500);
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 2,
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "child_restart" },
        plannedTransition: childRestartTransition({
          supervisor: processGeneration(30, "new-parent", "d"),
          previousLaunch: processGeneration(31, "new-parent-child", "e"),
          launch: processGeneration(32, "restarted-child", "f"),
        }),
        dispatchAccepted: true,
      },
      nowMs: 9_000,
      pollMs: 5_000,
    });

    expect(settled.status, settled.failure?.code).toBe(
      DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
    );
    expect(settled.lastSuccessfulDeployment).not.toHaveProperty(
      "parentGeneration",
    );
  });

  it.each(["frontend_reload", "backend_rebuild"])(
    "accepts exact cold bootstrap as application %s activation",
    (kind) => {
      const attempt = beginDevDeployAttempt(queued(), 6_000);
      const receipt = {
        ...coldBootstrapActivationReceipt(kind),
        deployReceiptVersion: 2,
        dispatchAccepted: true,
        ...(kind === "backend_rebuild"
          ? { controlPlaneActivation: controlPlaneActivationProof() }
          : {}),
      };
      delete receipt.verification;
      delete receipt.runtime;
      const settled = settleDevDeployAttempt(attempt, {
        attemptGeneration: attempt.generation,
        exitCode: 0,
        receipt,
        nowMs: 7_000,
        pollMs: 5_000,
      });

      expect(settled.status, settled.failure?.code).toBe(
        DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
      );
      expect(settled.lastSuccessfulDeployment).toMatchObject({
        sourceHead: TARGET_B,
        ...(kind === "backend_rebuild" ? { backendHead: TARGET_B } : {}),
        parentGeneration: {
          sourceGeneration: "5".repeat(64),
        },
      });
    },
  );

  it("projects exact cold-bootstrap authority from an application skip", () => {
    const previous = deployedStateWithParent();
    const pending = queued({
      existing: previous.state,
      nowMs: 8_000,
      receipt: {
        action: "defer",
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        impact: { kind: "parent_reload" },
      },
    });
    const attempt = beginDevDeployAttempt(pending, 8_500);
    const receipt = {
      ...coldBootstrapActivationReceipt("parent_reload"),
      deployReceiptVersion: 2,
      action: "skip",
      currentHead: TARGET_B,
      dispatchAccepted: true,
    };
    delete receipt.verification;
    delete receipt.runtime;
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt,
      nowMs: 9_000,
      pollMs: 5_000,
    });

    expect(settled.status, settled.failure?.code).toBe(
      DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
    );
    expect(settled.lastSuccessfulDeployment.parentGeneration).toEqual({
      sourceGeneration:
        receipt.plannedTransition.receipt.parentGeneration.sourceGeneration,
      supervisor:
        receipt.plannedTransition.receipt.parentGeneration.supervisor,
      launch: receipt.plannedTransition.receipt.parentGeneration.launch,
    });
    expect(settled.request.reconciliation).toBeUndefined();
  });

  it.each([false, true])(
    "requires residual child authority after application parent convergence (%s)",
    (withResidual) => {
      const previous = deployedStateWithParent();
      const pending = queued({
        existing: previous.state,
        nowMs: 8_000,
        receipt: {
          action: "defer",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
          impact: { kind: "backend_rebuild" },
        },
      });
      const request = {
        ...pending.request,
        reconciliation: { kind: "parent_generation", targetHead: TARGET_B },
      };
      const attempt = beginDevDeployAttempt({ ...pending, request }, 8_500);
      const receipt = {
        ...(withResidual
          ? convergedParentActivationWithResidualReceipt()
          : convergedParentActivationReceipt()),
        deployReceiptVersion: 2,
        action: "skip",
        currentHead: TARGET_B,
        impact: completeImpact({ kind: "backend_rebuild" }),
        controlPlaneActivation: controlPlaneActivationProof(),
        dispatchAccepted: true,
      };
      delete receipt.verification;
      delete receipt.runtime;
      const settled = settleDevDeployAttempt(attempt, {
        attemptGeneration: attempt.generation,
        exitCode: 0,
        receipt,
        nowMs: 9_000,
        pollMs: 5_000,
      });

      if (!withResidual) {
        expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
        expect(settled.failure.code).toBe(
          "unverified_parent_reconciliation",
        );
        return;
      }
      expect(settled.status, settled.failure?.code).toBe(
        DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
      );
      expect(settled.lastSuccessfulDeployment.parentGeneration.launch).toEqual(
        receipt.residualTransition.receipt.launch,
      );
      expect(settled.lastSuccessfulDeployment.backendHead).toBe(TARGET_B);
    },
  );

  it.each([false, true])(
    "preserves a subordinate child obligation in parent impact (%s)",
    (withResidual) => {
      const impact = completeImpact({
        kind: "parent_reload",
        backendChanged: false,
        changedPathCount: 2,
        parentStrategy: "exec_handoff",
        childRestartRequired: true,
      });
      const pending = queued({
        nowMs: 8_000,
        receipt: {
          action: "defer",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
          impact,
        },
      });
      const attempt = beginDevDeployAttempt(pending, 8_500);
      const receipt = {
        ...(withResidual
          ? convergedParentActivationWithResidualReceipt()
          : convergedParentActivationReceipt()),
        deployReceiptVersion: 2,
        action: "skip",
        currentHead: TARGET_B,
        impact,
        dispatchAccepted: true,
      };
      delete receipt.verification;
      delete receipt.runtime;
      const settled = settleDevDeployAttempt(attempt, {
        attemptGeneration: attempt.generation,
        exitCode: 0,
        receipt,
        nowMs: 9_000,
        pollMs: 5_000,
      });

      if (!withResidual) {
        expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
        expect(settled.failure.code).toBe("unverified_skip_receipt");
        return;
      }
      expect(settled.status, settled.failure?.code).toBe(
        DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
      );
      expect(settled.lastSuccessfulDeployment.parentGeneration.launch).toEqual(
        receipt.residualTransition.receipt.launch,
      );
    },
  );

  it("coalesces a newer target without extending the absolute wait bound", () => {
    const first = queued();
    const second = queued({
      existing: first,
      nowMs: 10_000,
      receipt: {
        action: "defer",
        targetHead: TARGET_C,
        pendingCommits: 3,
      },
    });
    expect(second.generation).toBe(2);
    expect(second.firstQueuedAtMs).toBe(1_000);
    expect(second.expiresAtMs).toBe(61_000);
    expect(second.request.observed).toMatchObject({
      targetHead: TARGET_C,
      pendingCommits: 3,
    });
    expect(second.request.observed.impact).toBeUndefined();
  });

  it("does not project an older target impact onto a coalesced target", () => {
    const first = queued({
      receipt: {
        action: "defer",
        currentHead: TARGET_A,
        targetHead: TARGET_B,
        pendingCommits: 1,
        impact: {
          kind: "frontend_reload",
          backendChanged: false,
          changedPathCount: 2,
        },
      },
    });
    const second = enqueueDevDeploy({
      ...BASE_REQUEST,
      existing: first,
      transaction: transaction(TARGET_C),
      receipt: null,
      nowMs: 10_000,
    });

    expect(second.request.transaction.targetHead).toBe(TARGET_C);
    expect(second.request.observed).toEqual({});
  });

  it("keeps explicit force urgency only across a descendant coalesced target", () => {
    const forced = queued({
      attemptArgs: ["--force", "--live-worktree", WORKTREE],
    });
    const descendant = enqueueDevDeploy({
      ...BASE_REQUEST,
      existing: forced,
      transaction: transaction(TARGET_C),
      attemptArgs: ["--live-worktree", WORKTREE],
      receipt: null,
      nowMs: 10_000,
      targetDescendsFrom: (ancestor, target) =>
        ancestor === TARGET_B && target === TARGET_C,
    });
    expect(descendant.request.attemptArgs).toContain("--force");

    const unrelated = enqueueDevDeploy({
      ...BASE_REQUEST,
      existing: descendant,
      transaction: transaction(TARGET_X),
      attemptArgs: ["--live-worktree", WORKTREE],
      receipt: null,
      nowMs: 11_000,
      targetDescendsFrom: () => false,
    });
    expect(unrelated.request.attemptArgs).not.toContain("--force");

    const afterSettlement = enqueueDevDeploy({
      ...BASE_REQUEST,
      existing: cancelDevDeploy(forced, 10_500),
      transaction: transaction(TARGET_C),
      attemptArgs: ["--live-worktree", WORKTREE],
      receipt: null,
      nowMs: 11_000,
      targetDescendsFrom: () => {
        throw new Error("a settled queue has no force lineage");
      },
    });
    expect(afterSettlement.request.attemptArgs).not.toContain("--force");
  });

  it("reuses only an exact terminal proof with the same live runtime and executor", () => {
    const pending = queued();
    const succeeded = settleDevDeployAttempt(
      beginDevDeployAttempt(pending, 6_000),
      {
        attemptGeneration: pending.generation,
        exitCode: 0,
        receipt: validActivationReceipt("frontend_reload"),
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const exactRequest = {
      ...BASE_REQUEST,
      existing: succeeded,
      transaction: transaction(TARGET_B),
      receipt: {
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        pendingCommits: 0,
        impact: completeImpact({
          kind: "frontend_reload",
          changedPathCount: 0,
        }),
      },
      nowMs: 8_000,
      runtimeLiveness: "active",
    };

    expect(enqueueDevDeploy(exactRequest)).toBe(succeeded);
    for (const dureHome of ["", "/another-app"]) {
      expect(enqueueDevDeploy({
        ...exactRequest,
        executionEnvironment: { ...BASE_REQUEST.executionEnvironment, DURE_HOME: dureHome },
      }).generation).toBe(succeeded.generation + 1);
    }
    expect(
      enqueueDevDeploy({ ...exactRequest, runtimeLiveness: "stale" }).generation,
    ).toBe(succeeded.generation + 1);
    expect(
      enqueueDevDeploy({
        ...exactRequest,
        attemptArgs: ["--force", "--live-worktree", WORKTREE],
      }).generation,
    ).toBe(succeeded.generation + 1);
    expect(
      enqueueDevDeploy({
        ...exactRequest,
        transaction: {
          ...transaction(TARGET_B),
          executor: {
            generation: "9".repeat(64),
            entrypoint:
              `/tmp/executors-v1/${"9".repeat(64)}/scripts/deploy-dev-app.mjs`,
          },
        },
      }).generation,
    ).toBe(succeeded.generation + 1);
    expect(
      enqueueDevDeploy({
        ...exactRequest,
        existing: parseQueuedDeployState({
          ...succeeded,
          finalReceipt: { ...succeeded.finalReceipt, liveVerified: false },
        }),
      }).generation,
    ).toBe(succeeded.generation + 1);
  });

  it("keeps verified source, backend, and runtime truth across an interrupted generation", () => {
    const backendDeployment = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          backendChanged: true,
          impact: { kind: "backend_rebuild" },
          verification: {
            status: "ok",
            controlPlaneActivation: controlPlaneActivationProof(),
          },
          runtime: {
            pid: 41,
            processIdentity: "runtime-41",
            observedAtMs: 6_500,
            buildId: "0.1.4+bbb",
          },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    expect(lastSuccessfulDeploymentFor(backendDeployment)).toEqual({
      sourceHead: TARGET_B,
      backendHead: TARGET_B,
      controlPlaneActivation: controlPlaneActivationProof(),
      verifiedAtMs: 7_000,
      runtime: {
        pid: 41,
        processIdentity: "runtime-41",
        observedAtMs: 6_500,
        buildId: "0.1.4+bbb",
      },
    });

    const frontendRequest = queued({
      existing: backendDeployment,
      nowMs: 8_000,
      transaction: transaction(TARGET_C),
      receipt: { action: "defer", targetHead: TARGET_C },
    });
    const frontendDeployment = settleDevDeployAttempt(
      beginDevDeployAttempt(frontendRequest, 8_000),
      {
        attemptGeneration: frontendRequest.generation,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_C,
          backendChanged: false,
          impact: { kind: "frontend_reload" },
          verification: { status: "ok" },
          runtime: {
            pid: 42,
            processIdentity: "runtime-42",
            observedAtMs: 8_500,
          },
        },
        nowMs: 9_000,
        pollMs: 5_000,
      },
    );
    expect(frontendDeployment.lastSuccessfulDeployment).toMatchObject({
      sourceHead: TARGET_C,
      backendHead: TARGET_B,
      runtime: { pid: 42, processIdentity: "runtime-42" },
    });

    const interrupted = reconcileDevDeployAttempt(
      beginDevDeployAttempt(
        queued({ existing: frontendDeployment, nowMs: 10_000 }),
        10_000,
      ),
      { executorLiveness: "stale", nowMs: 11_000, pollMs: 5_000 },
    );
    expect(interrupted.failure.code).toBe("deploy_attempt_interrupted");
    expect(interrupted.lastSuccessfulDeployment).toEqual(
      frontendDeployment.lastSuccessfulDeployment,
    );
  });

  it("fences a different live checkout only while the verified runtime is active", () => {
    const deployed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload" },
          verification: { status: "ok" },
          runtime: {
            pid: 41,
            processIdentity: "runtime-41",
            observedAtMs: 6_500,
          },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );

    expect(() =>
      assertLiveWorktreeSelection(deployed, "/tmp/not-live", "active"),
    ).toThrow(/live_worktree_mismatch/);
    expect(() =>
      assertLiveWorktreeSelection(deployed, "/tmp/not-live", "stale"),
    ).not.toThrow();
  });

  it("lets a fresh request replace a pending generation whose deadline passed", () => {
    const first = queued();
    const replacement = queued({
      existing: first,
      worktree: "/tmp/other-live",
      nowMs: first.expiresAtMs + 1,
    });
    expect(replacement.worktree).toBe("/tmp/other-live");
    expect(replacement.firstQueuedAtMs).toBe(first.expiresAtMs + 1);
    expect(replacement.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
  });

  it("replaces failed generation 410 with a new exact-target executor", () => {
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 1,
        receipt: null,
        stderr: "old staged executor rejected the request",
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const generation410 = parseQueuedDeployState({
      ...failed,
      generation: 410,
      lastAttempt: { ...failed.lastAttempt, generation: 410 },
    });
    const exactTarget = "c".repeat(40);
    const newExecutorGeneration = "9".repeat(64);
    const newTransaction = {
      ...transaction(exactTarget),
      targetAuthority: "exact-local-candidate",
      executor: {
        generation: newExecutorGeneration,
        entrypoint:
          `/tmp/executors-v1/${newExecutorGeneration}/scripts/deploy-dev-app.mjs`,
      },
    };

    const replacement = queued({
      existing: generation410,
      attemptArgs: ["--live-worktree", WORKTREE],
      transaction: newTransaction,
      nowMs: 8_000,
    });

    expect(replacement).toMatchObject({
      generation: 411,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      firstQueuedAtMs: 8_000,
      expiresAtMs: 68_000,
      attempts: 0,
      request: {
        attemptArgs: ["--live-worktree", WORKTREE],
        transaction: newTransaction,
      },
      priorFailure: {
        failure: { code: "deploy_attempt_failed" },
      },
    });
    expect(replacement.request.transaction.executor.generation).not.toBe(
      generation410.request.transaction.executor.generation,
    );
  });

  it("does not let another live worktree replace the machine queue", () => {
    expect(() =>
      queued({ existing: queued(), worktree: "/tmp/other-live" }),
    ).toThrow(/already owns/);
  });

  it("does not carry terminal parent history into another worktree", () => {
    const deployed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload" },
          verification: { status: "ok" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const terminal = parseQueuedDeployState({
      ...deployed,
      request: {
        ...deployed.request,
        reconciliation: {
          kind: "parent_generation",
          targetHead: TARGET_B,
        },
      },
    });
    expect(terminal.request.reconciliation.targetHead).toBe(TARGET_B);

    const otherWorktree = "/tmp/other-live";
    const replacement = queued({
      existing: terminal,
      worktree: otherWorktree,
      attemptArgs: ["--live-worktree", otherWorktree],
      nowMs: 8_000,
      receipt: {
        action: "defer",
        currentHead: TARGET_X,
        targetHead: TARGET_Y,
        impact: { kind: "frontend_reload" },
      },
    });
    expect(replacement.request.reconciliation).toBeUndefined();
    expect(replacement.lastSuccessfulDeployment).toBeUndefined();
  });

  it("keeps a newer generation pending after an older attempt completes", () => {
    const attempting = beginDevDeployAttempt(queued(), 6_000);
    const superseded = queued({
      existing: attempting,
      nowMs: 7_000,
      receipt: { action: "defer", targetHead: TARGET_C },
    });
    const settled = settleDevDeployAttempt(superseded, {
      attemptGeneration: 1,
      exitCode: 0,
      receipt: { action: "deploy", targetHead: TARGET_B },
      nowMs: 8_000,
      pollMs: 5_000,
    });
    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(settled.generation).toBe(2);
    expect(settled.request.observed.targetHead).toBe(TARGET_C);
  });

  it.each([false, true])("refreshes exact pending selections regardless of impact key order: %s", (reordered) => {
    const attempting = beginDevDeployAttempt(queued(), 6_000);
    const superseded = queued({
      existing: attempting,
      nowMs: 7_000,
      receipt: { action: "defer", currentHead: TARGET_A, targetHead: TARGET_C },
    });
    const pending = settleDevDeployAttempt(superseded, {
      attemptGeneration: 1,
      exitCode: 0,
      receipt: {
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "frontend_reload" },
        verification: { status: "ok" },
      },
      nowMs: 8_000,
      pollMs: 5_000,
    });
    const impact = {
      kind: "parent_reload",
      backendChanged: true,
      changedPathCount: 105,
      hmuxRuntimeChanged: true,
      controlPlanePayloadChanged: true,
      parentStrategy: "exec_handoff",
      childRestartRequired: true,
    };
    const refreshedTransaction = {
      ...transaction(TARGET_C),
      selection: { sourceHead: TARGET_B, impact },
    };
    const receipt = {
      currentHead: TARGET_B,
      targetHead: TARGET_C,
      impact: reordered
        ? Object.fromEntries(Object.entries(impact).reverse())
        : impact,
    };
    const refreshed = refreshPendingDevDeploySelection(pending, {
      transaction: refreshedTransaction,
      receipt,
    });
    expect(refreshed.generation).toBe(pending.generation);
    expect(refreshed.expiresAtMs).toBe(pending.expiresAtMs);
    expect(refreshed.attempts).toBe(pending.attempts);
    expect(beginDevDeployAttempt(refreshed, 14_000).activeAttempt.transaction)
      .toEqual(refreshedTransaction);

    for (const invalidReceipt of [
      { ...receipt, currentHead: TARGET_A },
      { ...receipt, targetHead: TARGET_B },
      { ...receipt, impact: { ...impact, hmuxRuntimeChanged: false } },
      { ...receipt, impact: { ...impact, controlPlanePayloadChanged: false } },
      { ...receipt, impact: { ...impact, changedPathCount: 104 } },
      { ...receipt, impact: { ...impact, backendChanged: false } },
      { ...receipt, impact: { ...impact, parentStrategy: "cold_bootstrap" } },
      { ...receipt, impact: { ...impact, childRestartRequired: false } },
      { ...receipt, impact: { ...impact, hmuxRuntimeChanged: "true" } },
      { ...receipt, impact: null },
    ]) {
      expect(() => refreshPendingDevDeploySelection(pending, {
        transaction: refreshedTransaction,
        receipt: invalidReceipt,
      })).toThrow();
    }
    expect(() => refreshPendingDevDeploySelection(pending, {
      transaction: {
        ...refreshedTransaction,
        executor: {
          generation: "e".repeat(64),
          entrypoint: `/tmp/executors-v1/${"e".repeat(64)}/scripts/deploy-dev-app.mjs`,
        },
      },
      receipt,
    })).toThrow(/latest exact deployment observation/);
  });

  it("retargets reconciliation when an older attempt advances the source", () => {
    const { state, sourceGeneration } =
      queuedParentObligationWithOldParent();
    const older = beginDevDeployAttempt(state, 10_000);
    expect(older.request.reconciliation.targetHead).toBe(TARGET_B);
    const coalesced = queued({
      existing: older,
      nowMs: 11_000,
      receipt: { action: "defer", targetHead: TARGET_C },
    });
    const advanced = settleDevDeployAttempt(coalesced, {
      attemptGeneration: older.generation,
      exitCode: 0,
      receipt: {
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "frontend_reload" },
        verification: { status: "ok" },
      },
      nowMs: 12_000,
      pollMs: 5_000,
    });
    expect(advanced.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(advanced.request.reconciliation.targetHead).toBe(TARGET_B);
    expect(
      advanced.lastSuccessfulDeployment.parentGeneration.sourceGeneration,
    ).toBe(sourceGeneration);

    const restaged = queued({
      existing: advanced,
      nowMs: 12_000,
      transaction: transaction(TARGET_B),
      receipt: {
        action: "defer",
        currentHead: TARGET_B,
        targetHead: TARGET_B,
      },
    });
    const hmuxActivation = hmuxActivationProof(TARGET_A);
    restaged.lastSuccessfulDeployment = {
      ...restaged.lastSuccessfulDeployment,
      backendHead: TARGET_A,
      hmuxActivation,
    };
    const reconciled = settleDevDeployAttempt(
      beginDevDeployAttempt(restaged, 12_000),
      {
        attemptGeneration: restaged.generation,
        exitCode: 0,
        receipt: parentReconciliationReceipt({ targetHead: TARGET_B }),
        nowMs: 13_000,
        pollMs: 5_000,
      },
    );
    expect(reconciled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
    expect(reconciled.lastSuccessfulDeployment.sourceHead).toBe(TARGET_B);
    expect(reconciled.lastSuccessfulDeployment.hmuxActivation).toEqual(
      hmuxActivation,
    );
  });

  it("atomically settles a late exact proof after a duplicate enqueue", () => {
    const targetSourceGeneration = "2".repeat(64);
    const { state } = queuedParentObligationWithOldParent({
      targetSourceGeneration,
    });
    const older = beginDevDeployAttempt(state, 10_000);
    const duplicate = queued({
      existing: older,
      nowMs: 11_000,
      receipt: {
        action: "defer",
        currentHead: TARGET_B,
        targetHead: TARGET_B,
      },
    });
    const settled = settleDevDeployAttempt(duplicate, {
      attemptGeneration: older.generation,
      exitCode: 0,
      receipt: parentReconciliationReceipt({
        targetHead: TARGET_B,
        sourceGeneration: targetSourceGeneration,
      }),
      nowMs: 12_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
    expect(settled.request.reconciliation).toBeUndefined();
    expect(settled.priorFailure).toBeUndefined();
    expect(settled.lastSuccessfulDeployment).toMatchObject({
      sourceHead: TARGET_B,
      runtime: { generation: "app-server-generation-1" },
      parentGeneration: { sourceGeneration: targetSourceGeneration },
    });

  });

  it("retargets reconciliation when the current deploy advances before failing", () => {
    const { state, sourceGeneration } =
      queuedParentObligationWithOldParent();
    const attempt = beginDevDeployAttempt(state, 10_000);
    const failed = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 1,
      receipt: {
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        impact: { kind: "frontend_reload" },
        verification: { status: "skew" },
      },
      nowMs: 11_000,
      pollMs: 5_000,
    });

    expect(failed.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(failed.request.reconciliation.targetHead).toBe(TARGET_B);
    expect(
      failed.lastSuccessfulDeployment.parentGeneration.sourceGeneration,
    ).toBe(sourceGeneration);
    expect(
      queued({ existing: failed, nowMs: 12_000 }).request.reconciliation
        .targetHead,
    ).toBe(TARGET_B);
  });

  it("carries superseded attempt evidence into the newer generation", () => {
    const initialFailure = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 1,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          verification: { status: "skew" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const retryAttempt = beginDevDeployAttempt(
      queued({ existing: initialFailure, nowMs: 8_000 }),
      8_000,
    );
    const newer = queued({
      existing: retryAttempt,
      nowMs: 9_000,
      receipt: { action: "defer", targetHead: TARGET_X },
    });
    const verifiedOlder = settleDevDeployAttempt(newer, {
      attemptGeneration: retryAttempt.generation,
      exitCode: 0,
      receipt: {
        action: "deploy",
        deployed: true,
        targetHead: TARGET_C,
        impact: { kind: "frontend_reload" },
        verification: { status: "ok" },
      },
      nowMs: 10_000,
      pollMs: 5_000,
    });
    expect(verifiedOlder.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(verifiedOlder.request.observed.targetHead).toBe(TARGET_X);
    expect(verifiedOlder.priorFailure).toMatchObject({
      failure: { code: "deploy_transaction_mismatch" },
      receipt: { targetHead: TARGET_C },
    });
    const failedOlder = settleDevDeployAttempt(newer, {
      attemptGeneration: retryAttempt.generation,
      exitCode: 1,
      receipt: {
        action: "deploy",
        deployed: true,
        targetHead: TARGET_B,
        verification: { status: "skew", reason: "boot skew" },
      },
      nowMs: 10_000,
      pollMs: 5_000,
    });
    expect(failedOlder.priorFailure).toMatchObject({
      failure: { code: "deploy_attempt_failed" },
      receipt: { targetHead: TARGET_B },
    });
  });

  it("retries policy deferrals but rejects a bare skip receipt", () => {
    const attempting = beginDevDeployAttempt(queued(), 6_000);
    const deferred = settleDevDeployAttempt(attempting, {
      attemptGeneration: 1,
      exitCode: 0,
      receipt: { action: "defer", reason: "user active" },
      nowMs: 7_000,
      pollMs: 5_000,
    });
    expect(deferred.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(deferred.nextAttemptAtMs).toBe(12_000);

    const rejected = settleDevDeployAttempt(
      beginDevDeployAttempt(deferred, 12_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: {
          action: "skip",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload", changedPathCount: 0 },
          verification: { status: "ok" },
          liveVerified: false,
          reason: "already current",
        },
        nowMs: 13_000,
        pollMs: 5_000,
      },
    );
    expect(rejected.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(rejected.failure.code).toBe("unverified_skip_receipt");
  });

  it("upgrades a receiptless pending queue without inventing old attempt identity", () => {
    const deferred = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: { action: "defer", reason: "user active" },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const receiptless = structuredClone(deferred);
    receiptless.schemaVersion = 3;
    delete receiptless.lastAttempt.attemptId;
    delete receiptless.lastAttempt.startedAtMs;
    expect(parseQueuedDeployState(receiptless)).toBe(receiptless);

    const resumed = beginDevDeployAttempt(receiptless, 12_000);
    expect(resumed).toMatchObject({
      schemaVersion: 5,
      status: DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING,
      lastAttempt: {
        receipt: { action: "defer" },
        attemptIdentity: { kind: "unavailable", sourceSchemaVersion: 3 },
      },
      activeAttempt: { generation: 1, transaction: { targetHead: TARGET_B } },
    });
    expect(resumed.lastAttempt.attemptId).toBeUndefined();
    expect(resumed.activeAttempt.attemptId).toMatch(/^[a-f0-9]{32}$/);
    expect(parseQueuedDeployState(resumed)).toBe(resumed);

    const coalesced = queued({
      existing: receiptless,
      transaction: transaction(TARGET_C),
      receipt: {
        currentHead: TARGET_B,
        targetHead: TARGET_C,
        pendingCommits: 1,
        impact: completeImpact({ kind: "frontend_reload" }),
      },
      nowMs: 8_000,
    });
    expect(parseQueuedDeployState(coalesced)).toBe(coalesced);
    expect(coalesced).toMatchObject({
      schemaVersion: 5,
      generation: 2,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      request: { transaction: { targetHead: TARGET_C } },
      lastAttempt: {
        receipt: { action: "defer" },
        attemptIdentity: { kind: "unavailable", sourceSchemaVersion: 3 },
      },
    });
  });

  it("upgrades a schema-v4 queue without inventing an acknowledgement", () => {
    const preBootstrap = structuredClone(queued());
    preBootstrap.schemaVersion = 4;
    delete preBootstrap.request.coldBootstrapOperationId;
    delete preBootstrap.request.coldBootstrapInitialRows;
    delete preBootstrap.request.coldBootstrapInitialColumns;
    expect(parseQueuedDeployState(preBootstrap)).toMatchObject({
      schemaVersion: 5,
      request: {
        transaction: preBootstrap.request.transaction,
      },
    });

    const previous = structuredClone(queued());
    previous.schemaVersion = 4;

    const upgraded = parseQueuedDeployState(previous);

    expect(upgraded).not.toBe(previous);
    expect(upgraded.schemaVersion).toBe(5);
    expect(upgraded.request).toMatchObject({
      coldBootstrapInitialRows: 24,
      coldBootstrapInitialColumns: 80,
    });
    expect(
      upgraded.request.coldBootstrapRetirementAcknowledgement,
    ).toBeUndefined();
    expect(beginDevDeployAttempt(previous, 2_000)).toMatchObject({
      schemaVersion: 5,
      status: DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING,
      activeAttempt: {
        coldBootstrap: {
          operationId: previous.request.coldBootstrapOperationId,
          initialRows: 24,
          initialColumns: 80,
        },
      },
    });

    const submitted = submitColdBootstrap(
      beginDevDeployAttempt(queued(), 2_000),
    );
    submitted.schemaVersion = 4;
    delete submitted.request.coldBootstrapInitialRows;
    delete submitted.request.coldBootstrapInitialColumns;
    delete submitted.activeAttempt.coldBootstrap.initialRows;
    delete submitted.activeAttempt.coldBootstrap.initialColumns;
    expect(parseQueuedDeployState(submitted)).toMatchObject({
      schemaVersion: 5,
      request: {
        coldBootstrapInitialRows: 24,
        coldBootstrapInitialColumns: 80,
      },
      activeAttempt: {
        coldBootstrap: {
          initialRows: 24,
          initialColumns: 80,
        },
      },
    });
  });

  it("preserves a newer target after a receiptless attempt disappears", () => {
    const receiptless = structuredClone(
      beginDevDeployAttempt(queued(), 6_000),
    );
    receiptless.schemaVersion = 3;
    receiptless.generation = 2;
    delete receiptless.activeAttempt.attemptId;
    receiptless.request = {
      ...receiptless.request,
      transaction: transaction(TARGET_C),
      observed: {
        currentHead: TARGET_B,
        targetHead: TARGET_C,
        pendingCommits: 1,
        impact: completeImpact({ kind: "frontend_reload" }),
      },
    };
    expect(parseQueuedDeployState(receiptless)).toBe(receiptless);

    const interrupted = reconcileDevDeployAttempt(receiptless, {
      executorLiveness: "stale",
      nowMs: 7_000,
      pollMs: 5_000,
    });
    expect(interrupted).toMatchObject({
      schemaVersion: 3,
      generation: 2,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      nextAttemptAtMs: 12_000,
      request: { transaction: { targetHead: TARGET_C } },
      priorFailure: {
        failure: { code: "deploy_attempt_interrupted" },
        transaction: { targetHead: TARGET_B },
      },
      lastAttempt: {
        generation: 1,
        transaction: { targetHead: TARGET_B },
        exitCode: 1,
      },
    });
    expect(interrupted.lastAttempt.attemptId).toBeUndefined();
    expect(interrupted.lastAttempt.startedAtMs).toBeUndefined();

    const resumed = beginDevDeployAttempt(interrupted, 12_000);
    expect(resumed).toMatchObject({
      schemaVersion: 5,
      generation: 2,
      status: DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING,
      request: { transaction: { targetHead: TARGET_C } },
      lastAttempt: {
        attemptIdentity: { kind: "unavailable", sourceSchemaVersion: 3 },
      },
      activeAttempt: {
        generation: 2,
        transaction: { targetHead: TARGET_C },
      },
    });
    expect(parseQueuedDeployState(resumed)).toBe(resumed);
  });

  it("fails loudly on executor failure or an invalid receipt", () => {
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 1,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          verification: { reason: "boot skew" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    expect(failed.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(failed.failure).toMatchObject({
      code: "deploy_attempt_failed",
      reason: "boot skew",
    });

    const rejectedBeforeCheckout = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 8_000),
      {
        attemptGeneration: 1,
        exitCode: 1,
        receipt: {
          action: "deploy",
          deployed: false,
          targetHead: TARGET_B,
          reason: "parent activation admission failed",
          impact: { kind: "parent_reload" },
        },
        nowMs: 9_000,
        pollMs: 5_000,
      },
    );
    expect(rejectedBeforeCheckout.failure).toMatchObject({
      code: "deploy_attempt_failed",
      reason: "parent activation admission failed",
    });
    expect(rejectedBeforeCheckout.request.reconciliation).toBeUndefined();

    const invalid = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: { action: "unknown" },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    expect(invalid.failure.code).toBe("invalid_deploy_receipt");
  });

  it.each([
    "parent_reload",
    "child_restart",
    "launcher_restart",
    undefined,
  ])(
    "rejects %s success without recognized exact activation evidence",
    (kind) => {
      const failed = settleDevDeployAttempt(
        beginDevDeployAttempt(queued(), 6_000),
        {
          attemptGeneration: 1,
          exitCode: 0,
          receipt: {
            action: "deploy",
            deployed: true,
            targetHead: TARGET_B,
            ...(kind ? { impact: { kind } } : {}),
            verification: { status: "ok" },
          },
          nowMs: 7_000,
          pollMs: 5_000,
        },
      );

      expect(failed.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
      expect(failed.failure.code).toBe("unverified_deploy_receipt");
      expect(failed.lastSuccessfulDeployment).toBeUndefined();
    },
  );

  it("settles a cumulative parent reload from an exact already-active generation", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt: convergedParentActivationReceipt(),
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status, settled.failure?.code).toBe(
      DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
    );
    expect(settled.lastSuccessfulDeployment).toMatchObject({
      sourceHead: TARGET_B,
      backendHead: TARGET_B,
      runtime: { generation: "parent-converged-app-generation" },
      parentGeneration: {
        sourceGeneration: "5".repeat(64),
        supervisor: processGeneration(40, "active-parent", "7"),
        launch: processGeneration(42, "active-child", "9"),
      },
    });
  });

  it("settles the residual child generation after an already-active cumulative parent", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const receipt = convergedParentActivationWithResidualReceipt();
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt,
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status, settled.failure?.code).toBe(
      DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
    );
    expect(settled.lastSuccessfulDeployment.parentGeneration).toEqual(
      receipt.verification.activatedGeneration,
    );
  });

  it("rejects a residual child generation that did not continue from the active parent", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const receipt = convergedParentActivationWithResidualReceipt();
    receipt.residualTransition.receipt.previousLaunch = processGeneration(
      44,
      "foreign-child",
      "b",
    );
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt,
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_deploy_receipt");
    expect(settled.lastSuccessfulDeployment).toBeUndefined();
  });

  it.each([
    "parent_reload",
    "child_restart",
    "backend_rebuild",
    "frontend_reload",
  ])(
    "settles an exact %s deployment recovered by cold bootstrap",
    (kind) => {
      const initial = queued();
      const queuedState = kind === "frontend_reload"
        ? {
            ...initial,
            request: {
              ...initial.request,
              reconciliation: {
                kind: "parent_generation",
                targetHead: TARGET_B,
              },
            },
          }
        : initial;
      const attempt = beginDevDeployAttempt(queuedState, 6_000);
      const receipt = coldBootstrapActivationReceipt(kind);
      const settled = settleDevDeployAttempt(attempt, {
        attemptGeneration: attempt.generation,
        exitCode: 0,
        receipt,
        nowMs: 7_000,
        pollMs: 5_000,
      });

      expect(settled.status, settled.failure?.code).toBe(
        DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
      );
      expect(settled.lastSuccessfulDeployment?.parentGeneration).toEqual(
        receipt.verification.activatedGeneration,
      );
      expect(settled.request.reconciliation).toBeUndefined();
    },
  );

  it.each(["frontend_reload", "backend_rebuild"])(
    "settles an exact late %s cold-bootstrap recovery",
    (kind) => {
      const initial = queued();
      const attempt = beginDevDeployAttempt(
        {
          ...initial,
          request: {
            ...initial.request,
            reconciliation: {
              kind: "parent_generation",
              targetHead: TARGET_B,
            },
          },
        },
        6_000,
      );
      const receipt = coldBootstrapActivationReceipt(kind, "recovery");
      const settled = settleDevDeployAttempt(attempt, {
        attemptGeneration: attempt.generation,
        exitCode: 0,
        receipt,
        nowMs: 7_000,
        pollMs: 5_000,
      });

      expect(settled.status, settled.failure?.code).toBe(
        DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
      );
      expect(settled.lastSuccessfulDeployment?.parentGeneration).toEqual(
        receipt.verification.activatedGeneration,
      );
      expect(settled.request.reconciliation).toBeUndefined();
    },
  );

  it("rejects cold-bootstrap settlement without its exact Hmux identity", () => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const receipt = coldBootstrapActivationReceipt();
    delete receipt.plannedTransition.receipt.hmux.workspaceId;
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt,
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_deploy_receipt");
  });

  it.each([
    [
      "a mismatched active source generation",
      (receipt) => {
        receipt.plannedTransition.receipt.sourceGeneration = "6".repeat(64);
      },
    ],
    [
      "a mismatched verified launch",
      (receipt) => {
        receipt.verification.activatedGeneration.launch = processGeneration(
          43,
          "unexpected-child",
          "a",
        );
      },
    ],
  ])("rejects converged parent proof with %s", (_label, corrupt) => {
    const attempt = beginDevDeployAttempt(queued(), 6_000);
    const receipt = convergedParentActivationReceipt();
    corrupt(receipt);
    const settled = settleDevDeployAttempt(attempt, {
      attemptGeneration: attempt.generation,
      exitCode: 0,
      receipt,
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(settled.failure.code).toBe("unverified_deploy_receipt");
    expect(settled.lastSuccessfulDeployment).toBeUndefined();
  });

  it.each([
    "frontend_reload",
    "backend_rebuild",
    "child_restart",
    "parent_reload",
  ])("rejects %s settlement without live verification", (kind) => {
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: { ...validActivationReceipt(kind), liveVerified: false },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );

    expect(failed.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(failed.failure.code).toBe("unverified_deploy_receipt");
    expect(failed.lastSuccessfulDeployment).toBeUndefined();
  });

  it("does not advance the backend source without exact control-plane payload proof", () => {
    const receipt = validActivationReceipt("backend_rebuild");
    delete receipt.verification.controlPlaneActivation;
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt,
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );

    expect(failed.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(failed.failure.code).toBe("unverified_deploy_receipt");
    expect(failed.lastSuccessfulDeployment).toBeUndefined();
  });

  it("advances an immutable CLI payload without requiring an app child restart", () => {
    const impact = completeImpact({
      kind: "frontend_reload",
      backendChanged: false,
      controlPlanePayloadChanged: true,
    });
    const pending = queued({
      transaction: {
        ...transaction(),
        selection: { sourceHead: TARGET_A, impact },
      },
      receipt: { ...BASE_REQUEST.receipt, impact },
    });
    const receipt = {
      ...validActivationReceipt("frontend_reload"),
      deployReceiptVersion: 2,
      currentHead: TARGET_A,
      impact,
      controlPlaneActivation: controlPlaneActivationProof(),
      dispatchAccepted: true,
    };
    const settled = settleDevDeployAttempt(
      beginDevDeployAttempt(pending, 6_000),
      {
        attemptGeneration: pending.generation,
        exitCode: 0,
        receipt,
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );

    expect(settled.status, settled.failure?.code).toBe(
      DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
    );
    expect(settled.lastSuccessfulDeployment).toMatchObject({
      sourceHead: TARGET_B,
      backendHead: TARGET_B,
      controlPlaneActivation: controlPlaneActivationProof(),
    });
    expect(receipt.plannedTransition).toBeUndefined();
  });

  it("does not advance the backend source without exact Hmux channel activation", () => {
    const impact = completeImpact({
      kind: "backend_rebuild",
      hmuxRuntimeChanged: true,
    });
    const pending = queued({
      transaction: {
        ...transaction(),
        selection: { sourceHead: TARGET_A, impact },
      },
      receipt: {
        ...BASE_REQUEST.receipt,
        impact,
      },
    });
    const receipt = {
      deployReceiptVersion: 2,
      action: "deploy",
      deployed: true,
      currentHead: TARGET_A,
      targetHead: TARGET_B,
      impact,
      controlPlaneActivation: controlPlaneActivationProof(),
      plannedTransition: childRestartTransition(),
      dispatchAccepted: true,
    };
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(pending, 6_000),
      {
        attemptGeneration: pending.generation,
        exitCode: 0,
        receipt,
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );

    expect(failed.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(failed.failure.code).toBe("unverified_deploy_receipt");
    expect(failed.lastSuccessfulDeployment).toBeUndefined();

    const activated = settleDevDeployAttempt(
      beginDevDeployAttempt(pending, 6_000),
      {
        attemptGeneration: pending.generation,
        exitCode: 0,
        receipt: { ...receipt, hmuxActivation: hmuxActivationProof() },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    expect(activated.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
    expect(activated.lastSuccessfulDeployment?.hmuxActivation).toEqual(
      hmuxActivationProof(),
    );
  });

  it.each(["child_restart", "parent_reload"])(
    "rejects %s settlement when the live app generation differs",
    (kind) => {
      const receipt = validActivationReceipt(kind);
      receipt.verification.activatedAppServerGeneration =
        "different-app-generation";
      const failed = settleDevDeployAttempt(
        beginDevDeployAttempt(queued(), 6_000),
        {
          attemptGeneration: 1,
          exitCode: 0,
          receipt,
          nowMs: 7_000,
          pollMs: 5_000,
        },
      );

      expect(failed.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
      expect(failed.failure.code).toBe("unverified_deploy_receipt");
      expect(failed.lastSuccessfulDeployment).toBeUndefined();
    },
  );

  it("accepts exact child and in-process parent activation envelopes", () => {
    const childRequestId = "e".repeat(64);
    const childSupervisor = processGeneration(10, "parent", "a");
    const previousChild = processGeneration(20, "child-old", "b");
    const nextChild = processGeneration(21, "child-new", "c");
    const childAppGeneration = "child-app-generation";
    const childReceipt = {
      action: "deploy",
      deployed: true,
      targetHead: TARGET_B,
      impact: { kind: "child_restart" },
      verification: {
        status: "ok",
        activatedAppServerGeneration: childAppGeneration,
      },
      runtime: {
        pid: 22,
        processIdentity: "child-app",
        generation: childAppGeneration,
        observedAtMs: 6_800,
      },
      plannedTransition: childRestartTransition({
        requestId: childRequestId,
        supervisor: childSupervisor,
        previousLaunch: previousChild,
        launch: nextChild,
      }),
    };
    expect(
      settleDevDeployAttempt(beginDevDeployAttempt(queued(), 6_000), {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: childReceipt,
        nowMs: 7_000,
        pollMs: 5_000,
      }).status,
    ).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);

    const parentRequestId = "f".repeat(64);
    const sourceGeneration = "1".repeat(64);
    const obligation = queuedParentObligationWithOldParent({
      targetHead: TARGET_B,
      targetSourceGeneration: sourceGeneration,
    });
    expect(obligation.state.request.reconciliation).toEqual({
      kind: "parent_generation",
      targetHead: TARGET_B,
    });
    const previousSupervisor = obligation.supervisor;
    const nextSupervisor = {
      ...previousSupervisor,
      generation: "d".repeat(64),
    };
    const parentLaunch = processGeneration(22, "child-parent-new", "e");
    const parentAppGeneration = "parent-app-generation";
    const parentProof = v2Envelope("parent_reload_receipt", {
      requestId: parentRequestId,
      previousSupervisor,
      previousLaunch: obligation.launch,
      supervisor: nextSupervisor,
      launch: parentLaunch,
      sourceGeneration,
      activatedAtMs: 6_500,
    });
    const parentReceipt = {
      action: "deploy",
      deployed: true,
      targetHead: TARGET_B,
      impact: { kind: "parent_reload" },
      expectedParentSourceGeneration: sourceGeneration,
      verification: {
        status: "ok",
        activatedAppServerGeneration: parentAppGeneration,
        activatedGeneration: {
          sourceGeneration,
          supervisor: nextSupervisor,
          launch: parentLaunch,
        },
      },
      runtime: {
        pid: 23,
        processIdentity: "parent-app",
        generation: parentAppGeneration,
        observedAtMs: 11_800,
      },
      plannedTransition: {
        kind: "parent_reload",
        relaunchDispatched: true,
        parentReloadRequestId: parentRequestId,
        receipt: parentProof,
      },
    };
    const parentAttempt = beginDevDeployAttempt(obligation.state, 11_000);
    const settledParent = settleDevDeployAttempt(
      parentAttempt,
      {
        attemptGeneration: parentAttempt.generation,
        exitCode: 0,
        receipt: parentReceipt,
        nowMs: 12_000,
        pollMs: 5_000,
      },
    );
    expect(settledParent.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
    expect(settledParent.request.reconciliation).toBeUndefined();
    expect(settledParent.priorFailure).toBeUndefined();
    expect(settledParent.lastSuccessfulDeployment.parentGeneration).toEqual(
      parentReceipt.verification.activatedGeneration,
    );
  });

  it("accepts an exact legacy v1 child receipt without granting parent reload proof", () => {
    const requestId = "6".repeat(64);
    const supervisor = processGeneration(10, "legacy-parent", "a");
    const previousLaunch = processGeneration(20, "legacy-child-old", "b");
    const launch = processGeneration(21, "legacy-child-new", "c");
    const appServerGeneration = "legacy-child-app-generation";
    const receipt = {
      action: "deploy",
      deployed: true,
      targetHead: TARGET_B,
      impact: { kind: "child_restart" },
      verification: {
        status: "ok",
        activatedAppServerGeneration: appServerGeneration,
      },
      runtime: {
        pid: 22,
        processIdentity: "legacy-child-app",
        generation: appServerGeneration,
        observedAtMs: 6_800,
      },
      plannedTransition: {
        kind: "child_restart",
        relaunchDispatched: true,
        restartRequestId: requestId,
        receipt: {
          schemaVersion: 1,
          type: "restart_receipt",
          requestId,
          worktreeRoot: WORKTREE,
          channel: CHANNEL,
          supervisor,
          previousLaunch,
          launch,
          restartedAtMs: 6_500,
        },
      },
    };

    const settled = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt,
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );

    expect(settled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
    expect(settled.lastSuccessfulDeployment).toMatchObject({
      sourceHead: TARGET_B,
    });
    expect(settled.lastSuccessfulDeployment.parentGeneration).toBeUndefined();
  });

  it.each([
    ["schema", { schemaVersion: 999 }],
    ["protocol", { protocolVersion: 999 }],
    ["worktree", { worktreeRoot: "/tmp/foreign-live" }],
    ["channel", { channel: "foreign-channel" }],
  ])("rejects a child proof when its %s fence does not match", (_label, mutation) => {
    const transition = childRestartTransition();
    transition.receipt = {
      ...transition.receipt,
      ...mutation,
    };
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "child_restart" },
          verification: { status: "ok" },
          plannedTransition: transition,
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );

    expect(failed.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(failed.failure.code).toBe("unverified_deploy_receipt");
    expect(failed.lastSuccessfulDeployment).toBeUndefined();
  });

  it("reconciles a legacy failed target from a read-only cold-bootstrap proof", () => {
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 1,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "launcher_restart" },
          verification: { status: "skew" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const retry = queued({ existing: failed, nowMs: 8_000 });
    const sourceGeneration = "7".repeat(64);
    const supervisor = processGeneration(30, "cold-parent", "d");
    const launch = processGeneration(31, "cold-child", "e");
    const appServerGeneration = "app-server-generation-1";
    const exactReceipt = parentReconciliationReceipt({
      sourceGeneration,
      supervisor,
      launch,
      appServerGeneration,
    });
    for (const incompleteReceipt of [
      { ...exactReceipt, runtime: undefined },
      {
        ...exactReceipt,
        verification: {
          status: "skew",
          activatedAppServerGeneration: appServerGeneration,
        },
      },
    ]) {
      const unresolved = settleDevDeployAttempt(
        beginDevDeployAttempt(retry, 8_000),
        {
          attemptGeneration: retry.generation,
          exitCode: 0,
          receipt: incompleteReceipt,
          nowMs: 9_000,
          pollMs: 5_000,
        },
      );
      expect(unresolved.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
      expect(unresolved.failure.code).toBe("unverified_parent_reconciliation");
    }
    const reconciled = settleDevDeployAttempt(
      beginDevDeployAttempt(retry, 8_000),
      {
        attemptGeneration: retry.generation,
        exitCode: 0,
        receipt: exactReceipt,
        nowMs: 9_000,
        pollMs: 5_000,
      },
    );

    expect(reconciled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
    expect(reconciled.lastSuccessfulDeployment.parentGeneration).toEqual({
      sourceGeneration,
      supervisor,
      launch,
    });
    expect(reconciled.lastSuccessfulDeployment.runtime.generation).toBe(
      appServerGeneration,
    );
  });

  it("migrates a legacy succeeded target only with exact current proof", () => {
    const legacy = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload" },
          verification: { status: "ok" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    expect(legacy.lastSuccessfulDeployment.parentGeneration).toBeUndefined();
    const migration = queued({ existing: legacy, nowMs: 8_000 });
    expect(migration.request.reconciliation).toEqual({
      kind: "parent_generation",
      targetHead: TARGET_B,
    });
    const missingProof = settleDevDeployAttempt(
      beginDevDeployAttempt(migration, 8_000),
      {
        attemptGeneration: migration.generation,
        exitCode: 0,
        receipt: {
          action: "skip",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
        },
        nowMs: 9_000,
        pollMs: 5_000,
      },
    );
    expect(missingProof.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(missingProof.failure.code).toBe(
      "unverified_parent_reconciliation",
    );

    const reconciled = settleDevDeployAttempt(
      beginDevDeployAttempt(migration, 8_000),
      {
        attemptGeneration: migration.generation,
        exitCode: 0,
        receipt: parentReconciliationReceipt(),
        nowMs: 9_000,
        pollMs: 5_000,
      },
    );
    expect(reconciled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
    expect(
      reconciled.lastSuccessfulDeployment.parentGeneration.sourceGeneration,
    ).toBe("7".repeat(64));
  });

  it("retargets a legacy parent obligation across a frontend deploy", () => {
    const legacy = settleDevDeployAttempt(
      beginDevDeployAttempt(
        queued({ transaction: transaction(TARGET_A) }),
        6_000,
      ),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_A,
          impact: { kind: "frontend_reload" },
          verification: { status: "ok" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const migration = queued({ existing: legacy, nowMs: 8_000 });
    expect(migration.request.reconciliation.targetHead).toBe(TARGET_A);
    const advanced = settleDevDeployAttempt(
      beginDevDeployAttempt(migration, 8_000),
      {
        attemptGeneration: migration.generation,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload" },
          verification: { status: "ok" },
        },
        nowMs: 9_000,
        pollMs: 5_000,
      },
    );
    expect(advanced.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(advanced.failure).toBeUndefined();
    expect(advanced.lastSuccessfulDeployment.sourceHead).toBe(TARGET_B);
    expect(advanced.request.reconciliation.targetHead).toBe(TARGET_B);
    const reconciled = settleDevDeployAttempt(
      beginDevDeployAttempt(advanced, 10_000),
      {
        attemptGeneration: advanced.generation,
        exitCode: 0,
        receipt: parentReconciliationReceipt({ targetHead: TARGET_B }),
        nowMs: 11_000,
        pollMs: 5_000,
      },
    );
    expect(reconciled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
    expect(reconciled.lastSuccessfulDeployment.sourceHead).toBe(TARGET_B);
  });

  it.each(["missing", "stale"])(
    "migrates legacy skip truth with %s deployment history",
    (history) => {
      const prior =
        history === "stale"
          ? deployedStateWithParent({ sourceHead: TARGET_A }).state
          : undefined;
      const legacy = parseQueuedDeployState({
        schemaVersion: 2,
        generation: prior?.generation ?? 1,
        worktree: WORKTREE,
        status: DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
        firstQueuedAtMs: 1_000,
        requestedAtMs: 8_000,
        expiresAtMs: 61_000,
        attempts: 1,
        completedAtMs: 9_000,
        request: {
          attemptArgs: ["--live-worktree", WORKTREE],
          executorPath: "/tmp/legacy-deploy-dev-app.mjs",
          executionEnvironment: { HOME: "/tmp/home", PATH: "/usr/bin" },
          observed: { currentHead: TARGET_B, targetHead: TARGET_B },
        },
        finalReceipt: {
          action: "skip",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
        },
        ...(prior?.lastSuccessfulDeployment
          ? { lastSuccessfulDeployment: prior.lastSuccessfulDeployment }
          : {}),
      });
      if (history === "missing") {
        expect(legacy.lastSuccessfulDeployment).toBeUndefined();
      } else {
        expect(legacy.lastSuccessfulDeployment.sourceHead).toBe(TARGET_A);
      }

      const migration = queued({
        existing: legacy,
        nowMs: 10_000,
        receipt: {
          action: "defer",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
        },
      });
      expect(migration.request.reconciliation).toEqual({
        kind: "parent_generation",
        targetHead: TARGET_B,
      });

      const missingProof = settleDevDeployAttempt(
        beginDevDeployAttempt(migration, 10_000),
        {
          attemptGeneration: migration.generation,
          exitCode: 0,
          receipt: {
            action: "skip",
            currentHead: TARGET_B,
            targetHead: TARGET_B,
          },
          nowMs: 11_000,
          pollMs: 5_000,
        },
      );
      expect(missingProof.failure.code).toBe(
        "unverified_parent_reconciliation",
      );

      const reconciled = settleDevDeployAttempt(
        beginDevDeployAttempt(migration, 10_000),
        {
          attemptGeneration: migration.generation,
          exitCode: 0,
          receipt: parentReconciliationReceipt({ targetHead: TARGET_B }),
          nowMs: 11_000,
          pollMs: 5_000,
        },
      );
      expect(reconciled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
      expect(reconciled.lastSuccessfulDeployment.sourceHead).toBe(TARGET_B);
    },
  );

  it("does not clear a target parent obligation with an old-parent child restart", () => {
    const {
      state: retry,
      sourceGeneration: oldSourceGeneration,
      supervisor: oldSupervisor,
      launch: oldLaunch,
    } = queuedParentObligationWithOldParent();
    const replacement = processGeneration(21, "old-parent-new-child", "c");
    const appServerGeneration = "old-parent-child-app-generation";
    const childTransition = childRestartTransition({
      supervisor: oldSupervisor,
      previousLaunch: oldLaunch,
      launch: replacement,
    });
    const childDeploy = settleDevDeployAttempt(
      beginDevDeployAttempt(retry, 10_000),
      {
        attemptGeneration: retry.generation,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "child_restart" },
          verification: {
            status: "ok",
            activatedAppServerGeneration: appServerGeneration,
          },
          runtime: {
            pid: 22,
            processIdentity: "old-parent-child-app",
            generation: appServerGeneration,
            observedAtMs: 10_800,
          },
          plannedTransition: childTransition,
        },
        nowMs: 11_000,
        pollMs: 5_000,
      },
    );

    expect(childDeploy.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(childDeploy.failure).toBeUndefined();
    expect(childDeploy.request.reconciliation.targetHead).toBe(TARGET_B);
    expect(
      childDeploy.lastSuccessfulDeployment.parentGeneration.sourceGeneration,
    ).toBe(oldSourceGeneration);
  });

  it("does not let skip erase an unresolved deploy failure", () => {
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 1,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload" },
          verification: { reason: "boot skew" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const retry = queued({ existing: failed, nowMs: 8_000 });
    const skipped = settleDevDeployAttempt(
      beginDevDeployAttempt(retry, 8_000),
      {
        attemptGeneration: retry.generation,
        exitCode: 0,
        receipt: {
          action: "skip",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload", changedPathCount: 0 },
          verification: { status: "ok" },
          liveVerified: false,
          reason: "already current",
        },
        nowMs: 9_000,
        pollMs: 5_000,
      },
    );
    expect(skipped.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(skipped.failure.code).toBe("prior_deploy_failure_unresolved");
  });

  it("rejects a receipt authority projection that contradicts its transaction", () => {
    const mismatched = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          targetAuthority: "exact-local-candidate",
          impact: { kind: "frontend_reload" },
          verification: { status: "ok" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );

    expect(mismatched.failure.code).toBe("deploy_transaction_mismatch");
    expect(mismatched.lastSuccessfulDeployment).toBeUndefined();
  });

  it("keeps unresolved failure evidence across coalescing and expiry", () => {
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 1,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload" },
          verification: { status: "skew" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const retry = queued({ existing: failed, nowMs: 8_000 });
    const coalesced = queued({ existing: retry, nowMs: 9_000 });
    const afterExpiry = queued({
      existing: coalesced,
      nowMs: coalesced.expiresAtMs + 1,
    });

    expect(coalesced.priorFailure).toEqual(retry.priorFailure);
    expect(afterExpiry.priorFailure).toEqual(retry.priorFailure);
    expect(afterExpiry.priorFailure.receipt.targetHead).toBe(TARGET_B);
  });

  it("clears a prior failure only with verified deployment evidence", () => {
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      {
        attemptGeneration: 1,
        exitCode: 1,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          verification: { status: "skew" },
        },
        nowMs: 7_000,
        pollMs: 5_000,
      },
    );
    const retry = queued({ existing: failed, nowMs: 8_000 });
    const unverified = settleDevDeployAttempt(
      beginDevDeployAttempt(retry, 8_000),
      {
        attemptGeneration: retry.generation,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_B,
          impact: { kind: "frontend_reload" },
          verification: { status: "unverified" },
        },
        nowMs: 9_000,
        pollMs: 5_000,
      },
    );
    expect(unverified.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(unverified.failure.code).toBe("unverified_deploy_receipt");
    expect(
      queued({ existing: unverified, nowMs: 10_000 }).priorFailure.receipt
        .targetHead,
    ).toBe(TARGET_B);

    const verifiedRetry = queued({
      existing: unverified,
      nowMs: 10_000,
      transaction: transaction(TARGET_X),
      receipt: { action: "defer", targetHead: TARGET_X },
    });
    const deployed = settleDevDeployAttempt(
      beginDevDeployAttempt(verifiedRetry, 10_000),
      {
        attemptGeneration: verifiedRetry.generation,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TARGET_X,
          impact: { kind: "frontend_reload" },
          verification: { status: "ok" },
        },
        nowMs: 11_000,
        pollMs: 5_000,
      },
    );
    expect(deployed.status).toBe(DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED);
    expect(deployed.priorFailure).toBeUndefined();
  });

  it("cancels only before the attempt crosses its execution boundary", () => {
    const canceled = cancelDevDeploy(queued(), 2_000);
    expect(canceled.status).toBe(DEV_DEPLOY_QUEUE_STATUS.CANCELED);
    expect(() =>
      cancelDevDeploy(beginDevDeployAttempt(queued(), 6_000), 7_000),
    ).toThrow(/after it has started/);
  });

  it("expires pending work but never an in-flight attempt", () => {
    const expired = expireDevDeploy(queued(), 61_000);
    expect(expired.status).toBe(DEV_DEPLOY_QUEUE_STATUS.EXPIRED);
    expect(expired.failure.code).toBe("deploy_wait_expired");
    expect(() =>
      expireDevDeploy(beginDevDeployAttempt(queued(), 6_000), 61_000),
    ).toThrow(/in-flight/);
  });

  it("keeps unresolved submitted bootstrap authority past cancel and expiry", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const first = queued({
      transaction: {
        ...transaction(),
        selection: { sourceHead: TARGET_A, impact },
      },
    });
    expect(
      nextDevDeployWakeAtMs({
        ...first,
        nextAttemptAtMs: first.expiresAtMs + 5_000,
      }),
    ).toBe(first.expiresAtMs);
    const operationId = first.request.coldBootstrapOperationId;
    const pending = settleDevDeployAttempt(
      submitColdBootstrap(beginDevDeployAttempt(first, 2_000)),
      {
        attemptGeneration: first.generation,
        exitCode: 0,
        receipt: {
          action: "defer",
          currentHead: TARGET_B,
          targetHead: TARGET_B,
          impact,
        },
        nowMs: 3_000,
        pollMs: 5_000,
      },
    );

    expect(() => cancelDevDeploy(pending, 4_000)).toThrow(
      /cold-bootstrap lifecycle work/,
    );
    expect(() => expireDevDeploy(pending, pending.expiresAtMs)).toThrow(
      /cold-bootstrap lifecycle work/,
    );
    expect(nextDevDeployWakeAtMs(pending)).toBe(pending.nextAttemptAtMs);
    expect(
      beginDevDeployAttempt(pending, pending.expiresAtMs).activeAttempt
        .coldBootstrap,
    ).toMatchObject({ operationId, submittedAtMs: expect.any(Number) });
  });

  it("reconciles a submitted operation after its executor and lease expire", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const transactionWithSelection = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const submitted = submitColdBootstrap(
      beginDevDeployAttempt(
        queued({ transaction: transactionWithSelection }),
        2_000,
      ),
    );
    const operationId = submitted.request.coldBootstrapOperationId;
    const active = submitted.activeAttempt;
    const recovered = reconcileDevDeployAttempt(submitted, {
      executorLiveness: "stale",
      authority: {
        queuedAttempt: {
          attemptId: active.attemptId,
          generation: active.generation,
          targetHead: TARGET_B,
          executorGeneration: EXECUTOR_GENERATION,
        },
        currentHead: TARGET_B,
      },
      nowMs: submitted.expiresAtMs + 1,
      pollMs: 5_000,
    });

    expect(recovered).toMatchObject({
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      request: { coldBootstrapOperationId: operationId },
      lastAttempt: {
        coldBootstrap: { operationId, submittedAtMs: expect.any(Number) },
      },
    });
  });

  it("does not blindly retry after a runner disappears mid-attempt", () => {
    const interrupted = reconcileDevDeployAttempt(
      beginDevDeployAttempt(queued(), 6_000),
      { executorLiveness: "stale", nowMs: 7_000, pollMs: 5_000 },
    );
    expect(interrupted.status).toBe(DEV_DEPLOY_QUEUE_STATUS.FAILED);
    expect(interrupted.failure.code).toBe("deploy_attempt_interrupted");
  });

  it("retries the same generation only after exact checkout and absent-chain proof", () => {
    const transactionWithSelection = {
      ...transaction(),
      selection: {
        sourceHead: TARGET_A,
        impact: completeImpact({ kind: "frontend_reload" }),
      },
    };
    const begun = beginDevDeployAttempt(
      queued({ transaction: transactionWithSelection }),
      6_000,
    );
    const binding = {
      attemptId: begun.activeAttempt.attemptId,
      attemptGeneration: begun.activeAttempt.generation,
      transaction: begun.activeAttempt.transaction,
    };
    const executor = {
      pid: 39,
      processIdentity: "executor-39",
      observedAtMs: 6_100,
    };
    const attached = attachDevDeployAttemptExecutor(begun, {
      ...binding,
      executor,
    });
    const exactAuthority = {
      queuedAttempt: {
        attemptId: binding.attemptId,
        generation: binding.attemptGeneration,
        targetHead: TARGET_B,
        executorGeneration: EXECUTOR_GENERATION,
      },
      currentHead: TARGET_A,
      devChain: {
        state: "absent",
        worktreeRoot: WORKTREE,
        port: 1420,
        observedAtMs: 6_900,
      },
    };

    const recovered = reconcileDevDeployAttempt(attached, {
      executorLiveness: "stale",
      authority: exactAuthority,
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(recovered).toMatchObject({
      generation: 1,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      attempts: 1,
      nextAttemptAtMs: 12_000,
      request: { transaction: transactionWithSelection },
      priorFailure: {
        failure: { code: "deploy_attempt_interrupted" },
        transaction: transactionWithSelection,
        evidence: { attemptId: binding.attemptId, executor },
      },
      lastAttempt: {
        generation: 1,
        attemptId: binding.attemptId,
        executor,
        exitCode: 1,
      },
    });
    expect(recovered.activeAttempt).toBeUndefined();
    expect(recovered.failure).toBeUndefined();
    expect(recovered.completedAtMs).toBeUndefined();

    const targetAlreadyApplied = reconcileDevDeployAttempt(attached, {
      executorLiveness: "stale",
      authority: { ...exactAuthority, currentHead: TARGET_B },
      nowMs: 7_000,
      pollMs: 5_000,
    });
    expect(targetAlreadyApplied).toMatchObject({
      generation: 1,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      attempts: 1,
    });

    for (const authority of [
      { ...exactAuthority, currentHead: TARGET_X },
      {
        ...exactAuthority,
        devChain: { ...exactAuthority.devChain, state: "present" },
      },
      {
        ...exactAuthority,
        devChain: { ...exactAuthority.devChain, observedAtMs: 5_900 },
      },
      {
        ...exactAuthority,
        queuedAttempt: {
          ...exactAuthority.queuedAttempt,
          attemptId: "0".repeat(32),
        },
      },
    ]) {
      expect(
        reconcileDevDeployAttempt(attached, {
          executorLiveness: "stale",
          authority,
          nowMs: 7_000,
          pollMs: 5_000,
        }),
      ).toMatchObject({
        status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
        failure: { code: "deploy_attempt_interrupted" },
      });
    }
    expect(
      reconcileDevDeployAttempt(
        {
          ...attached,
          request: {
            ...attached.request,
            attemptArgs: [
              ...attached.request.attemptArgs,
              "--adopt-integrated-target",
            ],
          },
        },
        {
          executorLiveness: "stale",
          authority: exactAuthority,
          nowMs: 7_000,
          pollMs: 5_000,
        },
      ),
    ).toMatchObject({
      status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
      failure: { code: "deploy_attempt_interrupted" },
    });
    expect(
      reconcileDevDeployAttempt(attached, {
        executorLiveness: "stale",
        authority: {
          ...exactAuthority,
          devChain: { ...exactAuthority.devChain, observedAtMs: 61_000 },
        },
        nowMs: 61_000,
        pollMs: 5_000,
      }),
    ).toMatchObject({
      status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
      failure: { code: "deploy_attempt_interrupted" },
    });
  });

  it("replays a journaled cold bootstrap after executor loss even when the chain is present", () => {
    const impact = completeImpact({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    const selected = {
      ...transaction(),
      selection: { sourceHead: TARGET_A, impact },
    };
    const active = submitColdBootstrap(
      beginDevDeployAttempt(queued({ transaction: selected }), 6_000),
      6_100,
    );
    const authority = {
      queuedAttempt: {
        attemptId: active.activeAttempt.attemptId,
        generation: active.activeAttempt.generation,
        targetHead: TARGET_B,
        executorGeneration: EXECUTOR_GENERATION,
      },
      currentHead: TARGET_B,
      devChain: {
        state: "present",
        worktreeRoot: WORKTREE,
        port: 1420,
        observedAtMs: 6_900,
      },
    };
    const recovered = reconcileDevDeployAttempt(active, {
      executorLiveness: "stale",
      authority,
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(recovered.status).toBe(DEV_DEPLOY_QUEUE_STATUS.PENDING);
    expect(recovered.lastAttempt.coldBootstrap).toEqual(
      active.activeAttempt.coldBootstrap,
    );
    expect(recovered.priorFailure.evidence.coldBootstrap).toEqual(
      active.activeAttempt.coldBootstrap,
    );
    expect(beginDevDeployAttempt(recovered, 12_000).activeAttempt.coldBootstrap)
      .toEqual({
        ...active.activeAttempt.coldBootstrap,
        mode:
          DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
      });

    for (const [candidate, candidateAuthority, nowMs] of [
      [active, undefined, 7_000],
      [active, authority, active.expiresAtMs],
      [
        {
          ...active,
          request: {
            ...active.request,
            attemptArgs: [
              ...active.request.attemptArgs,
              "--adopt-integrated-target",
            ],
          },
        },
        authority,
        7_000,
      ],
    ]) {
      expect(
        reconcileDevDeployAttempt(candidate, {
          executorLiveness: "stale",
          authority: candidateAuthority,
          nowMs,
          pollMs: 5_000,
        }),
      ).toMatchObject({
        status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
        priorFailure: {
          failure: { code: "deploy_attempt_interrupted" },
        },
      });
    }
  });

  it("preserves a newer request when its older executor disappears", () => {
    const begun = beginDevDeployAttempt(queued(), 6_000);
    const binding = {
      attemptId: begun.activeAttempt.attemptId,
      attemptGeneration: begun.activeAttempt.generation,
      transaction: begun.activeAttempt.transaction,
    };
    const executor = {
      pid: 40,
      processIdentity: "executor-40",
      observedAtMs: 6_100,
    };
    const applied = recordDevDeployAttemptPhase(
      attachDevDeployAttemptExecutor(begun, { ...binding, executor }),
      { ...binding, observedAtMs: 6_200 },
    );
    const coalesced = queued({
      existing: applied,
      transaction: transaction(TARGET_C),
      receipt: {
        currentHead: TARGET_B,
        targetHead: TARGET_C,
        pendingCommits: 1,
        impact: completeImpact({ kind: "frontend_reload" }),
      },
      nowMs: 6_500,
    });

    const reconciled = reconcileDevDeployAttempt(coalesced, {
      executorLiveness: "stale",
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(reconciled).toMatchObject({
      generation: 2,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      nextAttemptAtMs: 12_000,
      request: { transaction: { targetHead: TARGET_C } },
      priorFailure: {
        failure: { code: "deploy_attempt_interrupted" },
        transaction: { targetHead: TARGET_B },
        evidence: {
          attemptId: binding.attemptId,
          executor,
          phase: { kind: "target_applied", targetHead: TARGET_B },
        },
      },
      lastAttempt: {
        generation: 1,
        attemptId: binding.attemptId,
        phase: { kind: "target_applied", targetHead: TARGET_B },
      },
    });
    expect(reconciled.activeAttempt).toBeUndefined();
    expect(reconciled.failure).toBeUndefined();
    expect(reconciled.completedAtMs).toBeUndefined();

    const repeated = queued({ existing: applied, nowMs: 6_500 });
    const failedClosed = reconcileDevDeployAttempt(repeated, {
      executorLiveness: "stale",
      nowMs: 7_000,
      pollMs: 5_000,
    });
    expect(failedClosed).toMatchObject({
      generation: 1,
      status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
      failure: { code: "deploy_attempt_interrupted" },
      request: { transaction: { targetHead: TARGET_B } },
      lastAttempt: { generation: 1, attemptId: binding.attemptId },
    });
  });

  it("durably reconciles one exact executor result without another attempt", () => {
    const begun = beginDevDeployAttempt(queued(), 6_000);
    const binding = {
      attemptId: begun.activeAttempt.attemptId,
      attemptGeneration: begun.activeAttempt.generation,
      transaction: begun.activeAttempt.transaction,
    };
    const executor = {
      pid: 41,
      processIdentity: "executor-41",
      observedAtMs: 6_100,
    };
    const attached = attachDevDeployAttemptExecutor(begun, {
      ...binding,
      executor,
    });
    const applied = recordDevDeployAttemptPhase(attached, {
      ...binding,
      observedAtMs: 6_200,
    });
    const receipt = {
      action: "deploy",
      deployed: true,
      currentHead: TARGET_A,
      targetHead: TARGET_B,
      targetAuthority: "origin/main",
      impact: completeImpact({ kind: "frontend_reload" }),
      verification: { status: "ok" },
      liveVerified: true,
      liveWorktree: WORKTREE,
      transaction: begun.activeAttempt.transaction,
      runtime: {
        pid: 42,
        processIdentity: "runtime-42",
        observedAtMs: 6_250,
        generation: "app-generation-1",
      },
    };
    const completed = recordDevDeployAttemptResult(applied, {
      ...binding,
      completedAtMs: 6_300,
      exitCode: 0,
      receipt,
    });

    expect(
      reconcileDevDeployAttempt(completed, {
        executorLiveness: "unknown",
        nowMs: 6_500,
        pollMs: 5_000,
      }),
    ).toBe(completed);

    const staleAuthority = {
      queuedAttempt: {
        attemptId: binding.attemptId,
        generation: binding.attemptGeneration,
        targetHead: TARGET_B,
        executorGeneration: EXECUTOR_GENERATION,
      },
      currentHead: TARGET_B,
      runtime: receipt.runtime,
      parentGeneration: v2Envelope("parent_generation_receipt", {
        sourceGeneration: "1".repeat(64),
        supervisor: processGeneration(70, "parent-70", "2"),
        launch: processGeneration(71, "launch-71", "3"),
        observedAtMs: 6_900,
      }),
    };
    const reconciled = reconcileDevDeployAttempt(completed, {
      executorLiveness: "stale",
      authority: staleAuthority,
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(reconciled).toMatchObject({
      status: DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED,
      attempts: 1,
      finalReceipt: { action: "deploy", targetHead: TARGET_B },
      lastAttempt: {
        attemptId: binding.attemptId,
        executor,
        phase: { kind: "target_applied", targetHead: TARGET_B },
        completedAtMs: 6_300,
        exitCode: 0,
      },
    });
    expect(reconciled.completedAtMs).toBe(7_000);
    expect(reconciled.activeAttempt).toBeUndefined();
  });

  it("rejects a stale receipt when the current app descriptor generation advanced", () => {
    const begun = beginDevDeployAttempt(queued(), 6_000);
    const binding = {
      attemptId: begun.activeAttempt.attemptId,
      attemptGeneration: begun.activeAttempt.generation,
      transaction: begun.activeAttempt.transaction,
    };
    const executor = {
      pid: 43,
      processIdentity: "executor-43",
      observedAtMs: 6_100,
    };
    const attached = attachDevDeployAttemptExecutor(begun, {
      ...binding,
      executor,
    });
    const applied = recordDevDeployAttemptPhase(attached, {
      ...binding,
      observedAtMs: 6_200,
    });
    const receipt = {
      action: "deploy",
      deployed: true,
      currentHead: TARGET_A,
      targetHead: TARGET_B,
      targetAuthority: "origin/main",
      impact: completeImpact({ kind: "frontend_reload" }),
      verification: { status: "ok" },
      liveVerified: true,
      liveWorktree: WORKTREE,
      transaction: begun.activeAttempt.transaction,
      runtime: {
        pid: 44,
        processIdentity: "runtime-44",
        observedAtMs: 6_250,
        generation: "app-generation-before",
      },
    };
    const completed = recordDevDeployAttemptResult(applied, {
      ...binding,
      completedAtMs: 6_300,
      exitCode: 0,
      receipt,
    });

    const staleAuthority = {
      queuedAttempt: {
        attemptId: binding.attemptId,
        generation: binding.attemptGeneration,
        targetHead: TARGET_B,
        executorGeneration: EXECUTOR_GENERATION,
      },
      currentHead: TARGET_B,
      runtime: {
        ...receipt.runtime,
        observedAtMs: 6_900,
        generation: "app-generation-after",
      },
      parentGeneration: v2Envelope("parent_generation_receipt", {
        sourceGeneration: "1".repeat(64),
        supervisor: processGeneration(70, "parent-70", "2"),
        launch: processGeneration(71, "launch-71", "3"),
        observedAtMs: 6_900,
      }),
    };
    const reconciled = reconcileDevDeployAttempt(completed, {
      executorLiveness: "stale",
      authority: staleAuthority,
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(reconciled).toMatchObject({
      status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
      failure: { code: "deploy_attempt_recovery_authority_mismatch" },
      lastAttempt: {
        attemptId: binding.attemptId,
        executor,
        phase: { kind: "target_applied", targetHead: TARGET_B },
        completedAtMs: 6_300,
      },
    });

    const coalesced = queued({
      existing: completed,
      transaction: transaction(TARGET_C),
      receipt: {
        currentHead: TARGET_B,
        targetHead: TARGET_C,
        pendingCommits: 1,
        impact: completeImpact({ kind: "frontend_reload" }),
      },
      nowMs: 6_500,
    });
    const preservedNewerRequest = reconcileDevDeployAttempt(coalesced, {
      executorLiveness: "stale",
      authority: staleAuthority,
      nowMs: 7_000,
      pollMs: 5_000,
    });
    expect(preservedNewerRequest).toMatchObject({
      generation: 2,
      status: DEV_DEPLOY_QUEUE_STATUS.PENDING,
      request: { transaction: { targetHead: TARGET_C } },
      priorFailure: {
        failure: { code: "deploy_attempt_recovery_authority_mismatch" },
      },
      lastAttempt: { attemptId: binding.attemptId, exitCode: 0 },
    });
    expect(preservedNewerRequest.lastSuccessfulDeployment).toBeUndefined();
  });

  it("preserves target-applied evidence when the exact executor disappears", () => {
    const begun = beginDevDeployAttempt(queued(), 6_000);
    const binding = {
      attemptId: begun.activeAttempt.attemptId,
      attemptGeneration: begun.activeAttempt.generation,
      transaction: begun.activeAttempt.transaction,
    };
    const attached = attachDevDeployAttemptExecutor(begun, {
      ...binding,
      executor: {
        pid: 51,
        processIdentity: "executor-51",
        observedAtMs: 6_100,
      },
    });
    const applied = recordDevDeployAttemptPhase(attached, {
      ...binding,
      observedAtMs: 6_200,
    });

    const interrupted = reconcileDevDeployAttempt(applied, {
      executorLiveness: "stale",
      currentHead: TARGET_B,
      observeLiveness: () => "stale",
      nowMs: 7_000,
      pollMs: 5_000,
    });

    expect(interrupted).toMatchObject({
      status: DEV_DEPLOY_QUEUE_STATUS.FAILED,
      attempts: 1,
      failure: { code: "deploy_attempt_interrupted" },
      lastAttempt: {
        evidence: {
          attemptId: binding.attemptId,
          phase: { kind: "target_applied", targetHead: TARGET_B },
        },
      },
    });
    expect(interrupted.activeAttempt).toBeUndefined();
  });

  it("waits for only the exact attached executor and rejects another writer", () => {
    const begun = beginDevDeployAttempt(queued(), 6_000);
    const binding = {
      attemptId: begun.activeAttempt.attemptId,
      attemptGeneration: begun.activeAttempt.generation,
      transaction: begun.activeAttempt.transaction,
    };
    const attached = attachDevDeployAttemptExecutor(begun, {
      ...binding,
      executor: {
        pid: 61,
        processIdentity: "executor-61",
        observedAtMs: 6_100,
      },
    });

    expect(
      reconcileDevDeployAttempt(attached, {
        executorLiveness: "active",
        nowMs: 6_200,
        pollMs: 5_000,
      }),
    ).toBe(attached);
    expect(
      reconcileDevDeployAttempt(attached, {
        executorLiveness: "unknown",
        nowMs: 6_250,
        pollMs: 5_000,
      }),
    ).toBe(attached);
    expect(() =>
      recordDevDeployAttemptResult(attached, {
        ...binding,
        attemptId: "0".repeat(32),
        completedAtMs: 6_300,
        exitCode: 0,
      }),
    ).toThrow(/no longer owns its exact transaction/);
  });

  it("rejects corrupt state and unsafe replay arguments", () => {
    expect(() =>
      parseQueuedDeployState({ ...queued(), schemaVersion: 99 }),
    ).toThrow(/unsupported/);
    expect(() =>
      parseQueuedDeployState({ ...queued(), schemaVersion: 1 }),
    ).toThrow(/unsupported/);
    expect(() => queued({ attemptArgs: ["--live-worktree", "bad\npath"] })).toThrow(
      /unsafe/,
    );
    expect(() =>
      parseQueuedDeployState({
        ...queued(),
        lastSuccessfulDeployment: {
          sourceHead: TARGET_B,
          verifiedAtMs: 2_000,
          runtime: {
            pid: 0,
            processIdentity: "reused",
            observedAtMs: 1_500,
          },
        },
      }),
    ).toThrow(/runtime pid/);

    const submitted = submitColdBootstrap(
      beginDevDeployAttempt(queued(), 6_000),
      6_100,
    );
    for (const missing of ["executor", "phase"]) {
      const corrupt = structuredClone(submitted);
      delete corrupt.activeAttempt[missing];
      expect(
        () => parseQueuedDeployState(corrupt),
        `missing ${missing}`,
      ).toThrow();
    }
    const deferred = settleDevDeployAttempt(submitted, {
      attemptGeneration: submitted.generation,
      exitCode: 0,
      receipt: {
        action: "defer",
        currentHead: TARGET_B,
        targetHead: TARGET_B,
        impact: completeImpact({ kind: "frontend_reload" }),
      },
      nowMs: 7_000,
      pollMs: 5_000,
    });
    const { phase: _phase, ...lastWithoutPhase } = deferred.lastAttempt;
    expect(() =>
      parseQueuedDeployState({
        ...deferred,
        lastAttempt: lastWithoutPhase,
      }),
    ).toThrow(/submitted cold bootstrap/);
  });
});
