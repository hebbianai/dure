#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEV_DEPLOY_QUEUE_SCHEMA_VERSION,
  DEV_DEPLOY_QUEUE_STATUS,
  assertLiveWorktreeSelection,
  attachDeployQueueWorker,
  beginDevDeployAttempt,
  cancelDevDeploy,
  enqueueDevDeploy,
  expireDevDeploy,
  isActiveQueuedDeploy,
  isTerminalQueuedDeploy,
  lastSuccessfulDeploymentFor,
  nextDevDeployWakeAtMs,
  reconcileDevDeployAttempt,
  recordDevDeployColdBootstrapSubmission,
  refreshPendingDevDeploySelection,
  settleDevDeployAttempt,
} from "./lib/dev-deploy-queue.mjs";
import {
  devDeployQueueEntrypoint,
  stageDevDeployExecutor,
} from "./lib/dev-deploy-executor.mjs";
import {
  newDevDeployTransaction,
  parseDevDeployExecutorGeneration,
  parseDevDeployTransaction,
} from "./lib/dev-deploy-transaction.mjs";
import {
  DevDeployQueueStore,
} from "./lib/dev-deploy-queue-store.mjs";
import {
  devDeployRunnerExactIdentity,
} from "./lib/dev-deploy-runner-generation.mjs";
import { signalProcessGenerationSync } from "./lib/process-identity.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  DEV_SERVER_PORT_ENV,
  worktreeDevIdentity,
} from "./lib/app-channel.mjs";
import { resolveDevDeployServerProfile } from "./lib/dev-server-profile.mjs";
import { resolveLiveDevWorktree } from "./lib/dev-live-worktree.mjs";
import {
  DEV_DEPLOY_IMPACT,
  backendRebuildRequired,
  controlPlanePayloadStageRequired,
  devDeployImpact,
  hmuxDevRuntimeStageRequired,
} from "./lib/dev-launch-impact.mjs";
import { appRuntimeObservation } from "./lib/dev-app-runtime.mjs";
import {
  DEV_CHAIN_RESTART_STATE,
  executeDevChainRetirementAcknowledgement,
  inspectDevChainState,
} from "./lib/dev-chain-recovery.mjs";
import {
  DEV_HMUX_STANDALONE_OPERATION_MODE,
} from "./lib/dev-hmux-operation-contract.mjs";
import { parseDevHmuxBuildId } from "./lib/dev-hmux-tool.mjs";
import {
  acquireDevDeployLock,
  devDeployLockPath,
} from "./lib/dev-deploy-lock.mjs";
import { appRootUnder } from "./lib/dure-home.mjs";
import {
  HMUX_DEV_RUSTC_IDENTITY_TIMEOUT_MS,
  readHmuxDevRustcVersion,
} from "./hmux-dev-build-id.mjs";
import { observeDevLaunchParentAuthority } from "./lib/dev-launch-client.mjs";
import {
  deployArgumentTakesValue,
  resolveHeadTransitionRequest,
  resolveTargetCommitRequest,
} from "./lib/dev-deploy-head-transition-options.mjs";
import {
  hasPendingDevControlPlaneActivation,
} from "./lib/dev-control-plane-activation.mjs";

const SELF = fileURLToPath(import.meta.url);
const DEPLOY_SCRIPT = fileURLToPath(
  new URL("./deploy-dev-app.mjs", import.meta.url),
);
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_MAX_WAIT_MS = 6 * 60 * 60 * 1_000;
const RETIREMENT_ACKNOWLEDGEMENT_TIMEOUT_MS = 420_000;
const RUNNER_HANDSHAKE_TIMEOUT_MS = 7_500;
const RUNNER_RETIREMENT_TIMEOUT_MS = 7_500;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_DEV_PORT = 1420;
const USAGE = `Usage:
  pnpm app:dev:deploy --live-worktree <path> [--force] [--target-commit <full-sha>] [--adopt-integrated-target] [--json]
  pnpm app:dev:deploy --live-worktree <path> [--target-commit <full-sha>] --retire-preserved-live-head \\
    --retire-reason <text> --retire-evidence <text> --retire-wip-ref <ref> [--json]
  pnpm app:dev:deploy:status [--json]
  pnpm app:dev:deploy:resume [--json]
  pnpm app:dev:deploy:cancel [--json]

The deploy command durably coalesces requests for the live daily-driver worktree.
`;

function durationFromEnvironment(name, fallback, minimum) {
  const source = process.env[name];
  if (source === undefined || source === "") return fallback;
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function queueConfiguration() {
  return {
    pollMs: durationFromEnvironment(
      "DURE_DEV_DEPLOY_QUEUE_POLL_MS",
      DEFAULT_POLL_MS,
      10,
    ),
    maxWaitMs: durationFromEnvironment(
      "DURE_DEV_DEPLOY_QUEUE_MAX_WAIT_MS",
      DEFAULT_MAX_WAIT_MS,
      1_000,
    ),
  };
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function liveWorktreeFromArguments(args) {
  let explicitPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--worktree") {
      throw new Error(
        "--worktree is ambiguous; pass --live-worktree <path> for the checkout hosting the running daily driver",
      );
    }
    if (deployArgumentTakesValue(args[index])) {
      index += 1;
      continue;
    }
    if (args[index] !== "--live-worktree") continue;
    if (!args[index + 1]) throw new Error("--live-worktree requires a value");
    explicitPath = args[index + 1];
    index += 1;
  }
  return resolveLiveDevWorktree({ explicitPath });
}

function canonicalDeployArguments(args, liveWorktree) {
  const normalized = [];
  let explicitPort;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") continue;
    if (argument === "--live-worktree") {
      index += 1;
      continue;
    }
    if (argument === "--port") {
      if (explicitPort !== undefined) {
        throw new Error("--port may only be specified once");
      }
      explicitPort = args[(index += 1)];
      if (explicitPort === undefined) throw new Error("--port requires a value");
      continue;
    }
    if (deployArgumentTakesValue(argument)) {
      const value = args[(index += 1)];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      normalized.push(argument, value);
      continue;
    }
    normalized.push(argument);
  }
  const { channel } = worktreeDevIdentity(liveWorktree);
  const devServer = resolveDevDeployServerProfile({
    home: homedir(),
    channel,
    worktreeRoot: liveWorktree,
    explicitPort,
    ambientPort: process.env[DEV_SERVER_PORT_ENV] ?? String(DEFAULT_DEV_PORT),
  });
  normalized.push("--port", String(devServer.port));
  return [...normalized, "--live-worktree", liveWorktree];
}

function replayEnvironment() {
  // Empty is an explicit default selection, not permission to inherit a later
  // runner's portable app root. Older requests without this key stay unchanged.
  const environment = {
    DURE_HOME: process.env.DURE_HOME ? resolve(process.env.DURE_HOME) : "",
  };
  for (const key of ["HOME", "PATH"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return environment;
}

function deployEnvironment(executionEnvironment = {}) {
  const environment = { ...process.env, ...executionEnvironment };
  environment.DURE_HOME ||= appRootUnder(environment.HOME || homedir());
  // A queued deploy may outlive the pane that requested it. Never replay its
  // catalog override, including requests persisted by older code.
  delete environment.HMUX_DISCOVERY_ROOT;
  return environment;
}

function queuedAttemptArguments(args) {
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--target-commit") {
      index += 1;
      continue;
    }
    normalized.push(args[index]);
  }
  return normalized;
}

function parseCommandArguments(args) {
  const options = {
    mode: "request",
    once: false,
    json: args.includes("--json"),
    deployArgs: [],
    executorGeneration: undefined,
  };
  const selectMode = (mode) => {
    if (options.mode !== "request" && options.mode !== mode) {
      throw new Error("deploy queue control modes are mutually exclusive");
    }
    options.mode = mode;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") selectMode("help");
    else if (argument === "--queue-status" || argument === "--status")
      selectMode("status");
    else if (argument === "--resume") selectMode("resume");
    else if (argument === "--cancel-pending") selectMode("cancel");
    else if (argument === "--internal-runner") selectMode("runner");
    else if (argument === "--internal-runner-supervisor")
      selectMode("runner-supervisor");
    else if (argument === "--internal-runner-executor-generation") {
      const generation = args[(index += 1)];
      parseDevDeployExecutorGeneration(
        generation,
        "internal runner executor generation",
      );
      if (options.executorGeneration !== undefined) {
        throw new Error(
          "internal runner executor generation may only be specified once",
        );
      }
      options.executorGeneration = generation;
    } else if (argument === "--once") options.once = true;
    else options.deployArgs.push(argument);
  }
  if (options.mode !== "runner" && options.once) {
    throw new Error("--once is only valid for the internal deploy runner");
  }
  if (
    options.executorGeneration !== undefined &&
    options.mode !== "runner" &&
    options.mode !== "runner-supervisor"
  ) {
    throw new Error(
      "internal runner executor generation requires an internal runner mode",
    );
  }
  if (
    options.mode === "runner-supervisor" &&
    options.executorGeneration === undefined
  ) {
    throw new Error(
      "internal runner supervisor requires an executor generation",
    );
  }
  if (
    options.mode !== "request" &&
    options.deployArgs.some((argument) => argument !== "--json")
  ) {
    throw new Error("deploy arguments cannot be combined with a queue control mode");
  }
  return options;
}

function parseDeployReceipt(result) {
  const stdout = result.stdout?.trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function runDeployAttempt(
  args,
  transaction,
  executionEnvironment = {},
  reconciliation,
  attempt,
) {
  const liveWorktree = liveWorktreeFromArguments(args);
  if (
    attempt?.coldBootstrapOperationId &&
    attempt.coldBootstrapMode === undefined
  ) {
    throw new Error("queued cold-bootstrap attempt has no lifecycle mode");
  }
  const parsedTransaction = transaction
    ? parseDevDeployTransaction(transaction)
    : undefined;
  const requestedArgs = reconciliation
    ? [
        ...args,
        "--reconcile-parent-target",
        reconciliation.targetHead,
      ]
    : args;
  const transactionalArgs = parsedTransaction
    ? [
        ...requestedArgs,
        "--queued-deploy-transaction",
        JSON.stringify(parsedTransaction),
      ]
    : requestedArgs;
  const attemptArgs = attempt
    ? [
        ...transactionalArgs,
        "--queued-deploy-attempt",
        JSON.stringify({
          schemaVersion: 1,
          attemptId: attempt.attemptId,
          generation: attempt.generation,
          ...(attempt.coldBootstrapOperationId
            ? {
                coldBootstrapOperationId: attempt.coldBootstrapOperationId,
                coldBootstrapInitialRows: attempt.coldBootstrapInitialRows,
                coldBootstrapInitialColumns:
                  attempt.coldBootstrapInitialColumns,
                coldBootstrapMode: attempt.coldBootstrapMode,
                ...(attempt.coldBootstrapMode !==
                DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE
                  ? {
                      coldBootstrapCommand: attempt.coldBootstrapCommand,
                      ...(attempt.coldBootstrapHmuxBuildId === undefined
                        ? {}
                        : {
                            coldBootstrapHmuxBuildId:
                              attempt.coldBootstrapHmuxBuildId,
                          }),
                    }
                  : {}),
              }
            : {}),
        }),
      ]
    : transactionalArgs;
  const deployArgs = attemptArgs.includes("--json")
    ? attemptArgs
    : [...attemptArgs, "--json"];
  const childEnvironment = deployEnvironment(executionEnvironment);
  const result = spawnSync(
    process.execPath,
    [parsedTransaction?.executor.entrypoint ?? DEPLOY_SCRIPT, ...deployArgs],
    {
      cwd: liveWorktree,
      encoding: "utf8",
      env: withoutLocalGitOverrides(childEnvironment),
      maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    },
  );
  return {
    exitCode: result.status ?? 1,
    receipt: parseDeployReceipt(result),
    stderr:
      result.error?.message ??
      result.stderr?.trim() ??
      "deploy attempt exited without a receipt",
  };
}

async function runRetirementAcknowledgementAttempt(state) {
  const activeAttempt = state.activeAttempt;
  const acknowledgement =
    activeAttempt.coldBootstrapRetirementAcknowledgement;
  const { channel } = worktreeDevIdentity(state.worktree);
  const transition = await executeDevChainRetirementAcknowledgement({
    root: state.worktree,
    channel,
    home: state.request.executionEnvironment.HOME,
    requestGeneration: activeAttempt.attemptId,
    hmuxBuildId: acknowledgement.hmuxBuildId,
    binding: {
      operationId: acknowledgement.operationId,
      sessionName: acknowledgement.sessionName,
      command: acknowledgement.command,
      initialRows: acknowledgement.initialRows,
      initialColumns: acknowledgement.initialColumns,
    },
    timeoutMs: RETIREMENT_ACKNOWLEDGEMENT_TIMEOUT_MS,
  });
  const failed = transition.state === DEV_CHAIN_RESTART_STATE.FAILED;
  return {
    exitCode: failed ? 1 : 0,
    receipt: {
      action: "defer",
      reason: transition.reason,
      plannedTransition: transition,
      liveWorktree: state.worktree,
      transaction: activeAttempt.transaction,
    },
    ...(failed ? { stderr: transition.reason } : {}),
  };
}

function publicQueueView(state, store, observedRunner) {
  const { paths } = store;
  if (!state) return { status: "empty", statePath: paths.state };
  const runnerObservation = observedRunner ?? store.runnerLeaseObservation();
  const runner = runnerObservation.liveness === "stale"
    ? null
    : runnerObservation.owner;
  const workerLiveness = state.worker
    ? store.workerLiveness(state.worker)
    : undefined;
  const lastSuccessfulDeployment = lastSuccessfulDeploymentFor(state);
  const runtimeLiveness = lastSuccessfulDeployment?.runtime
    ? store.workerLiveness(lastSuccessfulDeployment.runtime)
    : undefined;
  return {
    status: state.status,
    generation: state.generation,
    liveWorktree: state.worktree,
    firstQueuedAtMs: state.firstQueuedAtMs,
    requestedAtMs: state.requestedAtMs,
    expiresAtMs: state.expiresAtMs,
    attempts: state.attempts,
    runnerLease: {
      active: Boolean(runner),
      liveness: runnerObservation.liveness,
      ...(runner
        ? {
            pid: runner.pid,
            startedAtMs: runner.startedAtMs,
            processIdentity: devDeployRunnerExactIdentity(runner),
            ...(runner.processGeneration
              ? { processGeneration: runner.processGeneration }
              : {}),
          }
        : {}),
    },
    ...(state.nextAttemptAtMs ? { nextAttemptAtMs: state.nextAttemptAtMs } : {}),
    ...(state.request?.observed ? { impact: state.request.observed.impact } : {}),
    ...(state.request?.transaction
      ? {
          targetHead: state.request.transaction.targetHead,
          executorGeneration: state.request.transaction.executor.generation,
        }
      : {}),
    ...(state.worker
      ? {
          worker: {
            ...state.worker,
            ...(state.worker.processGeneration
              ? {
                  processIdentity: devDeployRunnerExactIdentity(state.worker),
                }
              : {}),
            alive: workerLiveness === "active",
            liveness: workerLiveness,
          },
        }
      : {}),
    ...(state.failure ? { failure: state.failure } : {}),
    ...(state.finalReceipt ? { finalReceipt: state.finalReceipt } : {}),
    ...(state.lastAttempt ? { lastAttempt: state.lastAttempt } : {}),
    ...(lastSuccessfulDeployment
      ? {
          lastSuccessfulDeployment: {
            ...lastSuccessfulDeployment,
            ...(lastSuccessfulDeployment.runtime
              ? {
                  runtime: {
                    ...lastSuccessfulDeployment.runtime,
                    alive: runtimeLiveness === "active",
                    liveness: runtimeLiveness,
                  },
                }
              : {}),
          },
        }
      : {}),
    statePath: paths.state,
    logPath: paths.log,
  };
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
  }).trim();
}

function queuedTarget(liveWorktree, requestedTarget) {
  if (!requestedTarget) {
    git(liveWorktree, ["fetch", "origin", "main", "--quiet"]);
  }
  const targetHead = requestedTarget ?? git(liveWorktree, ["rev-parse", "origin/main"]);
  let resolved;
  try {
    resolved = git(liveWorktree, [
      "rev-parse",
      "--verify",
      `${targetHead}^{commit}`,
    ]);
  } catch {
    throw new Error("queued deploy target does not resolve to its exact commit");
  }
  if (resolved !== targetHead) {
    throw new Error("queued deploy target does not resolve to its exact commit");
  }
  return {
    targetHead,
    targetAuthority: requestedTarget
      ? "exact-local-candidate"
      : "origin/main",
  };
}

function changedPathsBetween(liveWorktree, sourceHead, targetHead) {
  if (sourceHead === targetHead) return [];
  return git(liveWorktree, [
    "diff",
    "--name-only",
    `${sourceHead}..${targetHead}`,
  ])
    .split("\n")
    .filter(Boolean);
}

function hmuxActivationRequiresRefresh(liveWorktree, targetHead, deployed) {
  const activation = deployed?.hmuxActivation;
  if (
    !activation ||
    activation.channel !== worktreeDevIdentity(liveWorktree).channel
  ) {
    return true;
  }
  try {
    if (!targetDescendsFrom(liveWorktree, activation.sourceRevision, targetHead)) {
      return true;
    }
  } catch {
    return true;
  }
  return hmuxDevRuntimeStageRequired(
    changedPathsBetween(liveWorktree, activation.sourceRevision, targetHead),
  );
}

function queuedTargetObservation(liveWorktree, targetHead, deployed) {
  const worktreeHead = git(liveWorktree, ["rev-parse", "HEAD"]);
  const activationSourceHead = deployed?.sourceHead ?? worktreeHead;
  const pendingCommits =
    worktreeHead === targetHead
      ? 0
      : Number(
          git(liveWorktree, [
            "rev-list",
            "--count",
            `${worktreeHead}..${targetHead}`,
          ]),
        );
  const sourcePaths = changedPathsBetween(
    liveWorktree,
    activationSourceHead,
    targetHead,
  );
  const backendPaths = changedPathsBetween(
    liveWorktree,
    deployed?.backendHead ?? activationSourceHead,
    targetHead,
  );
  const sourceImpact = devDeployImpact(sourcePaths);
  const backendMutationChanged =
    hasPendingDevControlPlaneActivation(deployed) ||
    backendRebuildRequired(backendPaths);
  const controlPlanePayloadChanged =
    sourceImpact.controlPlanePayloadChanged === true ||
    controlPlanePayloadStageRequired(backendPaths);
  const hmuxRuntimeChanged =
    sourceImpact.hmuxRuntimeChanged === true ||
    ((Boolean(deployed?.backendHead) || backendMutationChanged) &&
      hmuxActivationRequiresRefresh(liveWorktree, targetHead, deployed));
  const backendChanged = backendMutationChanged || hmuxRuntimeChanged;
  const changedPathCount = backendChanged || controlPlanePayloadChanged
    ? new Set([...sourcePaths, ...backendPaths]).size
    : sourcePaths.length;
  const impact = backendChanged || controlPlanePayloadChanged
    ? {
        ...sourceImpact,
        kind:
          backendChanged &&
          sourceImpact.kind === DEV_DEPLOY_IMPACT.FRONTEND_RELOAD
            ? DEV_DEPLOY_IMPACT.BACKEND_REBUILD
            : sourceImpact.kind,
        backendChanged,
        changedPathCount,
        ...(controlPlanePayloadChanged
          ? { controlPlanePayloadChanged: true }
          : {}),
        ...(hmuxRuntimeChanged ? { hmuxRuntimeChanged: true } : {}),
      }
    : sourceImpact;
  return {
    currentHead: worktreeHead,
    activationSourceHead,
    targetHead,
    pendingCommits,
    impact,
  };
}

function targetDescendsFrom(liveWorktree, ancestor, target) {
  try {
    git(liveWorktree, ["merge-base", "--is-ancestor", ancestor, target]);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const queueReason = result.queue
    ? `${result.queue.status} (generation ${result.queue.generation ?? 0}, ` +
      `${result.queue.attempts ?? 0} attempt(s))`
    : undefined;
  const reason = result.reason ?? queueReason;
  process.stdout.write(`${result.action}${reason ? `: ${reason}` : ""}\n`);
  const liveWorktree = result.liveWorktree ?? result.queue?.liveWorktree;
  const targetHead = result.targetHead ?? result.queue?.lastAttempt?.receipt?.targetHead;
  const runtimeBuild =
    result.runtime?.buildId ??
    result.queue?.lastSuccessfulDeployment?.runtime?.buildId;
  const runtimeGeneration =
    result.runtime?.generation ??
    result.queue?.lastSuccessfulDeployment?.runtime?.generation;
  const activated =
    result.parentGeneration ??
    result.queue?.lastSuccessfulDeployment?.parentGeneration;
  if (liveWorktree) process.stdout.write(`  live checkout: ${liveWorktree}\n`);
  if (targetHead) process.stdout.write(`  target commit: ${targetHead}\n`);
  if (runtimeBuild) process.stdout.write(`  runtime build: ${runtimeBuild}\n`);
  if (runtimeGeneration) {
    process.stdout.write(`  app server generation: ${runtimeGeneration}\n`);
  }
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

function assertSelectedLiveWorktree(store, state, liveWorktree) {
  const deployed = lastSuccessfulDeploymentFor(state);
  const observedRuntime =
    state?.worktree && state.worktree !== liveWorktree
      ? appRuntimeObservation(state.worktree, Date.now(), {
          environment: deployEnvironment(state.request.executionEnvironment),
        })
      : undefined;
  const runtime = observedRuntime ?? deployed?.runtime;
  const runtimeLiveness = runtime
    ? store.workerLiveness(runtime)
    : undefined;
  assertLiveWorktreeSelection(state, liveWorktree, runtimeLiveness);
  return runtimeLiveness;
}

function desiredQueueExecutor(state) {
  if (!state?.request?.transaction?.executor) {
    throw new Error("dev deploy queue has no desired executor");
  }
  const executor = state.request.transaction.executor;
  return {
    generation: executor.generation,
    entrypoint: devDeployQueueEntrypoint(executor),
  };
}

function assertStagedQueueEntrypoint(executor) {
  assertStagedExecutorFile(executor.entrypoint, "queue executor");
}

function assertStagedExecutorFile(pathname, label) {
  const stat = lstatSync(pathname);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      `dev deploy ${label} is unsafe: ${pathname}`,
    );
  }
}

function runningAuthoritativeQueueEntrypoint(executor) {
  return realpathSync(executor.entrypoint) === realpathSync(SELF);
}

function startDetachedRunnerSupervisor(store, executor) {
  assertStagedQueueEntrypoint(executor);
  store.assertLogPath();
  const descriptor = openSync(store.paths.log, "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        executor.entrypoint,
        "--internal-runner-supervisor",
        "--internal-runner-executor-generation",
        executor.generation,
      ],
      {
        cwd: dirname(executor.entrypoint),
        detached: true,
        env: withoutLocalGitOverrides(),
        stdio: ["ignore", descriptor, descriptor],
      },
    );
    child.unref();
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      throw new Error("dev deploy runner supervisor did not start");
    }
    return child.pid;
  } finally {
    closeSync(descriptor);
  }
}

function reportDirectResult(result, options) {
  if (result.receipt) printResult(result.receipt, options.json);
  else if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  return result.exitCode;
}

function workerIdentity(owner) {
  return {
    pid: owner.pid,
    startedAtMs: owner.startedAtMs,
    ...(owner.processIdentity
      ? { processIdentity: owner.processIdentity }
      : {}),
    ...(owner.executorGeneration
      ? { executorGeneration: owner.executorGeneration }
      : {}),
    ...(owner.processGeneration
      ? { processGeneration: owner.processGeneration }
      : {}),
  };
}

function attachRunner(store, owner) {
  return store.mutate((current) =>
    current && isActiveQueuedDeploy(current)
      ? attachDeployQueueWorker(current, workerIdentity(owner))
      : current,
  );
}

function ensureRunner(store) {
  let desired = desiredQueueExecutor(store.read());
  const active = store.activeRunnerFor(desired.generation);
  if (active) {
    attachRunner(store, active);
    return { ...store.runnerLeaseObservation(), spawned: false };
  }
  let spawnedPid = startDetachedRunnerSupervisor(store, desired);
  const deadline = Date.now() + RUNNER_HANDSHAKE_TIMEOUT_MS;
  for (;;) {
    const current = store.read();
    if (!current || isTerminalQueuedDeploy(current)) {
      return {
        liveness: "stale",
        owner: null,
        spawned: true,
        supervisorPid: spawnedPid,
      };
    }
    const currentDesired = desiredQueueExecutor(current);
    if (currentDesired.generation !== desired.generation) {
      desired = currentDesired;
      spawnedPid = startDetachedRunnerSupervisor(store, desired);
    }
    const owner = store.activeRunnerFor(desired.generation);
    if (owner) {
      attachRunner(store, owner);
      return {
        ...store.runnerLeaseObservation(),
        spawned: true,
        supervisorPid: spawnedPid,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `dev deploy runner ${spawnedPid} did not publish a lease receipt`,
      );
    }
    sleep(25);
  }
}

function firstRequestResult(options, store, reserved, configuration) {
  for (;;) {
    const state = store.read();
    if (!state) throw new Error("dev deploy queue disappeared after reservation");
    if (state.generation !== reserved.generation) {
      printResult(
        {
          action: "defer",
          reason: "a newer deploy request superseded this generation",
          queued: true,
          queueSchemaVersion: DEV_DEPLOY_QUEUE_SCHEMA_VERSION,
          queue: publicQueueView(state, store),
        },
        options.json,
      );
      return 0;
    }
    if (state.status === DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED) {
      printResult(state.finalReceipt, options.json);
      return 0;
    }
    if (
      state.status === DEV_DEPLOY_QUEUE_STATUS.FAILED ||
      state.status === DEV_DEPLOY_QUEUE_STATUS.EXPIRED
    ) {
      if (
        state.failure?.code === "deploy_attempt_failed" &&
        state.lastAttempt?.receipt
      ) {
        printResult(state.lastAttempt.receipt, options.json);
      } else {
        process.stderr.write(`${state.failure?.reason ?? "queued deploy failed"}\n`);
      }
      return 1;
    }
    if (state.status === DEV_DEPLOY_QUEUE_STATUS.CANCELED) {
      process.stderr.write(`${state.failure?.reason ?? "queued deploy canceled"}\n`);
      return 1;
    }
    if (
      state.status === DEV_DEPLOY_QUEUE_STATUS.PENDING &&
      state.lastAttempt?.generation === reserved.generation &&
      state.lastAttempt.receipt?.action === "defer"
    ) {
      if (process.env.DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART !== "1") {
        ensureRunner(store);
      }
      const current = store.read();
      const receipt = {
        ...state.lastAttempt.receipt,
        queued: true,
        queueSchemaVersion: DEV_DEPLOY_QUEUE_SCHEMA_VERSION,
        queue: publicQueueView(current, store),
      };
      printResult(receipt, options.json);
      return 0;
    }
    if (state.status === DEV_DEPLOY_QUEUE_STATUS.PENDING) {
      const owner = store.activeRunner();
      if (!owner && process.env.DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART !== "1") {
        ensureRunner(store);
      }
    } else if (
      state.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING &&
      !store.workerAlive(state.worker)
    ) {
      if (process.env.DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART !== "1") {
        ensureRunner(store);
      }
    }
    sleep(Math.min(50, configuration.pollMs));
  }
}

async function requestDeploy(options, store, configuration) {
  // Validate every exceptional transition before the queue reserves a
  // generation. The exact original values are still persisted below.
  const headTransition = resolveHeadTransitionRequest(options.deployArgs);
  const requestedTarget = resolveTargetCommitRequest(
    options.deployArgs,
    headTransition,
  );
  if (
    options.deployArgs.includes("--queued-deploy-transaction") ||
    options.deployArgs.includes("--queued-deploy-attempt")
  ) {
    throw new Error(
      "queued deploy identity arguments are reserved for the queue worker",
    );
  }
  const liveWorktree = liveWorktreeFromArguments(options.deployArgs);
  const attemptArgs = canonicalDeployArguments(options.deployArgs, liveWorktree);
  const bypassQueue =
    attemptArgs.includes("--dry-run") || attemptArgs.includes("--restart-only");
  if (bypassQueue) {
    const current = store.read();
    assertSelectedLiveWorktree(store, current, liveWorktree);
    if (attemptArgs.includes("--restart-only")) {
      if (isActiveQueuedDeploy(current) && current.worktree !== liveWorktree) {
        throw new Error(
          `another live worktree already owns the deploy queue: ${current.worktree}`,
        );
      }
    }
    const result = runDeployAttempt(attemptArgs);
    return reportDirectResult(result, options);
  }

  const target = queuedTarget(liveWorktree, requestedTarget);
  const executor = stageDevDeployExecutor({
    queueDirectory: store.paths.directory,
    sourceRoot: liveWorktree,
    sourceHead: target.targetHead,
  });
  const reserved = store.mutate((current) => {
    const runtimeLiveness = assertSelectedLiveWorktree(
      store,
      current,
      liveWorktree,
    );
    const deployed = lastSuccessfulDeploymentFor(current);
    const observation = queuedTargetObservation(
      liveWorktree,
      target.targetHead,
      deployed,
    );
    const transaction = newDevDeployTransaction({
      ...target,
      executor,
      selection: {
        sourceHead: observation.activationSourceHead,
        impact: observation.impact,
      },
    });
    return enqueueDevDeploy({
      existing: current,
      worktree: liveWorktree,
      attemptArgs: queuedAttemptArguments(attemptArgs),
      transaction,
      executionEnvironment: replayEnvironment(),
      receipt: observation,
      runtimeLiveness:
        !headTransition && deployed?.runtime ? runtimeLiveness : undefined,
      targetDescendsFrom: (ancestor, targetHead) =>
        targetDescendsFrom(liveWorktree, ancestor, targetHead),
      maxWaitMs: configuration.maxWaitMs,
      pollMs: configuration.pollMs,
    });
  });

  if (isActiveQueuedDeploy(reserved)) {
    if (process.env.DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART === "1") {
      await runQueueWorker({ once: true }, store, configuration);
    } else {
      ensureRunner(store);
    }
  }
  return firstRequestResult(options, store, reserved, configuration);
}

function statusCommand(options, store) {
  const state = store.read();
  const result = {
    action: "queue-status",
    queue: publicQueueView(state, store),
  };
  printResult(result, options.json);
  return state &&
    (state.status === DEV_DEPLOY_QUEUE_STATUS.FAILED ||
      state.status === DEV_DEPLOY_QUEUE_STATUS.EXPIRED)
    ? 1
    : 0;
}

function resumeCommand(options, store) {
  const state = store.read();
  if (!state || isTerminalQueuedDeploy(state)) {
    const result = {
      action: "queue-unchanged",
      reason: state
        ? `queue is already ${state.status}`
        : "deploy queue is empty",
      queue: publicQueueView(state, store),
    };
    printResult(result, options.json);
    return 0;
  }
  const observation = store.runnerLeaseObservation();
  if (observation.owner && observation.liveness !== "stale") {
    const reason = observation.liveness === "active"
      ? "the exact queue runner lease is already live"
      : `queue runner lease is ${observation.liveness}; takeover is blocked`;
    printResult(
      {
        action: "queue-unchanged",
        reason,
        queue: publicQueueView(state, store, observation),
      },
      options.json,
    );
    return 0;
  }
  const resumed = ensureRunner(store);
  const current = store.read();
  const result = resumed.owner && resumed.liveness !== "stale"
    ? {
        action: "queue-resumed",
        reason: `started a runner for existing generation ${state.generation}`,
        queue: publicQueueView(current, store),
      }
    : {
        action: "queue-unchanged",
        reason: current
          ? `queue became ${current.status} before a runner acquired its lease`
          : "deploy queue became empty before a runner acquired its lease",
        queue: publicQueueView(current, store),
      };
  printResult(result, options.json);
  return 0;
}

function cancelCommand(options, store) {
  const state = store.mutate((current) =>
    current ? cancelDevDeploy(current) : null,
  );
  const result = state
    ? {
        action:
          state.status === DEV_DEPLOY_QUEUE_STATUS.CANCELED
            ? "queue-canceled"
            : "queue-unchanged",
        reason: state.failure?.reason ?? `queue is already ${state.status}`,
        queue: publicQueueView(state, store),
      }
    : {
        action: "queue-unchanged",
        reason: "deploy queue is empty",
        queue: publicQueueView(null, store),
      };
  printResult(result, options.json);
  return 0;
}

function refreshPendingRunnerSelection(current) {
  if (current.status !== DEV_DEPLOY_QUEUE_STATUS.PENDING) return current;
  const deployed = lastSuccessfulDeploymentFor(current);
  if (
    !deployed ||
    current.request.transaction.selection?.sourceHead === deployed.sourceHead
  ) {
    return current;
  }
  const observation = queuedTargetObservation(
    current.worktree,
    current.request.transaction.targetHead,
    deployed,
  );
  if (observation.currentHead !== deployed.sourceHead) return current;
  return refreshPendingDevDeploySelection(current, {
    transaction: newDevDeployTransaction({
      ...current.request.transaction,
      selection: {
        sourceHead: observation.activationSourceHead,
        impact: observation.impact,
      },
    }),
    receipt: observation,
  });
}

function queuedAttemptBinding(activeAttempt) {
  return {
    attemptId: activeAttempt.attemptId,
    generation: activeAttempt.generation,
    targetHead: activeAttempt.transaction.targetHead,
    executorGeneration: activeAttempt.transaction.executor.generation,
  };
}

function sameAttempt(current, expected) {
  return Boolean(
    current?.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING &&
      current.activeAttempt.attemptId === expected.attemptId &&
      current.activeAttempt.generation === expected.generation &&
      current.activeAttempt.transaction.targetHead === expected.targetHead &&
      current.activeAttempt.transaction.executor.generation ===
        expected.executorGeneration,
  );
}

async function backfillLegacyColdBootstrapHmuxBuildId(store, state) {
  const operation = state.activeAttempt?.coldBootstrap;
  if (
    operation?.submittedAtMs === undefined ||
    operation.hmuxBuildId !== undefined
  ) {
    return state;
  }
  const predecessor = state.lastAttempt;
  const predecessorOperation = predecessor?.coldBootstrap;
  if (
    !predecessor?.transaction?.executor ||
    predecessorOperation?.operationId !== operation.operationId ||
    predecessorOperation.submittedAtMs !== operation.submittedAtMs ||
    predecessorOperation.initialRows !== operation.initialRows ||
    predecessorOperation.initialColumns !== operation.initialColumns ||
    JSON.stringify(predecessorOperation.command) !==
      JSON.stringify(operation.command)
  ) {
    throw new Error(
      "legacy cold-bootstrap submission has no exact predecessor executor authority",
    );
  }
  const buildIdEntrypoint = join(
    dirname(predecessor.transaction.executor.entrypoint),
    "hmux-dev-build-id.mjs",
  );
  assertStagedExecutorFile(buildIdEntrypoint, "Hmux build identity executor");
  const buildIdentity = await import(pathToFileURL(buildIdEntrypoint).href);
  if (typeof buildIdentity.computeHmuxDevBuildId !== "function") {
    throw new Error(
      "legacy cold-bootstrap predecessor has no Hmux build identity authority",
    );
  }
  const environment = withoutLocalGitOverrides(
    deployEnvironment(state.request.executionEnvironment),
  );
  const predecessorRoot = realpathSync(state.worktree);
  const rustcVersion = readHmuxDevRustcVersion({
    repositoryRoot: predecessorRoot,
    environment,
    timeoutMs: HMUX_DEV_RUSTC_IDENTITY_TIMEOUT_MS,
  });
  const hmuxBuildId = parseDevHmuxBuildId(
    buildIdentity.computeHmuxDevBuildId({
      repositoryRoot: predecessorRoot,
      environment,
      rustcVersion,
    }),
  );
  const attempted = queuedAttemptBinding(state.activeAttempt);
  return store.mutate((current) => {
    if (!current || !sameAttempt(current, attempted)) return current;
    if (current.activeAttempt.coldBootstrap?.hmuxBuildId !== undefined) {
      return current;
    }
    return recordDevDeployColdBootstrapSubmission(current, {
      attemptId: current.activeAttempt.attemptId,
      attemptGeneration: current.activeAttempt.generation,
      transaction: current.activeAttempt.transaction,
      operationId: current.activeAttempt.coldBootstrap.operationId,
      command: current.activeAttempt.coldBootstrap.command,
      hmuxBuildId,
      submittedAtMs: current.activeAttempt.coldBootstrap.submittedAtMs,
    });
  });
}

function queuedDevServerPort(state) {
  const ports = [];
  for (let index = 0; index < state.request.attemptArgs.length; index += 1) {
    if (state.request.attemptArgs[index] !== "--port") continue;
    const value = state.request.attemptArgs[index + 1];
    if (!/^\d+$/.test(value ?? "")) continue;
    const port = Number(value);
    if (Number.isSafeInteger(port) && port >= 1 && port <= 65_535) {
      ports.push(port);
    }
  }
  return ports.length === 1 ? ports[0] : undefined;
}

async function reconcileCompletedRunnerAttempt(
  store,
  observed,
  nowMs,
  configuration,
) {
  const queuedAttempt = queuedAttemptBinding(observed.activeAttempt);
  const unobserved = reconcileDevDeployAttempt(observed, {
    executorLiveness: "stale",
    nowMs,
    pollMs: configuration.pollMs,
  });
  const requiresAuthority =
    unobserved.failure?.code ===
      "deploy_attempt_recovery_authority_mismatch" ||
    unobserved.priorFailure?.failure?.code ===
      "deploy_attempt_recovery_authority_mismatch";
  if (!requiresAuthority) {
    return store.mutate((current) =>
      current && sameAttempt(current, queuedAttempt)
        ? reconcileDevDeployAttempt(current, {
            executorLiveness: "stale",
            nowMs,
            pollMs: configuration.pollMs,
          })
        : current,
    );
  }
  const { channel } = worktreeDevIdentity(observed.worktree);
  const deployLock = acquireDevDeployLock({
    pathname: devDeployLockPath(
      deployEnvironment(observed.request.executionEnvironment).DURE_HOME,
    ),
    worktreeRoot: observed.worktree,
    channel,
    suppressHmr: false,
  });
  if (!deployLock) return store.read() ?? observed;
  try {
    const locked = store.read();
    if (!locked || !sameAttempt(locked, queuedAttempt)) return locked;
    if (!locked.activeAttempt.result) return locked;
    let parentGeneration;
    try {
      parentGeneration = await observeDevLaunchParentAuthority({
        root: locked.worktree,
        channel,
      });
    } catch {
      // Missing or changed parent authority is reduced to an exact mismatch.
    }
    let currentHead;
    let runtime;
    try {
      currentHead = git(locked.worktree, ["rev-parse", "HEAD"]);
      runtime = appRuntimeObservation(locked.worktree, Date.now(), {
        environment: deployEnvironment(locked.request.executionEnvironment),
      });
    } catch {
      // Missing checkout/app authority is reduced to an exact mismatch.
    }
    const authority = {
      queuedAttempt,
      currentHead,
      runtime,
      parentGeneration,
    };
    return store.mutate((current) => {
      if (!current || !sameAttempt(current, queuedAttempt)) return current;
      const executor = current.activeAttempt.executor;
      return reconcileDevDeployAttempt(current, {
        executorLiveness: executor
          ? store.workerLiveness(executor)
          : "stale",
        authority,
        nowMs,
        pollMs: configuration.pollMs,
      });
    });
  } finally {
    deployLock.release();
  }
}

async function reconcileExistingRunnerAttempt(
  store,
  observed,
  nowMs,
  configuration,
) {
  if (observed.schemaVersion !== DEV_DEPLOY_QUEUE_SCHEMA_VERSION) {
    return store.mutate((current) =>
      current?.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING &&
      current.schemaVersion === observed.schemaVersion &&
      current.activeAttempt.generation === observed.activeAttempt.generation
        ? reconcileDevDeployAttempt(current, {
            executorLiveness: "stale",
            nowMs,
            pollMs: configuration.pollMs,
          })
        : current,
    );
  }
  if (
    observed.activeAttempt?.coldBootstrapRetirementAcknowledgement &&
    !observed.activeAttempt.executor &&
    !observed.activeAttempt.result
  ) {
    const queuedAttempt = queuedAttemptBinding(observed.activeAttempt);
    return store.mutate((current) =>
      current && sameAttempt(current, queuedAttempt)
        ? reconcileDevDeployAttempt(current, {
            executorLiveness: "stale",
            nowMs,
            pollMs: configuration.pollMs,
          })
        : current,
    );
  }
  const executor = observed.activeAttempt?.executor;
  const executorLiveness = executor
    ? store.workerLiveness(executor)
    : "stale";
  if (executorLiveness !== "stale") return observed;
  if (observed.activeAttempt.result) {
    return reconcileCompletedRunnerAttempt(
      store,
      observed,
      nowMs,
      configuration,
    );
  }
  const queuedAttempt = queuedAttemptBinding(observed.activeAttempt);
  const { channel } = worktreeDevIdentity(observed.worktree);
  const deployLock = acquireDevDeployLock({
    pathname: devDeployLockPath(
      deployEnvironment(observed.request.executionEnvironment).DURE_HOME,
    ),
    worktreeRoot: observed.worktree,
    channel,
    suppressHmr: false,
  });
  if (!deployLock) return store.read() ?? observed;
  try {
    const locked = store.read();
    if (!locked || !sameAttempt(locked, queuedAttempt)) return locked;
    const port = queuedDevServerPort(locked);
    let currentHead;
    let devChain;
    try {
      currentHead = git(locked.worktree, ["rev-parse", "HEAD"]);
      if (port !== undefined) {
        devChain = inspectDevChainState({ root: locked.worktree, port });
      }
    } catch {
      // Missing checkout/process authority is reduced to an exact mismatch.
    }
    const reconciledAtMs = Math.max(
      nowMs,
      devChain?.observedAtMs ?? 0,
      Date.now(),
    );
    const authority = {
      queuedAttempt,
      currentHead,
      devChain,
    };
    return store.mutate((current) => {
      if (!current || !sameAttempt(current, queuedAttempt)) return current;
      const currentExecutor = current.activeAttempt.executor;
      return reconcileDevDeployAttempt(current, {
        executorLiveness: currentExecutor
          ? store.workerLiveness(currentExecutor)
          : "stale",
        authority,
        nowMs: reconciledAtMs,
        pollMs: configuration.pollMs,
      });
    });
  } finally {
    deployLock.release();
  }
}

async function prepareRunnerStep(store, nowMs, configuration) {
  let beganAttempt = false;
  const observed = store.read();
  if (!observed || isTerminalQueuedDeploy(observed)) {
    return { beganAttempt, state: observed };
  }
  if (observed.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING) {
    return {
      beganAttempt,
      state: await reconcileExistingRunnerAttempt(
        store,
        observed,
        nowMs,
        configuration,
      ),
    };
  }
  const state = store.mutate((current) => {
    if (!current || isTerminalQueuedDeploy(current)) return current;
    if (current.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING) return current;
    const refreshed = refreshPendingRunnerSelection(current);
    if (nowMs < nextDevDeployWakeAtMs(refreshed)) {
      return refreshed;
    }
    const next = beginDevDeployAttempt(refreshed, nowMs);
    beganAttempt = next.status === DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING;
    return next;
  });
  return { beganAttempt, state };
}

async function settleRunnerAttempt(store, attempted, result, configuration) {
  const observed = store.read();
  if (!observed) {
    throw new Error("dev deploy queue disappeared during an attempt");
  }
  if (!sameAttempt(observed, queuedAttemptBinding(attempted.activeAttempt))) {
    return observed;
  }
  if (!observed.activeAttempt.result && !observed.activeAttempt.executor) {
    return store.mutate((current) => {
      if (!current) {
        throw new Error("dev deploy queue disappeared during an attempt");
      }
      if (
        current.status !== DEV_DEPLOY_QUEUE_STATUS.ATTEMPTING ||
        current.activeAttempt.attemptId !== attempted.activeAttempt.attemptId
      ) {
        return current;
      }
      return settleDevDeployAttempt(current, {
        attemptGeneration: current.activeAttempt.generation,
        exitCode: result.exitCode,
        receipt: result.receipt,
        stderr: result.stderr,
        pollMs: configuration.pollMs,
      });
    });
  }
  return reconcileExistingRunnerAttempt(
    store,
    observed,
    Date.now(),
    configuration,
  );
}

async function runQueueWorker(options, store, configuration) {
  if (options.executorGeneration !== undefined) {
    const observed = store.read();
    if (!observed || isTerminalQueuedDeploy(observed)) {
      return queuedDeployExitCode(observed);
    }
    const desired = desiredQueueExecutor(observed);
    if (
      desired.generation !== options.executorGeneration ||
      !runningAuthoritativeQueueEntrypoint(desired)
    ) {
      return 0;
    }
  }
  const owner = store.acquireRunner(options.executorGeneration);
  if (!owner) return 0;
  try {
    store.mutate((current) =>
      current &&
      isActiveQueuedDeploy(current) &&
      (!owner.executorGeneration ||
        current.request.transaction.executor.generation ===
          owner.executorGeneration)
        ? attachDeployQueueWorker(current, workerIdentity(owner))
        : current,
    );
    for (;;) {
      if (owner.executorGeneration) {
        const observed = store.read();
        if (
          !observed ||
          isTerminalQueuedDeploy(observed) ||
          observed.request.transaction.executor.generation !==
            owner.executorGeneration
        ) {
          return queuedDeployExitCode(observed);
        }
      }
      const nowMs = Date.now();
      const { beganAttempt, state } = await prepareRunnerStep(
        store,
        nowMs,
        configuration,
      );
      if (!state || isTerminalQueuedDeploy(state)) {
        process.stderr.write(
          `${JSON.stringify({ event: "dev-deploy-queue-settled", state: state?.status ?? "empty" })}\n`,
        );
        return state &&
          (state.status === DEV_DEPLOY_QUEUE_STATUS.FAILED ||
            state.status === DEV_DEPLOY_QUEUE_STATUS.EXPIRED)
          ? 1
          : 0;
      }
      if (state.status === DEV_DEPLOY_QUEUE_STATUS.PENDING) {
        if (options.once) return 0;
        const waitUntil = nextDevDeployWakeAtMs(state);
        sleep(Math.max(10, waitUntil - Date.now()));
        continue;
      }
      if (!beganAttempt) {
        if (options.once) return 0;
        sleep(configuration.pollMs);
        continue;
      }
      process.stderr.write(
        `${JSON.stringify({ event: "dev-deploy-attempt-started", generation: state.generation, attempt: state.attempts })}\n`,
      );
      const attempted = await backfillLegacyColdBootstrapHmuxBuildId(
        store,
        state,
      );
      if (!sameAttempt(attempted, queuedAttemptBinding(state.activeAttempt))) {
        continue;
      }
      const result = attempted.activeAttempt
        .coldBootstrapRetirementAcknowledgement
        ? await runRetirementAcknowledgementAttempt(attempted)
        : runDeployAttempt(
            attempted.request.attemptArgs,
            attempted.activeAttempt.transaction,
            attempted.request.executionEnvironment,
            attempted.request.reconciliation,
            {
              ...attempted.activeAttempt,
              coldBootstrapOperationId:
                attempted.activeAttempt.coldBootstrap?.operationId,
              coldBootstrapInitialRows:
                attempted.activeAttempt.coldBootstrap?.initialRows,
              coldBootstrapInitialColumns:
                attempted.activeAttempt.coldBootstrap?.initialColumns,
              coldBootstrapMode:
                attempted.activeAttempt.coldBootstrap?.mode,
              coldBootstrapCommand:
                attempted.activeAttempt.coldBootstrap?.command,
              coldBootstrapHmuxBuildId:
                attempted.activeAttempt.coldBootstrap?.hmuxBuildId,
            },
          );
      const settled = await settleRunnerAttempt(
        store,
        attempted,
        result,
        configuration,
      );
      process.stderr.write(
        `${JSON.stringify({ event: "dev-deploy-attempt-settled", generation: settled.generation, state: settled.status })}\n`,
      );
      if (isTerminalQueuedDeploy(settled)) {
        return settled.status === DEV_DEPLOY_QUEUE_STATUS.SUCCEEDED ? 0 : 1;
      }
      if (options.once) return 0;
    }
  } finally {
    store.releaseRunner(owner);
  }
}

function queuedDeployExitCode(state) {
  return state &&
    (state.status === DEV_DEPLOY_QUEUE_STATUS.FAILED ||
      state.status === DEV_DEPLOY_QUEUE_STATUS.EXPIRED)
    ? 1
    : 0;
}

function runRunnerSupervisor(options, store, configuration) {
  let retirement;
  for (;;) {
    const observed = store.read();
    if (!observed || isTerminalQueuedDeploy(observed)) {
      return queuedDeployExitCode(observed);
    }
    const desired = desiredQueueExecutor(observed);
    assertStagedQueueEntrypoint(desired);
    if (
      desired.generation !== options.executorGeneration ||
      !runningAuthoritativeQueueEntrypoint(desired)
    ) {
      process.stderr.write(
        `${JSON.stringify({ event: "dev-deploy-runner-supervisor-handoff", currentExecutorGeneration: options.executorGeneration, desiredExecutorGeneration: desired.generation })}\n`,
      );
      startDetachedRunnerSupervisor(store, desired);
      return 0;
    }
    const activeObservation = store.runnerLeaseObservation();
    const active = activeObservation.liveness === "stale"
      ? null
      : activeObservation.owner;
    if (active?.executorGeneration === desired.generation) return 0;
    if (active) {
      if (activeObservation.liveness !== "active") {
        sleep(Math.min(50, configuration.pollMs));
        continue;
      }
      if (retirement?.token !== active.token) {
        process.stderr.write(
          `${JSON.stringify({ event: "dev-deploy-runner-retiring", pid: active.pid, currentExecutorGeneration: active.executorGeneration, desiredExecutorGeneration: desired.generation })}\n`,
        );
        signalProcessGenerationSync(
          {
            ...active,
            processIdentity: devDeployRunnerExactIdentity(active),
          },
          "SIGTERM",
        );
        retirement = {
          token: active.token,
          deadlineMs: Date.now() + RUNNER_RETIREMENT_TIMEOUT_MS,
        };
      } else if (Date.now() >= retirement.deadlineMs) {
        throw new Error(
          `incompatible dev deploy runner ${active.pid} did not retire`,
        );
      }
      sleep(Math.min(50, configuration.pollMs));
      continue;
    }
    retirement = undefined;
    process.stderr.write(
      `${JSON.stringify({ event: "dev-deploy-runner-starting", executorGeneration: desired.generation })}\n`,
    );
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        desired.entrypoint,
        "--internal-runner",
        "--internal-runner-executor-generation",
        desired.generation,
      ],
      {
        cwd: dirname(desired.entrypoint),
        env: withoutLocalGitOverrides(),
        stdio: "inherit",
      },
    );
    const current = store.read();
    if (!current || isTerminalQueuedDeploy(current)) {
      return queuedDeployExitCode(current);
    }
    if (store.activeRunnerFor(desired.generation)) return 0;
    sleep(configuration.pollMs);
  }
}

async function main() {
  const options = parseCommandArguments(process.argv.slice(2));
  if (options.mode === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const store = new DevDeployQueueStore();
  try {
    if (options.mode === "status") return statusCommand(options, store);
    if (options.mode === "resume") return resumeCommand(options, store);
    if (options.mode === "cancel") return cancelCommand(options, store);
    const configuration = queueConfiguration();
    if (options.mode === "runner") {
      return await runQueueWorker(options, store, configuration);
    }
    if (options.mode === "runner-supervisor") {
      return runRunnerSupervisor(options, store, configuration);
    }
    return await requestDeploy(options, store, configuration);
  } finally {
    store.close();
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(
      `dev-deploy-queue: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
