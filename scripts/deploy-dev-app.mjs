#!/usr/bin/env node
/**
 * 라이브 daily-driver 워크트리를 새 main으로 옮기는 **단일 배포 경로**
 * (hebbian-frontend-x6r.11).
 *
 * 에이전트가 각자 `git merge --ff-only`로 라이브 워크트리를 밀면 Tauri dev
 * watcher가 커밋마다 재컴파일하고 모든 pane이 동시에 복구에 들어간다. 이
 * 스크립트는 그 갱신을 머신 단일 writer로 직렬화하고, 정책 경계
 * (dev-deploy-policy)에서만 한 번 옮긴다.
 *
 *   node scripts/deploy-dev-app.mjs --live-worktree <path> [--force] [--dry-run] [--json]
 *
 * worktree를 생략하면 DURE_DEV_LIVE_WORKTREE 환경변수를 쓴다.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEPLOY_ACTIONS,
  decideDevDeploy,
} from "./lib/dev-deploy-policy.mjs";
import { acquireDevDeployLock } from "./lib/dev-deploy-lock.mjs";
import {
  DEV_SERVER_PORT_ENV,
  worktreeDevIdentity,
} from "./lib/app-channel.mjs";
import {
  DEV_CHAIN_RESTART_STATE,
  executeDevChainColdBootstrap,
  executeDevChainRestart,
  executeDevParentReload,
  inspectDevChainState,
  supportsDevChainColdBootstrap,
} from "./lib/dev-chain-recovery.mjs";
import { prepareDevLaunchCheckout } from "./lib/dev-launch-checkout.mjs";
import {
  observeDevLaunchParentAuthority,
  observeDevLaunchRestartAuthority,
} from "./lib/dev-launch-client.mjs";
import {
  DEV_DEPLOY_IMPACT,
  DEV_PARENT_RELOAD_STRATEGY,
  changedPathsRequireChildRestart,
  devDeployImpact,
  devDeployRequiresControlPlaneActivation,
  devDeployRequiresChildRestart,
  devParentSourceGeneration,
  hmuxDevRuntimeStageRequired,
  nodeDependencyInstallRequired,
} from "./lib/dev-launch-impact.mjs";
import {
  DEV_HMUX_STANDALONE_OPERATION_MODE,
  devHmuxStandaloneCommandEnvironmentValue,
  parseDevHmuxStandaloneCommand,
  parseDevHmuxStandaloneOperationMode,
} from "./lib/dev-hmux-operation-contract.mjs";
import {
  parseDevHmuxActivationProof,
  parseDevHmuxBuildId,
} from "./lib/dev-hmux-tool.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  inspectNodeDependencyInstall,
  installNodeDependencies,
} from "./node-dependency-preflight.mjs";
import {
  executeHeadTransition,
  planHeadTransition,
} from "./lib/dev-deploy-head-transition.mjs";
import {
  assertNoHeadTransitionTargetPathCollision,
} from "./lib/dev-deploy-target-collision.mjs";
import {
  headTransitionArgumentTakesValue,
  isHeadTransitionArgument,
  resolveHeadTransitionRequest,
  resolveTargetCommitRequest,
  supportsExactTargetTransition,
} from "./lib/dev-deploy-head-transition-options.mjs";
import { resolveDevDeployServerProfile } from "./lib/dev-server-profile.mjs";
import {
  dispatchCoordinatedFrontendTransition,
} from "./lib/dev-frontend-transition.mjs";
import {
  DEV_DEPLOY_APPLICATION_RECEIPT_VERSION,
  parseDevDeployTransaction,
} from "./lib/dev-deploy-transaction.mjs";
import { parseColdBootstrapOperation } from "./lib/dev-cold-bootstrap-operation.mjs";
import { resolveLiveDevWorktree } from "./lib/dev-live-worktree.mjs";
import { HMUX_STAGE_AUTHORIZATION_ENV } from "./lib/hmux-app-stage-admission.mjs";
import { COREPACK_EXECUTABLE_ENV } from "./lib/corepack-install.mjs";
import {
  PACKAGE_SCRIPT_SHELL_ENV,
  POSIX_SHELL_EXECUTABLE_ENV,
  resolveCorepackExecutable,
  resolvePosixShellExecutable,
  resolveUnixDevChainTools,
} from "./lib/unix-process-tools.mjs";
import {
  activateDevControlPlaneTarget,
  reconcileDevControlPlaneActivation,
} from "./lib/dev-control-plane-activation.mjs";
import { awaitAppRuntimeReady } from "./lib/dev-app-runtime.mjs";

/** Long-running build/relaunch actions keep their own bounded transaction. */
const DEFAULT_ACTIVATION_TIMEOUT_MS = 420_000;
const DEFAULT_DEV_PORT = 1420;
const PARENT_RECONCILIATION_TIMEOUT_MS = 30_000;
const APP_RUNTIME_READINESS_TIMEOUT_MS = 120_000;
const HMUX_ACTIVATION_RECEIPT_PREFIX = "DURE_HMUX_ACTIVATION_V1 ";
const SELF = fileURLToPath(import.meta.url);
const QUEUED_ATTEMPT_ID = /^[a-f0-9]{32}$/;

function coldBootstrapUnavailable(
  reason,
  state = DEV_CHAIN_RESTART_STATE.NOT_STARTED,
) {
  return {
    kind: "cold_bootstrap",
    state,
    attempted: false,
    destructiveBoundaryCrossed: false,
    relaunchDispatched: false,
    reason: `dev_launch_cold_bootstrap_unavailable: ${reason}`,
  };
}

/** The last lines a failed stage wrote, joined so they survive as one reason. */
function stageDiagnostic(stderr) {
  const lines = (stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-3).join(" | ") || "no diagnostic output";
}

function activatedAppLaunch(plannedTransition, residualTransition) {
  const transition = residualTransition ?? plannedTransition;
  return (
    transition?.receipt?.parentGeneration?.launch ??
    transition?.receipt?.launch
  );
}

function stageLocalHmuxRuntime({
  root,
  deployLock,
  shellExecutable,
  targetHead,
  channel,
}) {
  // Remote bundles have their own explicit preparation/release workflow.
  // Local activation must neither compile them nor relabel retained artifacts.
  const staged = spawnSync(
    process.execPath,
    [
      join(root, "scripts/run-with-build-storage.mjs"),
      "full",
      "--",
      shellExecutable,
      join(root, "scripts/stage-hmux-runtime.sh"),
      "debug",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...withoutLocalGitOverrides(),
        [POSIX_SHELL_EXECUTABLE_ENV]: shellExecutable,
        [HMUX_STAGE_AUTHORIZATION_ENV]: `Bearer ${deployLock.token}`,
        HMUX_DEV_CHANNEL: channel,
      },
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (staged.stderr) process.stderr.write(staged.stderr);
  if (staged.stdout) process.stderr.write(staged.stdout);
  if (staged.error) throw staged.error;
  if (staged.status !== 0) {
    // Preserve the stage diagnostic in the queue's failure receipt.
    throw new Error(
      `Hmux stage exited ${staged.status ?? staged.signal}: ${stageDiagnostic(staged.stderr)}`,
    );
  }
  const buildId = parseDevHmuxBuildId(
    (staged.stdout ?? "")
      .split("\n")
      .find((line) => line.startsWith(HMUX_ACTIVATION_RECEIPT_PREFIX))
      ?.slice(HMUX_ACTIVATION_RECEIPT_PREFIX.length),
  );
  return parseDevHmuxActivationProof(
    { schemaVersion: 1, sourceRevision: targetHead, channel, buildId },
    { sourceRevision: targetHead, channel },
  );
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    // 훅에서 불릴 수 있다 — 저장소 지역 Git 포인터를 다른 cwd로 물려주지 않는다.
    env: withoutLocalGitOverrides(),
  }).trim();
}

function changedPathsBetween(root, sourceHead, targetHead) {
  if (sourceHead === targetHead) return [];
  return git(root, ["diff", "--name-only", `${sourceHead}..${targetHead}`])
    .split("\n")
    .filter(Boolean);
}

function coordinatedFrontendSourceTransition(paths) {
  return (
    paths.length > 0 &&
    paths.every(
      (relativePath) =>
        relativePath.startsWith("src/") &&
        relativePath !== "src/contracts/frontendRuntimeObservation.mjs",
    )
  );
}

function includesFrontendSourceTransition(paths) {
  return paths.some(
    (relativePath) =>
      relativePath.startsWith("src/") &&
      relativePath !== "src/contracts/frontendRuntimeObservation.mjs",
  );
}

function exactLocalCommit(root, requested) {
  let resolved;
  try {
    resolved = git(root, ["rev-parse", "--verify", `${requested}^{commit}`]);
  } catch {
    throw new Error(
      "--target-commit does not resolve to the exact requested commit",
    );
  }
  if (resolved !== requested) {
    throw new Error(
      "--target-commit does not resolve to the exact requested commit",
    );
  }
  return resolved;
}

async function admitAbsentDevChainBootstrap({
  transition,
  root,
  channel,
  port,
  sourceGeneration,
  requestGeneration,
  operationId,
  initialRows,
  initialColumns,
  coldBootstrapMode,
  command,
  hmuxBuildId,
  coldBootstrapToolCapability,
  onOperationSubmitted,
  timeoutMs,
}) {
  if (!operationId) return transition;
  if (coldBootstrapMode === DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE) {
    if (
      transition?.relaunchDispatched ||
      transition?.state === DEV_CHAIN_RESTART_STATE.CONVERGED
    ) {
      return transition;
    }
    if (!supportsDevChainColdBootstrap(coldBootstrapToolCapability)) {
      return transition;
    }
    let chain;
    try {
      chain = inspectDevChainState({
        root,
        port,
        toolCapability: coldBootstrapToolCapability,
      });
    } catch (error) {
      chain = { state: "unknown", reason: error.message };
    }
    if (chain?.state === "present") return transition;
    if (chain?.state !== "absent") {
      return coldBootstrapUnavailable(
        chain?.reason ?? "dev chain absence was not proven",
        DEV_CHAIN_RESTART_STATE.FAILED,
      );
    }
  }
  return executeDevChainColdBootstrap(
    {
      root,
      channel,
      port,
      sourceGeneration,
      requestGeneration,
      operationId,
      initialRows,
      initialColumns,
      mode: coldBootstrapMode,
      command,
      hmuxBuildId,
      onOperationSubmitted,
      timeoutMs,
    },
    coldBootstrapToolCapability
      ? { resolveTools: () => coldBootstrapToolCapability }
      : {},
  );
}

function parseQueuedColdBootstrapMode(attempt) {
  const legacyReconcile = attempt.coldBootstrapReplay;
  if (legacyReconcile !== undefined && legacyReconcile !== true) {
    throw new Error("invalid legacy cold-bootstrap replay action");
  }
  const explicitMode = Object.hasOwn(attempt, "coldBootstrapMode")
    ? parseDevHmuxStandaloneOperationMode(attempt.coldBootstrapMode)
    : undefined;
  if (
    explicitMode ===
    DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET
  ) {
    throw new Error("retirement acknowledgement is not a deploy action");
  }
  if (
    legacyReconcile === true &&
    explicitMode !== undefined &&
    explicitMode !==
      DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET
  ) {
    throw new Error("contradictory cold-bootstrap actions");
  }
  return (
    explicitMode ??
    (legacyReconcile === true
      ? DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET
      : DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE)
  );
}

function assertQueuedColdBootstrapBinding(attempt, activeAttempt) {
  const expected = activeAttempt?.coldBootstrap;
  if (
    !expected ||
    attempt.coldBootstrapOperationId !== expected.operationId ||
    attempt.coldBootstrapInitialRows !== expected.initialRows ||
    attempt.coldBootstrapInitialColumns !== expected.initialColumns
  ) {
    throw new Error("queued cold-bootstrap operation binding no longer matches");
  }
  if (
    attempt.coldBootstrapMode !== DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE &&
    (expected.submittedAtMs === undefined ||
      JSON.stringify(attempt.coldBootstrapCommand) !==
        JSON.stringify(expected.command) ||
      attempt.coldBootstrapHmuxBuildId !== expected.hmuxBuildId)
  ) {
    throw new Error("queued cold-bootstrap submitted binding no longer matches");
  }
}

function exactLocalTarget(root, currentHead, requested) {
  const resolved = exactLocalCommit(root, requested);
  try {
    git(root, ["merge-base", "--is-ancestor", currentHead, resolved]);
  } catch {
    throw new Error("--target-commit must be a fast-forward of the live head");
  }
  return resolved;
}

function exactLocalWorktreeStatus(root) {
  return git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

function assertFastForwardCheckoutAdmissible(root, currentHead, targetHead) {
  if (git(root, ["rev-parse", "HEAD"]) !== currentHead) {
    throw new Error("live head changed before fast-forward admission");
  }
  if (currentHead === targetHead) return;
  // A byte-for-byte restored file can retain stale index metadata. Refreshing
  // the cache is non-destructive; read-tree remains the admission authority.
  try {
    git(root, ["update-index", "-q", "--refresh"]);
  } catch {}
  try {
    git(root, [
      "read-tree",
      "--dry-run",
      "-m",
      "-u",
      currentHead,
      targetHead,
    ]);
  } catch (error) {
    throw new Error(
      `live fast-forward is not admissible: ${error.stderr?.trim() || error.message}`,
    );
  }
  assertNoHeadTransitionTargetPathCollision({
    root,
    currentHead,
    targetHead,
  });
}

function assertExactLocalFastForwardBoundary(root, currentHead, targetHead) {
  assertFastForwardCheckoutAdmissible(root, currentHead, targetHead);
  if (exactLocalWorktreeStatus(root)) {
    throw new Error("exact local deploy requires a clean worktree");
  }
}

function assertExactLocalTargetResult(root, targetHead) {
  if (git(root, ["rev-parse", "HEAD"]) !== targetHead) {
    throw new Error("exact local deploy did not reach the requested commit");
  }
  if (exactLocalWorktreeStatus(root)) {
    throw new Error("exact local deploy left a dirty worktree");
  }
}

/** 머신 HID idle(초). macOS 밖이거나 읽을 수 없으면 null — 신호 없음은
 *  배포를 막지 않는다(정책이 null을 그렇게 다룬다). */
function userIdleSeconds() {
  try {
    const out = execFileSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const match = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!match) return null;
    return Number(match[1]) / 1_000_000_000;
  } catch {
    return null;
  }
}

function deployTarget(transaction, requestedTargetCommit, headTransition) {
  if (transaction) {
    if (requestedTargetCommit) {
      throw new Error(
        "queued deploy transaction cannot be combined with --target-commit",
      );
    }
    if (
      transaction.targetAuthority === "exact-local-candidate" &&
      !supportsExactTargetTransition(headTransition)
    ) {
      throw new Error(
        "exact-local queued deploy transaction cannot use a head transition",
      );
    }
    return {
      authority: transaction.targetAuthority,
      commit: transaction.targetHead,
    };
  }
  return requestedTargetCommit
    ? {
        authority: "exact-local-candidate",
        commit: requestedTargetCommit,
      }
    : { authority: "origin/main" };
}

function parseArguments(argv) {
  const headTransition = resolveHeadTransitionRequest(argv);
  const requestedTargetCommit = resolveTargetCommitRequest(
    argv,
    headTransition,
  );
  const options = {
    force: false,
    dryRun: false,
    json: false,
    liveWorktree: undefined,
    restartOnly: false,
    parentReconciliationTarget: undefined,
    headTransition,
    activationTimeoutMs: DEFAULT_ACTIVATION_TIMEOUT_MS,
    portArgument: undefined,
    transaction: undefined,
    queuedAttempt: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") options.force = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--json") options.json = true;
    // Compatibility no-ops for queue entries persisted before receipt v2.
    // Daily deploy has no verification mode, while required activation remains
    // part of applying a backend or launcher target and cannot be disabled.
    else if (argument === "--no-verify") {}
    else if (argument === "--no-recover") {}
    // Compatibility action for an already-current checkout whose process must
    // be relaunched. It dispatches the relaunch without a verification phase.
    else if (argument === "--restart-only") options.restartOnly = true;
    else if (argument === "--reconcile-parent-target") {
      if (options.parentReconciliationTarget !== undefined) {
        throw new Error("parent reconciliation target may only be specified once");
      }
      const value = argv[(index += 1)];
      if (!value || value.length > 256) {
        throw new Error("parent reconciliation target is invalid");
      }
      options.parentReconciliationTarget = value;
    }
    else if (argument === "--queued-deploy-transaction") {
      if (options.transaction !== undefined) {
        throw new Error("queued deploy transaction may only be specified once");
      }
      const source = argv[(index += 1)];
      try {
        options.transaction = parseDevDeployTransaction(JSON.parse(source));
      } catch {
        throw new Error("queued deploy transaction is invalid");
      }
    }
    else if (argument === "--queued-deploy-attempt") {
      if (options.queuedAttempt !== undefined) {
        throw new Error("queued deploy attempt may only be specified once");
      }
      try {
        const attempt = JSON.parse(argv[(index += 1)]);
        const coldBootstrapMode = parseQueuedColdBootstrapMode(attempt);
        const boundColdBootstrapAction =
          coldBootstrapMode !== DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE;
        if (
          attempt?.schemaVersion !== 1 ||
          typeof attempt.attemptId !== "string" ||
          !QUEUED_ATTEMPT_ID.test(attempt.attemptId) ||
          !Number.isSafeInteger(attempt.generation) ||
          attempt.generation < 1 ||
          (boundColdBootstrapAction &&
            (attempt.coldBootstrapOperationId === undefined ||
              attempt.coldBootstrapCommand === undefined)) ||
          (attempt.coldBootstrapOperationId === undefined &&
            (attempt.coldBootstrapInitialRows !== undefined ||
              attempt.coldBootstrapInitialColumns !== undefined ||
              attempt.coldBootstrapHmuxBuildId !== undefined)) ||
          (!boundColdBootstrapAction &&
            (attempt.coldBootstrapCommand !== undefined ||
              attempt.coldBootstrapHmuxBuildId !== undefined))
        ) {
          throw new Error("invalid attempt");
        }
        options.queuedAttempt = {
          ...attempt,
          coldBootstrapMode,
          ...(attempt.coldBootstrapOperationId === undefined
            ? {}
            : (() => {
                const operation = parseColdBootstrapOperation({
                  operationId: attempt.coldBootstrapOperationId,
                  initialRows: attempt.coldBootstrapInitialRows,
                  initialColumns: attempt.coldBootstrapInitialColumns,
                });
                return {
                  coldBootstrapOperationId: operation.operationId,
                  coldBootstrapInitialRows: operation.initialRows,
                  coldBootstrapInitialColumns: operation.initialColumns,
                };
              })()),
          ...(boundColdBootstrapAction
            ? {
                coldBootstrapCommand: parseDevHmuxStandaloneCommand(
                  attempt.coldBootstrapCommand,
                ),
                ...(attempt.coldBootstrapHmuxBuildId === undefined
                  ? {}
                  : {
                      coldBootstrapHmuxBuildId: parseDevHmuxBuildId(
                        attempt.coldBootstrapHmuxBuildId,
                      ),
                    }),
              }
            : {}),
        };
      } catch {
        throw new Error("queued deploy attempt is invalid");
      }
    }
    else if (argument === "--target-commit") index += 1;
    else if (isHeadTransitionArgument(argument)) {
      if (headTransitionArgumentTakesValue(argument)) index += 1;
    }
    else if (argument === "--worktree") {
      throw new Error(
        "--worktree is ambiguous; pass --live-worktree <path> for the checkout hosting the running daily driver",
      );
    }
    else if (argument === "--live-worktree") {
      const value = argv[(index += 1)];
      if (!value) throw new Error("--live-worktree requires a value");
      options.liveWorktree = value;
    }
    else if (argument === "--port") {
      if (options.portArgument !== undefined) {
        throw new Error("--port may only be specified once");
      }
      const value = argv[(index += 1)];
      if (value === undefined) throw new Error("--port requires a value");
      options.portArgument = value;
    } else if (argument === "--verify-timeout") index += 1;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.restartOnly && options.headTransition) {
    throw new Error(
      "--restart-only cannot be combined with a head transition mode",
    );
  }
  if (options.restartOnly && options.dryRun) {
    throw new Error("--restart-only cannot be combined with --dry-run");
  }
  if (options.transaction) {
    if (
      realpathSync(options.transaction.executor.entrypoint) !==
      realpathSync(SELF)
    ) {
      throw new Error(
        "queued deploy transaction does not name the executing generation",
      );
    }
  }
  if (options.queuedAttempt && !options.transaction) {
    throw new Error(
      "queued deploy attempt identity requires its exact transaction",
    );
  }
  options.target = deployTarget(
    options.transaction,
    requestedTargetCommit,
    headTransition,
  );
  return options;
}

async function createQueuedAttemptRecorder(options) {
  if (!options.queuedAttempt) return null;
  const queue = await import("./lib/dev-deploy-queue.mjs");
  const { DevDeployQueueStore, processIdentity } = await import(
    "./lib/dev-deploy-queue-store.mjs"
  );
  const store = new DevDeployQueueStore();
  const binding = {
    attemptId: options.queuedAttempt.attemptId,
    attemptGeneration: options.queuedAttempt.generation,
    transaction: options.transaction,
  };
  const executor = {
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
    observedAtMs: Date.now(),
  };
  if (!executor.processIdentity) {
    throw new Error("queued deploy executor identity is unavailable");
  }
  const mutateExact = (mutation) =>
    store.mutate((current) => {
      if (current?.worktree !== options.liveWorktree) {
        throw new Error("queued deploy attempt worktree no longer matches");
      }
      return mutation(current);
    });
  const attached = mutateExact((current) => {
    const next = queue.attachDevDeployAttemptExecutor(current, {
      ...binding,
      executor,
    });
    assertQueuedColdBootstrapBinding(
      options.queuedAttempt,
      next.activeAttempt,
    );
    return next;
  });
  const backendHead = queue.lastSuccessfulDeploymentFor(attached)?.backendHead;
  let resultRecorded = false;
  return {
    ...(backendHead ? { backendHead } : {}),
    recordTargetApplied(targetHead) {
      if (targetHead !== options.transaction.targetHead) {
        throw new Error("queued deploy phase target no longer matches");
      }
      mutateExact((current) =>
        queue.recordDevDeployAttemptPhase(current, {
          ...binding,
          observedAtMs: Date.now(),
        }),
      );
    },
    recordColdBootstrapSubmitted(operationId, command, hmuxBuildId) {
      mutateExact((current) =>
        queue.recordDevDeployColdBootstrapSubmission(current, {
          ...binding,
          operationId,
          command,
          hmuxBuildId,
          submittedAtMs: Date.now(),
        }),
      );
    },
    recordResult(receipt, exitCode, stderr) {
      mutateExact((current) =>
        queue.recordDevDeployAttemptResult(current, {
          ...binding,
          completedAtMs: Date.now(),
          exitCode,
          receipt,
          stderr,
        }),
      );
      resultRecorded = true;
    },
    recordFailure(error) {
      if (resultRecorded) return;
      this.recordResult(undefined, 1, error?.message ?? String(error));
    },
    close() {
      store.close();
    },
  };
}

async function deploy(options) {
  const root = resolveLiveDevWorktree({ explicitPath: options.liveWorktree });
  options.liveWorktree = root;
  options.attemptRecorder = await createQueuedAttemptRecorder(options);
  options.coldBootstrapOperationId =
    options.queuedAttempt?.coldBootstrapOperationId;
  options.coldBootstrapInitialRows =
    options.queuedAttempt?.coldBootstrapInitialRows;
  options.coldBootstrapInitialColumns =
    options.queuedAttempt?.coldBootstrapInitialColumns;
  options.coldBootstrapMode =
    options.queuedAttempt?.coldBootstrapMode ??
    DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE;
  options.coldBootstrapHmuxBuildId =
    options.queuedAttempt?.coldBootstrapHmuxBuildId;
  const { channel } = worktreeDevIdentity(root);
  const devServer = resolveDevDeployServerProfile({
    home: homedir(),
    channel,
    worktreeRoot: root,
    explicitPort: options.portArgument,
    ambientPort: process.env[DEV_SERVER_PORT_ENV] ?? String(DEFAULT_DEV_PORT),
  });
  options.port = devServer.port;

  let preparedTarget;
  if (!options.restartOnly) {
    if (!options.target.commit) {
      git(root, ["fetch", "origin", "main", "--quiet"]);
    }
    const observedHead = git(root, ["rev-parse", "HEAD"]);
    const targetHead = options.target.commit
      ? options.headTransition
        ? exactLocalCommit(root, options.target.commit)
        : exactLocalTarget(root, observedHead, options.target.commit)
      : git(root, ["rev-parse", "origin/main"]);
    const parentReconciliationAtTarget =
      options.parentReconciliationTarget !== undefined &&
      observedHead === targetHead;
    const previewSourceHead =
      options.transaction?.selection?.sourceHead ??
      options.parentReconciliationTarget ??
      observedHead;
    const checkoutChangedPaths = changedPathsBetween(
      root,
      observedHead,
      targetHead,
    );
    const previewChangedPaths = changedPathsBetween(
      root,
      previewSourceHead,
      targetHead,
    );
    const transitionPaths =
      checkoutChangedPaths.length > 0
        ? checkoutChangedPaths
        : previewChangedPaths;
    preparedTarget = {
      observedHead,
      targetHead,
      checkoutChangedPaths,
      parentReconciliationAtTarget,
      suppressHmr:
        !options.headTransition &&
        (coordinatedFrontendSourceTransition(transitionPaths) ||
          (parentReconciliationAtTarget &&
            includesFrontendSourceTransition(previewChangedPaths))),
    };
  }

  const deployLease = acquireDevDeployLock({
    worktreeRoot: root,
    channel,
    suppressHmr: preparedTarget?.suppressHmr ?? false,
  });
  if (!deployLease) {
    report(options, {
      action: DEPLOY_ACTIONS.DEFER,
      reason: "another deploy coordinator holds the lock",
    });
    return;
  }
  try {
    if (options.restartOnly) {
      const recovery = await executeDevChainRestart({ root, channel });
      const failed = !recovery.relaunchDispatched;
      report(
        options,
        {
          action: "restart-only",
          currentHead: git(root, ["rev-parse", "HEAD"]),
          reason: recovery.reason,
          recovery,
          dispatched: recovery.relaunchDispatched,
        },
        failed ? 1 : 0,
      );
      if (failed) {
        process.exitCode = 1;
      }
      return;
    }
    const {
      observedHead,
      targetHead,
      checkoutChangedPaths,
      parentReconciliationAtTarget,
    } = preparedTarget;
    if (git(root, ["rev-parse", "HEAD"]) !== observedHead) {
      report(options, {
        action: DEPLOY_ACTIONS.DEFER,
        reason: "live head changed before the deploy lease was acquired",
        currentHead: observedHead,
        targetHead,
      });
      return;
    }
    const targetAuthority = options.target.authority;
    const transitionPlan = options.headTransition
      ? planHeadTransition({
          root,
          home: homedir(),
          currentHead: observedHead,
          targetHead,
          request: options.headTransition,
        })
      : undefined;
    const activationSourceHead =
      options.transaction?.selection?.sourceHead ??
      transitionPlan?.currentHead ??
      observedHead;
    const currentHead = parentReconciliationAtTarget
      ? observedHead
      : activationSourceHead;
    const changedPaths = changedPathsBetween(
      root,
      activationSourceHead,
      targetHead,
    );
    const pendingCommits =
      currentHead === targetHead
        ? 0
        : Number(git(root, ["rev-list", "--count", `${currentHead}..${targetHead}`]));
    const targetAgeMs =
      currentHead === targetHead
        ? null
        : Date.now() - Number(git(root, ["log", "-1", "--format=%ct", targetHead])) * 1000;
    const backendSourceHead =
      options.attemptRecorder?.backendHead ?? activationSourceHead;
    const backendChangedPaths = changedPathsBetween(
      root,
      backendSourceHead,
      targetHead,
    );
    const impact =
      options.transaction?.selection?.impact ?? devDeployImpact(changedPaths);

    const parentReconciliationRequired =
      options.parentReconciliationTarget !== undefined;
    const selectedLifecycleAtTarget =
      Boolean(options.transaction) &&
      observedHead === targetHead &&
      !parentReconciliationAtTarget &&
      (impact.kind === DEV_DEPLOY_IMPACT.PARENT_RELOAD ||
        devDeployRequiresChildRestart(impact) ||
        devDeployRequiresControlPlaneActivation(impact));
    const decision = parentReconciliationAtTarget
      ? {
          action: DEPLOY_ACTIONS.SKIP,
          reason: "resuming target parent activation",
        }
      : selectedLifecycleAtTarget
      ? {
          action: DEPLOY_ACTIONS.DEPLOY,
          reason: "selected target lifecycle is not activated",
        }
      : decideDevDeploy({
          currentHead,
          targetHead,
          pendingCommits,
          targetAgeMs,
          userIdleSeconds: userIdleSeconds(),
          // pane 입력 관측은 아직 없다 — null은 정책상 '막지 않음'이고,
          // HID idle이 사용자 활동을 이미 덮는다 (hebbian-frontend-x6r.11 후속).
          paneInputAgeMs: null,
          force: options.force,
          impact,
        });

    const queuedLifecycleAtTarget =
      decision.action === DEPLOY_ACTIONS.SKIP &&
      Boolean(
        options.transaction &&
          (parentReconciliationAtTarget ||
            (options.coldBootstrapOperationId &&
              (options.coldBootstrapMode !==
                DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE ||
                (impact.kind === DEV_DEPLOY_IMPACT.PARENT_RELOAD &&
                  impact.parentStrategy ===
                    DEV_PARENT_RELOAD_STRATEGY.COLD_BOOTSTRAP)))),
      );
    if (
      (!queuedLifecycleAtTarget && decision.action !== DEPLOY_ACTIONS.DEPLOY) ||
      options.dryRun
    ) {
      report(options, {
        ...decision,
        currentHead,
        targetHead,
        targetAuthority,
        pendingCommits,
        impact,
      });
      return;
    }
    const replayCommand =
      options.coldBootstrapMode === DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE
        ? undefined
        : options.queuedAttempt?.coldBootstrapCommand;
    const replayCorepackExecutable = devHmuxStandaloneCommandEnvironmentValue(
      replayCommand,
      COREPACK_EXECUTABLE_ENV,
    );
    const replayShellExecutable = devHmuxStandaloneCommandEnvironmentValue(
      replayCommand,
      POSIX_SHELL_EXECUTABLE_ENV,
    );
    const activatingTarget =
      options.coldBootstrapMode === DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE;
    const backendChanged = impact.backendChanged;
    const controlPlaneActivationRequired =
      devDeployRequiresControlPlaneActivation(impact);
    const parentLifecycleRequired =
      parentReconciliationRequired ||
      impact.kind === DEV_DEPLOY_IMPACT.PARENT_RELOAD;
    const dependencyInstallRequired =
      nodeDependencyInstallRequired(changedPaths);
    if (!options.headTransition) {
      assertFastForwardCheckoutAdmissible(root, observedHead, targetHead);
    }
    if (
      options.coldBootstrapMode ===
      DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET
    ) {
      const plannedTransition = await executeDevChainColdBootstrap({
        root,
        channel,
        requestGeneration: deployLease.record.generation,
        operationId: options.coldBootstrapOperationId,
        initialRows: options.coldBootstrapInitialRows,
        initialColumns: options.coldBootstrapInitialColumns,
        mode: options.coldBootstrapMode,
        command: replayCommand,
        hmuxBuildId: options.coldBootstrapHmuxBuildId,
        timeoutMs: options.activationTimeoutMs,
      });
      const deferred =
        plannedTransition.state === DEV_CHAIN_RESTART_STATE.PENDING;
      report(
        options,
        {
          ...(deferred ? { action: DEPLOY_ACTIONS.DEFER } : decision),
          reason: plannedTransition.reason,
          currentHead,
          targetHead,
          targetAuthority,
          pendingCommits,
          impact,
          deployed: false,
          backendChanged,
          dependencyInstallRequired,
          plannedTransition,
          dispatchAccepted: false,
        },
        deferred ? 0 : 1,
      );
      if (!deferred) process.exitCode = 1;
      return;
    }
    let coldBootstrapToolCapability;
    const freshColdBootstrapRequested = Boolean(
      options.transaction &&
        options.coldBootstrapOperationId &&
        options.coldBootstrapMode ===
          DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
    );
    const coldBootstrapDependencyRepairRequired =
      freshColdBootstrapRequested && !inspectNodeDependencyInstall(root).ok;
    const corepackRequired =
      process.platform !== "win32" &&
      ((activatingTarget &&
        (controlPlaneActivationRequired || dependencyInstallRequired)) ||
        coldBootstrapDependencyRepairRequired);
    const corepackExecutable =
      replayCorepackExecutable ??
      (corepackRequired && activatingTarget
        ? resolveCorepackExecutable()
        : undefined);
    if (corepackRequired && !corepackExecutable) {
      throw new Error(
        "development deployment stopped before checkout: Corepack is unavailable",
      );
    }
    if (freshColdBootstrapRequested) {
      coldBootstrapToolCapability = resolveUnixDevChainTools({
        dependencyInstallerExecutable: corepackExecutable,
      });
      if (
        !supportsDevChainColdBootstrap(coldBootstrapToolCapability) &&
        (!parentLifecycleRequired || parentReconciliationAtTarget)
      ) {
        let authorityFailureReason =
          impact.parentStrategy ===
          DEV_PARENT_RELOAD_STRATEGY.COLD_BOOTSTRAP
            ? "the selected target requires a fresh cold bootstrap"
            : undefined;
        if (!authorityFailureReason) {
          try {
            const observeAuthority = parentReconciliationAtTarget
              ? observeDevLaunchParentAuthority
              : observeDevLaunchRestartAuthority;
            await observeAuthority({
              root,
              channel,
              ...(parentReconciliationAtTarget
                ? {
                    requireParentReloadAuthority: true,
                    requireFrontendAuthority: true,
                  }
                : {}),
              timeoutMs: Math.min(
                options.activationTimeoutMs,
                PARENT_RECONCILIATION_TIMEOUT_MS,
              ),
            });
          } catch (error) {
            authorityFailureReason = error.message;
          }
        }
        if (authorityFailureReason) {
          const plannedTransition = coldBootstrapUnavailable(
            `${coldBootstrapToolCapability.reason}; authenticated dev chain unavailable: ${authorityFailureReason}`,
          );
          report(
            options,
            {
              ...decision,
              reason: plannedTransition.reason,
              currentHead,
              targetHead,
              targetAuthority,
              pendingCommits,
              impact,
              deployed: false,
              backendChanged,
              dependencyInstallRequired,
              plannedTransition,
            },
            1,
          );
          process.exitCode = 1;
          return;
        }
      }
    }
    if (
      (parentLifecycleRequired ||
        (activatingTarget && devDeployRequiresChildRestart(impact))) &&
      !parentReconciliationAtTarget
    ) {
      const admission = await prepareDevLaunchCheckout(
        {
          kind: parentLifecycleRequired
            ? DEV_DEPLOY_IMPACT.PARENT_RELOAD
            : DEV_DEPLOY_IMPACT.CHILD_RESTART,
          root,
          channel,
          port: options.port,
          parentStrategy: impact.parentStrategy,
          allowColdBootstrap: Boolean(options.coldBootstrapOperationId),
          coldBootstrapReplay:
            options.coldBootstrapMode ===
            DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
          timeoutMs: Math.min(
            options.activationTimeoutMs,
            PARENT_RECONCILIATION_TIMEOUT_MS,
          ),
        },
        coldBootstrapToolCapability
          ? { resolveTools: () => coldBootstrapToolCapability }
          : {},
      );
      if (!admission.admitted) {
        report(
          options,
          {
            ...decision,
            reason: admission.transition.reason,
            currentHead,
            targetHead,
            targetAuthority,
            pendingCommits,
            impact,
            deployed: false,
            backendChanged,
            dependencyInstallRequired,
            plannedTransition: admission.transition,
            dispatchAccepted: false,
          },
          1,
        );
        process.exitCode = 1;
        return;
      }
      coldBootstrapToolCapability ??=
        admission.coldBootstrapToolCapability;
    }
    const hmuxRuntimeStaged =
      impact.hmuxRuntimeChanged === true ||
      hmuxDevRuntimeStageRequired(backendChangedPaths);
    const dependencyShellRequired =
      activatingTarget && dependencyInstallRequired;
    const runtimeToolsStaged = backendChanged || hmuxRuntimeStaged;
    const stagingShellExecutable = runtimeToolsStaged
      ? replayShellExecutable ??
        coldBootstrapToolCapability?.tools.shellExecutable ??
        resolvePosixShellExecutable()
      : undefined;
    if (runtimeToolsStaged && !stagingShellExecutable) {
      throw new Error(
        "development runtime tool staging failed: a POSIX shell is unavailable",
      );
    }
    const dependencyShellExecutable = dependencyShellRequired
      ? replayShellExecutable ??
        coldBootstrapToolCapability?.tools.shellExecutable ??
        stagingShellExecutable ??
        resolvePosixShellExecutable()
      : undefined;
    if (dependencyShellRequired && !dependencyShellExecutable) {
      throw new Error(
        "development dependency installation failed: a POSIX shell is unavailable",
      );
    }
    const deploymentShellExecutable =
      replayShellExecutable ??
      dependencyShellExecutable ??
      stagingShellExecutable;
    const deploymentToolEnvironment =
      corepackExecutable || deploymentShellExecutable
        ? {
            ...process.env,
            ...(corepackExecutable
              ? { [COREPACK_EXECUTABLE_ENV]: corepackExecutable }
              : {}),
            ...(deploymentShellExecutable
              ? {
                  [POSIX_SHELL_EXECUTABLE_ENV]: deploymentShellExecutable,
                  [PACKAGE_SCRIPT_SHELL_ENV]: deploymentShellExecutable,
                }
              : {}),
          }
        : process.env;
    // The ordinary path stays fast-forward only. Every exceptional divergent
    // transition uses the same durable retained-head state machine and adds its
    // own proof before the shared boundary.
    if (targetAuthority === "exact-local-candidate" && !transitionPlan) {
      assertExactLocalFastForwardBoundary(root, observedHead, targetHead);
    }
    const sourceMutationStartedAtMs = Date.now();
    const headTransition = transitionPlan
      ? executeHeadTransition(transitionPlan)
      : (git(root, ["merge", "--ff-only", "--quiet", targetHead]), undefined);
    if (targetAuthority === "exact-local-candidate") {
      assertExactLocalTargetResult(root, targetHead);
    }
    options.attemptRecorder?.recordTargetApplied(targetHead);
    const deployedAtMs = Date.now();
    const hmuxActivation = hmuxRuntimeStaged
      ? stageLocalHmuxRuntime({
          root,
          deployLock: deployLease.record,
          shellExecutable: stagingShellExecutable,
          targetHead,
          channel,
        })
      : undefined;
    const controlPlane = !controlPlaneActivationRequired
      ? undefined
      : activatingTarget
        ? await activateDevControlPlaneTarget({
            root,
            targetHead,
            timeoutMs: options.activationTimeoutMs,
            environment: deploymentToolEnvironment,
          })
        : reconcileDevControlPlaneActivation({
            root,
            targetHead,
            environment: deploymentToolEnvironment,
          });
    if (controlPlane && controlPlane.status !== "ok") {
      const deferred = controlPlane.status === "pending";
      report(
        options,
        {
          ...(deferred ? { action: DEPLOY_ACTIONS.DEFER } : decision),
          reason: controlPlane.reason,
          currentHead,
          targetHead,
          targetAuthority,
          pendingCommits,
          impact,
          deployed: true,
          backendChanged,
          hmuxRuntimeStaged,
          ...(hmuxActivation ? { hmuxActivation } : {}),
          controlPlanePayloadStaged: controlPlane.staged,
          controlPlaneTransition: controlPlane,
          dependencyInstallRequired,
          dispatchAccepted: false,
        },
        deferred ? 0 : 1,
      );
      if (!deferred) process.exitCode = 1;
      return;
    }
    let resolvedTargetParentSourceGeneration;
    const targetParentSourceGeneration = () => {
      resolvedTargetParentSourceGeneration ??= devParentSourceGeneration(root);
      return resolvedTargetParentSourceGeneration;
    };
    const expectedParentSourceGeneration =
      parentLifecycleRequired
        ? targetParentSourceGeneration()
        : undefined;
    const coldBootstrapRequired =
      parentLifecycleRequired &&
      impact.parentStrategy === DEV_PARENT_RELOAD_STRATEGY.COLD_BOOTSTRAP;
    const executeParentTransition = () =>
      executeDevParentReload({
        root,
        channel,
        sourceGeneration: expectedParentSourceGeneration,
        parentStrategy: impact.parentStrategy,
        timeoutMs: options.activationTimeoutMs,
      });
    const runtimePinTransition = coldBootstrapRequired
      ? await executeParentTransition()
      : undefined;

    // The fast-forward makes the new lockfile authoritative. Installation and
    // relaunch dispatch are deploy actions; product verification is not.
    if (
      activatingTarget &&
      dependencyInstallRequired &&
      !coldBootstrapRequired
    ) {
      installNodeDependencies(root, deploymentToolEnvironment);
    }
    let plannedTransition =
      runtimePinTransition ??
      (parentLifecycleRequired
        ? await executeParentTransition()
        : devDeployRequiresChildRestart(impact)
          ? await executeDevChainRestart({ root, channel })
          : undefined);
    if (options.transaction) {
      plannedTransition = await admitAbsentDevChainBootstrap({
        transition: plannedTransition,
        root,
        channel,
        port: options.port,
        sourceGeneration: targetParentSourceGeneration,
        requestGeneration: deployLease.record.generation,
        operationId: options.coldBootstrapOperationId,
        initialRows: options.coldBootstrapInitialRows,
        initialColumns: options.coldBootstrapInitialColumns,
        coldBootstrapMode: options.coldBootstrapMode,
        command: options.queuedAttempt?.coldBootstrapCommand,
        hmuxBuildId: options.coldBootstrapHmuxBuildId,
        coldBootstrapToolCapability,
        onOperationSubmitted: (operationId, command, hmuxBuildId) =>
          options.attemptRecorder?.recordColdBootstrapSubmitted(
            operationId,
            command,
            hmuxBuildId,
          ),
        timeoutMs: options.activationTimeoutMs,
      });
    }
    let residualTransition;
    // Queue selection is cumulative from the last applied deployment. A
    // target parent may therefore already be active while this checkout still
    // owes one exact child transition.
    if (plannedTransition?.state === DEV_CHAIN_RESTART_STATE.CONVERGED) {
      const childRestartStillRequired =
        devDeployRequiresChildRestart(impact) ||
        changedPathsRequireChildRestart(changedPaths) ||
        changedPathsRequireChildRestart(checkoutChangedPaths);
      if (childRestartStillRequired) {
        residualTransition = await executeDevChainRestart({ root, channel });
      }
    }
    const rejectedTransition = [plannedTransition, residualTransition].find(
      (transition) =>
        transition &&
        transition.state !== DEV_CHAIN_RESTART_STATE.PENDING &&
        transition.state !== DEV_CHAIN_RESTART_STATE.CONVERGED &&
        transition.state !== DEV_CHAIN_RESTART_STATE.RESTARTED,
    );
    const deferredTransition = [plannedTransition, residualTransition].find(
      (transition) =>
        transition?.state === DEV_CHAIN_RESTART_STATE.PENDING,
    );
    const frontendTransitionRequired =
      !deferredTransition &&
      deployLease.record.suppressHmr &&
      !plannedTransition?.relaunchDispatched &&
      !residualTransition?.relaunchDispatched;
    const frontendTransition =
      !rejectedTransition && frontendTransitionRequired
        ? await dispatchCoordinatedFrontendTransition({
            origin: devServer.origin,
            channel,
            deployedAtMs,
            sourceMutationStartedAtMs,
            lockRecord: deployLease.record,
            requireSuppressedUpdate: checkoutChangedPaths.length > 0,
          })
        : undefined;
    let parentGeneration;
    let parentAuthorityFailure;
    if (
      options.transaction &&
      frontendTransition?.status === "dispatched"
    ) {
      try {
        parentGeneration = await observeDevLaunchParentAuthority({
          root,
          channel,
          timeoutMs: Math.min(
            options.activationTimeoutMs,
            PARENT_RECONCILIATION_TIMEOUT_MS,
          ),
        });
      } catch (error) {
        parentAuthorityFailure =
          `dev_launch_parent_authority_unavailable: ${error.message}`;
      }
    }
    let runtime;
    if (
      backendChanged &&
      !rejectedTransition &&
      !deferredTransition &&
      frontendTransition?.status !== "failed" &&
      !parentAuthorityFailure
    ) {
      const expectedLaunch = activatedAppLaunch(
        plannedTransition,
        residualTransition,
      );
      runtime = expectedLaunch
        ? await awaitAppRuntimeReady({
            root,
            channel,
            targetHead,
            expectedLaunch,
            notBeforeMs: deployedAtMs,
            timeoutMs: Math.min(
              options.activationTimeoutMs,
              APP_RUNTIME_READINESS_TIMEOUT_MS,
            ),
          })
        : {
            state: "failed",
            channel,
            targetHead,
            observedAtMs: Date.now(),
            reason: "app_runtime_launch_receipt_unavailable",
          };
    }
    const runtimePending = runtime?.state === "starting";
    const runtimeFailed = runtime?.state === "failed";
    const failed = Boolean(
      rejectedTransition ||
        frontendTransition?.status === "failed" ||
        parentAuthorityFailure ||
        runtimePending ||
        runtimeFailed,
    );
    report(
      options,
      {
        ...decision,
        ...(deferredTransition
          ? { action: "defer", reason: deferredTransition.reason }
          : {}),
        ...(headTransition ?? {}),
        currentHead,
        targetHead,
        targetAuthority,
        pendingCommits,
        impact,
        deployed: true,
        backendChanged,
        hmuxRuntimeStaged,
        ...(hmuxActivation ? { hmuxActivation } : {}),
        ...(controlPlane
          ? {
              controlPlanePayloadStaged: controlPlane.staged,
              controlPlaneActivation: controlPlane.proof,
            }
          : {}),
        dependencyInstallRequired,
        ...(coldBootstrapRequired && dependencyInstallRequired
          ? { dependencyInstallDeferred: true }
          : {}),
        expectedParentSourceGeneration,
        plannedTransition,
        ...(residualTransition ? { residualTransition } : {}),
        ...(frontendTransition ? { frontendTransition } : {}),
        ...(frontendTransition?.status === "failed" || parentAuthorityFailure
          ? {
              reason:
                frontendTransition?.status === "failed"
                  ? frontendTransition.reason
                  : parentAuthorityFailure,
            }
          : {}),
        ...(parentGeneration ? { parentGeneration } : {}),
        ...(runtime ? { runtime } : {}),
        ...(runtimePending || runtimeFailed ? { reason: runtime.reason } : {}),
        dispatchAccepted:
          !failed && !deferredTransition && !runtimePending,
      },
      failed ? 1 : 0,
    );
    if (failed) {
      process.exitCode = 1;
    }
  } finally {
    deployLease.release();
  }
}

function report(options, result, exitCode = 0) {
  const receipt = {
    deployReceiptVersion: DEV_DEPLOY_APPLICATION_RECEIPT_VERSION,
    ...result,
    liveWorktree: options.liveWorktree,
    ...(options.transaction ? { transaction: options.transaction } : {}),
  };
  options.attemptRecorder?.recordResult(receipt, exitCode);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  process.stdout.write(`${receipt.action}: ${receipt.reason}\n`);
  if (receipt.liveWorktree) {
    process.stdout.write(`  live checkout: ${receipt.liveWorktree}\n`);
  }
  if (receipt.targetHead) {
    process.stdout.write(`  target commit: ${receipt.targetHead}\n`);
  }
  if (receipt.runtime?.buildId) {
    process.stdout.write(`  runtime build: ${receipt.runtime.buildId}\n`);
  }
  if (receipt.runtime?.generation) {
    process.stdout.write(`  app server generation: ${receipt.runtime.generation}\n`);
  }
  const activated = receipt.parentGeneration;
  if (activated?.sourceGeneration) {
    process.stdout.write(`  parent source generation: ${activated.sourceGeneration}\n`);
  }
  if (activated?.supervisor?.generation) {
    process.stdout.write(
      `  supervisor generation: ${activated.supervisor.generation}\n`,
    );
  }
  if (activated?.launch?.generation) {
    process.stdout.write(`  launch generation: ${activated.launch.generation}\n`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  try {
    await deploy(options);
  } catch (error) {
    options.attemptRecorder?.recordFailure(error);
    throw error;
  } finally {
    options.attemptRecorder?.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
