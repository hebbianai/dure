import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { COREPACK_EXECUTABLE_ENV } from "./corepack-install.mjs";
import {
  debugAppRootFromCommand,
  isBundledAppProcessCommand,
  isDebugAppProcessCommand,
} from "./app-executable.mjs";
import {
  DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED,
  DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE,
} from "./dev-launch-contract.mjs";
import {
  ensureDevLaunchParentGeneration,
  observeDevLaunchParentGeneration,
  requestDevLaunchRestart,
} from "./dev-launch-client.mjs";
import {
  DEV_DEPLOY_IMPACT,
  DEV_PARENT_RELOAD_STRATEGY,
} from "./dev-launch-impact.mjs";
import { appRootUnder } from "./dure-home.mjs";
import {
  coldBootstrapSessionName,
  parseColdBootstrapOperation,
} from "./dev-cold-bootstrap-operation.mjs";
import {
  PACKAGE_SCRIPT_SHELL_ENV,
  POSIX_SHELL_EXECUTABLE_ENV,
  readProcessCwd,
  resolveUnixDevChainTools,
} from "./unix-process-tools.mjs";
import { resolvePinnedDevNodeTool } from "./dev-node-tool.mjs";
import {
  ensureDevHmuxTool,
  parseDevHmuxBuildId,
  targetDevHmuxBuildId,
} from "./dev-hmux-tool.mjs";
import {
  DEV_HMUX_STANDALONE_ACKNOWLEDGE_CAPABILITY,
  DEV_HMUX_STANDALONE_OPERATION_CAPABILITY,
  DEV_HMUX_STANDALONE_OPERATION_FRAME_LIMIT,
  DEV_HMUX_STANDALONE_OPERATION_MODE,
  DEV_HMUX_STANDALONE_OPERATION_SUBCOMMAND,
  DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY,
  DEV_HMUX_STANDALONE_RETIRE_CAPABILITY,
  decodeDevHmuxStandaloneOperation,
  devHmuxStandaloneCommandEnvironmentValue,
  encodeDevHmuxStandaloneOperation,
  parseDevHmuxStandaloneCommand,
  parseDevHmuxStandaloneOperationBinding,
  parseDevHmuxStandaloneOperationMode,
} from "./dev-hmux-operation-contract.mjs";

export const DEV_CHAIN_RESTART_STATE = Object.freeze({
  NOT_STARTED: "not_started",
  PENDING: "pending",
  FAILED: "failed",
  RESTARTED: "restarted",
  CONVERGED: "converged",
});

export function supportsDevChainColdBootstrap(capability) {
  return capability?.status === "available";
}

export function supportsStandaloneCreateOperation(platform = process.platform) {
  return platform !== "win32";
}

const COLD_BOOTSTRAP_KIND = "cold_bootstrap";
const RETIREMENT_ACKNOWLEDGEMENT_KIND =
  "cold_bootstrap_retirement_acknowledgement";
const COLD_BOOTSTRAP_POLL_MS = 100;
const COLD_BOOTSTRAP_HMUX_ATTEMPT_MS = 5_000;
const SAFE_BOOTSTRAP_ENVIRONMENT = Object.freeze([
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
]);

export function coldBootstrapDiscoveryRoot(home) {
  return join(appRootUnder(home), "state", "dev-launch-hosts");
}

function coldBootstrapEnvironment(home, source = process.env) {
  const environment = { HOME: home };
  for (const key of SAFE_BOOTSTRAP_ENVIRONMENT) {
    if (key !== "HOME" && typeof source[key] === "string") {
      environment[key] = source[key];
    }
  }
  return environment;
}

function prepareColdBootstrapSession(request) {
  request.hmuxBuildId =
    request.hmuxBuildId === undefined
      ? targetDevHmuxBuildId({
          root: request.root,
          home: request.home,
          timeoutMs: request.timeoutMs,
        })
      : parseDevHmuxBuildId(request.hmuxBuildId);
  request.hmuxExecutable = ensureDevHmuxTool({
    root: request.root,
    home: request.home,
    channel: request.channel,
    requiredCapability:
      request.mode ===
      DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET
        ? DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY
        : request.mode ===
            DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET
          ? DEV_HMUX_STANDALONE_RETIRE_CAPABILITY
        : request.mode ===
            DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET
          ? DEV_HMUX_STANDALONE_ACKNOWLEDGE_CAPABILITY
          : DEV_HMUX_STANDALONE_OPERATION_CAPABILITY,
    expectedBuildId: request.hmuxBuildId,
    shellExecutable:
      request.shellExecutable ?? request.unixTools?.shellExecutable,
    timeoutMs: request.timeoutMs,
  });
  if (!request.command) {
    const node = resolvePinnedDevNodeTool({
      root: request.root,
      home: request.home,
    });
    request.command = parseDevHmuxStandaloneCommand([
      request.unixTools.environmentExecutable,
      "-u",
      "HMUX_DISCOVERY_ROOT",
      ...(process.env.DURE_HOME ? [`DURE_HOME=${process.env.DURE_HOME}`] : []),
      `PATH=${node.binDirectory}:${process.env.PATH ?? ""}`,
      `DURE_DEV_PORT=${request.port}`,
      `${POSIX_SHELL_EXECUTABLE_ENV}=${request.unixTools.shellExecutable}`,
      `${PACKAGE_SCRIPT_SHELL_ENV}=${request.unixTools.shellExecutable}`,
      ...(request.unixTools.dependencyInstallerExecutable
        ? [
            `${COREPACK_EXECUTABLE_ENV}=${request.unixTools.dependencyInstallerExecutable}`,
          ]
        : []),
      node.nodeExecutable,
      join(request.root, "scripts", "run-dev-app.mjs"),
    ]);
  }
}

function createColdBootstrapSession(request) {
  const input = encodeDevHmuxStandaloneOperation({
    operationId: request.operationId,
    sessionName: request.sessionName,
    command: request.command,
    initialRows: request.initialRows,
    initialColumns: request.initialColumns,
    mode: request.mode,
  });
  const deadline = Date.now() + request.timeoutMs;
  const result = spawnSync(
    request.hmuxExecutable,
    [
      "--discovery-root",
      request.discoveryRoot,
      DEV_HMUX_STANDALONE_OPERATION_SUBCOMMAND,
    ],
    {
      cwd: request.root,
      env: coldBootstrapEnvironment(request.home),
      input,
      timeout: Math.min(
        COLD_BOOTSTRAP_HMUX_ATTEMPT_MS,
        Math.max(1, deadline - Date.now()),
      ),
      maxBuffer: DEV_HMUX_STANDALONE_OPERATION_FRAME_LIMIT + 4,
    },
  );
  if (result.status !== 0) {
    return {
      outcome: "pending",
      errorCode: "hmux_standalone_create_transport_pending",
    };
  }
  try {
    return decodeDevHmuxStandaloneOperation(result.stdout, request);
  } catch {
    return {
      outcome: "pending",
      errorCode: "hmux_standalone_create_transport_pending",
    };
  }
}

function processRows(executable, execute = execFileSync) {
  const rows = execute(executable, ["-Ao", "pid=,command="], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const processes = [];
  for (const line of rows.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match) processes.push({ pid: Number(match[1]), command: match[2] });
  }
  return processes;
}

function coldBootstrapPortState(port, executable, spawn = spawnSync) {
  const result = spawn(
    executable,
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status === 0) return "present";
  if (!result.error && result.status === 1) return "absent";
  return "unknown";
}

export function inspectDevChainState(
  {
    root,
    port,
    toolCapability = resolveUnixDevChainTools(),
  },
  runtime = {},
) {
  const identity = { worktreeRoot: root, port };
  if (toolCapability.observationStatus !== "available") {
    return {
      ...identity,
      state: "unsupported",
      reason: toolCapability.observationReason,
      observedAtMs: Date.now(),
    };
  }
  const { tools } = toolCapability;
  const execute = runtime.execute ?? execFileSync;
  const resolveCwd = (pid) =>
    readProcessCwd(pid, {
      execute,
      executable: tools.processCwdExecutable,
    });
  const resolveWorktreeRoot =
    runtime.resolveWorktreeRoot ?? gitWorktreeRootForPath;
  let processes;
  try {
    processes = processRows(tools.processCensusExecutable, execute);
  } catch {
    return {
      ...identity,
      state: "unknown",
      reason: "process census was unavailable",
      observedAtMs: Date.now(),
    };
  }
  if (
    hasOwnedAppProcess(
      processes,
      root,
      resolveCwd,
      resolveWorktreeRoot,
    )
  ) {
    return {
      ...identity,
      state: "present",
      reason: "an owned app process is still present",
      observedAtMs: Date.now(),
    };
  }
  if (
    hasOwnedDevLaunchProcess(
      processes,
      root,
      resolveCwd,
      resolveWorktreeRoot,
    )
  ) {
    return {
      ...identity,
      state: "present",
      reason: "an owned dev launch is still present",
      observedAtMs: Date.now(),
    };
  }
  const portState = coldBootstrapPortState(
    port,
    tools.portCensusExecutable,
    runtime.spawn ?? spawnSync,
  );
  const state = portState === "present" ? "blocked" : portState;
  return {
    ...identity,
    state,
    observedAtMs: Date.now(),
    ...(state === "absent"
      ? {}
      : {
          reason:
            state === "blocked"
              ? `development port ${port} is already in use`
              : `development port ${port} could not be observed safely`,
        }),
  };
}

async function awaitColdBootstrapParent(request) {
  const deadline = Date.now() + request.timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("cold-bootstrap parent generation did not become ready");
    }
    try {
      return await observeDevLaunchParentGeneration({
        root: request.root,
        channel: request.channel,
        sourceGeneration: request.sourceGeneration,
        hmuxProviderIdentity: request.hmuxProviderIdentity,
        timeoutMs: Math.min(remaining, 5_000),
      });
    } catch (error) {
      if (
        error?.code !== DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED &&
        error?.code !== DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE
      ) {
        throw error;
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(COLD_BOOTSTRAP_POLL_MS, remaining)),
    );
  }
}

const systemColdBootstrapAdapter = Object.freeze({
  resolveTools: resolveUnixDevChainTools,
  prepare: prepareColdBootstrapSession,
  create: createColdBootstrapSession,
  awaitParent: awaitColdBootstrapParent,
});

export async function executeDevChainRetirementAcknowledgement(
  options = {},
  adapter = {},
) {
  const operations = { ...systemColdBootstrapAdapter, ...adapter };
  if (!supportsStandaloneCreateOperation()) {
    return unavailableResult(
      RETIREMENT_ACKNOWLEDGEMENT_KIND,
      "dev_launch_retirement_acknowledgement_unavailable: this platform has no standalone-create operation adapter",
    );
  }
  if (
    !options.root ||
    !options.channel ||
    !/^[a-f0-9]{32}$/.test(options.requestGeneration ?? "") ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1
  ) {
    return unavailableResult(
      RETIREMENT_ACKNOWLEDGEMENT_KIND,
      "dev_launch_retirement_acknowledgement_unavailable: an exact deploy generation and timeout are required",
    );
  }
  let binding;
  let hmuxBuildId;
  try {
    binding = parseDevHmuxStandaloneOperationBinding(options.binding);
    hmuxBuildId =
      options.hmuxBuildId === undefined
        ? undefined
        : parseDevHmuxBuildId(options.hmuxBuildId);
    if (
      binding.sessionName !==
      coldBootstrapSessionName({
        root: options.root,
        channel: options.channel,
        operationId: binding.operationId,
      })
    ) {
      throw new Error("standalone operation session does not match");
    }
  } catch (error) {
    return unavailableResult(
      RETIREMENT_ACKNOWLEDGEMENT_KIND,
      `dev_launch_retirement_acknowledgement_unavailable: ${error.message}`,
    );
  }
  const home = options.home ?? homedir();
  const replayShellExecutable = devHmuxStandaloneCommandEnvironmentValue(
    binding.command,
    POSIX_SHELL_EXECUTABLE_ENV,
  );
  const request = {
    ...binding,
    root: options.root,
    channel: options.channel,
    requestGeneration: options.requestGeneration,
    mode: DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET,
    timeoutMs: options.timeoutMs,
    home,
    discoveryRoot: coldBootstrapDiscoveryRoot(home),
    ...(hmuxBuildId ? { hmuxBuildId } : {}),
    ...(replayShellExecutable
      ? { shellExecutable: replayShellExecutable }
      : {}),
  };
  try {
    await operations.prepare(request);
  } catch (error) {
    return {
      ...unavailableResult(
        RETIREMENT_ACKNOWLEDGEMENT_KIND,
        `dev_launch_retirement_acknowledgement_failed: ${error.message}`,
      ),
      state: DEV_CHAIN_RESTART_STATE.FAILED,
    };
  }

  let hmux;
  try {
    hmux = await operations.create(request);
  } catch (error) {
    return {
      kind: RETIREMENT_ACKNOWLEDGEMENT_KIND,
      state: DEV_CHAIN_RESTART_STATE.PENDING,
      attempted: true,
      acknowledgementDispatched: true,
      hmuxOutcome: "pending",
      reason: `dev_launch_retirement_acknowledgement_pending: ${error.message}`,
    };
  }
  if (hmux?.outcome === "acknowledged") {
    return {
      kind: RETIREMENT_ACKNOWLEDGEMENT_KIND,
      state: DEV_CHAIN_RESTART_STATE.CONVERGED,
      attempted: true,
      destructiveBoundaryCrossed: true,
      acknowledgementDispatched: true,
      hmuxOutcome: "acknowledged",
      reason: "dev_launch_retirement_acknowledgement_applied",
      receipt: {
        schemaVersion: 1,
        type: "cold_bootstrap_retirement_acknowledged",
        requestGeneration: request.requestGeneration,
        hmux,
      },
    };
  }
  if (hmux?.outcome === "refused") {
    return {
      kind: RETIREMENT_ACKNOWLEDGEMENT_KIND,
      state: DEV_CHAIN_RESTART_STATE.FAILED,
      attempted: true,
      destructiveBoundaryCrossed: false,
      acknowledgementDispatched: false,
      hmuxOutcome: "refused",
      hmuxErrorCode: hmux.errorCode,
      reason: `dev_launch_retirement_acknowledgement_refused: ${hmux.errorCode}`,
    };
  }
  return {
    kind: RETIREMENT_ACKNOWLEDGEMENT_KIND,
    state: DEV_CHAIN_RESTART_STATE.PENDING,
    attempted: true,
    acknowledgementDispatched: true,
    hmuxOutcome: "pending",
    ...(hmux?.errorCode ? { hmuxErrorCode: hmux.errorCode } : {}),
    reason: `dev_launch_retirement_acknowledgement_pending: ${hmux?.errorCode ?? "uncorrelated response"}`,
  };
}

export async function executeDevChainColdBootstrap(
  options = {},
  adapter = {},
) {
  const operations = { ...systemColdBootstrapAdapter, ...adapter };
  if (!supportsStandaloneCreateOperation()) {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: this platform has no standalone-create operation adapter",
    );
  }
  if (
    !options.root ||
    !options.channel ||
    !/^[a-f0-9]{32}$/.test(options.requestGeneration ?? "") ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1
  ) {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: an exact deploy generation and timeout are required",
    );
  }
  let operation;
  try {
    operation = parseColdBootstrapOperation({
      operationId: options.operationId,
      initialRows: options.initialRows,
      initialColumns: options.initialColumns,
    });
  } catch {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: an exact deploy operation is required",
    );
  }
  let mode;
  try {
    if (Object.hasOwn(options, "reconcileCompletedTarget")) {
      throw new Error("legacy reconciliation flag is not accepted");
    }
    mode = parseDevHmuxStandaloneOperationMode(options.mode);
  } catch {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: an exact standalone operation mode is required",
    );
  }
  if (
    mode ===
    DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET
  ) {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: retirement acknowledgement is not a cold-bootstrap action",
    );
  }
  const retiresCompletedTarget =
    mode === DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET;
  if (
    !retiresCompletedTarget &&
    (!Number.isSafeInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535 ||
      (typeof options.sourceGeneration !== "function" &&
        !/^[a-f0-9]{64}$/.test(options.sourceGeneration ?? "")))
  ) {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: an exact target source and port are required",
    );
  }
  let command;
  try {
    command = options.command
      ? parseDevHmuxStandaloneCommand(options.command)
      : undefined;
  } catch {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: the standalone operation command is invalid",
    );
  }
  let hmuxBuildId;
  try {
    hmuxBuildId =
      options.hmuxBuildId === undefined
        ? undefined
        : parseDevHmuxBuildId(options.hmuxBuildId);
  } catch {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: the development Hmux build identity is invalid",
    );
  }
  if (
    mode !== DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE &&
    !command
  ) {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: replay requires the saved standalone operation command",
    );
  }
  if (
    mode === DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE &&
    command
  ) {
    return unavailableResult(
      COLD_BOOTSTRAP_KIND,
      "dev_launch_cold_bootstrap_unavailable: a fresh create command must be composed from resolved target tools",
    );
  }
  const replayShellExecutable = devHmuxStandaloneCommandEnvironmentValue(
    command,
    POSIX_SHELL_EXECUTABLE_ENV,
  );
  let toolCapability;
  if (mode === DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE) {
    toolCapability = operations.resolveTools();
    if (!supportsDevChainColdBootstrap(toolCapability)) {
      return unavailableResult(
        COLD_BOOTSTRAP_KIND,
        `dev_launch_cold_bootstrap_unavailable: ${toolCapability.reason}`,
      );
    }
  }
  const home = options.home ?? homedir();
  const request = {
    root: options.root,
    channel: options.channel,
    requestGeneration: options.requestGeneration,
    ...operation,
    mode,
    timeoutMs: options.timeoutMs,
    sessionName: coldBootstrapSessionName({
      root: options.root,
      channel: options.channel,
      operationId: operation.operationId,
    }),
    home,
    discoveryRoot: coldBootstrapDiscoveryRoot(home),
    ...(retiresCompletedTarget ? {} : { port: options.port }),
    ...(command ? { command } : {}),
    ...(hmuxBuildId ? { hmuxBuildId } : {}),
    ...(replayShellExecutable
      ? { shellExecutable: replayShellExecutable }
      : {}),
    ...(toolCapability ? { unixTools: toolCapability.tools } : {}),
  };
  if (!retiresCompletedTarget) {
    let sourceGeneration;
    try {
      sourceGeneration =
        typeof options.sourceGeneration === "function"
          ? options.sourceGeneration()
          : options.sourceGeneration;
    } catch (error) {
      return {
        ...unavailableResult(
          COLD_BOOTSTRAP_KIND,
          `dev_launch_cold_bootstrap_failed: target source generation was unavailable: ${error.message}`,
        ),
        state: DEV_CHAIN_RESTART_STATE.FAILED,
      };
    }
    if (!/^[a-f0-9]{64}$/.test(sourceGeneration ?? "")) {
      return {
        ...unavailableResult(
          COLD_BOOTSTRAP_KIND,
          "dev_launch_cold_bootstrap_failed: target source generation was invalid",
        ),
        state: DEV_CHAIN_RESTART_STATE.FAILED,
      };
    }
    request.sourceGeneration = sourceGeneration;
  }

  try {
    await operations.prepare(request);
    request.command = parseDevHmuxStandaloneCommand(request.command);
    await options.onOperationSubmitted?.(
      operation.operationId,
      request.command,
      request.hmuxBuildId,
    );
  } catch (error) {
    return {
      kind: COLD_BOOTSTRAP_KIND,
      state: DEV_CHAIN_RESTART_STATE.FAILED,
      attempted: false,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: false,
      reason: `dev_launch_cold_bootstrap_failed: ${error.message}`,
    };
  }

  let hmux;
  try {
    hmux = await operations.create(request);
  } catch (error) {
    return {
      kind: COLD_BOOTSTRAP_KIND,
      state: DEV_CHAIN_RESTART_STATE.PENDING,
      attempted: true,
      destructiveBoundaryCrossed: retiresCompletedTarget ? null : false,
      relaunchDispatched: !retiresCompletedTarget,
      hmuxOutcome: "pending",
      reason: `dev_launch_cold_bootstrap_pending: ${error.message}`,
    };
  }
  if (hmux?.outcome === "pending") {
    return {
      kind: COLD_BOOTSTRAP_KIND,
      state: DEV_CHAIN_RESTART_STATE.PENDING,
      attempted: true,
      destructiveBoundaryCrossed: retiresCompletedTarget ? null : false,
      relaunchDispatched: !retiresCompletedTarget,
      hmuxOutcome: "pending",
      hmuxErrorCode: hmux.errorCode,
      reason: `dev_launch_cold_bootstrap_pending: ${hmux.errorCode}`,
    };
  }
  if (hmux?.outcome === "retired") {
    return {
      kind: COLD_BOOTSTRAP_KIND,
      state: DEV_CHAIN_RESTART_STATE.PENDING,
      attempted: true,
      destructiveBoundaryCrossed: true,
      relaunchDispatched: false,
      hmuxOutcome: "retired",
      reason: "dev_launch_cold_bootstrap_target_retired",
      receipt: {
        schemaVersion: 1,
        type: "cold_bootstrap_target_retired",
        requestGeneration: request.requestGeneration,
        hmux,
      },
    };
  }
  if (hmux?.outcome === "refused") {
    return {
      kind: COLD_BOOTSTRAP_KIND,
      state: DEV_CHAIN_RESTART_STATE.FAILED,
      attempted: true,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: false,
      hmuxOutcome: "refused",
      hmuxErrorCode: hmux.errorCode,
      reason: `dev_launch_cold_bootstrap_refused: ${hmux.errorCode}`,
    };
  }
  if (retiresCompletedTarget) {
    return {
      kind: COLD_BOOTSTRAP_KIND,
      state: DEV_CHAIN_RESTART_STATE.FAILED,
      attempted: true,
      destructiveBoundaryCrossed: null,
      relaunchDispatched: false,
      reason:
        "dev_launch_cold_bootstrap_failed: Hmux retirement receipt was invalid",
    };
  }
  request.hmuxProviderIdentity = {
    sessionId: hmux.sessionId,
    workspaceId: hmux.workspaceId,
  };

  let parentGeneration;
  try {
    parentGeneration = await operations.awaitParent(request);
  } catch (error) {
    return {
      kind: COLD_BOOTSTRAP_KIND,
      state: DEV_CHAIN_RESTART_STATE.PENDING,
      attempted: true,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: true,
      hmuxOutcome: "created",
      reason: `dev_launch_cold_bootstrap_parent_unavailable: ${error.message}`,
      receipt: {
        schemaVersion: 1,
        type: "cold_bootstrap_dispatched",
        requestGeneration: request.requestGeneration,
        hmux,
      },
    };
  }
  return {
    kind: COLD_BOOTSTRAP_KIND,
    state: DEV_CHAIN_RESTART_STATE.RESTARTED,
    attempted: true,
    destructiveBoundaryCrossed: false,
    relaunchDispatched: true,
    hmuxOutcome: "created",
    reason: "dev_launch_cold_bootstrap_receipt_verified",
    receipt: {
      schemaVersion: 1,
      type: "cold_bootstrap_receipt",
      requestGeneration: request.requestGeneration,
      hmux,
      parentGeneration,
    },
  };
}

export function unavailableResult(kind, reason) {
  return {
    kind,
    state: DEV_CHAIN_RESTART_STATE.NOT_STARTED,
    attempted: false,
    destructiveBoundaryCrossed: false,
    relaunchDispatched: false,
    reason,
  };
}

/** Hmux session identity never grants dev-launch control. Restart is admitted
 * only through the exact owner-only descriptor emitted by app:dev itself; the
 * launcher supervisor retires its own child and returns the replacement receipt. */
export function executeDevChainRestart(options = {}) {
  if (!options.root || !options.channel) {
    return unavailableResult(
      DEV_DEPLOY_IMPACT.CHILD_RESTART,
      "dev_launch_supervisor_authority_unavailable: automatic restart requires an exact dev-launch supervisor descriptor",
    );
  }
  return requestDevLaunchRestart(options)
    .then((receipt) => ({
      kind: DEV_DEPLOY_IMPACT.CHILD_RESTART,
      state: DEV_CHAIN_RESTART_STATE.RESTARTED,
      attempted: true,
      destructiveBoundaryCrossed: true,
      relaunchDispatched: true,
      reason: "dev_launch_supervisor_restart_receipt_verified",
      restartRequestId: receipt.requestId,
      receipt,
    }))
    .catch((error) => {
      if (error?.code === DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE) {
        return unavailableResult(
          DEV_DEPLOY_IMPACT.CHILD_RESTART,
          `dev_launch_supervisor_authority_unavailable: ${error.message}`,
        );
      }
      return {
        kind: DEV_DEPLOY_IMPACT.CHILD_RESTART,
        state: DEV_CHAIN_RESTART_STATE.FAILED,
        attempted: true,
        destructiveBoundaryCrossed:
          error?.destructiveBoundaryCrossed === true
            ? true
            : error?.destructiveBoundaryCrossed === false
              ? false
              : null,
        relaunchDispatched: false,
        reason: `dev_launch_supervisor_restart_failed: ${error.message}`,
        ...(error?.restartRequestId
          ? { restartRequestId: error.restartRequestId }
          : {}),
      };
    });
}

export function executeDevParentReload(options = {}) {
  if (options.parentStrategy === DEV_PARENT_RELOAD_STRATEGY.COLD_BOOTSTRAP) {
    return Promise.resolve(
      unavailableResult(
        DEV_DEPLOY_IMPACT.PARENT_RELOAD,
        "cold_bootstrap_required: the target changes the Node runtime pin and cannot be activated by same-binary exec",
      ),
    );
  }
  if (!options.root || !options.channel || !options.sourceGeneration) {
    return Promise.resolve(
      unavailableResult(
        DEV_DEPLOY_IMPACT.PARENT_RELOAD,
        "dev_launch_parent_authority_unavailable: parent reload requires an exact descriptor and target source generation",
      ),
    );
  }
  return ensureDevLaunchParentGeneration({
    ...options,
    requireFrontendAuthority: true,
  })
    .then((result) => {
      if (result.outcome === "already_active") {
        return {
          kind: DEV_DEPLOY_IMPACT.PARENT_RELOAD,
          state: DEV_CHAIN_RESTART_STATE.CONVERGED,
          attempted: false,
          destructiveBoundaryCrossed: false,
          relaunchDispatched: false,
          reason: "dev_launch_parent_generation_already_active",
          receipt: result.parentGeneration,
        };
      }
      const receipt = result.activation;
      return {
        kind: DEV_DEPLOY_IMPACT.PARENT_RELOAD,
        state: DEV_CHAIN_RESTART_STATE.RESTARTED,
        attempted: true,
        destructiveBoundaryCrossed: true,
        relaunchDispatched: true,
        reason: "dev_launch_parent_reload_receipt_verified",
        parentReloadRequestId: receipt.requestId,
        receipt,
      };
    })
    .catch((error) => {
      if (
        error?.code === DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED ||
        error?.code === DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE
      ) {
        return unavailableResult(
          DEV_DEPLOY_IMPACT.PARENT_RELOAD,
          `${error?.code === DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED ? "cold_bootstrap_required" : "dev_launch_parent_authority_unavailable"}: ${error.message}`,
        );
      }
      return {
        kind: DEV_DEPLOY_IMPACT.PARENT_RELOAD,
        state: DEV_CHAIN_RESTART_STATE.FAILED,
        attempted: true,
        destructiveBoundaryCrossed:
          error?.destructiveBoundaryCrossed === true
            ? true
            : error?.destructiveBoundaryCrossed === false
              ? false
              : null,
        relaunchDispatched: false,
        reason: `dev_launch_parent_reload_failed: ${error.message}`,
        ...(error?.parentReloadRequestId
          ? { parentReloadRequestId: error.parentReloadRequestId }
          : {}),
      };
    });
}

const DEV_LAUNCH_COMMAND =
  /(?:^|\s)(?:node\s+)?(?:\S*\/)?tauri(?:\.js)?\s+dev(?:\s|$)/;

/** pathname을 소유한 가장 가까운 Git worktree root.
 * null은 Git worktree 밖, undefined는 관측 실패다. */
export function gitWorktreeRootForPath(pathname) {
  let candidate;
  try {
    candidate = realpathSync(pathname);
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      statSync(join(candidate, ".git"));
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        return undefined;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

function processWorktreeOwnership(
  pid,
  root,
  resolveCwd,
  resolveWorktreeRoot,
) {
  const cwd = resolveCwd(pid);
  if (!cwd) return "unknown";
  const owner = resolveWorktreeRoot(cwd);
  if (owner === undefined) return "unknown";
  return owner === root ? "owned" : "foreign";
}

function hasOwnedProcess(
  processes,
  root,
  resolveCwd,
  resolveWorktreeRoot,
  matchesCommand,
) {
  for (const { pid, command } of processes) {
    if (!matchesCommand(command)) continue;
    const ownership = processWorktreeOwnership(
      pid,
      root,
      resolveCwd,
      resolveWorktreeRoot,
    );
    if (ownership !== "foreign") return true;
  }
  return false;
}

function isDevLaunchCommand(command) {
  return (
    command.includes("scripts/run-dev-app.mjs") ||
    DEV_LAUNCH_COMMAND.test(command)
  );
}

/** 이 worktree가 소유한 Tauri launch process가 하나라도 있는지. run-dev-app과
 * tauri CLI는 부모·자식으로 함께 존재하는 것이 정상이므로 복수 후보도 true다. */
export function hasOwnedDevLaunchProcess(
  processes,
  root,
  resolveCwd,
  resolveWorktreeRoot = gitWorktreeRootForPath,
) {
  return hasOwnedProcess(
    processes,
    root,
    resolveCwd,
    resolveWorktreeRoot,
    isDevLaunchCommand,
  );
}

/**
 * 이 워크트리가 소유한 앱 프로세스 pid. 정확히 하나로 좁혀지지 않으면 null —
 * 남의 워크트리 앱을 재기동하는 것이 최악이므로 모호하면 물러난다.
 *
 * 실행 파일 경로만으로는 소유를 알 수 없다. raw `tauri dev`는 앱을
 * **워크트리 기준 상대경로**(`target/debug/dure`)로 보여주고, macOS 표시명을
 * 제공하는 개발 번들은 절대 `Dure.app/Contents/MacOS/dure` 경로로 보여준다.
 * 절대경로만 보던 이전 구현은 이 실제 형태를 놓쳐 자동 복구가 항상 "앱 없음"으로
 * 물러났다(2026-07-30 실기에서 확인). 그래서 상대경로면 cwd로 소유를 판정한다.
 *
 * cwd는 워크트리 루트가 아니라 그 하위일 수 있다(실측: `<root>/src-tauri`).
 * 가장 가까운 `.git` 경계를 찾고 exact root를 비교해 main 아래 linked worktree도
 * 다른 소유자로 구분한다.
 *
 * @param {{pid: number, command: string}[]} processes ps의 pid/comm 목록
 * @param {string} root 워크트리 루트(끝 슬래시 없음)
 * @param {(pid: number) => string | undefined} resolveCwd pid → cwd
 * @param {(cwd: string) => string | null | undefined} resolveWorktreeRoot
 * @returns {number | null}
 */
function ownedAppProcessPids(
  processes,
  root,
  resolveCwd,
  resolveWorktreeRoot = gitWorktreeRootForPath,
) {
  const owned = [];
  for (const { pid, command } of processes) {
    if (isBundledAppProcessCommand(command)) {
      if (debugAppRootFromCommand(command) === root) owned.push(pid);
      continue;
    }
    if (!isDebugAppProcessCommand(command)) continue;
    const commandRoot = debugAppRootFromCommand(command);
    if (commandRoot !== undefined) {
      if (commandRoot === root) owned.push(pid);
      continue;
    }
    if (
      processWorktreeOwnership(pid, root, resolveCwd, resolveWorktreeRoot) ===
      "owned"
    ) {
      owned.push(pid);
    }
  }
  return owned;
}

function hasOwnedAppProcess(
  processes,
  root,
  resolveCwd,
  resolveWorktreeRoot = gitWorktreeRootForPath,
) {
  return (
    ownedAppProcessPids(processes, root, resolveCwd, resolveWorktreeRoot)
      .length > 0
  );
}

export function ownedAppPid(
  processes,
  root,
  resolveCwd,
  resolveWorktreeRoot = gitWorktreeRootForPath,
) {
  const owned = ownedAppProcessPids(
    processes,
    root,
    resolveCwd,
    resolveWorktreeRoot,
  );
  return owned.length === 1 ? owned[0] : null;
}
