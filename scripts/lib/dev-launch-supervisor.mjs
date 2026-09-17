import { spawn } from "node:child_process";
import {
  chmodSync,
  linkSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appControlDirectory } from "./app-channel.mjs";
import {
  CHILD_IDENTITY_TIMEOUT_MS,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_RESTART_SETTLEMENT_TIMEOUT_MS,
  DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
  DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
  DEV_LAUNCH_FRONTEND_GENERATION_ENV,
  DEV_LAUNCH_CHILD_GENERATION_ENV,
  DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION,
  DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
  FRONTEND_ACTIVATION_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_RESTART_TRANSACTIONS,
  PARENT_RELOAD_CAPABILITY,
  TERMINAL_RETENTION_GRACE_MS,
  parseDevLaunchFrontendActivation,
  parseDevLaunchGeneration,
  parseDevLaunchHmuxProviderIdentity,
  parseDevLaunchFrontendReady,
  parseDevLaunchFrontendUnavailable,
  parseDevLaunchChildActivationFailure,
  parseDevLaunchChildReady,
  exactDescriptor,
  descriptorOwnedLaunchIdentities,
  exactParentHandoff,
  parentGenerationFrame,
  randomIdentity,
  redactDevLaunchCapability,
  responseProtocolMatches,
  sameDevLaunchGeneration,
  sameDevLaunchIdentity,
  sameOptionalDevLaunchGeneration,
  sameOptionalDevLaunchIdentity,
  validateParentGenerationProbeRequest,
} from "./dev-launch-contract.mjs";
import {
  assertOwnerOnlyDirectory,
  createDescriptor,
  delay,
  descriptorPath,
  isOwner,
  readDescriptor,
  safeLstat,
  socketPathFor,
  writeDescriptor,
} from "./dev-launch-client.mjs";
import { requireDevLaunchAdmission } from "./dev-launch-admission.mjs";
import { normalizeFrontendAuthority } from "./dev-frontend-authority.mjs";
import { fsyncDirectory } from "./durable-file.mjs";
import {
  observeProcessIdentity as readProcessIdentity,
  observeProcessLiveness,
} from "./process-identity.mjs";
import {
  bindProcessGroupAuthority,
  observeOwnedProcessGroup,
  parseProcessGroupWitnessReady,
} from "./process-group-authority.mjs";
import {
  candidateCleanupAuthority,
  launchRetired,
  launchRuntimeState,
  retireOwnedLaunch,
  settleOwnedLaunchRetirement,
  waitForLaunchRetirement,
} from "./dev-launch-retirement.mjs";
import { createWindowsJobLease, isWindowsJobCandidateMessage } from "./windows-process-job.mjs";

const launchChildPath = fileURLToPath(
  new URL("../run-dev-launch-child.mjs", import.meta.url),
);

async function observeProcessIdentity(pid) {
  const deadline = Date.now() + CHILD_IDENTITY_TIMEOUT_MS;
  do {
    const identity = await readProcessIdentity(pid, {
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    if (identity) return identity;
    await delay(20);
  } while (Date.now() < deadline);
  return null;
}

function waitForServerClose(server) {
  return new Promise((resolve) => server.close(resolve));
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function probeSocket(socketPath, timeoutMs = 250) {
  return new Promise((resolve) => {
    const connection = createConnection(socketPath);
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    connection.once("connect", () => finish(true));
    connection.once("error", () => finish(false));
  });
}

function unlinkExactSocket(pathname) {
  if (process.platform === "win32") return;
  const stat = safeLstat(pathname);
  if (!stat) return;
  if (
    stat.isSymbolicLink() ||
    !stat.isSocket() ||
    !isOwner(stat)
  ) {
    throw new Error(`refusing to remove unsafe supervisor socket: ${pathname}`);
  }
  unlinkSync(pathname);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function descriptorClaimPath(pathname, supervisorGeneration) {
  const generation = parseDevLaunchGeneration(
    supervisorGeneration,
    "recovery claim generation",
  );
  return `${pathname}.claim-${generation}`;
}

function releaseDescriptorClaim(claim) {
  if (!claim) return;
  const stat = safeLstat(claim.pathname);
  if (
    !stat ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !isOwner(stat) ||
    !sameFile(stat, claim.stat) ||
    readFileSync(claim.pathname, "utf8") !== claim.source
  ) {
    throw new Error(
      `dev launch supervisor recovery claim changed: ${claim.pathname}`,
    );
  }
  unlinkSync(claim.pathname);
  fsyncDirectory(dirname(claim.pathname));
}

export function claimStaleDescriptor(
  snapshot,
  { linkDescriptor = linkSync } = {},
) {
  const claimPathname = descriptorClaimPath(
    snapshot.pathname,
    snapshot.value?.supervisor?.generation,
  );
  try {
    linkDescriptor(snapshot.pathname, claimPathname);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        "dev launch supervisor recovery stopped before claimant publication",
      );
    }
    if (error?.code === "ENOENT") {
      throw new Error(
        "dev launch supervisor authority changed during stale recovery",
      );
    }
    throw error;
  }
  const claim = {
    pathname: claimPathname,
    source: null,
    stat: null,
  };
  try {
    claim.stat = safeLstat(claimPathname);
    claim.source = claim.stat
      ? readFileSync(claimPathname, "utf8")
      : null;
    const current = safeLstat(snapshot.pathname);
    if (
      !claim.stat ||
      claim.stat.isSymbolicLink() ||
      !claim.stat.isFile() ||
      !isOwner(claim.stat) ||
      !current ||
      !sameFile(claim.stat, snapshot.stat) ||
      !sameFile(current, snapshot.stat) ||
      claim.source !== snapshot.source ||
      readFileSync(snapshot.pathname, "utf8") !== snapshot.source ||
      readFileSync(claim.pathname, "utf8") !== claim.source
    ) {
      throw new Error(
        "dev launch supervisor descriptor changed during stale recovery",
      );
    }
    fsyncDirectory(dirname(claim.pathname));
    return claim;
  } catch (error) {
    try {
      releaseDescriptorClaim(claim);
    } catch (cleanupError) {
      throw new Error(`${error.message}; recovery claim cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

function hasOwnedCleanupObligation(liveness) {
  switch (liveness) {
    case "active":
    case "owned_group":
      return true;
    case "stale":
      return false;
    default:
      throw new Error(`unknown dev launch cleanup liveness: ${liveness}`);
  }
}

async function observeAdoptedRuntime(record, label) {
  try {
    return await launchRuntimeState(record.launch, `adopted ${label}`);
  } catch (error) {
    if (error?.code !== "DEV_LAUNCH_OBSERVATION_UNAVAILABLE") throw error;
    return "unknown";
  }
}

async function frontendReady(frontendAuthority, identity) {
  if (
    !frontendAuthority ||
    await launchRuntimeState(identity, "frontend") !== "active"
  ) {
    return false;
  }
  let ready = false;
  try {
    ready = (await frontendAuthority.probe(identity)) === true;
  } catch {
    return false;
  }
  return (
    ready &&
    await launchRuntimeState(identity, "frontend after readiness probe") ===
      "active"
  );
}

async function frontendReusable(frontendAuthority, identity) {
  if (!await frontendReady(frontendAuthority, identity)) return false;
  if (
    frontendAuthority.canReuse &&
    !await frontendAuthority.canReuse(identity)
  ) return false;
  return (
    await launchRuntimeState(identity, "frontend after reuse admission") === "active"
  );
}

export async function reclaimStaleDescriptor({
  home,
  channel,
  worktreeRoot,
  frontendAuthority,
  publishClaimant,
  adoptLive = true,
}) {
  const pathname = descriptorPath(home, channel);
  if (!safeLstat(pathname)) return null;
  const snapshot = readDescriptor({ home, channel, worktreeRoot });
  const { value } = snapshot;
  if (await probeSocket(value.socketPath)) {
    throw new Error(
      `dev launch supervisor is already active for ${channel} (pid ${value.supervisor.pid})`,
    );
  }
  if (
    await observeProcessLiveness(value.supervisor) !== "stale"
  ) {
    throw new Error(
      "dev launch supervisor process is still live but its endpoint is unavailable",
    );
  }
  const claim = claimStaleDescriptor(snapshot);
  try {
    const committedLaunch =
      value.state === "handoff" ? value.handoff.previousLaunch : value.launch;
    let launchLiveness = await launchRuntimeState(committedLaunch, "launch");
    const candidateLiveness = await launchRuntimeState(
      value.candidateLaunch,
      "candidate launch",
    );
    if (
      value.state === "handoff" &&
      hasOwnedCleanupObligation(launchLiveness) &&
      hasOwnedCleanupObligation(candidateLiveness)
    ) {
      throw new Error(
        "stale parent handoff retains two live app cleanup obligations",
      );
    }
    const candidateFrontendLiveness = await launchRuntimeState(
      value.candidateFrontend,
      "candidate frontend",
    );
    let frontendLiveness = await launchRuntimeState(
      value.frontend,
      "frontend",
    );
    if (
      hasOwnedCleanupObligation(frontendLiveness) &&
      !frontendAuthority
    ) {
      throw new Error(
        "stale dev launch supervisor retains a live frontend without a compatible readiness authority",
      );
    }
    const frontendIsReady =
      frontendLiveness === "active" &&
      await frontendReady(frontendAuthority, value.frontend);
    frontendLiveness = await launchRuntimeState(value.frontend, "frontend");
    const retireLegacyLaunch =
      launchLiveness === "active" &&
      !committedLaunch?.processGroup;
    const retireLegacyFrontend =
      frontendLiveness === "active" &&
      !value.frontend?.processGroup;
    if (retireLegacyLaunch && candidateLiveness !== "stale") {
      throw new Error(
        "stale legacy launch recovery cannot encode two live cleanup candidates",
      );
    }
    if (
      !adoptLive &&
      (hasOwnedCleanupObligation(launchLiveness) ||
        hasOwnedCleanupObligation(frontendLiveness))
    ) {
      throw new Error(
        "dev launch authority changed while reclaiming a live stale generation",
      );
    }
    publishClaimant(
      {
        launch:
          value.state === "handoff" || retireLegacyLaunch
            ? null
            : value.launch,
        candidateLaunch:
          value.state === "handoff"
            ? hasOwnedCleanupObligation(candidateLiveness)
              ? value.candidateLaunch
              : committedLaunch
            : retireLegacyLaunch
              ? committedLaunch
              : value.candidateLaunch,
        frontend: value.frontend ?? null,
        candidateFrontend: value.candidateFrontend,
        socketPath: value.socketPath,
      },
      { claim, snapshot },
    );
    unlinkExactSocket(value.socketPath);
    if (hasOwnedCleanupObligation(candidateLiveness)) {
      await retireOwnedLaunch(adoptLaunchRecord(value.candidateLaunch));
    }
    if (hasOwnedCleanupObligation(candidateFrontendLiveness)) {
      await retireOwnedLaunch(adoptLaunchRecord(value.candidateFrontend));
    }
    if (
      value.state === "handoff" &&
      hasOwnedCleanupObligation(launchLiveness)
    ) {
      await retireOwnedLaunch(adoptLaunchRecord(committedLaunch));
      launchLiveness = "stale";
    }
    if (value.state !== "handoff" && launchLiveness === "owned_group") {
      await retireOwnedLaunch(adoptLaunchRecord(committedLaunch));
      launchLiveness = "stale";
    }
    if (
      hasOwnedCleanupObligation(frontendLiveness) &&
      (!frontendIsReady || retireLegacyFrontend)
    ) {
      await retireOwnedLaunch(adoptLaunchRecord(value.frontend));
      frontendLiveness = "stale";
    }
    if (retireLegacyLaunch) {
      await retireOwnedLaunch(adoptLaunchRecord(committedLaunch));
      launchLiveness = "stale";
    }
    return {
      claim,
      launch:
        value.state !== "handoff" && launchLiveness === "active"
          ? value.launch
          : null,
      frontend: frontendLiveness === "active" ? value.frontend : null,
    };
  } catch (error) {
    try {
      releaseDescriptorClaim(claim);
    } catch (cleanupError) {
      throw new Error(`${error.message}; recovery claim cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

function validateRestartRequestAuthority(request, descriptor) {
  if (
    !request ||
    request.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    request.protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION ||
    request.type !== "restart" ||
    !/^[a-f0-9]{64}$/.test(request.requestId) ||
    request.capability !== descriptor.capability ||
    request.worktreeRoot !== descriptor.worktreeRoot ||
    request.channel !== descriptor.channel ||
    !sameDevLaunchGeneration(request.supervisor, descriptor.supervisor)
  ) {
    throw new Error("dev launch restart request does not match current authority");
  }
}

function validateRestartExpectedLaunch(request, descriptor) {
  if (
    (request.expectedState !== undefined &&
      request.expectedState !== descriptor.state) ||
    !sameDevLaunchGeneration(request.expectedLaunch, descriptor.launch) ||
    !sameOptionalDevLaunchGeneration(
      request.expectedFrontend,
      descriptor.frontend,
    )
  ) {
    throw new Error("dev launch restart request does not match current authority");
  }
}

function validateParentReloadRequest(
  request,
  descriptor,
  { sourceGeneration, preflightParent, reloadParent },
) {
  if (
    !request ||
    request.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    request.protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION ||
    request.type !== "parent_reload" ||
    !/^[a-f0-9]{64}$/.test(request.requestId) ||
    request.capability !== descriptor.capability ||
    request.worktreeRoot !== descriptor.worktreeRoot ||
    request.channel !== descriptor.channel ||
    !sameDevLaunchGeneration(
      request.expectedSupervisor,
      descriptor.supervisor,
    ) ||
    !sameDevLaunchGeneration(request.expectedLaunch, descriptor.launch) ||
    !sameOptionalDevLaunchGeneration(
      request.expectedFrontend,
      descriptor.frontend,
    ) ||
    typeof preflightParent !== "function" ||
    typeof reloadParent !== "function" ||
    descriptor.sourceGeneration !== sourceGeneration
  ) {
    throw new Error(
      "dev launch parent reload request does not match current authority",
    );
  }
  parseDevLaunchGeneration(
    request.targetSupervisorGeneration,
    "parent reload target generation",
  );
  parseDevLaunchGeneration(
    request.targetSourceGeneration,
    "parent reload target source generation",
  );
  if (request.targetSourceGeneration === sourceGeneration) {
    throw new Error("dev launch parent reload target is already active");
  }
  if (
    request.targetSupervisorGeneration === descriptor.supervisor.generation
  ) {
    throw new Error("dev launch parent reload target supervisor is already active");
  }
}

function validateRestartTransactionRequest(request, descriptor) {
  if (
    !request ||
    request.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    request.protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION ||
    (request.type !== "restart_status" && request.type !== "restart_ack") ||
    !/^[a-f0-9]{64}$/.test(request.requestId) ||
    request.capability !== descriptor.capability ||
    request.worktreeRoot !== descriptor.worktreeRoot ||
    request.channel !== descriptor.channel ||
    !sameDevLaunchGeneration(request.supervisor, descriptor.supervisor)
  ) {
    throw new Error(
      "dev launch restart transaction request does not match authority",
    );
  }
}

function sendFrame(connection, value) {
  connection.end(`${JSON.stringify(value)}\n`);
}

function sendFrameBeforeTransition(connection, value) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      connection.off("error", finish);
      connection.off("close", finish);
      resolve();
    };
    connection.once("error", finish);
    connection.once("close", finish);
    connection.end(`${JSON.stringify(value)}\n`, finish);
  });
}

function processExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function spawnLaunchRecord({
  command,
  args,
  spawnOptions,
}) {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    ...spawnOptions,
    detached,
  });
  const spawnedPid = child.pid;
  const identityPromise = Number.isSafeInteger(spawnedPid) && spawnedPid > 0
    ? observeProcessIdentity(spawnedPid)
    : Promise.resolve(null);
  const record = {
    child,
    detached,
    exited: false,
    exit: null,
    exitPromise: null,
    launch: null,
    restarting: false,
    adopted: false,
    identityPromise,
  };
  const exited = processExit(child);
  if (process.platform === "win32") record.windowsJob = createWindowsJobLease(child, identityPromise);
  record.exitPromise = Promise.all([exited, record.windowsJob?.retired]).then(([outcome]) => {
    record.exited = true;
    record.exit = outcome;
    return outcome;
  });
  return record;
}

async function waitForCandidatePromise(record, promise, label) {
  const remainingMs = record.readinessDeadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`${label} readiness deadline expired`);
  }
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} readiness deadline expired`)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const waitForCandidateReadiness = (record, label) =>
  waitForCandidatePromise(record, record.readyPromise, label);

function ipcStdio(stdio) {
  if (Array.isArray(stdio)) {
    if (stdio.length > 3) {
      throw new Error("development app stdio already defines an IPC channel");
    }
    return [
      stdio[0] ?? "pipe",
      stdio[1] ?? "pipe",
      stdio[2] ?? "pipe",
      "ipc",
    ];
  }
  const entry = stdio ?? "pipe";
  return [entry, entry, entry, "ipc"];
}

function configureCandidateHandshake(
  record,
  { channel, generation, parseReady },
) {
  if (!record.child.channel) {
    const error = new Error("dev launch candidate requires an IPC readiness channel");
    record.groupWitnessPromise = Promise.reject(error);
    record.readyPromise = Promise.reject(error);
    record.groupWitnessPromise.catch(() => {});
    record.readyPromise.catch(() => {});
    return;
  }
  let resolveGroup;
  let rejectGroup;
  let resolveReady;
  let rejectReady;
  let groupReported = false;
  let readyReported = false;
  record.groupWitnessPromise = new Promise((resolve, reject) => {
    resolveGroup = resolve;
    rejectGroup = reject;
  });
  record.readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const cleanup = () => record.child.off("message", onMessage);
  const reject = (error) => {
    cleanup();
    rejectGroup(error);
    rejectReady(error);
  };
  const onMessage = (message) => {
    try {
      if (record.windowsJob && isWindowsJobCandidateMessage(message)) return;
      if (message?.type === "process_group_witness_ready") {
        if (groupReported || readyReported) {
          throw new Error("duplicate or late process group witness readiness");
        }
        const witness = parseProcessGroupWitnessReady(message, {
          schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
          channel,
          generation,
        });
        groupReported = true;
        resolveGroup(witness);
        return;
      }
      if (!groupReported) {
        throw new Error("candidate readiness preceded its process group witness");
      }
      const ready = parseReady(message);
      readyReported = true;
      cleanup();
      resolveReady(ready);
    } catch (error) {
      reject(error);
    }
  };
  record.child.on("message", onMessage);
  record.exitPromise.then((outcome) => {
    reject(
      new Error(
        outcome.signal
          ? `dev launch candidate exited from signal ${outcome.signal} before readiness`
          : `dev launch candidate exited with code ${outcome.code ?? 1} before readiness`,
      ),
    );
  });
  record.groupWitnessPromise.catch(() => {});
  record.readyPromise.catch(() => {});
}

async function bindRecordProcessGroup(record) {
  const windowsGroup = record.windowsJob
    ? await waitForCandidatePromise(record, record.windowsJob.authority, "Windows Job")
    : null;
  const { pid: witnessPid } = await waitForCandidatePromise(
    record,
    record.groupWitnessPromise,
    "dev launch process group witness",
  );
  const processGroup = windowsGroup ?? await bindProcessGroupAuthority({
    leader: record.launch,
    witnessPid,
    timeoutMs: CHILD_IDENTITY_TIMEOUT_MS,
    delay,
  });
  record.launch = { ...record.launch, processGroup };
}

function spawnAppCandidate(
  { command, args = [], spawnOptions = {} },
  channel,
) {
  if (spawnOptions.shell) {
    throw new Error(
      "development activation wrapper does not support shell execution",
    );
  }
  const generation = randomIdentity();
  const record = spawnLaunchRecord({
    command: process.execPath,
    args: [launchChildPath, JSON.stringify({ command, args })],
    spawnOptions: {
      ...spawnOptions,
      env: {
        ...(spawnOptions.env ?? process.env),
        DURE_APP_CHANNEL: channel,
        [DEV_LAUNCH_CHILD_GENERATION_ENV]: generation,
      },
      stdio: ipcStdio(spawnOptions.stdio),
    },
  });
  record.activationGeneration = generation;
  record.cleanupAuthority = candidateCleanupAuthority.activationLease;
  record.readinessDeadlineMs = Date.now() + DEFAULT_CONNECTION_TIMEOUT_MS;
  configureCandidateHandshake(record, {
    channel,
    generation,
    parseReady: (message) =>
      parseDevLaunchChildReady(message, { generation, channel }),
  });
  return record;
}

async function bindAppCandidateRecord(record, onIdentityBound) {
  await bindLaunchRecord(record);
  await bindRecordProcessGroup(record);
  await onIdentityBound?.(record.launch);
  await waitForCandidateReadiness(record, "development app candidate");
  if (
    await launchRuntimeState(record.launch, "app candidate") !== "active"
  ) {
    throw new Error("development app candidate changed identity after readiness");
  }
  return record;
}

async function activateLaunchCandidate(record, channel) {
  if (!record.child.channel) {
    throw new Error("development app candidate has no IPC activation channel");
  }
  const transition = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle(value);
    };
    const onMessage = (message) => {
      try {
        parseDevLaunchChildActivationFailure(message, {
          channel,
          generation: record.activationGeneration,
        });
        finish(
          reject,
          new Error("development app candidate activation failed"),
        );
      } catch (error) {
        finish(reject, error);
      }
    };
    const onDisconnect = () => {
      finish(resolve, { kind: "activated" });
    };
    const cleanup = () => {
      record.child.off("message", onMessage);
      record.child.off("disconnect", onDisconnect);
    };
    record.child.once("message", onMessage);
    record.child.once("disconnect", onDisconnect);
    record.exitPromise.then((outcome) => {
      setImmediate(() => finish(resolve, { kind: "exited", outcome }));
    });
  });
  transition.catch(() => {});
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        await new Promise((resolve, reject) => {
          try {
            record.child.send(
              {
                schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
                type: "launch_activate",
                channel,
                generation: record.activationGeneration,
              },
              (error) => (error ? reject(error) : resolve()),
            );
          } catch (error) {
            reject(error);
          }
        });
        return transition;
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "development app candidate activation acknowledgement timed out",
              ),
            ),
          CHILD_IDENTITY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function adoptLaunchRecord(launch) {
  return {
    child: { pid: launch.pid },
    detached: process.platform !== "win32",
    exited: false,
    exit: null,
    exitPromise: new Promise(() => {}),
    launch,
    restarting: false,
    adopted: true,
  };
}

async function bindLaunchRecord(
  record,
  {
    generation = record.activationGeneration ?? randomIdentity(),
  } = {},
) {
  const { child } = record;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    const error = await new Promise((resolve) => child.once("error", resolve));
    throw error;
  }
  const identity = await Promise.race([
    record.identityPromise,
    record.exitPromise.then(() => null),
  ]);
  if (!identity || record.exited) {
    throw new Error("could not bind the dev child to an exact process identity");
  }
  record.launch = {
    pid: child.pid,
    processIdentity: identity,
    generation,
  };
  return record;
}

function spawnFrontendRecord(frontendAuthority, channel) {
  const generation = randomIdentity();
  const spawnOptions = {
    ...frontendAuthority.spawnOptions,
    env: {
      ...(frontendAuthority.spawnOptions.env ?? process.env),
      [DEV_LAUNCH_FRONTEND_GENERATION_ENV]: generation,
    },
  };
  const record = spawnLaunchRecord({
    command: frontendAuthority.command,
    args: frontendAuthority.args,
    spawnOptions,
  });
  record.frontendGeneration = generation;
  record.cleanupAuthority = candidateCleanupAuthority.activationLease;
  record.readinessDeadlineMs = Date.now() + DEFAULT_CONNECTION_TIMEOUT_MS;
  configureCandidateHandshake(record, {
    channel,
    generation,
    parseReady: (message) => {
      if (message?.type === "frontend_unavailable") {
        parseDevLaunchFrontendUnavailable(message, { generation, channel });
        const error = new Error(
          "dev launch frontend could not claim its strict port",
        );
        error.code = "DEV_FRONTEND_PORT_CONFLICT";
        throw error;
      }
      return parseDevLaunchFrontendReady(message, { generation, channel });
    },
  });
  return record;
}

async function bindFrontendRecord(record, onIdentityBound) {
  try {
    await bindLaunchRecord(record, {
      generation: record.frontendGeneration,
    });
    await bindRecordProcessGroup(record);
  } catch (error) {
    // An exited candidate has settled its handshake. Preserve its typed
    // refusal; the caller still proves exact cleanup before convergence.
    if (record.exited) await record.readyPromise;
    throw error;
  }
  await onIdentityBound?.(record.launch);
  await waitForCandidateReadiness(record, "dev launch frontend");
  if (
    await launchRuntimeState(record.launch, "frontend candidate") !== "active"
  ) {
    throw new Error("dev launch frontend changed identity after readiness");
  }
  return record;
}

async function activateFrontendRecord(record, channel) {
  const frame = {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    type: "frontend_activate",
    channel,
    generation: record.frontendGeneration,
  };
  const acknowledgement = new Promise((resolve, reject) => {
    const cleanup = () => {
      record.child.off("message", onMessage);
      record.child.off("disconnect", onDisconnect);
    };
    const onMessage = (message) => {
      try {
        const parsed =
          parseDevLaunchFrontendActivation(message, {
            type: "frontend_activated",
            channel,
            generation: record.frontendGeneration,
          });
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("dev launch frontend disconnected before activation"));
    };
    record.child.once("message", onMessage);
    record.child.once("disconnect", onDisconnect);
    record.exitPromise.then((outcome) => {
      cleanup();
      reject(
        new Error(
          outcome.signal
            ? `dev launch frontend exited from signal ${outcome.signal} before activation`
            : `dev launch frontend exited with code ${outcome.code ?? 1} before activation`,
        ),
      );
    });
  });
  acknowledgement.catch(() => {});
  let timeout;
  try {
    await Promise.race([
      (async () => {
        await new Promise((resolve, reject) => {
          try {
            record.child.send(frame, (error) =>
              error ? reject(error) : resolve(),
            );
          } catch (error) {
            reject(error);
          }
        });
        await acknowledgement;
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "dev launch frontend activation acknowledgement timed out",
              ),
            ),
          FRONTEND_ACTIVATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function preflightDevLaunchParentResume({
  home = homedir(),
  worktreeRoot,
  channel,
  sourceGeneration,
  handoff,
}) {
  parseDevLaunchGeneration(sourceGeneration, "preflight source generation");
  const proposal = exactParentHandoff(handoff, { channel, worktreeRoot });
  const descriptor = readDescriptor({ home, channel, worktreeRoot }).value;
  const candidateProcessIdentity = descriptor.state === "preparing"
    ? await readProcessIdentity(process.pid)
    : null;
  const ownsCurrentPreflightCandidate =
    descriptor.state === "preparing" &&
    sameDevLaunchGeneration(descriptor.candidateLaunch, {
      pid: process.pid,
      processIdentity: candidateProcessIdentity,
      generation: process.env[DEV_LAUNCH_CHILD_GENERATION_ENV],
    });
  if (
    proposal.phase !== "exec_pending" ||
    proposal.targetSourceGeneration !== sourceGeneration ||
    proposal.targetSupervisorGeneration === descriptor.supervisor.generation ||
    descriptor.protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION ||
    (descriptor.state !== "ready" && !ownsCurrentPreflightCandidate) ||
    !descriptor.capabilities.includes(PARENT_RELOAD_CAPABILITY) ||
    !sameDevLaunchIdentity(proposal.previousSupervisor, descriptor.supervisor) ||
    !sameDevLaunchIdentity(proposal.previousLaunch, descriptor.launch) ||
    !sameOptionalDevLaunchIdentity(
      proposal.previousFrontend,
      descriptor.frontend,
    ) ||
    (proposal.previousFrontend !== undefined &&
      !descriptor.capabilities.includes(
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      )) ||
    proposal.capability !== redactDevLaunchCapability(descriptor.capability) ||
    await observeProcessLiveness(descriptor.supervisor) !== "active"
  ) {
    throw new Error(
      "target parent cannot resume the exact active supervisor handoff",
    );
  }
  return proposal;
}

export async function superviseDevLaunch({
  home = homedir(),
  worktreeRoot,
  channel,
  command,
  args = [],
  spawnOptions = {},
  frontend,
  prepareInitialLaunch,
  prepareLaunch,
  sourceGeneration,
  hmuxProviderIdentity,
  parentHandoff,
  preflightParent,
  reloadParent,
  restartSettlementTimeoutMs = DEFAULT_RESTART_SETTLEMENT_TIMEOUT_MS,
}) {
  await requireDevLaunchAdmission();
  const controlDirectory = appControlDirectory(home, channel);
  assertOwnerOnlyDirectory(controlDirectory, { create: true });
  const descriptorPathname = descriptorPath(home, channel);
  const frontendAuthority = normalizeFrontendAuthority(frontend);
  if (sourceGeneration !== undefined) {
    parseDevLaunchGeneration(sourceGeneration, "source generation");
  }
  const startupHmuxIdentity =
    parseDevLaunchHmuxProviderIdentity(hmuxProviderIdentity);
  if (
    !Number.isSafeInteger(restartSettlementTimeoutMs) ||
    restartSettlementTimeoutMs < 1
  ) {
    throw new Error(
      "dev launch restart settlement timeout must be a positive integer",
    );
  }
  const inheritedHandoff =
    parentHandoff === undefined
      ? undefined
      : exactParentHandoff(parentHandoff, { channel, worktreeRoot });
  if (
    !frontendAuthority &&
    inheritedHandoff?.previousFrontend &&
    hasOwnedCleanupObligation(
      await launchRuntimeState(
        inheritedHandoff.previousFrontend,
        "inherited frontend",
      ),
    )
  ) {
    throw new Error(
      "dev launch parent handoff retains a live frontend without a compatible readiness authority",
    );
  }
  const capability = randomIdentity();
  const supervisorIdentity = await readProcessIdentity(process.pid);
  if (!supervisorIdentity) {
    throw new Error("could not bind dev launcher supervisor process identity");
  }
  const supervisor = {
    pid: process.pid,
    processIdentity: supervisorIdentity,
    generation:
      inheritedHandoff?.targetSupervisorGeneration ?? randomIdentity(),
  };
  let inheritedDescriptorSnapshot;
  if (inheritedHandoff) {
    inheritedDescriptorSnapshot = readDescriptor({
      home,
      channel,
      worktreeRoot,
    });
    const predecessor = inheritedDescriptorSnapshot.value;
    if (
      predecessor.state !== "handoff" ||
      predecessor.handoff.phase !== "exec_pending" ||
      predecessor.handoff.requestId !== inheritedHandoff.requestId ||
      predecessor.handoff.capability !== inheritedHandoff.capability ||
      predecessor.handoff.targetSupervisorGeneration !==
        supervisor.generation ||
      predecessor.handoff.targetSourceGeneration !== sourceGeneration ||
      !sameDevLaunchIdentity(
        predecessor.handoff.previousSupervisor,
        inheritedHandoff.previousSupervisor,
      ) ||
      !sameDevLaunchIdentity(
        predecessor.handoff.previousLaunch,
        inheritedHandoff.previousLaunch,
      ) ||
      !sameOptionalDevLaunchIdentity(
        predecessor.handoff.previousFrontend,
        inheritedHandoff.previousFrontend,
      ) ||
      !sameOptionalDevLaunchIdentity(
        predecessor.frontend,
        inheritedHandoff.previousFrontend,
      ) ||
      predecessor.supervisor.pid !== process.pid ||
      predecessor.supervisor.processIdentity !== supervisorIdentity
    ) {
      throw new Error(
        "dev launch parent handoff does not match the committed predecessor",
      );
    }
    if (await probeSocket(predecessor.socketPath)) {
      throw new Error("dev launch predecessor endpoint is still active");
    }
    unlinkExactSocket(predecessor.socketPath);
  }
  const socketPath = socketPathFor(
    worktreeRoot,
    channel,
    supervisor.generation,
  );
  if (safeLstat(socketPath)) {
    throw new Error(`dev launch supervisor socket already exists: ${socketPath}`);
  }
  const baseCapabilities = [
    "child_restart",
    ...(frontendAuthority
      ? [DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY]
      : []),
    ...(sourceGeneration &&
    typeof preflightParent === "function" &&
    typeof reloadParent === "function"
      ? [PARENT_RELOAD_CAPABILITY]
      : []),
  ];
  const descriptorCapabilities = (descriptor) => {
    const identities = descriptorOwnedLaunchIdentities(descriptor);
    return [
      ...baseCapabilities,
      ...(identities.length > 0 &&
      identities.every((identity) => identity.processGroup)
        ? [DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY]
        : []),
    ];
  };
  const inheritedActivation = inheritedHandoff
    ? {
        type: "parent_reload",
        requestId: inheritedHandoff.requestId,
        previousSupervisor: inheritedHandoff.previousSupervisor,
        previousLaunch: inheritedHandoff.previousLaunch,
        ...(inheritedHandoff.previousFrontend
          ? { previousFrontend: inheritedHandoff.previousFrontend }
          : {}),
        sourceGeneration: inheritedHandoff.targetSourceGeneration,
      }
    : undefined;
  const descriptorValue = ({
    state,
    launch,
    candidateLaunch,
    candidateFrontend,
    frontend,
    handoff,
    activation,
    socketPath: descriptorSocketPath = socketPath,
  }) => {
    const descriptor = {
      schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      state,
      worktreeRoot,
      channel,
      socketPath: descriptorSocketPath,
      capability,
      supervisor,
      launch,
      ...(candidateLaunch ? { candidateLaunch } : {}),
      ...(candidateFrontend ? { candidateFrontend } : {}),
      ...(frontendAuthority ? { frontend } : {}),
      ...(handoff ? { handoff } : {}),
      ...(sourceGeneration ? { sourceGeneration } : {}),
      ...(activation ? { activation } : {}),
      publishedAtMs: Date.now(),
    };
    return descriptor;
  };
  const lifecycleAuthorityBrand = Symbol("devLaunchLifecycleAuthority");
  let lifecycleEpoch = 0;
  let activeTransition = null;
  let stopping = false;
  let stopAuthority = null;
  let startupActive = true;
  const lifecycleAuthority = (kind, source = {}) =>
    Object.freeze({
      [lifecycleAuthorityBrand]: true,
      epoch: lifecycleEpoch,
      kind,
      ...source,
    });
  const startupAuthority = lifecycleAuthority("startup");
  const lifecycleAuthorityIsCurrent = (authority) => {
    if (
      authority?.[lifecycleAuthorityBrand] !== true ||
      authority.epoch !== lifecycleEpoch
    ) {
      return false;
    }
    if (authority.kind === "startup") {
      return startupActive && !stopping;
    }
    if (authority.kind === "transition") {
      return activeTransition?.authority === authority && !stopping;
    }
    if (authority.kind === "stop") {
      return stopAuthority === authority && stopping;
    }
    return (
      authority.kind === "observation" &&
      !stopping &&
      !activeTransition &&
      published === authority.published &&
      current === authority.current &&
      frontendRecord === authority.frontendRecord &&
      candidate === authority.candidate &&
      frontendCandidate === authority.frontendCandidate
    );
  };
  const requireLifecycleAuthority = (authority) => {
    if (!lifecycleAuthorityIsCurrent(authority)) {
      const error = new Error("dev launch lifecycle authority is stale");
      error.code = "DEV_LAUNCH_STALE_LIFECYCLE";
      throw error;
    }
  };
  let published;
  const requireCanonicalDescriptorAuthority = ({ expectedSnapshot, claim }) => {
    const canonical = readDescriptor({ home, channel, worktreeRoot });
    if (expectedSnapshot) {
      const claimStat = claim ? safeLstat(claim.pathname) : null;
      if (
        canonical.source !== expectedSnapshot.source ||
        !sameFile(canonical.stat, expectedSnapshot.stat) ||
        (claim &&
          (!claimStat ||
            !sameFile(claimStat, claim.stat) ||
            !sameFile(claimStat, expectedSnapshot.stat) ||
            readFileSync(claim.pathname, "utf8") !== expectedSnapshot.source))
      ) {
        throw new Error(
          "dev launch supervisor lost canonical descriptor authority",
        );
      }
      return;
    }
    if (!sameDevLaunchIdentity(canonical.value.supervisor, supervisor)) {
      throw new Error(
        "dev launch supervisor lost canonical descriptor authority",
      );
    }
  };
  const commitDescriptor = (
    next,
    {
      authority,
      create = false,
      expectedSnapshot,
      claim,
      publishedRecords = [],
    } = {},
  ) => {
    requireLifecycleAuthority(authority);
    const normalized = {
      ...next,
      capabilities: descriptorCapabilities(next),
    };
    exactDescriptor(normalized, { channel, worktreeRoot });
    if (create) {
      createDescriptor(descriptorPathname, normalized);
    } else {
      requireCanonicalDescriptorAuthority({ expectedSnapshot, claim });
      writeDescriptor(descriptorPathname, normalized);
    }
    const identities = descriptorOwnedLaunchIdentities(normalized);
    for (const record of publishedRecords) {
      if (
        record?.launch &&
        identities.some((identity) =>
          sameDevLaunchIdentity(record.launch, identity),
        )
      ) {
        record.cleanupAuthority = candidateCleanupAuthority.publishedIdentity;
      }
    }
    published = normalized;
    return normalized;
  };
  const publishRecoveryClaimant = (
    {
      launch,
      candidateLaunch,
      candidateFrontend,
      frontend: claimedFrontend,
      socketPath: claimedSocketPath,
    },
    { claim, snapshot },
  ) => {
    const next = descriptorValue({
      state: "preparing",
      launch,
      candidateLaunch,
      candidateFrontend,
      frontend: claimedFrontend,
      socketPath: claimedSocketPath,
    });
    commitDescriptor(next, {
      authority: startupAuthority,
      claim,
      expectedSnapshot: snapshot,
    });
  };
  const recovered = inheritedHandoff
    ? null
    : await reclaimStaleDescriptor({
        home,
        channel,
        worktreeRoot,
        frontendAuthority,
        publishClaimant: publishRecoveryClaimant,
      });
  let current = recovered?.launch
    ? adoptLaunchRecord(recovered.launch)
    : null;
  let frontendRecord = inheritedHandoff?.previousFrontend
    ? adoptLaunchRecord(inheritedHandoff.previousFrontend)
    : recovered?.frontend
      ? adoptLaunchRecord(recovered.frontend)
      : null;
  let candidate = null;
  let frontendCandidate = null;
  const preparingDescriptor = () => descriptorValue({
    state: "preparing",
    launch: current?.launch ?? null,
    frontend: frontendRecord?.launch ?? null,
    activation: inheritedActivation,
  });
  if (inheritedHandoff) {
    commitDescriptor(preparingDescriptor(), {
      authority: startupAuthority,
      expectedSnapshot: inheritedDescriptorSnapshot,
    });
  } else if (recovered) {
    try {
      commitDescriptor(preparingDescriptor(), { authority: startupAuthority });
    } finally {
      releaseDescriptorClaim(recovered.claim);
    }
  } else {
    try {
      commitDescriptor(preparingDescriptor(), {
        authority: startupAuthority,
        create: true,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const contended = await reclaimStaleDescriptor({
        home,
        channel,
        worktreeRoot,
        frontendAuthority,
        publishClaimant: publishRecoveryClaimant,
        adoptLive: false,
      });
      if (!contended) {
        throw new Error(
          "dev launch supervisor authority changed after descriptor contention",
        );
      }
      try {
        commitDescriptor(preparingDescriptor(), {
          authority: startupAuthority,
        });
      } finally {
        releaseDescriptorClaim(contended.claim);
      }
    }
  }
  const beginTransition = (kind, operation) => {
    if (activeTransition) {
      throw new Error("dev launch lifecycle transition is already active");
    }
    lifecycleEpoch += 1;
    startupActive = false;
    const authority = lifecycleAuthority("transition", { transition: kind });
    const transition = { authority, transaction: null };
    activeTransition = transition;
    const transaction = Promise.resolve().then(() => operation(authority));
    transition.transaction = transaction;
    const clear = () => {
      if (activeTransition === transition) activeTransition = null;
    };
    transaction.then(clear, clear);
    return transaction;
  };
  const observeLifecycle = (kind) => {
    if (stopping || activeTransition) {
      throw new Error("dev launch lifecycle is transitioning");
    }
    return lifecycleAuthority("observation", {
      observation: kind,
      published,
      current,
      frontendRecord,
      candidate,
      frontendCandidate,
    });
  };
  const enterStopping = () => {
    if (stopAuthority) return stopAuthority;
    lifecycleEpoch += 1;
    startupActive = false;
    stopping = true;
    stopAuthority = lifecycleAuthority("stop");
    return stopAuthority;
  };
  const restartTransactions = new Map();
  const rememberRestartTransaction = (requestId, response) => {
    let transaction = restartTransactions.get(requestId);
    if (!transaction) {
      while (restartTransactions.size >= MAX_RESTART_TRANSACTIONS) {
        const evictedRequestId = restartTransactions.keys().next().value;
        const evicted = restartTransactions.get(evictedRequestId);
        restartTransactions.delete(evictedRequestId);
        evicted?.finishObservation?.();
      }
      transaction = { response, finishObservation: null };
      restartTransactions.set(requestId, transaction);
    } else {
      transaction.response = response;
    }
    return transaction;
  };
  const pendingRestart = (
    requestId,
    previousLaunch,
    previousFrontend,
    phase,
  ) => ({
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    type: "restart_pending",
    requestId,
    worktreeRoot,
    channel,
    supervisor,
    previousLaunch,
    ...(previousFrontend ? { previousFrontend } : {}),
    phase,
  });
  const waitForTerminalObservation = (requestId) =>
    new Promise((resolve) => {
      const transaction = restartTransactions.get(requestId);
      if (!transaction) {
        throw new Error("dev launch restart transaction was not retained");
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (transaction.finishObservation === finish) {
          transaction.finishObservation = null;
        }
        resolve();
      };
      const timer = setTimeout(finish, TERMINAL_RETENTION_GRACE_MS);
      transaction.finishObservation = finish;
    });
  const hasUnobservedTerminalRestart = () =>
    [...restartTransactions.values()].some(
      (transaction) => typeof transaction.finishObservation === "function",
    );
  let activated = false;
  let handoffCommitted = Boolean(inheritedHandoff);
  let retainPublishedRecordsOnExit = false;
  const descriptorRetainsRecord = (record) =>
    retainPublishedRecordsOnExit &&
    record?.launch &&
    [
      published.launch,
      published.candidateLaunch,
      published.frontend,
      published.candidateFrontend,
    ].some(
      (identity) =>
        identity && sameDevLaunchIdentity(record.launch, identity),
    );
  const retainRecordForRecovery = (record) => {
    if (!descriptorRetainsRecord(record)) return false;
    if (!record.adopted) {
      if (record.child.connected) record.child.disconnect();
      record.child.unref();
    }
    return true;
  };
  const pendingFailureDescriptor = () => {
    const pendingLaunch =
      candidate?.launch ??
      (!activated && current && !current.adopted
        ? current.launch
        : published.candidateLaunch);
    const pendingFrontend =
      frontendCandidate?.launch ?? published.candidateFrontend;
    return descriptorValue({
      state: "preparing",
      launch: null,
      candidateLaunch: pendingLaunch,
      candidateFrontend: pendingFrontend,
      frontend: frontendRecord?.launch ?? published.frontend ?? null,
      activation: published.activation,
    });
  };
  const publishInheritedFailure = (error, authority) => {
    if (!inheritedHandoff) return;
    handoffCommitted = true;
    const next = {
      ...pendingFailureDescriptor(),
      parentReloadFailure: {
        type: "parent_reload_failure",
        requestId: inheritedHandoff.requestId,
        targetSupervisorGeneration:
          inheritedHandoff.targetSupervisorGeneration,
        targetSourceGeneration: inheritedHandoff.targetSourceGeneration,
        destructiveBoundaryCrossed: true,
        reason: error.message,
        failedAtMs: Date.now(),
      },
      publishedAtMs: Date.now(),
    };
    commitDescriptor(next, {
      authority,
      publishedRecords: [candidate, current, frontendCandidate],
    });
  };
  const publishHmuxStartupFailure = (error, authority) => {
    if (
      !startupHmuxIdentity ||
      sourceGeneration === undefined ||
      inheritedHandoff
    ) {
      return;
    }
    const reason = String(error?.message ?? error)
      .replaceAll("\0", "�")
      .slice(0, 4_096) || "unknown startup failure";
    const next = {
      ...pendingFailureDescriptor(),
      startupFailure: {
        type: "startup_failure",
        hmux: startupHmuxIdentity,
        reason,
        failedAtMs: Date.now(),
      },
      publishedAtMs: Date.now(),
    };
    commitDescriptor(next, {
      authority,
      publishedRecords: [candidate, current, frontendCandidate],
    });
  };
  const stopController = new AbortController();
  let completionOutcome = null;
  let finish;
  const completion = new Promise((resolve) => {
    finish = (outcome) => {
      if (completionOutcome) return;
      completionOutcome = outcome;
      resolve(outcome);
    };
  });
  const ownedLaunchCancelled = Object.freeze({ kind: "cancelled" });
  const raceOwnedLaunchWithStop = (operation) => {
    const { signal } = stopController;
    return new Promise((resolve, reject) => {
      let aborted = false;
      let settled = false;
      const removeAbortListener = () => {
        signal.removeEventListener("abort", onAbort);
      };
      const claimOperationSettlement = () => {
        if (aborted || settled) return false;
        settled = true;
        removeAbortListener();
        return true;
      };
      const onAbort = () => {
        if (aborted || settled) return;
        aborted = true;
        removeAbortListener();
        resolve(ownedLaunchCancelled);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(operation).then(
        (value) => {
          if (claimOperationSettlement()) {
            resolve({ kind: "completed", value });
          }
        },
        (error) => {
          if (claimOperationSettlement()) reject(error);
        },
      );
    });
  };
  const bindOwnedAppCandidate = (record, onIdentityBound) =>
    raceOwnedLaunchWithStop(bindAppCandidateRecord(record, onIdentityBound));
  const activateOwnedAppCandidate = (record) =>
    raceOwnedLaunchWithStop(activateLaunchCandidate(record, channel));
  const publishAppCandidate = (record, previousLaunch, authority) => {
    const next = descriptorValue({
      state: "preparing",
      launch: previousLaunch,
      candidateLaunch: record.launch,
      frontend: frontendRecord?.launch ?? null,
      activation: published.activation,
    });
    commitDescriptor(next, { authority, publishedRecords: [record] });
  };
  const publishRuntimeSnapshot = async ({
    authority,
    candidateFrontend,
    frontendReady = true,
  } = {}) => {
    const next = descriptorValue({
      state:
        activated && frontendReady && current && !await launchRetired(current)
          ? "ready"
          : "preparing",
      launch: current?.launch ?? null,
      candidateFrontend,
      frontend: frontendRecord?.launch ?? null,
      activation: published.activation,
    });
    commitDescriptor(next, {
      authority,
      publishedRecords: [frontendCandidate],
    });
  };
  const runOwnedPreparation = async (prerequisite, authority) => {
    if (
      prerequisite.timeoutMs !== undefined &&
      (!Number.isSafeInteger(prerequisite.timeoutMs) ||
        prerequisite.timeoutMs < 1)
    ) {
      throw new Error("dev launch prerequisite timeout is invalid");
    }
    const record = spawnAppCandidate(prerequisite, channel);
    candidate = record;
    let candidatePublished = false;
    let failure;
    let outcome = null;
    let cancelled = false;
    let timeout;
    try {
      const binding = await bindOwnedAppCandidate(record, () => {
        publishAppCandidate(
          record,
          current?.launch ?? null,
          authority,
        );
        candidatePublished = true;
      });
      if (binding.kind === "cancelled") {
        cancelled = true;
      } else {
        requireLifecycleAuthority(authority);
        const execution = (async () => {
          const activation = await activateOwnedAppCandidate(record);
          if (activation.kind === "cancelled") return ownedLaunchCancelled;
          if (activation.value.kind === "exited") {
            return { kind: "completed", value: activation.value.outcome };
          }
          return raceOwnedLaunchWithStop(record.exitPromise);
        })();
        const executionResult = prerequisite.timeoutMs === undefined
          ? await execution
          : await Promise.race([
              execution,
              new Promise((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error("dev launch prerequisite timed out")),
                  prerequisite.timeoutMs,
                );
              }),
            ]);
        if (executionResult.kind === "cancelled") cancelled = true;
        else outcome = executionResult.value;
      }
    } catch (error) {
      if (stopping) cancelled = true;
      else failure = error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    try {
      await retireOwnedLaunch(record);
      if (!await launchRetired(record)) {
        throw new Error(
          "dev launch prerequisite left its process group alive",
        );
      }
    } catch (cleanupError) {
      if (failure) {
        throw new Error(
          `${failure.message}; prerequisite cleanup failed: ${cleanupError.message}`,
          { cause: cleanupError },
        );
      }
      throw cleanupError;
    }
    if (!stopping && candidate === record) {
      candidate = null;
      try {
        if (candidatePublished) {
          await publishRuntimeSnapshot({ authority });
        }
      } catch (publicationError) {
        candidate = record;
        if (failure) {
          throw new Error(
            `${failure.message}; prerequisite retirement publication failed: ${publicationError.message}`,
            { cause: publicationError },
          );
        }
        throw publicationError;
      }
    }
    if (failure) throw failure;
    if (cancelled || stopping) return ownedLaunchCancelled;
    if (outcome.signal || outcome.code !== 0) {
      throw new Error(
        outcome.signal
          ? `dev launch prerequisite exited from signal ${outcome.signal}`
          : `dev launch prerequisite exited with code ${outcome.code ?? 1}`,
      );
    }
    return { kind: "completed" };
  };

  const publishPreparingProjection = ({
    authority,
    launch = current?.launch ?? null,
    frontend = frontendRecord?.launch ?? null,
  } = {}) => {
    const next = {
      ...descriptorValue({
        state: "preparing",
        launch,
        candidateLaunch: candidate?.launch,
        candidateFrontend: frontendCandidate?.launch,
        frontend,
        activation: published.activation,
      }),
      ...(published.parentReloadFailure
        ? { parentReloadFailure: published.parentReloadFailure }
        : {}),
    };
    commitDescriptor(next, {
      authority,
      publishedRecords: [candidate, frontendCandidate],
    });
  };
  const projectPreparingFailure = (error, authority) => {
    try {
      publishPreparingProjection({ authority });
      return error;
    } catch (publicationError) {
      return new Error(
        `${error.message}; preparing projection failed: ${publicationError.message}`,
      );
    }
  };
  const finishFromLaunchExit = (record, outcome, authority) => {
    try {
      publishPreparingProjection({ authority, launch: record.launch });
      finish(outcome);
    } catch (error) {
      finish({ code: 1, signal: null, error });
    }
  };
  const projectFrontendFailure = (record, authority) => {
    if (
      frontendRecord !== record ||
      record.restarting ||
      stopping ||
      activeTransition ||
      published.state !== "ready"
    ) {
      return;
    }
    publishPreparingProjection({ authority });
  };
  const watchFrontendExit = (record) => {
    if (record.adopted) return;
    record.exitPromise.then(async () => {
      try {
        while (
          !stopping &&
          frontendRecord === record &&
          !record.restarting
        ) {
          const transition = activeTransition;
          if (transition) {
            await transition.transaction.catch(() => {});
            continue;
          }
          if (published.state !== "ready") return;
          const authority = observeLifecycle("frontend_exit");
          projectFrontendFailure(record, authority);
          return;
        }
      } catch (error) {
        if (error?.code === "DEV_LAUNCH_STALE_LIFECYCLE") return;
        enterStopping();
        finish({ code: 1, signal: null, error });
      }
    });
  };
  const monitorAdoptedFrontendExit = (record) => {
    if (!record?.adopted) return;
    const monitor = async () => {
      while (!stopping && frontendRecord === record) {
        await delay(250);
        if (stopping || frontendRecord !== record || record.restarting) return;
        const transition = activeTransition;
        if (transition) {
          await transition.transaction.catch(() => {});
          continue;
        }
        if (published.state !== "ready") return;
        const authority = observeLifecycle("adopted_frontend_exit");
        const liveness = await observeAdoptedRuntime(record, "frontend");
        if (!lifecycleAuthorityIsCurrent(authority)) continue;
        if (liveness === "active" || liveness === "unknown") continue;
        projectFrontendFailure(record, authority);
        return;
      }
    };
    monitor().catch((error) => {
      if (
        !stopping &&
        !activeTransition &&
        frontendRecord === record &&
        published.state === "ready"
      ) {
        const authority = observeLifecycle("adopted_frontend_monitor_failure");
        finish({
          code: 1,
          signal: null,
          error: projectPreparingFailure(error, authority),
        });
      }
    });
  };
  const monitorAdoptedLaunch = (record) => {
    if (!record?.adopted) return;
    const monitor = async () => {
      while (!stopping && current === record) {
        await delay(250);
        if (stopping || current !== record || record.restarting) return;
        if (activeTransition) continue;
        const authority = observeLifecycle("adopted_launch_exit");
        const liveness = await observeAdoptedRuntime(record, "launch");
        if (liveness === "active" || liveness === "unknown") continue;
        if (!lifecycleAuthorityIsCurrent(authority)) continue;
        try {
          publishPreparingProjection({
            authority,
            launch: record.launch,
          });
          finish({ code: 1, signal: null });
        } catch (error) {
          finish({ code: 1, signal: null, error });
        }
        return;
      }
    };
    monitor().catch((error) => {
      if (!stopping && !activeTransition && current === record) {
        const authority = observeLifecycle("adopted_launch_monitor_failure");
        finish({
          code: 1,
          signal: null,
          error: projectPreparingFailure(error, authority),
        });
      }
    });
  };
  const requireAdmittedFrontendReady = async (label, authority) => {
    requireLifecycleAuthority(authority);
    if (!frontendAuthority) return;
    const admitted = frontendRecord;
    const ready = admitted &&
      await frontendReady(frontendAuthority, admitted.launch);
    requireLifecycleAuthority(authority);
    if (!ready || frontendRecord !== admitted) {
      throw new Error(`dev launch ${label} lost its admitted frontend generation`);
    }
  };
  const requireLaunchActive = async (record, label, authority) => {
    requireLifecycleAuthority(authority);
    const launch = record?.launch;
    const runtimeState = launch
      ? await launchRuntimeState(launch, label)
      : "stale";
    requireLifecycleAuthority(authority);
    if (
      !record ||
      record.exited ||
      record.launch !== launch ||
      runtimeState !== "active"
    ) {
      throw new Error(`dev launch ${label} exited before authority commit`);
    }
  };
  const ensureFrontendReady = async (authority) => {
    requireLifecycleAuthority(authority);
    if (!frontendAuthority) return;
    const previous = frontendRecord;
    if (previous) {
      const previousReusable = previous.launch.processGroup
        ? await frontendReusable(frontendAuthority, previous.launch)
        : false;
      requireLifecycleAuthority(authority);
      if (previousReusable) return;
    }
    const bindCandidate = async (record) => {
      frontendCandidate = record;
      let candidatePublished = false;
      try {
        const binding = await raceOwnedLaunchWithStop(
          bindFrontendRecord(record, async () => {
            await publishRuntimeSnapshot({
              authority,
              candidateFrontend: record.launch,
              frontendReady: false,
            });
            candidatePublished = true;
          }),
        );
        if (binding.kind === "cancelled") return ownedLaunchCancelled;
        requireLifecycleAuthority(authority);
        return { kind: "completed" };
      } catch (error) {
        if (stopping) return ownedLaunchCancelled;
        let retired = false;
        try {
          if (error.code === "DEV_FRONTEND_PORT_CONFLICT") {
            await waitForLaunchRetirement(
              record,
              CHILD_IDENTITY_TIMEOUT_MS,
            );
          }
          await retireOwnedLaunch(record);
          retired = true;
        } catch (cleanupError) {
          let failure = new Error(
            `dev launch frontend failed before readiness: ${error.message}; cleanup failed: ${cleanupError.message}`,
          );
          if (
            !candidatePublished &&
            record.launch &&
            record.cleanupAuthority === candidateCleanupAuthority.activationLease
          ) {
            try {
              await publishRuntimeSnapshot({
                authority,
                candidateFrontend: record.launch,
                frontendReady: false,
              });
              candidatePublished = true;
            } catch (publicationError) {
              failure = new Error(
                `${failure.message}; cleanup obligation publication failed: ${publicationError.message}`,
              );
            }
          }
          failure.cleanupUnproven = true;
          failure.mustStop = true;
          throw failure;
        }
        if (retired) {
          if (frontendCandidate === record) frontendCandidate = null;
          if (candidatePublished) {
            await publishRuntimeSnapshot({
              authority,
              frontendReady: false,
            });
          }
        }
        throw error;
      }
    };
    let replacement = spawnFrontendRecord(frontendAuthority, channel);
    try {
      const binding = await bindCandidate(replacement);
      if (binding.kind === "cancelled") return ownedLaunchCancelled;
      requireLifecycleAuthority(authority);
    } catch (error) {
      if (error.cleanupUnproven) throw error;
      const previousIsActive =
        previous &&
        frontendRecord === previous &&
        !previous.exited &&
        !previous.restarting &&
        await launchRuntimeState(previous.launch, "frontend") === "active";
      requireLifecycleAuthority(authority);
      if (error.code !== "DEV_FRONTEND_PORT_CONFLICT") {
        if (previousIsActive) {
          await publishRuntimeSnapshot({ authority });
        }
        throw new Error(
          `dev launch frontend failed before readiness: ${error.message}`,
        );
      }
      if (!previous || !previousIsActive) {
        throw new Error(
          `dev launch frontend failed before readiness: ${error.message}`,
        );
      }
      if (await frontendReusable(frontendAuthority, previous.launch)) {
        requireLifecycleAuthority(authority);
        await publishRuntimeSnapshot({ authority });
        return;
      }
      requireLifecycleAuthority(authority);
      try {
        await retireOwnedLaunch(previous);
      } catch (cleanupError) {
        throw new Error(
          `dev launch frontend port convergence could not retire its exact predecessor: ${cleanupError.message}`,
        );
      }
      requireLifecycleAuthority(authority);
      await publishRuntimeSnapshot({ authority, frontendReady: false });
      replacement = spawnFrontendRecord(frontendAuthority, channel);
      try {
        const binding = await bindCandidate(replacement);
        if (binding.kind === "cancelled") return ownedLaunchCancelled;
        requireLifecycleAuthority(authority);
      } catch (convergenceError) {
        const failure = new Error(
          `dev launch frontend failed after exact port-owner convergence: ${convergenceError.message}`,
        );
        failure.cleanupUnproven = convergenceError.cleanupUnproven;
        failure.mustStop = convergenceError.mustStop;
        throw failure;
      }
    }

    if (
      previous &&
      frontendRecord === previous &&
      !await launchRetired(previous)
    ) {
      requireLifecycleAuthority(authority);
      try {
        await retireOwnedLaunch(previous);
        requireLifecycleAuthority(authority);
      } catch (error) {
        try {
          await retireOwnedLaunch(replacement);
          frontendCandidate = null;
          await publishRuntimeSnapshot({ authority, frontendReady: false });
        } catch (cleanupError) {
          const failure = new Error(
            `dev launch frontend replacement could not retire its predecessor: ${error.message}; replacement cleanup failed: ${cleanupError.message}`,
          );
          failure.cleanupUnproven = true;
          failure.mustStop = true;
          throw failure;
        }
        throw new Error(
          `dev launch frontend replacement could not retire its predecessor: ${error.message}`,
        );
      }
    }
    let candidatePublished = false;
    const admittedFrontend = frontendRecord;
    try {
      await publishRuntimeSnapshot({
        authority,
        candidateFrontend: replacement.launch,
        frontendReady: false,
      });
      candidatePublished = true;
      const activation = await raceOwnedLaunchWithStop(
        activateFrontendRecord(replacement, channel),
      );
      if (activation.kind === "cancelled") return ownedLaunchCancelled;
      requireLifecycleAuthority(authority);
      const replacementReady = await frontendReady(
        frontendAuthority,
        replacement.launch,
      );
      requireLifecycleAuthority(authority);
      if (!replacementReady) {
        throw new Error(
          "dev launch frontend lost exact readiness during activation",
        );
      }
      frontendRecord = replacement;
      await publishRuntimeSnapshot({ authority });
    } catch (error) {
      if (stopping) return ownedLaunchCancelled;
      let failure = error;
      let replacementRetired = false;
      frontendRecord = admittedFrontend;
      try {
        await retireOwnedLaunch(replacement);
        replacementRetired = true;
      } catch (cleanupError) {
        failure = new Error(
          `${error.message}; cleanup failed: ${cleanupError.message}`,
        );
        failure.cleanupUnproven = true;
        failure.mustStop = true;
      }
      if (replacementRetired) {
        if (frontendCandidate === replacement) frontendCandidate = null;
      }
      if (candidatePublished && replacementRetired) {
        try {
          await publishRuntimeSnapshot({
            authority,
            frontendReady: false,
          });
        } catch (publicationError) {
          failure = new Error(
            `${failure.message}; failure publication failed: ${publicationError.message}`,
          );
        }
      }
      const activationFailure = new Error(
        `dev launch frontend failed before activation: ${failure.message}`,
      );
      activationFailure.cleanupUnproven = failure.cleanupUnproven;
      activationFailure.mustStop = failure.mustStop;
      throw activationFailure;
    }
    frontendCandidate = null;
    watchFrontendExit(replacement);
    return { kind: "completed" };
  };

  let retirementFailure = null;
  const controlConnections = new Set();
  const server = createServer((connection) => {
    controlConnections.add(connection);
    connection.once("close", () => controlConnections.delete(connection));
    let body = "";
    connection.on("error", () => connection.destroy());
    connection.setEncoding("utf8");
    connection.on("data", async (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_FRAME_BYTES) {
        connection.removeAllListeners("data");
        sendFrame(connection, {
          schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          type: "restart_rejected",
          reason: "dev launch restart request is too large",
        });
        return;
      }
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      connection.removeAllListeners("data");
      let request;
      let parentReloadRequest = false;
      let parentGenerationProbe = false;
      try {
        request = JSON.parse(body.slice(0, newline));
        parentGenerationProbe = request.type === "parent_generation_probe";
        if (parentGenerationProbe) {
          if (
            !activated ||
            stopping ||
            activeTransition ||
            candidate ||
            frontendCandidate
          ) {
            throw new Error("dev launch supervisor generation is transitioning");
          }
          const authority = observeLifecycle("parent_generation_probe");
          const observed = authority.published;
          validateParentGenerationProbeRequest(request, observed);
          let generationReady;
          try {
            generationReady =
              await launchRuntimeState(observed.launch, "launch") ===
                "active" &&
              (!frontendAuthority ||
                await frontendReady(frontendAuthority, observed.frontend));
          } catch (error) {
            if (!lifecycleAuthorityIsCurrent(authority)) {
              throw new Error(
                "dev launch supervisor generation changed during proof",
              );
            }
            throw error;
          }
          if (!lifecycleAuthorityIsCurrent(authority)) {
            throw new Error(
              "dev launch supervisor generation changed during proof",
            );
          }
          if (!generationReady) {
            throw new Error(
              "dev launch supervisor generation is no longer ready",
            );
          }
          sendFrame(connection, parentGenerationFrame(observed));
          return;
        }
        if (
          request.type === "restart_status" ||
          request.type === "restart_ack"
        ) {
          validateRestartTransactionRequest(request, published);
          const transaction = restartTransactions.get(request.requestId);
          if (!transaction) {
            throw new Error("dev launch restart transaction is unavailable");
          }
          if (request.type === "restart_ack") {
            if (
              transaction.response.type !== "restart_receipt" &&
              transaction.response.type !== "restart_rejected"
            ) {
              throw new Error("dev launch restart transaction is not terminal");
            }
            transaction.finishObservation?.();
            sendFrame(connection, {
              schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
              protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
              type: "restart_acknowledged",
              requestId: request.requestId,
              worktreeRoot,
              channel,
              supervisor,
            });
            return;
          }
          sendFrame(connection, transaction.response);
          return;
        }
        parentReloadRequest = request.type === "parent_reload";
        if (parentReloadRequest) {
          validateParentReloadRequest(request, published, {
            sourceGeneration,
            preflightParent,
            reloadParent,
          });
        } else {
          validateRestartRequestAuthority(request, published);
          const retained = restartTransactions.get(request.requestId)?.response;
          if (retained) {
            if (
              !sameDevLaunchGeneration(
                request.expectedLaunch,
                retained.previousLaunch,
              ) ||
              !sameOptionalDevLaunchGeneration(
                request.expectedFrontend,
                retained.previousFrontend,
              )
            ) {
              throw new Error(
                "dev launch restart request id is bound to another predecessor",
              );
            }
            sendFrame(connection, retained);
            return;
          }
          validateRestartExpectedLaunch(request, published);
        }
        if (
          !activated ||
          stopping ||
          activeTransition ||
          (parentReloadRequest && hasUnobservedTerminalRestart()) ||
          candidate ||
          frontendCandidate ||
          !current ||
          current.exited
        ) {
          throw new Error(
            retirementFailure
              ? `dev launch retirement pending: ${retirementFailure.message}`
              : "dev launch supervisor is busy",
          );
        }
      } catch (error) {
        sendFrame(connection, {
          schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          type: parentReloadRequest
            ? "parent_reload_rejected"
            : parentGenerationProbe
              ? "parent_generation_rejected"
              : "restart_rejected",
          requestId: request?.requestId,
          reason: error.message,
          destructiveBoundaryCrossed:
            request?.type === "restart_status" ||
            request?.type === "restart_ack"
              ? null
              : false,
        });
        return;
      }

      const previous = current;
      const previousFrontend = frontendRecord?.launch;
      if (parentReloadRequest) {
        const admissionFlushed = sendFrameBeforeTransition(connection, {
          schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          type: "parent_reload_admitted",
          requestId: request.requestId,
          worktreeRoot,
          channel,
          previousSupervisor: supervisor,
          previousLaunch: previous.launch,
          ...(previousFrontend
            ? { previousFrontend }
            : {}),
          targetSupervisorGeneration: request.targetSupervisorGeneration,
          targetSourceGeneration: request.targetSourceGeneration,
        });
        beginTransition("parent_reload", async (authority) => {
          await admissionFlushed;
          let destructiveBoundaryCrossed = false;
          let predecessorRetired = false;
          let restored = null;
          const handoff = (phase) => ({
            schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
            protocolVersion: DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION,
            type: "parent_handoff",
            requestId: request.requestId,
            worktreeRoot,
            channel,
            capability: redactDevLaunchCapability(capability),
            previousSupervisor: supervisor,
            previousLaunch: previous.launch,
            ...(previousFrontend
              ? { previousFrontend }
              : {}),
            targetSupervisorGeneration: request.targetSupervisorGeneration,
            targetSourceGeneration: request.targetSourceGeneration,
            phase,
            committedAtMs: Date.now(),
          });
          const publishHandoff = (phase) => {
            const parentHandoff = handoff(phase);
            const next = {
              ...published,
              state: "handoff",
              launch: null,
              ...(frontendAuthority
                ? { frontend: previousFrontend ?? null }
                : {}),
              handoff: parentHandoff,
              publishedAtMs: Date.now(),
            };
            commitDescriptor(next, { authority });
            handoffCommitted = true;
            return parentHandoff;
          };
          const publishFailure = (
            error,
            recoveredLaunch,
            frontendIsReady,
            cleanupLaunch,
            commitAuthority = authority,
          ) => {
            const parentReloadFailure = {
              type: "parent_reload_failure",
              requestId: request.requestId,
              targetSupervisorGeneration:
                request.targetSupervisorGeneration,
              targetSourceGeneration: request.targetSourceGeneration,
              destructiveBoundaryCrossed,
              reason: error.message,
              failedAtMs: Date.now(),
              ...(recoveredLaunch ? { recoveredLaunch } : {}),
            };
            const next = {
              ...descriptorValue({
                state:
                  recoveredLaunch && frontendIsReady && !cleanupLaunch
                    ? "ready"
                    : "preparing",
                launch: recoveredLaunch,
                candidateLaunch: cleanupLaunch,
                frontend: previousFrontend ?? null,
                activation: published.activation,
              }),
              parentReloadFailure,
            };
            commitDescriptor(next, {
              authority: commitAuthority,
              publishedRecords: [restored],
            });
          };
          const publishRollbackFailure = (error, cleanupLaunch) => {
            const durableHandoff = published.state === "handoff"
              ? published.handoff
              : handoff("exec_pending");
            const next = {
              ...descriptorValue({
                state: "handoff",
                launch: null,
                candidateLaunch: cleanupLaunch,
                frontend: previousFrontend ?? null,
                handoff: durableHandoff,
                activation: published.activation,
              }),
              parentReloadFailure: {
                type: "parent_reload_failure",
                requestId: request.requestId,
                targetSupervisorGeneration:
                  request.targetSupervisorGeneration,
                targetSourceGeneration: request.targetSourceGeneration,
                destructiveBoundaryCrossed: true,
                reason: error.message,
                failedAtMs: Date.now(),
              },
            };
            commitDescriptor(next, {
              authority,
              publishedRecords: [restored],
            });
            handoffCommitted = true;
          };
          const publishStoppedFailure = () => {
            if (!stopAuthority || destructiveBoundaryCrossed || handoffCommitted) return;
            try {
              // Cancellation is observable before cleanup finishes, while the
              // durable descriptor retains the exact pending cleanup owner.
              publishFailure(
                new Error("dev launch supervisor is stopping"),
                previous.launch,
                false,
                published.candidateLaunch,
                stopAuthority,
              );
            } catch (error) {
              finish({ code: 1, signal: null, error });
            }
          };
          stopController.signal.addEventListener("abort", publishStoppedFailure, { once: true });
          try {
            if (stopController.signal.aborted) {
              publishStoppedFailure();
              return;
            }
            const preflight = await raceOwnedLaunchWithStop(
              Promise.resolve().then(() =>
                preflightParent(
                  request.targetSourceGeneration,
                  handoff("exec_pending"),
                  stopController.signal,
                ),
              ),
            );
            if (preflight.kind === "cancelled") {
              throw new Error("dev launch supervisor is stopping");
            }
            const prerequisite = preflight.value;
            requireLifecycleAuthority(authority);
            if (prerequisite) {
              const prepared = await runOwnedPreparation(
                prerequisite,
                authority,
              );
              if (prepared.kind === "cancelled") {
                throw new Error("dev launch supervisor is stopping");
              }
            }
            if (stopping) {
              throw new Error("dev launch supervisor is stopping");
            }
            requireLifecycleAuthority(authority);
            const handoffFrontendReady = !frontendAuthority ||
              (previousFrontend &&
                await frontendReady(frontendAuthority, previousFrontend));
            requireLifecycleAuthority(authority);
            if (!handoffFrontendReady) {
              throw new Error(
                "dev launch parent handoff lost its admitted frontend generation",
              );
            }
            requireLifecycleAuthority(authority);
            await retireOwnedLaunch(previous, {
              requireActive: true,
              onRetirementCommitted: () => {
                publishHandoff("retiring");
                destructiveBoundaryCrossed = true;
              },
            });
            requireLifecycleAuthority(authority);
            predecessorRetired = await launchRetired(previous);
            if (!predecessorRetired) {
              throw new Error(
                "dev launch predecessor retirement was not proven",
              );
            }
            requireLifecycleAuthority(authority);
            const committed = publishHandoff("exec_pending");
            await closeControlEndpoint();
            requireLifecycleAuthority(authority);
            unlinkExactSocket(socketPath);
            requireLifecycleAuthority(authority);
            reloadParent(committed);
            throw new Error("dev launch parent reload returned without exec");
          } catch (error) {
            if (stopping) {
              publishStoppedFailure();
              return;
            }
            if (predecessorRetired) {
              try {
                restored = spawnAppCandidate(
                  { command, args, spawnOptions },
                  channel,
                );
                candidate = restored;
                const binding = await bindOwnedAppCandidate(restored, () => {
                  publishRollbackFailure(error, restored.launch);
                });
                if (binding.kind === "cancelled") return;
                requireLifecycleAuthority(authority);
                await requireAdmittedFrontendReady(
                  "predecessor recovery",
                  authority,
                );
                const activation = await activateOwnedAppCandidate(restored);
                if (activation.kind === "cancelled") return;
                requireLifecycleAuthority(authority);
                await requireAdmittedFrontendReady(
                  "predecessor recovery",
                  authority,
                );
                await requireLaunchActive(
                  restored,
                  "predecessor recovery",
                  authority,
                );
                current = restored;
                candidate = null;
                if (!server.listening) {
                  await listen(server, socketPath);
                  requireLifecycleAuthority(authority);
                  if (process.platform !== "win32") chmodSync(socketPath, 0o600);
                }
                await requireAdmittedFrontendReady(
                  "predecessor recovery commit",
                  authority,
                );
                await requireLaunchActive(
                  restored,
                  "predecessor recovery commit",
                  authority,
                );
                publishFailure(
                  error,
                  restored.launch,
                  true,
                );
                handoffCommitted = false;
                restored.exitPromise.then(async (outcome) => {
                  const transition = activeTransition;
                  if (transition) await transition.transaction;
                  if (
                    !restored.restarting &&
                    current === restored &&
                    !stopping
                  ) {
                    const observation = observeLifecycle(
                      "restored_launch_exit",
                    );
                    finishFromLaunchExit(restored, outcome, observation);
                  }
                });
              } catch (recoveryError) {
                let failure = new Error(
                  `${error.message}; predecessor relaunch failed: ${recoveryError.message}`,
                );
                try {
                  publishRollbackFailure(failure, restored?.launch);
                } catch (publicationError) {
                  failure = new Error(
                    `${failure.message}; failure publication failed: ${publicationError.message}`,
                  );
                }
                enterStopping();
                finish({ code: 1, signal: null, error: failure });
              }
            } else if (destructiveBoundaryCrossed || handoffCommitted) {
              let failure = new Error(
                `${error.message}; predecessor retirement was not proven, so relaunch was refused`,
              );
              try {
                publishRollbackFailure(failure);
              } catch (publicationError) {
                failure = new Error(
                  `${failure.message}; failure publication failed: ${publicationError.message}`,
                );
              }
              enterStopping();
              finish({ code: 1, signal: null, error: failure });
            } else {
              let failure = error;
              try {
                publishFailure(
                  failure,
                  previous.launch,
                  true,
                );
              } catch (publicationError) {
                failure = new Error(
                  `${failure.message}; predecessor authority projection failed: ${publicationError.message}`,
                );
                enterStopping();
                finish({ code: 1, signal: null, error: failure });
              }
            }
          } finally {
            stopController.signal.removeEventListener("abort", publishStoppedFailure);
          }
        });
        return;
      }
      rememberRestartTransaction(
        request.requestId,
        pendingRestart(
          request.requestId,
          previous.launch,
          frontendRecord?.launch,
          "preparing",
        ),
      );
      const admissionFlushed = sendFrameBeforeTransition(connection, {
        schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        type: "restart_admitted",
        requestId: request.requestId,
        worktreeRoot,
        channel,
        supervisor,
        previousLaunch: previous.launch,
        ...(frontendRecord?.launch
          ? { previousFrontend: frontendRecord.launch }
          : {}),
      });
      beginTransition("restart", async (authority) => {
        const settlementDeadlineMs =
          Date.now() + restartSettlementTimeoutMs;
        await admissionFlushed;
        let destructiveBoundaryCrossed = false;
        let replacement = null;
        let candidatePublished = false;
        try {
          const prepared = await prepareNextLaunch(
            authority,
            settlementDeadlineMs,
          );
          if (prepared.kind === "cancelled") return;
          requireLifecycleAuthority(authority);
          const frontend = await ensureFrontendReady(authority);
          if (frontend?.kind === "cancelled") return;
          requireLifecycleAuthority(authority);
          requireRestartSettlementDeadline(settlementDeadlineMs);
          replacement = spawnAppCandidate(
            { command, args, spawnOptions },
            channel,
          );
          candidate = replacement;
          const binding = await bindOwnedAppCandidate(replacement, () => {
            publishAppCandidate(replacement, previous.launch, authority);
            candidatePublished = true;
          });
          if (binding.kind === "cancelled") return;
          requireLifecycleAuthority(authority);
          await requireAdmittedFrontendReady("restart candidate", authority);
          await requireLaunchActive(
            replacement,
            "restart candidate before predecessor retirement",
            authority,
          );
          requireRestartSettlementDeadline(settlementDeadlineMs);
          await retireOwnedLaunch(previous, {
            requireActive: true,
            onRetirementCommitted: () => {
              requireRestartSettlementDeadline(settlementDeadlineMs);
              const retiring = descriptorValue({
                state: "preparing",
                launch: previous.launch,
                candidateLaunch: replacement.launch,
                frontend: frontendRecord?.launch ?? null,
                activation: published.activation,
              });
              commitDescriptor(retiring, {
                authority,
                publishedRecords: [replacement],
              });
              destructiveBoundaryCrossed = true;
              rememberRestartTransaction(
                request.requestId,
                pendingRestart(
                  request.requestId,
                  previous.launch,
                  previousFrontend,
                  "retiring",
                ),
              );
            },
          });
          requireLifecycleAuthority(authority);
          await requireAdmittedFrontendReady("restart activation", authority);
          const activation = await activateOwnedAppCandidate(replacement);
          if (activation.kind === "cancelled") return;
          requireLifecycleAuthority(authority);
          await requireAdmittedFrontendReady("restart commit", authority);
          await requireLaunchActive(
            replacement,
            "restart candidate",
            authority,
          );
          const nextDescriptor = descriptorValue({
            state: "ready",
            launch: replacement.launch,
            frontend: frontendRecord?.launch ?? null,
            activation: published.activation,
          });
          commitDescriptor(nextDescriptor, {
            authority,
            publishedRecords: [replacement],
          });
          current = replacement;
          candidate = null;
          rememberRestartTransaction(request.requestId, {
            schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
            protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
            type: "restart_receipt",
            requestId: request.requestId,
            worktreeRoot,
            channel,
            supervisor,
            previousLaunch: previous.launch,
            launch: replacement.launch,
            ...(previousFrontend ? { previousFrontend } : {}),
            ...(frontendRecord?.launch
              ? { frontend: frontendRecord.launch }
              : {}),
            restartedAtMs: Date.now(),
          });
          const terminalObserved = waitForTerminalObservation(
            request.requestId,
          );
          replacement.exitPromise.then(async (outcome) => {
            await terminalObserved;
            const transition = activeTransition;
            if (transition) await transition.transaction;
            if (
              !replacement.restarting &&
              current === replacement &&
              !stopping
            ) {
              const observation = observeLifecycle(
                "replacement_launch_exit",
              );
              finishFromLaunchExit(replacement, outcome, observation);
            }
          });
        } catch (error) {
          let failure = error;
          let replacementRetired = replacement === null;
          if (replacement && current !== replacement) {
            try {
              await retireOwnedLaunch(replacement);
              replacementRetired = true;
              if (candidate === replacement) candidate = null;
            } catch (cleanupError) {
              failure = new Error(
                `${error.message}; replacement cleanup failed: ${cleanupError.message}`,
              );
              if (!candidatePublished && replacement.launch) {
                try {
                  publishAppCandidate(
                    replacement,
                    previous.launch,
                    authority,
                  );
                  candidatePublished = true;
                } catch (publicationError) {
                  failure = new Error(
                    `${failure.message}; cleanup obligation publication failed: ${publicationError.message}`,
                  );
                }
              }
              failure.mustStop = true;
            }
          }
          if (stopping) return;
          const predecessorEndedBeforeRetirement =
            !destructiveBoundaryCrossed && !stopping && previous.exited;
          if (
            candidatePublished &&
            replacementRetired &&
            !destructiveBoundaryCrossed &&
            !stopping &&
            !predecessorEndedBeforeRetirement
          ) {
            try {
              const restored = descriptorValue({
                state: "ready",
                launch: previous.launch,
                frontend: frontendRecord?.launch ?? null,
                activation: published.activation,
              });
              commitDescriptor(restored, { authority });
            } catch (publicationError) {
              failure = new Error(
                `${failure.message}; predecessor authority restoration failed: ${publicationError.message}`,
              );
            }
          }
          rememberRestartTransaction(request.requestId, {
            schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
            protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
            type: "restart_rejected",
            requestId: request.requestId,
            previousLaunch: previous.launch,
            ...(previousFrontend ? { previousFrontend } : {}),
            reason: `dev launch restart failed: ${failure.message}`,
            destructiveBoundaryCrossed,
          });
          const mustStop = failure.mustStop === true;
          const terminalObserved =
            destructiveBoundaryCrossed ||
            predecessorEndedBeforeRetirement ||
            mustStop
              ? waitForTerminalObservation(request.requestId)
              : null;
          if (destructiveBoundaryCrossed || mustStop) {
            if (mustStop) retainPublishedRecordsOnExit = true;
            enterStopping();
            await terminalObserved;
            finish({
              code: 1,
              signal: null,
              ...(mustStop ? { error: failure } : {}),
            });
          } else {
            if (predecessorEndedBeforeRetirement) {
              await terminalObserved;
              if (!stopping) finish(previous.exit);
            }
          }
        }
      });
    });
  });

  let controlEndpointClose;
  const closeControlEndpoint = () => {
    if (controlEndpointClose) return controlEndpointClose;
    const closing = (() => {
      const closed = server.listening
        ? waitForServerClose(server)
        : Promise.resolve();
      for (const connection of controlConnections) connection.destroy();
      return closed;
    })();
    controlEndpointClose = closing;
    closing.then(
      () => {
        if (controlEndpointClose === closing) controlEndpointClose = undefined;
      },
      () => {
        if (controlEndpointClose === closing) controlEndpointClose = undefined;
      },
    );
    return closing;
  };

  const restartSettlementDeadlineError = () =>
    new Error(
      "dev launch restart settlement deadline expired before predecessor retirement",
    );
  const requireRestartSettlementDeadline = (deadlineMs) => {
    if (Date.now() >= deadlineMs) throw restartSettlementDeadlineError();
  };
  const prepareNextLaunch = async (authority, settlementDeadlineMs) => {
    const prerequisites = Array.isArray(prepareLaunch)
      ? prepareLaunch
      : prepareLaunch
        ? [prepareLaunch]
        : [];
    for (const prerequisite of prerequisites) {
      if (
        settlementDeadlineMs !== undefined &&
        prerequisite.timeoutMs !== undefined &&
        (!Number.isSafeInteger(prerequisite.timeoutMs) ||
          prerequisite.timeoutMs < 1)
      ) {
        throw new Error("dev launch prerequisite timeout is invalid");
      }
      let boundedBySettlement = false;
      let boundedPrerequisite = prerequisite;
      if (settlementDeadlineMs !== undefined) {
        const remainingMs = settlementDeadlineMs - Date.now();
        if (remainingMs <= 0) throw restartSettlementDeadlineError();
        boundedBySettlement =
          prerequisite.timeoutMs === undefined ||
          remainingMs < prerequisite.timeoutMs;
        if (boundedBySettlement) {
          boundedPrerequisite = {
            ...prerequisite,
            timeoutMs: remainingMs,
          };
        }
      }
      try {
        const prepared = await runOwnedPreparation(
          boundedPrerequisite,
          authority,
        );
        if (prepared.kind === "cancelled") return ownedLaunchCancelled;
      } catch (error) {
        if (
          boundedBySettlement &&
          error?.message === "dev launch prerequisite timed out"
        ) {
          throw restartSettlementDeadlineError();
        }
        throw error;
      }
      if (settlementDeadlineMs !== undefined) {
        requireRestartSettlementDeadline(settlementDeadlineMs);
      }
    }
    return { kind: "completed" };
  };

  const cleanup = async ({ preserveDescriptor = false } = {}) => {
    for (const transaction of restartTransactions.values()) {
      transaction.finishObservation?.();
    }
    await closeControlEndpoint();
    if (!preserveDescriptor) {
      const latest = safeLstat(descriptorPathname)
        ? readDescriptor({ home, channel, worktreeRoot }).value
        : null;
      if (latest && sameDevLaunchIdentity(latest.supervisor, supervisor)) {
        unlinkSync(descriptorPathname);
        fsyncDirectory(controlDirectory);
      }
    }
    unlinkExactSocket(socketPath);
  };

  const stopFromSignal = (signal) => {
    if (stopping) return;
    const authority = enterStopping();
    let failure;
    if (inheritedHandoff && handoffCommitted) {
      failure = new Error(
        `dev launch parent successor received ${signal} before activation`,
      );
      try {
        publishInheritedFailure(failure, authority);
      } catch (error) {
        failure = new Error(
          `${failure.message}; failure receipt could not be persisted: ${error.message}`,
        );
      }
    }
    stopController.abort(signal);
    finish(
      failure
        ? { code: 1, signal: null, error: failure }
        : { code: null, signal },
    );
  };
  const onSigint = () => stopFromSignal("SIGINT");
  const onSigterm = () => stopFromSignal("SIGTERM");
  const onSighup = () => stopFromSignal("SIGHUP");

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  try {
    await listen(server, socketPath);
    if (process.platform !== "win32") chmodSync(socketPath, 0o600);
    if (stopping) return await completion;
    requireLifecycleAuthority(startupAuthority);
    await prepareInitialLaunch?.();
    if (stopping) return await completion;
    requireLifecycleAuthority(startupAuthority);
    const prepared = await prepareNextLaunch(startupAuthority);
    if (prepared.kind === "cancelled" || stopping) return await completion;
    requireLifecycleAuthority(startupAuthority);
    const frontend = await ensureFrontendReady(startupAuthority);
    if (frontend?.kind === "cancelled" || stopping) return await completion;
    requireLifecycleAuthority(startupAuthority);
    if (current && !current.launch.processGroup) {
      await retireOwnedLaunch(current);
      current = null;
      commitDescriptor(preparingDescriptor(), {
        authority: startupAuthority,
      });
    }
    requireLifecycleAuthority(startupAuthority);
    if (!current || await launchRetired(current)) {
      const previousLaunch = current?.launch ?? null;
      const initialCandidate = spawnAppCandidate(
        { command, args, spawnOptions },
        channel,
      );
      candidate = initialCandidate;
      let bound;
      try {
        bound = await bindOwnedAppCandidate(initialCandidate, () => {
          publishAppCandidate(
            initialCandidate,
            previousLaunch,
            startupAuthority,
          );
        });
        requireLifecycleAuthority(startupAuthority);
      } catch (error) {
        let failure = error;
        try {
          await retireOwnedLaunch(initialCandidate);
          if (candidate === initialCandidate) candidate = null;
        } catch (cleanupError) {
          failure = new Error(
            `${error.message}; initial candidate cleanup failed: ${cleanupError.message}`,
          );
          if (
            initialCandidate.launch &&
            initialCandidate.cleanupAuthority ===
              candidateCleanupAuthority.activationLease
          ) {
            try {
              publishAppCandidate(
                initialCandidate,
                previousLaunch,
                startupAuthority,
              );
            } catch (publicationError) {
              failure = new Error(
                `${failure.message}; cleanup obligation publication failed: ${publicationError.message}`,
              );
            }
          }
        }
        throw failure;
      }
      if (bound.kind === "cancelled") {
        return await completion;
      }
      await requireAdmittedFrontendReady(
        "initial candidate",
        startupAuthority,
      );
      const activation = await activateOwnedAppCandidate(initialCandidate);
      if (activation.kind === "cancelled") {
        return await completion;
      }
      requireLifecycleAuthority(startupAuthority);
      await requireAdmittedFrontendReady(
        "initial activation",
        startupAuthority,
      );
      await requireLaunchActive(
        initialCandidate,
        "initial candidate",
        startupAuthority,
      );
      current = initialCandidate;
      candidate = null;
      if (stopping) return await completion;
    }
    await requireAdmittedFrontendReady(
      "ready publication",
      startupAuthority,
    );
    await requireLaunchActive(current, "ready publication", startupAuthority);
    const activation = inheritedActivation
      ? {
          ...inheritedActivation,
          launch: current.launch,
          ...(frontendRecord?.launch
            ? { frontend: frontendRecord.launch }
            : {}),
          activatedAtMs: Date.now(),
        }
      : undefined;
    const ready = descriptorValue({
      state: "ready",
      launch: current.launch,
      frontend: frontendRecord?.launch ?? null,
      activation,
    });
    activated = true;
    try {
      commitDescriptor(ready, {
        authority: startupAuthority,
        publishedRecords: [current, frontendRecord],
      });
    } catch (error) {
      activated = false;
      throw error;
    }
    handoffCommitted = false;
    startupActive = false;
    const initial = current;
    if (initial.adopted) {
      monitorAdoptedLaunch(initial);
    } else {
      initial.exitPromise.then(async (outcome) => {
        const transition = activeTransition;
        if (transition) await transition.transaction;
        if (
          !initial.restarting &&
          current === initial &&
          !stopping
        ) {
          const observation = observeLifecycle("initial_launch_exit");
          finishFromLaunchExit(initial, outcome, observation);
        }
      });
    }
    monitorAdoptedFrontendExit(frontendRecord);
    return await completion;
  } catch (error) {
    if (stopping) return await completion;
    publishInheritedFailure(error, startupAuthority);
    publishHmuxStartupFailure(error, startupAuthority);
    throw error;
  } finally {
    enterStopping();
    const transition = activeTransition;
    if (transition) {
      try {
        await transition.transaction;
      } catch {}
    }
    if (activated && !handoffCommitted && published.state === "ready") {
      publishPreparingProjection({ authority: stopAuthority });
    }
    const settleRetirement = (record) =>
      settleOwnedLaunchRetirement(record, (error) => {
        retirementFailure = error;
      });
    if (
      current &&
      (activated || !current.adopted) &&
      !retainRecordForRecovery(current)
    ) {
      await settleRetirement(current);
    }
    if (candidate && !retainRecordForRecovery(candidate)) {
      await settleRetirement(candidate);
      candidate = null;
    }
    if (
      frontendCandidate &&
      !retainRecordForRecovery(frontendCandidate)
    ) {
      await settleRetirement(frontendCandidate);
      frontendCandidate = null;
    }
    if (
      frontendRecord &&
      (activated || !frontendRecord.adopted) &&
      !retainRecordForRecovery(frontendRecord)
    ) {
      await settleRetirement(frontendRecord);
    }
    await cleanup({
      preserveDescriptor: Boolean(
        retainPublishedRecordsOnExit ||
          handoffCommitted ||
          published.parentReloadFailure ||
          published.startupFailure ||
          (!activated && (current?.adopted || frontendRecord?.adopted)),
      ),
    });
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
  }
}
