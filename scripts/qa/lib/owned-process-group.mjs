#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  macosProcessBoundaryCompileArguments,
  observeCurrentUserProcessIdentities,
  observeProcessMembers,
  processMemberSnapshots,
  signalProcessGenerationSync,
} from "../../lib/process-identity.mjs";
import {
  retireExactLeaderProcessGroup,
} from "../../lib/process-group-authority.mjs";
import {
  macosProcessMarkerToolPath,
  startMacosOwnershipObserver as startMacosOwnershipObserverProcess,
} from "./macos-ownership-observer.mjs";
import {
  identityOwnedRelations,
  terminateIdentityOwnedTree,
} from "./owned-process-identity-recovery.mjs";
import {
  isProcessStartMarkerV1,
  ownedProcessGenerationDigestV1,
  parsePersistedKernelStartMarkerV1,
  persistedOwnedProcessV1,
} from "./owned-process-persistence-v1.mjs";
import { qaEnvironmentValue } from "./qa-environment.mjs";
import {
  classifyOwnedGeneration,
  isDepartedProcessMember,
} from "./owned-process-generation.mjs";

const SCHEMA_VERSION = 1;
const POLL_INTERVAL_MS = 20;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_LEDGER_PRODUCER_EXIT_GRACE_MS = 30_000;
const CLEANUP_FAILURE_EXIT_CODE = 97;
const MAX_GRACE_MS = 10_000;
const MAX_COMMAND_TIMEOUT_MS = 2_147_483_647;
const MAX_LEDGER_PRODUCER_EXIT_GRACE_MS = 60_000;
const OWNED_PROCESS_GROUP_ERROR = "owned_process_group_error";
const OWNED_PROCESS_EXIT_RECEIPT_SCHEMA = "dure-qa-owned-process-exit/v1";
const HARD_PROCESS_CONTAINMENT_CAPABILITY = "hard_process_containment_v2";
export const OWNED_PROCESS_GENERATION_LIMIT = 32_768;
const MAX_OWNERSHIP_LEDGER_DELTA_ENTRIES =
  OWNED_PROCESS_GENERATION_LIMIT * 2 + 1;
const MAX_FREEZE_PASSES = 32;
const PROCESS_IDENTITY_WAIT_MS = 1_000;
const LIVENESS_WITNESS_FD = 3;
const LIVENESS_WITNESS_WAIT_MS = 250;
const LIVENESS_WITNESS_VERSION = "inherited-fd-v1";
const STARTUP_HANDSHAKE_WAIT_MS = 30_000;
const STARTUP_HANDSHAKE_SCHEMA = "owned-process-startup-v1";
const OWNERSHIP_LEDGER_SUFFIX = ".ownership-ledger.json";
const OWNERSHIP_LEDGER_DELTA_SUFFIX = ".ownership-ledger-deltas-v1";
const OWNERSHIP_LEDGER_DELTA_SCHEMA = "dure-owned-process-ledger-delta/v1";
const OWNERSHIP_IDENTITY_DELTA_SCHEMA =
  "dure-owned-process-identity-delta/v1";
const MAX_OWNERSHIP_LEDGER_DELTA_BYTES = 4_096;
const CLEANUP_HANDOFF_SNAPSHOT_SUFFIX = ".cleanup-handoff-frozen-v1.json";
const FROZEN_TERMINATION_REQUEST_SUFFIX = ".termination-frozen-v1.json";
const LINUX_PROCESS_BOUNDARY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../native/linux-process-boundary.py",
);
const HARD_CONTAINMENT_KINDS = new Map([
  ["linux", "linux-pidfd-subreaper-v1"],
]);

export class OwnedProcessCleanupHandoffError extends Error {
  constructor(cause) {
    super(
      `${OWNED_PROCESS_GROUP_ERROR}: exact successor completed cleanup after supervisor uncertainty: ${boundedDiagnostic(
        cause instanceof Error ? cause.message : cause,
      )}`,
      { cause },
    );
    this.name = "OwnedProcessCleanupHandoffError";
    this.kind = "owned-process-cleanup-handoff";
  }
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 1) {
    throw new Error(`${OWNED_PROCESS_GROUP_ERROR}: invalid ${name}`);
  }
  return parsed;
}

function boundedMilliseconds(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_GRACE_MS
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ${name} must be between 0 and ${MAX_GRACE_MS}`,
    );
  }
  return parsed;
}

function commandTimeoutMilliseconds(value) {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_COMMAND_TIMEOUT_MS
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: command timeout must be a positive duration`,
    );
  }
  return value;
}

function gracePeriods(environment = process.env) {
  return {
    killGraceMs: boundedMilliseconds(
      qaEnvironmentValue(environment, "PROCESS_KILL_GRACE_MS"),
      DEFAULT_KILL_GRACE_MS,
      "DURE_QA_PROCESS_KILL_GRACE_MS",
    ),
    termGraceMs: boundedMilliseconds(
      qaEnvironmentValue(environment, "PROCESS_TERM_GRACE_MS"),
      DEFAULT_TERM_GRACE_MS,
      "DURE_QA_PROCESS_TERM_GRACE_MS",
    ),
  };
}

function ledgerProducerExitGraceMs(environment = process.env) {
  const name = "DURE_QA_PROCESS_LEDGER_PRODUCER_EXIT_GRACE_MS";
  const value = qaEnvironmentValue(
    environment,
    "PROCESS_LEDGER_PRODUCER_EXIT_GRACE_MS",
  );
  if (value === undefined || value === "") {
    return DEFAULT_LEDGER_PRODUCER_EXIT_GRACE_MS;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_LEDGER_PRODUCER_EXIT_GRACE_MS
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ${name} must be between 0 and ${MAX_LEDGER_PRODUCER_EXIT_GRACE_MS}`,
    );
  }
  return parsed;
}

function processStartMarker(value, name = "process start marker") {
  if (!isProcessStartMarkerV1(value)) {
    throw new Error(`${OWNED_PROCESS_GROUP_ERROR}: invalid ${name}`);
  }
  return value;
}

function parsedKernelStartMarker(
  value,
  name = "kernel process start marker",
) {
  const parsed = parsePersistedKernelStartMarkerV1(value);
  if (!parsed) {
    throw new Error(`${OWNED_PROCESS_GROUP_ERROR}: invalid ${name}`);
  }
  return parsed;
}

function kernelStartMarker(value, name) {
  return parsedKernelStartMarker(value, name).marker;
}

function exactKernelStartMarker(value, name, purpose) {
  const parsed = parsedKernelStartMarker(value, name);
  if (parsed.kind !== "exact") {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: legacy Linux process generation cannot authorize ${purpose}`,
    );
  }
  return parsed.marker;
}

function exactKernelProcessIdentity(
  value,
  purpose = "destructive authority",
) {
  const parsed = parsedKernelStartMarker(value);
  if (parsed.kind !== "exact") {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: legacy Linux process generation cannot authorize ${purpose}`,
    );
  }
  return parsed.processIdentity;
}

export function exactOwnedProcessIdentity(expected) {
  return Object.freeze({
    pid: positiveInteger(expected?.pid, "owned process identity pid"),
    processIdentity: exactKernelProcessIdentity(
      expected?.kernelStartMarker,
      "an owned process identity",
    ),
  });
}

function classifiedOwnedGeneration(generation, member, purpose) {
  const state = classifyOwnedGeneration(generation, member);
  if (state.kind === "legacy_live") {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: legacy Linux process generation cannot authorize ${purpose}`,
    );
  }
  return state;
}

function classifyOwnedProcess(expected, members, purpose) {
  return classifiedOwnedGeneration(
    parsedKernelStartMarker(expected.kernelStartMarker, "owned process kernel start marker"),
    members.find(({ pid }) => pid === expected.pid),
    purpose,
  );
}

function samePersistedGeneration(left, right) {
  return left?.pid === right?.pid &&
    left?.kernelStartMarker === right?.kernelStartMarker;
}

function sameOwnedMetadata(left, right) {
  return samePersistedGeneration(left, right) &&
    left.parentPid === right.parentPid &&
    left.groupId === right.groupId &&
    left.sessionId === right.sessionId;
}

function ownedProcessFromMember(member, previous) {
  return persistedOwnedProcessV1(member, previous?.startMarker);
}

function observationTimeout(deadline) {
  const timeoutMs = Math.ceil(deadline - performance.now());
  if (timeoutMs <= 0) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: process topology observation timed out`,
    );
  }
  return { timeoutMs };
}

function canonicalPids(pids) {
  return [...new Set(pids)].sort((left, right) => left - right);
}

function samePids(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((pid, index) => actual[index] === pid)
  );
}

function observationMembers(observation, expectedScope, label) {
  const scope = observation?.scope;
  const scopeMatches =
    scope?.kind === expectedScope.kind &&
    (expectedScope.kind !== "point" ||
      samePids(scope.requestedPids, expectedScope.requestedPids)) &&
    (expectedScope.kind !== "group_census" ||
      scope.groupId === expectedScope.groupId) &&
    (expectedScope.kind !== "user_census" ||
      (scope.effectiveUid === process.geteuid?.() &&
        scope.evidence === "closed_enumeration" &&
        scope.expectedProcess?.pid === expectedScope.expectedProcess?.pid &&
        scope.expectedProcess?.processIdentity ===
          expectedScope.expectedProcess?.processIdentity));
  if (observation?.status !== "complete" || !scopeMatches) {
    const diagnostic = observation?.diagnostic
      ? ` (${boundedDiagnostic(observation.diagnostic)})`
      : "";
    if (
      scopeMatches && expectedScope.expectedProcess &&
      observation?.reason === "process_generation_changed"
    ) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: process group leader generation changed${diagnostic}`,
      );
    }
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ${label} is incomplete: ${boundedDiagnostic(
        observation?.reason,
      )}${diagnostic}`,
    );
  }
  return observation.members;
}

async function observeProcessClosureCandidates(
  descriptor,
  historical,
  observeMembers,
  deadline,
) {
  const { groupId, leaderPid, leaderKernelStartMarker } = descriptor;
  const persisted = [...historical];
  const generation = parsedKernelStartMarker(leaderKernelStartMarker);
  const userScope = {
    kind: "user_census",
    ...(generation.kind === "exact"
      ? {
          expectedProcess: {
            pid: leaderPid,
            processIdentity: generation.processIdentity,
          },
        }
      : {}),
  };
  const user = observationMembers(
    await observeMembers(
      userScope,
      observationTimeout(deadline),
    ),
    userScope,
    "current-user process census",
  );
  const groupScope = { groupId, kind: "group_census" };
  const group = observationMembers(
    await observeMembers(
      { groupId, kind: "group_census" },
      observationTimeout(deadline),
    ),
    groupScope,
    "owned process-group census",
  );
  const historicalPids = canonicalPids(persisted.map(({ pid }) => pid));
  const pointScope = { kind: "point", requestedPids: historicalPids };
  const points = observationMembers(
    await observeMembers(
      { kind: "point", pids: historicalPids },
      observationTimeout(deadline),
    ),
    pointScope,
    "historical process observation",
  );
  const current = new Map(user.map((member) => [member.pid, member]));
  for (const [pid, member] of current) {
    if (member.groupId === groupId) current.delete(pid);
  }
  for (const member of group) current.set(member.pid, member);
  for (const pid of historicalPids) current.delete(pid);
  for (const member of points) current.set(member.pid, member);
  return [...current.values()];
}

function cleanupHandoffSnapshotPath(descriptorPath) {
  return `${path.resolve(descriptorPath)}${CLEANUP_HANDOFF_SNAPSHOT_SUFFIX}`;
}

function frozenTerminationRequestPath(descriptorPath) {
  return `${path.resolve(descriptorPath)}${FROZEN_TERMINATION_REQUEST_SUFFIX}`;
}

export function macosProcessMarkerCompileArguments(executable) {
  return macosProcessBoundaryCompileArguments(executable);
}

function prepareMacosProcessMarkerTool(descriptorPath) {
  const executable = macosProcessMarkerToolPath(descriptorPath);
  if (fs.existsSync(executable)) return executable;
  const temporary = `${executable}.${process.pid}.tmp`;
  const result = spawnSync(
    "cc",
    macosProcessMarkerCompileArguments(temporary),
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    fs.rmSync(temporary, { force: true });
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: could not prepare exact process marker helper`,
    );
  }
  try {
    fs.renameSync(temporary, executable);
    fs.chmodSync(executable, 0o700);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return executable;
}

function boundedDiagnostic(value, fallback = "none") {
  const rendered = String(value ?? "").trim().replaceAll(/\s+/gu, " ");
  return (rendered || fallback).slice(0, 256);
}

function exactKernelObservation(pid) {
  const observation = processMemberSnapshots([pid]);
  if (observation.status !== "complete") {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: exact process generation observation is incomplete`,
    );
  }
  return observation.members[0];
}

function exactGenerationState(expected) {
  const member = exactKernelObservation(expected.pid);
  const state = classifyOwnedProcess(
    expected,
    member ? [member] : [],
    "cleanup state",
  );
  // The controller vocabulary is a projection, not another generation check.
  if (state.kind !== "current") return "gone";
  return state.member.state === "stopped"
    ? "quiescent"
    : "running";
}

function signalExactKernelGeneration(expected, signal) {
  const expectedIdentity = exactKernelProcessIdentity(
    expected.kernelStartMarker,
    "a signal",
  );
  // The native signal boundary atomically compares this generation itself.
  return signalProcessGenerationSync(
    { pid: expected.pid, processIdentity: expectedIdentity },
    signal,
  );
}

function exactProcessControllerForDescriptor(descriptorPath) {
  if (process.platform === "darwin") {
    prepareMacosProcessMarkerTool(descriptorPath);
  } else if (process.platform !== "linux") {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: exact process generation is unsupported`,
    );
  }
  return {
    generationState: exactGenerationState,
    signalGeneration: signalExactKernelGeneration,
  };
}

function processMetadataId(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${OWNED_PROCESS_GROUP_ERROR}: invalid ${name}`);
  }
  return parsed;
}

export function observeExactProcessGeneration(
  pid = process.pid,
) {
  pid = positiveInteger(pid, "process identity pid");
  const member = exactKernelObservation(pid);
  return !isDepartedProcessMember(member)
    ? persistedOwnedProcessV1(member)
    : undefined;
}

async function waitForProcessIdentity(pid, timeoutMs = PROCESS_IDENTITY_WAIT_MS) {
  // Require several completed point observations before declaring startup
  // identity unavailable so a single loaded adapter invocation cannot consume
  // the whole discovery window.
  const MIN_IDENTITY_OBSERVATIONS = 3;
  const deadline = Date.now() + timeoutMs;
  let observations = 0;
  do {
    const member = exactKernelObservation(pid);
    if (!isDepartedProcessMember(member)) {
      return persistedOwnedProcessV1(member);
    }
    observations += 1;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline || observations < MIN_IDENTITY_OBSERVATIONS);
  throw new Error(
    `${OWNED_PROCESS_GROUP_ERROR}: process ${pid} has no observable generation`,
  );
}

function currentProcessGroupId() {
  const member = exactKernelObservation(process.pid);
  if (!member || member.state === "zombie") {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: could not resolve caller process group`,
    );
  }
  return positiveInteger(member.groupId, "caller process group");
}

function assertSafeGroup(groupId) {
  if (groupId === currentProcessGroupId()) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: refusing to signal the caller process group`,
    );
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inheritedLivenessWitness(child) {
  const stream = child.stdio?.[LIVENESS_WITNESS_FD];
  if (!stream) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: liveness witness pipe was not created`,
    );
  }
  stream.resume();
  let closed = false;
  let failure;
  const closure = new Promise((resolve) => {
    const close = () => {
      closed = true;
      resolve();
    };
    stream.once("end", close);
    stream.once("close", close);
    stream.once("error", (error) => {
      failure = error;
      resolve();
    });
  });
  return {
    async assertClosedWithin(timeoutMs = LIVENESS_WITNESS_WAIT_MS) {
      if (!closed && !failure) {
        await Promise.race([closure, sleep(timeoutMs)]);
      }
      if (failure) {
        stream.destroy();
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: liveness witness failed`,
          { cause: failure },
        );
      }
      if (!closed) {
        stream.destroy();
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: inherited liveness witness remains ` +
            `open after the process-group leader exited`,
        );
      }
    },
  };
}

export function startupLeaderFromMessage(message, expectedPid) {
  const pid = positiveInteger(message?.pid, "startup leader pid");
  if (
    message?.schema !== STARTUP_HANDSHAKE_SCHEMA ||
    message?.kind !== "leader-identity" ||
    pid !== positiveInteger(expectedPid, "expected startup leader pid")
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: invalid startup leader handshake`,
    );
  }
  const leader = {
    groupId: processMetadataId(
      message.groupId,
      "startup leader process group",
    ),
    kernelStartMarker: exactKernelStartMarker(
      message.kernelStartMarker,
      "startup leader kernel start marker",
      "startup identity",
    ),
    parentPid: processMetadataId(
      message.parentPid,
      "startup leader parent",
    ),
    pid,
    sessionId: processMetadataId(
      message.sessionId,
      "startup leader session",
    ),
    startMarker: processStartMarker(
      message.startMarker,
      "startup leader start marker",
    ),
  };
  if (leader.groupId !== pid) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: startup leader is not its process-group leader`,
    );
  }
  return leader;
}

function commandGateFromMessage(message, leader) {
  const pid = positiveInteger(message?.pid, "command gate pid");
  if (
    message?.schema !== STARTUP_HANDSHAKE_SCHEMA ||
    message?.kind !== "command-gate-identity" ||
    message?.leaderPid !== leader.pid ||
    message?.leaderKernelStartMarker !== leader.kernelStartMarker ||
    pid === leader.pid
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: invalid command gate handshake`,
    );
  }
  return { pid };
}

function startupLaunchOwnerFromEnvironment(environment) {
  return {
    kernelStartMarker: exactKernelStartMarker(
      qaEnvironmentValue(
        environment,
        "LAUNCH_OWNER_KERNEL_START_MARKER",
      ),
      "startup launch owner kernel start marker",
      "startup identity",
    ),
    pid: positiveInteger(
      qaEnvironmentValue(environment, "LAUNCH_OWNER_PID"),
      "startup launch owner pid",
    ),
    startMarker: processStartMarker(
      qaEnvironmentValue(environment, "LAUNCH_OWNER_START_MARKER"),
      "startup launch owner start marker",
    ),
  };
}

function waitForLeadStartupIdentity(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("disconnect", onDisconnect);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error) reject(error);
      else resolve(message);
    };
    const onDisconnect = () => {
      finish(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: startup identity channel closed`,
        ),
      );
    };
    const onError = (error) => finish(error);
    const onExit = () => {
      finish(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: startup leader exited before publishing its identity`,
        ),
      );
    };
    const onMessage = (message) => finish(null, message);
    const timer = setTimeout(() => {
      finish(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: startup leader identity timed out`,
        ),
      );
    }, STARTUP_HANDSHAKE_WAIT_MS);
    child.once("disconnect", onDisconnect);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("message", onMessage);
  });
}

function acknowledgeLeadStartup(child, leader, launchOwner) {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: startup identity channel is unavailable`,
        ),
      );
      return;
    }
    child.send(
      {
        kernelStartMarker: leader.kernelStartMarker,
        kind: "descriptor-ready",
        launchOwnerKernelStartMarker:
          launchOwner.kernelStartMarker,
        launchOwnerPid: launchOwner.pid,
        launchOwnerStartMarker: launchOwner.startMarker,
        pid: leader.pid,
        schema: STARTUP_HANDSHAKE_SCHEMA,
        supervisorPid: process.pid,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function acknowledgeCommandGate(child, leader, gate) {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: command gate channel is unavailable`,
        ),
      );
      return;
    }
    child.send(
      {
        kernelStartMarker: gate.kernelStartMarker,
        kind: "command-gate-ready",
        leaderKernelStartMarker: leader.kernelStartMarker,
        leaderPid: leader.pid,
        pid: gate.pid,
        schema: STARTUP_HANDSHAKE_SCHEMA,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function publishLeadStartupIdentity(leader, launchOwner) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== "function" || !process.connected) {
      reject(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: startup identity channel is unavailable`,
        ),
      );
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("disconnect", onDisconnect);
      process.off("message", onMessage);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const onDisconnect = () => {
      finish(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: startup identity channel closed before readiness`,
        ),
      );
    };
    const onMessage = (message) => {
      if (
        message?.schema !== STARTUP_HANDSHAKE_SCHEMA ||
        message?.kind !== "descriptor-ready" ||
        message?.pid !== leader.pid ||
        message?.kernelStartMarker !== leader.kernelStartMarker ||
        message?.supervisorPid !== leader.parentPid ||
        message?.launchOwnerPid !== launchOwner.pid ||
        message?.launchOwnerStartMarker !==
          launchOwner.startMarker ||
        message?.launchOwnerKernelStartMarker !==
          launchOwner.kernelStartMarker
      ) {
        finish(
          new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: invalid startup readiness acknowledgement`,
          ),
        );
        return;
      }
      finish();
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: startup readiness acknowledgement timed out`,
        ),
      );
    }, STARTUP_HANDSHAKE_WAIT_MS);
    process.once("disconnect", onDisconnect);
    process.once("message", onMessage);
    process.send(
      {
        ...ledgerProcess(leader),
        kind: "leader-identity",
        schema: STARTUP_HANDSHAKE_SCHEMA,
      },
      (error) => {
        if (error) finish(error);
      },
    );
  });
}

function publishCommandGateIdentity(gate, leader) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== "function" || !process.connected) {
      reject(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: command gate channel is unavailable`,
        ),
      );
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("disconnect", onDisconnect);
      process.off("message", onMessage);
      if (error) reject(error);
      else resolve();
    };
    const onDisconnect = () => {
      finish(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: command gate channel closed before readiness`,
        ),
      );
    };
    const onMessage = (message) => {
      let valid =
        message?.schema === STARTUP_HANDSHAKE_SCHEMA &&
        message?.kind === "command-gate-ready" &&
        message?.pid === gate.pid &&
        message?.leaderPid === leader.pid &&
        message?.leaderKernelStartMarker === leader.kernelStartMarker;
      try {
        exactKernelStartMarker(
          message?.kernelStartMarker,
          "admitted command gate kernel start marker",
          "command admission",
        );
      } catch {
        valid = false;
      }
      if (!valid) {
        finish(
          new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: invalid command gate readiness acknowledgement`,
          ),
        );
        return;
      }
      finish();
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: command gate readiness timed out`,
        ),
      );
    }, STARTUP_HANDSHAKE_WAIT_MS);
    process.once("disconnect", onDisconnect);
    process.once("message", onMessage);
    process.send(
      {
        kind: "command-gate-identity",
        leaderKernelStartMarker: leader.kernelStartMarker,
        leaderPid: leader.pid,
        pid: gate.pid,
        schema: STARTUP_HANDSHAKE_SCHEMA,
      },
      (error) => {
        if (error) finish(error);
      },
    );
  });
}

function waitForLeadCommandOutcome(child, leader, onCommandGate) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      child.off("disconnect", onDisconnect);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      resolve(result);
    };
    const protocolFailure = (message, cause) => ({
      signal: null,
      spawnError: new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: ${message}`,
        cause ? { cause } : undefined,
      ),
      status: null,
    });
    const onDisconnect = () => {
      finish(
        protocolFailure(
          "startup identity channel closed before command outcome",
        ),
      );
    };
    const onError = (error) => {
      finish(protocolFailure("startup identity channel failed", error));
    };
    const onExit = (status, signal) => {
      finish({ signal, spawnError: null, status });
    };
    let commandGateReady = false;
    let commandGatePending = false;
    const onMessage = (message) => {
      if (message?.kind === "command-gate-identity") {
        if (commandGatePending || commandGateReady) {
          finish(protocolFailure("command gate identity was repeated"));
          return;
        }
        let gate;
        try {
          gate = commandGateFromMessage(message, leader);
        } catch (error) {
          finish(protocolFailure("invalid command gate identity", error));
          return;
        }
        commandGatePending = true;
        void Promise.resolve(onCommandGate(gate))
          .then((admittedGate) => {
            if (admittedGate?.pid !== gate.pid) {
              throw new Error(
                `${OWNED_PROCESS_GROUP_ERROR}: command gate admission returned a different process`,
              );
            }
            return acknowledgeCommandGate(child, leader, admittedGate);
          })
          .then(() => {
            commandGatePending = false;
            commandGateReady = true;
          })
          .catch((error) => {
            finish(
              protocolFailure(
                `command gate admission failed: ${boundedDiagnostic(error)}`,
                error,
              ),
            );
          });
        return;
      }
      if (
        message?.schema !== STARTUP_HANDSHAKE_SCHEMA ||
        message?.kind !== "command-outcome" ||
        message?.pid !== leader.pid ||
        message?.kernelStartMarker !== leader.kernelStartMarker
      ) {
        finish(protocolFailure("invalid command outcome handshake"));
        return;
      }
      const status = message.status;
      const signal = message.signal;
      if (
        !(
          status === null ||
          (Number.isSafeInteger(status) && status >= 0 && status <= 255)
        ) ||
        !(signal === null || typeof signal === "string")
      ) {
        finish(protocolFailure("invalid command outcome payload"));
        return;
      }
      let spawnError = null;
      if (message.spawnError !== null) {
        const code = message.spawnError?.code;
        const detail = message.spawnError?.message;
        if (
          !(code === undefined || typeof code === "string") ||
          typeof detail !== "string" ||
          detail.length === 0 ||
          detail.length > 512
        ) {
          finish(protocolFailure("invalid command spawn failure payload"));
          return;
        }
        spawnError = new Error(detail);
        if (code !== undefined) spawnError.code = code;
      }
      if ((!commandGateReady || commandGatePending) && !spawnError) {
        finish(protocolFailure("command outcome preceded gate admission"));
        return;
      }
      finish({ signal, spawnError, status });
    };
    child.once("disconnect", onDisconnect);
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

function publishLeadCommandOutcome(leader, result) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== "function" || !process.connected) {
      reject(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: startup identity channel is unavailable`,
        ),
      );
      return;
    }
    process.send(
      {
        kernelStartMarker: leader.kernelStartMarker,
        kind: "command-outcome",
        pid: leader.pid,
        schema: STARTUP_HANDSHAKE_SCHEMA,
        signal: result.signal,
        spawnError: result.spawnError
          ? {
              ...(typeof result.spawnError.code === "string"
                ? { code: result.spawnError.code }
                : {}),
              message: String(result.spawnError.message).slice(0, 512),
            }
          : null,
        status: result.status,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function waitForSupervisorDisconnect() {
  if (!process.connected) return Promise.resolve();
  return new Promise((resolve) => {
    process.once("disconnect", resolve);
  });
}

function launchDisconnectedSupervisorCleanup(
  descriptorPath,
  expectedSupervisorPid,
  launchOwner,
) {
  return new Promise((_resolve, reject) => {
    const cleanup = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "terminate-after-owner-exit",
        path.resolve(descriptorPath),
        String(expectedSupervisorPid),
        String(launchOwner.pid),
        launchOwner.startMarker,
        launchOwner.kernelStartMarker,
      ],
      {
        cwd: process.cwd(),
        detached: true,
        env: process.env,
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    cleanup.once("error", reject);
    cleanup.once("close", (status, signal) => {
      reject(
        new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: disconnected supervisor cleanup returned ` +
            `with status ${String(status)} and signal ${String(signal)}`,
        ),
      );
    });
  });
}

async function awaitDisconnectedSupervisorCleanup(
  descriptorPath,
  expectedSupervisorPid,
  launchOwner,
  processController,
) {
  let observationFailureLogged = false;
  for (;;) {
    try {
      if (
        !exactGenerationIsLive(
          launchOwner,
          processController,
        )
      ) {
        break;
      }
      observationFailureLogged = false;
    } catch (error) {
      if (!observationFailureLogged) {
        console.error(
          `${OWNED_PROCESS_GROUP_ERROR}: launch owner observation failed while awaiting cleanup authority: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        observationFailureLogged = true;
      }
    }
    await sleep(100);
  }
  try {
    await launchDisconnectedSupervisorCleanup(
      descriptorPath,
      expectedSupervisorPid,
      launchOwner,
    );
  } catch (error) {
    console.error(
      `${OWNED_PROCESS_GROUP_ERROR}: disconnected cleanup successor returned before retiring the exact lead; preserving the liveness witness: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Success retires this process with SIGKILL, so any observed successor
    // return is failure. Stop the exact lead and keep its inherited witness
    // open; only external descriptor-authorized recovery may resume or retire
    // it after the supervisor preserves the evidence root.
    process.kill(process.pid, "SIGSTOP");
    for (;;) await sleep(MAX_GRACE_MS);
  }
}

export function signalExactProcess(
  expected,
  signal,
  { member, signalGeneration } = {},
) {
  const pid = positiveInteger(expected?.pid, "signal process pid");
  processStartMarker(expected?.startMarker, "signal process start marker");
  const expectedIdentity = exactKernelProcessIdentity(
    expected?.kernelStartMarker,
    "a signal",
  );
  if (!signalGeneration) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: exact process signal controller is required`,
    );
  }
  const observed = member === undefined
    ? exactKernelObservation(pid)
    : member;
  const state = classifyOwnedGeneration(
    { kind: "exact", processIdentity: expectedIdentity }, observed,
  );
  if (state.kind === "departed") return false;
  if (state.kind === "reused") {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: refusing to signal a reused process generation`,
    );
  }
  return signalGeneration(expected, signal);
}

function processIsStopped(record) {
  return record.state === "stopped";
}

function exactGenerationIsLive(expected, processController) {
  return processController.generationState(expected) !== "gone";
}

export function ownedProcessClosure(
  groupId,
  members,
  historical = [],
  { seedProcessGroup = true } = {},
) {
  const owned = new Set();
  if (seedProcessGroup) {
    for (const member of members) {
      if (member.groupId === groupId) owned.add(member.pid);
    }
  }
  for (const expected of historical) {
    const observed = classifyOwnedProcess(
      expected,
      members,
      "ownership discovery",
    ).member;
    if (observed) {
      owned.add(observed.pid);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const member of members) {
      if (!owned.has(member.pid) && owned.has(member.parentPid)) {
        owned.add(member.pid);
        changed = true;
      }
    }
  }
  return members.filter((member) =>
    owned.has(member.pid) && !isDepartedProcessMember(member)
  );
}

function ownershipLedgerPath(descriptorPath) {
  return `${path.resolve(descriptorPath)}${OWNERSHIP_LEDGER_SUFFIX}`;
}

function ledgerProcess(record) {
  return {
    groupId: processMetadataId(record?.groupId, "ledger process group"),
    kernelStartMarker: kernelStartMarker(
      record?.kernelStartMarker,
      "ledger process kernel start marker",
    ),
    parentPid: processMetadataId(record?.parentPid, "ledger process parent"),
    pid: positiveInteger(record?.pid, "ledger process pid"),
    sessionId: processMetadataId(record?.sessionId, "ledger process session"),
    startMarker: processStartMarker(
      record?.startMarker,
      "ledger process start marker",
    ),
  };
}

function ledgerIdentityOnlyProcess(record) {
  const pid = positiveInteger(record?.pid, "ledger identity process pid");
  const parentPid = positiveInteger(
    record?.parentPid,
    "ledger identity process parent",
  );
  if (pid === parentPid) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ledger identity process cannot parent itself`,
    );
  }
  return {
    kernelStartMarker: exactKernelStartMarker(
      record?.kernelStartMarker,
      "ledger identity process kernel start marker",
      "identity-only ownership",
    ),
    parentKernelStartMarker: exactKernelStartMarker(
      record?.parentKernelStartMarker,
      "ledger identity parent kernel start marker",
      "identity-only ownership",
    ),
    parentPid,
    pid,
  };
}

function ownershipLedger(
  descriptor,
  processes,
  healthy = true,
  failureReason,
  identityOnlyProcesses = [],
) {
  return {
    ...(failureReason === undefined ? {} : { failureReason }),
    groupId: descriptor.groupId,
    ...(descriptor.hardContainmentKind
      ? { hardContainmentKind: descriptor.hardContainmentKind }
      : {}),
    healthy,
    identityOnlyProcesses: [...identityOnlyProcesses]
      .map(ledgerIdentityOnlyProcess)
      .sort((left, right) => left.pid - right.pid),
    leaderKernelStartMarker: descriptor.leaderKernelStartMarker,
    leaderStartMarker: descriptor.leaderStartMarker,
    processes: [...processes]
      .map(ledgerProcess)
      .sort((left, right) => left.pid - right.pid),
    schemaVersion: SCHEMA_VERSION,
    livenessWitnessVersion: descriptor.livenessWitnessVersion,
    supervisorPid: descriptor.supervisorPid,
    supervisorKernelStartMarker: descriptor.supervisorKernelStartMarker,
    supervisorStartMarker: descriptor.supervisorStartMarker,
    terminateDetachedOwnedGenerations:
      descriptor.terminateDetachedOwnedGenerations === true,
  };
}

function ownershipLedgerDeltaRoot(descriptorPath) {
  return `${path.resolve(descriptorPath)}${OWNERSHIP_LEDGER_DELTA_SUFFIX}`;
}

function ownershipLedgerAuthorityDigest(descriptor) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        groupId: descriptor.groupId,
        hardContainmentKind: descriptor.hardContainmentKind ?? null,
        leaderKernelStartMarker: descriptor.leaderKernelStartMarker,
        leaderStartMarker: descriptor.leaderStartMarker,
        livenessWitnessVersion: descriptor.livenessWitnessVersion,
        supervisorKernelStartMarker: descriptor.supervisorKernelStartMarker,
        supervisorPid: descriptor.supervisorPid,
        supervisorStartMarker: descriptor.supervisorStartMarker,
        terminateDetachedOwnedGenerations:
          descriptor.terminateDetachedOwnedGenerations === true,
      }),
    )
    .digest("hex");
}

function removeOwnershipLedgerDeltas(descriptorPath) {
  const root = ownershipLedgerDeltaRoot(descriptorPath);
  if (!fs.existsSync(root)) return;
  directoryIdentity(root, "ownership ledger delta root");
  for (const entry of fs.readdirSync(root)) {
    const file = path.join(root, entry);
    fileIdentity(file, "ownership ledger delta");
    fs.unlinkSync(file);
  }
  fs.rmdirSync(root);
}

function writeOwnershipLedgerDelta(descriptor, record, sequence) {
  const root = ownershipLedgerDeltaRoot(descriptor.descriptorPath);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { mode: 0o700 });
  } else {
    directoryIdentity(root, "ownership ledger delta root");
  }
  const file = path.join(root, `${String(sequence).padStart(8, "0")}.json`);
  if (fs.existsSync(file)) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger delta already exists`,
    );
  }
  writeAtomicJson(file, {
    authority: ownershipLedgerAuthorityDigest(descriptor),
    process: ledgerProcess(record),
    schema: OWNERSHIP_LEDGER_DELTA_SCHEMA,
  });
}

function writeOwnershipIdentityDelta(descriptor, record, sequence) {
  const root = ownershipLedgerDeltaRoot(descriptor.descriptorPath);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { mode: 0o700 });
  } else {
    directoryIdentity(root, "ownership ledger delta root");
  }
  const file = path.join(root, `${String(sequence).padStart(8, "0")}.json`);
  if (fs.existsSync(file)) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger delta already exists`,
    );
  }
  writeAtomicJson(file, {
    authority: ownershipLedgerAuthorityDigest(descriptor),
    identity: ledgerIdentityOnlyProcess(record),
    schema: OWNERSHIP_IDENTITY_DELTA_SCHEMA,
  });
}

function readOwnershipLedgerDeltas(descriptor) {
  const root = ownershipLedgerDeltaRoot(descriptor.descriptorPath);
  if (!fs.existsSync(root)) {
    return { entries: [], publicationComplete: true };
  }
  directoryIdentity(root, "ownership ledger delta root");
  const rawEntries = fs.readdirSync(root);
  if (rawEntries.length > MAX_OWNERSHIP_LEDGER_DELTA_ENTRIES) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger delta limit exceeded`,
    );
  }
  const authority = ownershipLedgerAuthorityDigest(descriptor);
  const entries = [];
  let publicationComplete = true;
  for (const entry of rawEntries.sort()) {
    if (/^\d{8}\.json\.\d+\.tmp$/u.test(entry)) {
      publicationComplete = false;
      continue;
    }
    if (!/^\d{8}\.json$/u.test(entry)) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: invalid ownership ledger delta name`,
      );
    }
    const file = path.join(root, entry);
    fileIdentity(file, "ownership ledger delta");
    const stat = fs.statSync(file);
    if (stat.size <= 0 || stat.size > MAX_OWNERSHIP_LEDGER_DELTA_BYTES) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: invalid ownership ledger delta size`,
      );
    }
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.authority !== authority) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: invalid ownership ledger delta authority`,
      );
    }
    if (value?.schema === OWNERSHIP_LEDGER_DELTA_SCHEMA) {
      entries.push({ kind: "process", value: ledgerProcess(value.process) });
    } else if (value?.schema === OWNERSHIP_IDENTITY_DELTA_SCHEMA) {
      entries.push({
        kind: "identity",
        value: ledgerIdentityOnlyProcess(value.identity),
      });
    } else {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: invalid ownership ledger delta schema`,
      );
    }
  }
  return { entries, publicationComplete };
}

function ledgerGenerationKey(pid, kernelStartMarker) {
  return `${pid}\0${kernelStartMarker}`;
}

function classifyIdentityOnlyProcessChains(processes, identityOnlyProcesses) {
  const fullGenerations = new Set(
    [...processes].map((record) =>
      ledgerGenerationKey(record.pid, record.kernelStartMarker)
    ),
  );
  const identityGenerations = new Map(
    [...identityOnlyProcesses].map((record) => [
      ledgerGenerationKey(record.pid, record.kernelStartMarker),
      record,
    ]),
  );
  const complete = [];
  const incomplete = [];
  for (const identity of identityGenerations.values()) {
    const visited = new Set([
      ledgerGenerationKey(identity.pid, identity.kernelStartMarker),
    ]);
    let current = identity;
    for (;;) {
      const parentKey = ledgerGenerationKey(
        current.parentPid,
        current.parentKernelStartMarker,
      );
      if (fullGenerations.has(parentKey)) {
        complete.push(identity);
        break;
      }
      const parent = identityGenerations.get(parentKey);
      if (!parent) {
        incomplete.push(identity);
        break;
      }
      if (visited.has(parentKey)) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: identity-only ownership chain is cyclic`,
        );
      }
      visited.add(parentKey);
      current = parent;
    }
  }
  return { complete, incomplete };
}

function assertIdentityOnlyProcessChains(processes, identityOnlyProcesses) {
  const { incomplete } = classifyIdentityOnlyProcessChains(
    processes,
    identityOnlyProcesses,
  );
  if (incomplete.length > 0) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: identity-only ownership chain is incomplete`,
    );
  }
}

function readOwnershipLedgerSnapshot(
  descriptor,
  { allowUnhealthyForCleanup = false } = {},
) {
  const file = ownershipLedgerPath(descriptor.descriptorPath);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const healthIsUsable =
    value?.healthy === true ||
    (allowUnhealthyForCleanup &&
      value?.healthy === false &&
      typeof value?.failureReason === "string" &&
      value.failureReason.length > 0 &&
      value.failureReason.length <= 512);
  if (
    value?.schemaVersion !== SCHEMA_VERSION ||
    !healthIsUsable ||
    value?.groupId !== descriptor.groupId ||
    value?.hardContainmentKind !== descriptor.hardContainmentKind ||
    value?.leaderKernelStartMarker !== descriptor.leaderKernelStartMarker ||
    value?.leaderStartMarker !== descriptor.leaderStartMarker ||
    value?.livenessWitnessVersion !== descriptor.livenessWitnessVersion ||
    value?.supervisorPid !== descriptor.supervisorPid ||
    value?.supervisorKernelStartMarker !==
      descriptor.supervisorKernelStartMarker ||
    value?.supervisorStartMarker !== descriptor.supervisorStartMarker ||
    (value?.terminateDetachedOwnedGenerations === true) !==
      (descriptor.terminateDetachedOwnedGenerations === true) ||
    !Array.isArray(value?.processes) ||
    value.processes.length > OWNED_PROCESS_GENERATION_LIMIT
  ) {
    const failureReason =
      typeof value?.failureReason === "string" &&
      value.failureReason.length > 0 &&
      value.failureReason.length <= 512
        ? `: ${value.failureReason}`
        : "";
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger is unavailable or unhealthy${failureReason}`,
    );
  }
  const processes = new Map(
    value.processes.map((record) => {
      const validated = ledgerProcess(record);
      return [validated.pid, validated];
    }),
  );
  const rawIdentityOnlyProcesses = value.identityOnlyProcesses ?? [];
  if (
    !Array.isArray(rawIdentityOnlyProcesses) ||
    rawIdentityOnlyProcesses.length > OWNED_PROCESS_GENERATION_LIMIT
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger identity limit exceeded`,
    );
  }
  const identityOnlyProcesses = new Map(
    rawIdentityOnlyProcesses.map((record) => {
      const validated = ledgerIdentityOnlyProcess(record);
      return [validated.pid, validated];
    }),
  );
  if (
    identityOnlyProcesses.size !== rawIdentityOnlyProcesses.length ||
    [...identityOnlyProcesses.keys()].some((pid) => processes.has(pid))
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger has conflicting generations`,
    );
  }
  const deltaView = readOwnershipLedgerDeltas(descriptor);
  for (const entry of deltaView.entries) {
    if (entry.kind === "process") {
      processes.set(entry.value.pid, entry.value);
      identityOnlyProcesses.delete(entry.value.pid);
    } else {
      identityOnlyProcesses.set(entry.value.pid, entry.value);
      processes.delete(entry.value.pid);
    }
  }
  if (
    processes.size + identityOnlyProcesses.size >
      OWNED_PROCESS_GENERATION_LIMIT
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger limit exceeded`,
    );
  }
  return {
    identityOnlyProcesses: [...identityOnlyProcesses.values()].sort(
      (left, right) => left.pid - right.pid,
    ),
    processes: [...processes.values()].sort(
      (left, right) => left.pid - right.pid,
    ),
    publicationComplete: deltaView.publicationComplete,
  };
}

function readOwnershipLedgerView(descriptor, options) {
  const view = readOwnershipLedgerSnapshot(descriptor, options);
  assertIdentityOnlyProcessChains(
    view.processes,
    view.identityOnlyProcesses,
  );
  return view;
}

function readOwnershipLedger(descriptor, options) {
  return readOwnershipLedgerView(descriptor, options).processes;
}

export function readOwnedProcessLedger(descriptor) {
  return readOwnershipLedger(descriptor);
}

export function readOwnedProcessLedgerForCleanup(descriptor) {
  return readOwnershipLedger(descriptor, {
    allowUnhealthyForCleanup: true,
  });
}

export function readOwnedProcessLedgerForRetirement(descriptor) {
  const view = readOwnershipLedgerView(descriptor);
  if (!view.publicationComplete) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: incomplete ownership ledger delta`,
    );
  }
  if (view.identityOnlyProcesses.length > 0) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: identity-only ownership requires exact recovery`,
    );
  }
  return view.processes;
}

function writeOwnershipLedger(
  descriptor,
  processes,
  healthy = true,
  failureReason,
  identityOnlyProcesses = [],
) {
  writeAtomicJson(
    ownershipLedgerPath(descriptor.descriptorPath),
    ownershipLedger(
      descriptor,
      processes,
      healthy,
      failureReason,
      identityOnlyProcesses,
    ),
  );
}

function frozenProcessSnapshot(descriptor, processes) {
  return {
    groupId: descriptor.groupId,
    ...(descriptor.hardContainmentKind
      ? { hardContainmentKind: descriptor.hardContainmentKind }
      : {}),
    leaderKernelStartMarker: descriptor.leaderKernelStartMarker,
    leaderPid: descriptor.leaderPid,
    leaderStartMarker: descriptor.leaderStartMarker,
    processes: processes
      .map(({
        groupId,
        kernelStartMarker,
        parentPid,
        pid,
        sessionId,
        startMarker,
      }) => ({
        groupId,
        kernelStartMarker,
        parentPid,
        pid,
        sessionId,
        startMarker,
      }))
      .sort((left, right) => left.pid - right.pid),
    schemaVersion: SCHEMA_VERSION,
    livenessWitnessVersion: descriptor.livenessWitnessVersion,
    supervisorPid: descriptor.supervisorPid,
    supervisorKernelStartMarker: descriptor.supervisorKernelStartMarker,
    supervisorStartMarker: descriptor.supervisorStartMarker,
    terminateDetachedOwnedGenerations:
      descriptor.terminateDetachedOwnedGenerations === true,
  };
}

function writeAtomicJson(destination, value) {
  const target = path.resolve(destination);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeNewAtomicJson(destination, value) {
  const target = path.resolve(destination);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    fs.linkSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function publishFrozenTerminationRequest(descriptor, frozen) {
  const requestPath = frozenTerminationRequestPath(descriptor.descriptorPath);
  const request = frozenProcessSnapshot(descriptor, frozen.processes);
  try {
    writeNewAtomicJson(requestPath, request);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readFrozenProcessTree(requestPath, descriptor);
    if (
      JSON.stringify(frozenProcessSnapshot(descriptor, existing.processes)) !==
      JSON.stringify(request)
    ) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: conflicting frozen termination request`,
        { cause: error },
      );
    }
  }
}

function readFrozenTerminationRequest(descriptor) {
  try {
    return readFrozenProcessTree(
      frozenTerminationRequestPath(descriptor.descriptorPath),
      descriptor,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function freezeOwnedProcessTree(
  descriptor,
  {
    includeDetachedOwnedGenerations = true,
    observeMembers = observeProcessMembers,
    processController: injectedProcessController,
    publishFrozen = () => {},
    readLedger = readOwnershipLedger,
    signalExact = signalExactProcess,
    wait = sleep,
  } = {},
) {
  if (
    !descriptor.leaderKernelStartMarker ||
    !descriptor.leaderStartMarker ||
    !descriptor.supervisorStartMarker
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: descriptor has incomplete process generations`,
    );
  }
  assertSafeGroup(descriptor.groupId);
  const processController =
    injectedProcessController ??
    exactProcessControllerForDescriptor(descriptor.descriptorPath);
  const deadline = performance.now() + STARTUP_HANDSHAKE_WAIT_MS;
  const allowsDetachedExactSignals =
    includeDetachedOwnedGenerations &&
    descriptor.terminateDetachedOwnedGenerations === true;
  const stoppedByCleanup = new Map();
  const observePoints = async (pids, label) => {
    const requestedPids = canonicalPids(pids);
    return observationMembers(
      await observeMembers(
        { kind: "point", pids: requestedPids },
        observationTimeout(deadline),
      ),
      { kind: "point", requestedPids },
      label,
    );
  };
  const stopOwnedGeneration = (expected, observed) => {
    if (
      observed &&
      observed.groupId !== descriptor.groupId &&
      !allowsDetachedExactSignals
    ) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: owned group changed before exact signal`,
      );
    }
    if (!observed || processIsStopped(observed)) return false;
    const stopped = signalExact(expected, "SIGSTOP", {
      member: observed,
      signalGeneration: processController.signalGeneration,
    });
    if (stopped) stoppedByCleanup.set(expected.pid, expected);
    return stopped;
  };
  const expectedLeader = {
    kernelStartMarker: descriptor.leaderKernelStartMarker,
    pid: descriptor.leaderPid,
    startMarker: descriptor.leaderStartMarker,
  };
  const rollbackFreeze = () => {
    const failures = [];
    const ordered = exactTerminationOrder(
      stoppedByCleanup.values(),
      descriptor.leaderPid,
    );
    for (const expected of ordered) {
      try {
        processController.signalGeneration(expected, "SIGCONT");
      } catch (error) {
        failures.push({ error, identity: String(expected.pid) });
      }
    }
    return failures;
  };

  try {
    const historical = readLedger(descriptor);
    const captured = new Map(
      historical.map((record) => [record.pid, record]),
    );
    const initial = await observeProcessClosureCandidates(
      descriptor,
      captured.values(),
      observeMembers,
      deadline,
    );
    let leaderState = classifyOwnedProcess(
      expectedLeader,
      initial,
      "the process group leader",
    );
    let leader = leaderState.member;
    const requiresLeaderAnchor = Boolean(leader);
    if (leaderState.kind === "reused") {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: process group leader generation changed`,
      );
    }
    if (leader) {
      if (leader.groupId !== descriptor.groupId) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: exact leader no longer anchors its process group`,
        );
      }
      stopOwnedGeneration(expectedLeader, leader);
      const leaderStopDeadline = Date.now() + PROCESS_IDENTITY_WAIT_MS;
      while (
        leader &&
        !processIsStopped(leader) &&
        Date.now() < leaderStopDeadline
      ) {
        await wait(POLL_INTERVAL_MS);
        const point = await observePoints(
          [expectedLeader.pid],
          "process group leader stop observation",
        );
        leaderState = classifyOwnedProcess(
          expectedLeader,
          point,
          "the process group leader",
        );
        leader = leaderState.member;
        if (leaderState.kind === "reused") {
          throw new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: process group leader generation changed while stopping`,
          );
        }
      }
      if (leader && !processIsStopped(leader)) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: process group leader did not stop`,
        );
      }
      if (!leader) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: process group lost its exact leader anchor`,
        );
      }
      if (leader) {
        if (leader.groupId !== descriptor.groupId) {
          throw new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: exact leader escaped its group while stopping`,
          );
        }
      }
    }

    let lastOwned = [];
    let lastLedgerUncaptured = [];
    for (let pass = 0; pass < MAX_FREEZE_PASSES; pass += 1) {
      let discovered = false;
      for (const record of readLedger(descriptor)) {
        const previous = captured.get(record.pid);
        if (previous && !samePersistedGeneration(previous, record)) {
          throw new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger reused a process id`,
          );
        }
        if (!previous) {
          captured.set(record.pid, record);
          discovered ||= allowsDetachedExactSignals ||
            record.groupId === descriptor.groupId;
        }
      }
      const candidates = await observeProcessClosureCandidates(
        descriptor,
        captured.values(),
        observeMembers,
        deadline,
      );
      const exactLeaderState = classifyOwnedProcess(
        expectedLeader,
        candidates,
        "the process group leader",
      );
      const exactLeader = exactLeaderState.member;
      if (exactLeaderState.kind === "reused") {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: process group leader generation changed during freeze`,
        );
      }
      if (requiresLeaderAnchor && !exactLeader) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: process group lost its exact leader anchor`,
        );
      }
      const owned = ownedProcessClosure(
        descriptor.groupId,
        candidates,
        captured.values(),
        { seedProcessGroup: Boolean(exactLeader) },
      );
      for (const member of owned) {
        const previous = captured.get(member.pid);
        if (
          previous &&
          classifyOwnedProcess(
            previous,
            [member],
            "an owned process generation",
          ).kind !== "current"
        ) {
          throw new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: owned process generation changed during freeze`,
          );
        }
        const ownedGeneration = ownedProcessFromMember(member, previous);
        if (!previous || !sameOwnedMetadata(previous, ownedGeneration)) {
          captured.set(member.pid, ownedGeneration);
          discovered ||= allowsDetachedExactSignals ||
            member.groupId === descriptor.groupId;
        }
        if (
          (member.groupId === descriptor.groupId ||
            allowsDetachedExactSignals) &&
          !processIsStopped(member)
        ) {
          stopOwnedGeneration(ownedGeneration, member);
        }
      }
      await wait(POLL_INTERVAL_MS);
      const settledCandidates = await observeProcessClosureCandidates(
        descriptor,
        captured.values(),
        observeMembers,
        deadline,
      );
      const settledLeaderState = classifyOwnedProcess(
        expectedLeader,
        settledCandidates,
        "the process group leader",
      );
      const settledLeader = settledLeaderState.member;
      if (settledLeaderState.kind === "reused") {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: process group leader generation changed after freeze`,
        );
      }
      if (requiresLeaderAnchor && !settledLeader) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: process group lost its exact leader anchor`,
        );
      }
      const settled = ownedProcessClosure(
        descriptor.groupId,
        settledCandidates,
        captured.values(),
        { seedProcessGroup: Boolean(settledLeader) },
      );
      for (const [pid, expected] of stoppedByCleanup) {
        const observed = classifyOwnedProcess(
          expected,
          settled,
          "a stopped owned process",
        ).member;
        if (!observed) {
          stoppedByCleanup.delete(pid);
          continue;
        }
        if (
          observed.groupId !== descriptor.groupId &&
          !allowsDetachedExactSignals
        ) {
          throw new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: exact process escaped its group while stopping`,
          );
        }
      }
      const currentContained = allowsDetachedExactSignals
        ? settled
        : settled.filter(({ groupId }) => groupId === descriptor.groupId);
      lastOwned = currentContained;
      const allStopped = currentContained.every(processIsStopped);
      const hasUncaptured = currentContained.some((member) => {
        const previous = captured.get(member.pid);
        return !previous ||
          classifyOwnedProcess(
            previous,
            [member],
            "a captured owned process",
          ).kind !== "current";
      });
      const latestLedger = readLedger(descriptor);
      const ledgerUncaptured = latestLedger.filter((record) => {
        if (
          !allowsDetachedExactSignals &&
          record.groupId !== descriptor.groupId
        ) {
          return false;
        }
        return !samePersistedGeneration(captured.get(record.pid), record);
      });
      lastLedgerUncaptured = ledgerUncaptured;
      if (
        !discovered &&
        !hasUncaptured &&
        ledgerUncaptured.length === 0 &&
        allStopped
      ) {
        const frozen = frozenProcessSnapshot(
          descriptor,
          [...captured.values()].filter(
            (record) =>
              allowsDetachedExactSignals ||
              record.groupId === descriptor.groupId,
          ),
        );
        // Snapshot publication is the commit point for a frozen tree. Keep it
        // inside this transaction so a write/rename failure resumes only the
        // exact generations this invocation stopped before returning an error.
        publishFrozen(frozen);
        return frozen;
      }
    }
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: owned process tree did not quiesce ` +
        `(owned=${lastOwned.map(({ pid, state }) => `${pid}:${state}`).join(",")}; ` +
        `ledger=${lastLedgerUncaptured.map(({ pid }) => pid).join(",")})`,
    );
  } catch (error) {
    const rollbackFailures = rollbackFreeze();
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [
          error,
          ...rollbackFailures.map((failure) => failure.error),
        ],
        `${OWNED_PROCESS_GROUP_ERROR}: freeze rollback failed for exact processes: ` +
          rollbackFailures
            .map((failure) => failure.identity)
            .join(",") +
          `; original=${boundedDiagnostic(
            error instanceof Error ? error.message : error,
          )}`,
      );
    }
    throw error;
  }
}

function validateFrozenProcess(value) {
  return {
    groupId: processMetadataId(value?.groupId, "frozen process group"),
    kernelStartMarker: kernelStartMarker(
      value?.kernelStartMarker,
      "frozen process kernel start marker",
    ),
    parentPid: processMetadataId(value?.parentPid, "frozen process parent"),
    pid: positiveInteger(value?.pid, "frozen process pid"),
    sessionId: processMetadataId(value?.sessionId, "frozen process session"),
    startMarker: processStartMarker(
      value?.startMarker,
      "frozen process start marker",
    ),
  };
}

export function readFrozenProcessTree(file, descriptor) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    value?.schemaVersion !== SCHEMA_VERSION ||
    value?.groupId !== descriptor.groupId ||
    value?.hardContainmentKind !== descriptor.hardContainmentKind ||
    value?.leaderKernelStartMarker !== descriptor.leaderKernelStartMarker ||
    value?.leaderPid !== descriptor.leaderPid ||
    value?.leaderStartMarker !== descriptor.leaderStartMarker ||
    value?.livenessWitnessVersion !== descriptor.livenessWitnessVersion ||
    value?.supervisorPid !== descriptor.supervisorPid ||
    value?.supervisorKernelStartMarker !==
      descriptor.supervisorKernelStartMarker ||
    value?.supervisorStartMarker !== descriptor.supervisorStartMarker ||
    (value?.terminateDetachedOwnedGenerations === true) !==
      (descriptor.terminateDetachedOwnedGenerations === true) ||
    !Array.isArray(value?.processes)
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: invalid frozen process tree`,
    );
  }
  if (value.processes.length > OWNED_PROCESS_GENERATION_LIMIT) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: frozen process tree exceeds generation limit ` +
        `(count=${value.processes.length}; limit=${OWNED_PROCESS_GENERATION_LIMIT})`,
    );
  }
  return {
    ...value,
    processes: value.processes.map(validateFrozenProcess),
  };
}

function liveExactProcesses(expected) {
  const observation = processMemberSnapshots(
    expected.map(({ pid }) => pid),
  );
  if (observation.status !== "complete") {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: exact process exit observation is incomplete: ${observation.reason}`,
    );
  }
  const observedByPid = new Map(
    observation.members.map((member) => [member.pid, member]),
  );
  return expected
    .filter(({ pid, generation }) => classifiedOwnedGeneration(
      generation,
      observedByPid.get(pid),
      "cleanup liveness",
    ).kind === "current")
    .map(({ process }) => process);
}

export function exactTerminationOrder(processes, leaderPid) {
  return [...processes].sort((left, right) => {
    const leaderOrder =
      Number(left.pid === leaderPid) - Number(right.pid === leaderPid);
    return leaderOrder || left.pid - right.pid;
  });
}

async function waitForExactProcessExit(
  processes,
  timeoutMs,
) {
  const expected = processes.map((process) => ({
    pid: positiveInteger(process?.pid, "owned process identity pid"),
    generation: parsedKernelStartMarker(
      process.kernelStartMarker, "owned process kernel start marker",
    ),
    process,
  }));
  // One saturated native observation can consume the entire grace period.
  // Require a small evidence floor so one pre-exit sighting is not terminal;
  // this may extend the wait but never weakens exact-generation matching.
  const MIN_EXIT_OBSERVATIONS = 3;
  const deadline = Date.now() + timeoutMs;
  let observations = 1;
  let live = liveExactProcesses(expected);
  while (
    live.length > 0 &&
    (Date.now() < deadline || observations < MIN_EXIT_OBSERVATIONS)
  ) {
    await sleep(POLL_INTERVAL_MS);
    live = liveExactProcesses(expected);
    observations += 1;
  }
  return live;
}

async function waitForExactKernelGenerations(processes, timeoutMs, isPending) {
  const deadline = Date.now() + timeoutMs;
  let pending = processes.filter(isPending);
  while (pending.length > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    pending = pending.filter(isPending);
  }
  return pending;
}

async function waitForExactKernelGenerationsExit(
  processes,
  timeoutMs,
  processController,
) {
  return waitForExactKernelGenerations(processes, timeoutMs, (expected) =>
    exactGenerationIsLive(
      expected,
      processController,
    ),
  );
}

export async function verifySealedCleanupHandoffExited(
  frozen,
  processController,
  timeoutMs,
) {
  const surviving = await waitForExactKernelGenerationsExit(
    frozen.processes,
    timeoutMs,
    processController,
  );
  if (surviving.length > 0) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: sealed cleanup generations remain live: ` +
        surviving.map(({ pid }) => pid).join(","),
    );
  }
}

async function waitForExactKernelGenerationsStopped(
  processes,
  timeoutMs,
  processController,
) {
  return waitForExactKernelGenerations(
    processes,
    timeoutMs,
    (expected) => processController.generationState(expected) === "running",
  );
}

async function waitForExactKernelGenerationRunning(
  expected,
  timeoutMs,
  processController,
) {
  const deadline = Date.now() + timeoutMs;
  let state = processController.generationState(expected);
  while (state === "quiescent" && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    state = processController.generationState(expected);
  }
  return state;
}

export async function verifyOwnedProcessTreeExited(
  descriptor,
  environment = process.env,
  {
    readLedger = readOwnershipLedger,
    sleepForLedgerStability = sleep,
    waitForExit = waitForExactProcessExit,
  } = {},
) {
  const { killGraceMs, termGraceMs } = gracePeriods(environment);
  const waitMs = termGraceMs + killGraceMs;
  // TERM/KILL grace bounds the processes we signal. The supervisor is the
  // independent ledger producer: after the frozen tree exits it can still be
  // draining observer frames and publishing the final ledger on a saturated
  // self-hosted runner. Keep observing only its exact kernel generation for a
  // longer bounded interval. This cannot adopt a reused PID or authorize an
  // uncertain root retirement; exhausting the bound still fails closed.
  const producerWaitMs = Math.max(
    waitMs,
    ledgerProducerExitGraceMs(environment),
  );
  const liveSupervisor = await waitForExit(
    [
      {
        kernelStartMarker: descriptor.supervisorKernelStartMarker,
        pid: descriptor.supervisorPid,
      },
    ],
    producerWaitMs,
  );
  if (liveSupervisor.length > 0) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger producer is still live after exact-generation wait ` +
        `(pid=${liveSupervisor[0].pid}; timeoutMs=${producerWaitMs})`,
    );
  }
  const historical = readLedger(descriptor);
  await sleepForLedgerStability(POLL_INTERVAL_MS);
  const confirmed = readLedger(descriptor);
  if (JSON.stringify(historical) !== JSON.stringify(confirmed)) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger changed after its producer exited`,
    );
  }
  if (confirmed.length > 0) {
    const surviving = await waitForExit(
      confirmed,
      waitMs,
    );
    if (surviving.length > 0) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: exact owned process generations remain outside the frozen group: ` +
          surviving.map(({ pid }) => pid).join(","),
      );
    }
  }
  return ownedProcessExitReceipt(
    descriptor,
    confirmed,
  );
}

function fileIdentity(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ${label} is not a direct file`,
    );
  }
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function directoryIdentity(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ${label} is not a direct directory`,
    );
  }
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function assertCleanupHandoffProcessAuthority(descriptor, processes) {
  const unauthorized = processes.filter(
    (expected) => expected.groupId !== descriptor.groupId,
  );
  if (
    unauthorized.length > 0 &&
    descriptor.terminateDetachedOwnedGenerations !== true
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: cleanup handoff cannot own detached generations: ` +
        unauthorized.map(({ pid }) => pid).join(","),
    );
  }
  return processes;
}

function cleanupHandoffProcesses(descriptor, processes, processController) {
  return assertCleanupHandoffProcessAuthority(
    descriptor,
    [...processes].filter((expected) =>
      exactGenerationIsLive(
        expected,
        processController,
      ),
    ),
  );
}

function receiptProcessIdentity(pid, startMarker, kernelStartMarker) {
  return { kernelStartMarker, pid, startMarker };
}

function ownedProcessExitReceipt(
  descriptor,
  confirmed,
) {
  const descriptorPath = path.resolve(descriptor.descriptorPath);
  const stateRoot = path.dirname(descriptorPath);
  const hardContainmentKind =
    descriptor.terminateDetachedOwnedGenerations === true &&
    descriptor.hardContainmentKind ===
      HARD_CONTAINMENT_KINDS.get(process.platform)
      ? descriptor.hardContainmentKind
      : undefined;
  return {
    capability: hardContainmentKind
      ? HARD_PROCESS_CONTAINMENT_CAPABILITY
      : "exact_process_observation_v1",
    descriptor: {
      groupId: descriptor.groupId,
      identity: fileIdentity(descriptorPath, "process descriptor"),
      leader: receiptProcessIdentity(
        descriptor.leaderPid,
        descriptor.leaderStartMarker,
        descriptor.leaderKernelStartMarker,
      ),
      name: path.basename(descriptorPath),
      supervisor: receiptProcessIdentity(
        descriptor.supervisorPid,
        descriptor.supervisorStartMarker,
        descriptor.supervisorKernelStartMarker,
      ),
    },
    ownedGenerations: {
      count: confirmed.length,
      digest: ownedProcessGenerationDigestV1(confirmed),
      ledgerIdentity: fileIdentity(
        ownershipLedgerPath(descriptorPath),
        "ownership ledger",
      ),
    },
    ...(hardContainmentKind
      ? {
          hardContainment: {
            generationAtomicSignals: true,
            kind: hardContainmentKind,
          },
        }
      : {}),
    platform: process.platform,
    schema: OWNED_PROCESS_EXIT_RECEIPT_SCHEMA,
    stateRootIdentity: directoryIdentity(stateRoot, "process state root"),
  };
}

async function observeFrozenOwnedProcessTree(
  descriptor,
  frozen,
  observeMembers = observeProcessMembers,
  ownedProcesses,
) {
  const allowsDetachedExactSignals =
    descriptor.terminateDetachedOwnedGenerations === true;
  const requestedPids = canonicalPids(
    [...frozen.processes, ...(ownedProcesses ?? [])].map(({ pid }) => pid),
  );
  const members = observationMembers(
    await observeMembers(
      { kind: "point", pids: requestedPids },
      { timeoutMs: STARTUP_HANDSHAKE_WAIT_MS },
    ),
    { kind: "point", requestedPids },
    "frozen process observation",
  );
  const live = frozen.processes.flatMap((expected) => {
    const member = classifyOwnedProcess(
      expected,
      members,
      "frozen process termination",
    ).member;
    return member ? [{ expected, member }] : [];
  });
  if (ownedProcesses) {
    const leader = classifyOwnedProcess(
      {
        kernelStartMarker: descriptor.leaderKernelStartMarker,
        pid: descriptor.leaderPid,
        startMarker: descriptor.leaderStartMarker,
      },
      members,
      "frozen command leader",
    );
    const owned = ownedProcessClosure(
      descriptor.groupId,
      members,
      ownedProcesses,
      { seedProcessGroup: leader.kind === "current" },
    );
    const ownedPids = new Set(owned.map(({ pid }) => pid));
    const requested = new Set(live.map(({ member }) => member.pid));
    if (
      requested.size !== ownedPids.size ||
      [...requested].some((pid) => !ownedPids.has(pid))
    ) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: frozen command does not match current owned targets`,
      );
    }
  }
  if (live.length === 0) return live;
  const detached = live.filter(
    ({ member }) => member.groupId !== descriptor.groupId,
  );
  if (detached.length > 0 && !allowsDetachedExactSignals) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: refusing exact KILL for detached ` +
        `owned processes without kernel containment: ` +
        detached.map(({ member }) => member.pid).join(","),
    );
  }
  if (
    !live.every(({ member }) => {
      return (
        processIsStopped(member) &&
        (allowsDetachedExactSignals ||
          member.groupId === descriptor.groupId)
      );
    })
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: owned group changed after its frozen snapshot`,
    );
  }
  return live;
}

export async function terminateFrozenOwnedProcessTree(
  descriptor,
  frozen,
  environment = process.env,
  {
    observeMembers = observeProcessMembers,
    ownedProcesses,
    processController: injectedProcessController,
    signalExact = signalExactProcess,
    waitForExit = waitForExactProcessExit,
  } = {},
) {
  const { killGraceMs } = gracePeriods(environment);
  const processController =
    injectedProcessController ??
    exactProcessControllerForDescriptor(descriptor.descriptorPath);
  const live = await observeFrozenOwnedProcessTree(
    descriptor,
    frozen,
    observeMembers,
    ownedProcesses,
  );
  if (live.length === 0) return;
  // The observation above proved every target stopped; each signal revalidates its
  // exact generation at the native boundary. Keep the leader until last so its
  // supervisor cannot race the remaining cleanup.
  const byPid = new Map(
    live.map(({ expected, member }) => [expected.pid, member]),
  );
  const targets = live.map(({ expected }) => expected);
  for (const expected of exactTerminationOrder(
    targets,
    descriptor.leaderPid,
  )) {
    signalExact(expected, "SIGKILL", {
      member: byPid.get(expected.pid),
      signalGeneration: processController.signalGeneration,
    });
  }
  const useKernelGenerationWait =
    waitForExit === waitForExactProcessExit;
  const surviving = useKernelGenerationWait
    ? await waitForExactKernelGenerationsExit(
        targets,
        killGraceMs,
        processController,
      )
    : await waitForExit(targets, killGraceMs);
  if (surviving.length > 0) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: exact owned processes survived SIGKILL: ` +
        surviving.map(({ pid }) => pid).join(","),
    );
  }
}

export async function terminateOwnedProcessGroup(
  exactLeader,
  {
    environment = process.env,
    timeoutMs,
  } = {},
) {
  const { killGraceMs, termGraceMs } = gracePeriods(environment);
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: invalid exact process-group timeout`,
    );
  }
  return retireExactLeaderProcessGroup(exactLeader, {
    timeoutMs: Math.min(
      killGraceMs + termGraceMs,
      timeoutMs ?? Number.POSITIVE_INFINITY,
    ),
  });
}

function validateDescriptor(value, expectedSupervisorPid) {
  if (
    value?.schemaVersion !== SCHEMA_VERSION ||
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: invalid process group descriptor`,
    );
  }
  const groupId = positiveInteger(value.groupId, "descriptor process group");
  const leaderPid = positiveInteger(value.leaderPid, "descriptor leader");
  const supervisorPid = positiveInteger(
    value.supervisorPid,
    "descriptor supervisor",
  );
  const leaderStartMarker =
    value.leaderStartMarker === undefined
      ? undefined
      : processStartMarker(
          value.leaderStartMarker,
          "descriptor leader start marker",
        );
  const leaderKernelStartMarker =
    value.leaderKernelStartMarker === undefined
      ? undefined
      : kernelStartMarker(
          value.leaderKernelStartMarker,
          "descriptor leader kernel start marker",
        );
  const supervisorStartMarker =
    value.supervisorStartMarker === undefined
      ? undefined
      : processStartMarker(
          value.supervisorStartMarker,
          "descriptor supervisor start marker",
        );
  const supervisorKernelStartMarker =
    value.supervisorKernelStartMarker === undefined
      ? undefined
      : kernelStartMarker(
          value.supervisorKernelStartMarker,
          "descriptor supervisor kernel start marker",
        );
  if (value.livenessWitnessVersion !== LIVENESS_WITNESS_VERSION) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: descriptor has no supported liveness witness`,
    );
  }
  const terminateDetachedOwnedGenerations =
    value.terminateDetachedOwnedGenerations === true;
  const hardContainmentKind = value.hardContainmentKind;
  if (
    hardContainmentKind !== undefined &&
    ![...HARD_CONTAINMENT_KINDS.values()].includes(hardContainmentKind)
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: descriptor has an unsupported hard containment boundary`,
    );
  }
  if (groupId !== leaderPid) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: leader does not own its process group`,
    );
  }
  if (
    expectedSupervisorPid !== undefined &&
    supervisorPid !== positiveInteger(expectedSupervisorPid, "expected supervisor")
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: supervisor identity does not match`,
    );
  }
  return {
    groupId,
    hardContainmentKind,
    leaderKernelStartMarker,
    leaderPid,
    leaderStartMarker,
    livenessWitnessVersion: value.livenessWitnessVersion,
    schemaVersion: SCHEMA_VERSION,
    supervisorPid,
    supervisorKernelStartMarker,
    supervisorStartMarker,
    terminateDetachedOwnedGenerations,
  };
}

export function readOwnedProcessGroup(
  descriptorPath,
  expectedSupervisorPid,
) {
  const value = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  return {
    ...validateDescriptor(value, expectedSupervisorPid),
    descriptorPath: path.resolve(descriptorPath),
  };
}

function writeDescriptor(descriptorPath, descriptor) {
  if (fs.existsSync(descriptorPath)) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: descriptor already exists`,
    );
  }
  writeNewAtomicJson(descriptorPath, descriptor);
}

function assertOwnedDescriptorCurrent(descriptorPath, expected) {
  if (!fs.existsSync(descriptorPath)) return undefined;
  let current;
  try {
    current = readOwnedProcessGroup(descriptorPath, expected.supervisorPid);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (current.groupId !== expected.groupId) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: refusing to remove a replacement descriptor`,
    );
  }
  if (
    expected.leaderStartMarker &&
    current.leaderStartMarker !== expected.leaderStartMarker
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: refusing to remove a replacement descriptor generation`,
    );
  }
  if (
    expected.leaderKernelStartMarker &&
    current.leaderKernelStartMarker !== expected.leaderKernelStartMarker
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: refusing to remove a replacement kernel generation`,
    );
  }
  if (
    expected.supervisorStartMarker &&
    current.supervisorStartMarker !== expected.supervisorStartMarker
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: refusing to remove a replacement supervisor generation`,
    );
  }
  if (
    expected.supervisorKernelStartMarker &&
    current.supervisorKernelStartMarker !==
      expected.supervisorKernelStartMarker
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: refusing to remove a replacement supervisor kernel generation`,
    );
  }
  return current;
}

function removeOwnedDescriptor(descriptorPath, expected) {
  if (!assertOwnedDescriptorCurrent(descriptorPath, expected)) return;
  removeOwnershipLedgerDeltas(descriptorPath);
  fs.rmSync(descriptorPath, { force: true });
  fs.rmSync(ownershipLedgerPath(descriptorPath), { force: true });
  fs.rmSync(macosProcessMarkerToolPath(descriptorPath), { force: true });
  fs.rmSync(cleanupHandoffSnapshotPath(descriptorPath), { force: true });
  fs.rmSync(frozenTerminationRequestPath(descriptorPath), { force: true });
}

function signalExitCode(signal) {
  const number = os.constants.signals[signal];
  return Number.isInteger(number) ? 128 + number : 1;
}

export async function startOwnershipLedgerSampler(
  descriptor,
  initialProcesses,
  continuousOwnershipSampling,
  {
    observeIdentities = observeCurrentUserProcessIdentities,
    observeMembers = observeProcessMembers,
    processController: injectedProcessController,
    startNativeObserver =
      process.platform === "darwin"
        ? startMacosOwnershipObserverProcess
        : undefined,
  } = {},
) {
  const processController =
    injectedProcessController ??
    exactProcessControllerForDescriptor(descriptor.descriptorPath);
  const known = new Map(
    initialProcesses.map((record) => [record.pid, ledgerProcess(record)]),
  );
  const identityOnly = new Map();
  let failure;
  let reportTerminalFailure;
  const terminalFailure = new Promise((resolve) => {
    reportTerminalFailure = resolve;
  });
  let stopped = false;
  let sealed = false;
  let nativeObserver;
  let injectedRuntimeFailureTimer;
  let ledgerDeltaSequence = 0;

  const checkpointLedger = (healthy = true, failureReason) => {
    writeOwnershipLedger(
      descriptor,
      known.values(),
      healthy,
      failureReason,
      identityOnly.values(),
    );
    removeOwnershipLedgerDeltas(descriptor.descriptorPath);
    ledgerDeltaSequence = 0;
  };

  const expireStoppedIdentityOnlyProcesses = async () => {
    if (
      process.platform !== "darwin" ||
      descriptor.terminateDetachedOwnedGenerations === true ||
      identityOnly.size === 0
    ) {
      return;
    }
    const current = identityOwnedRelations(
      [...identityOnly.values()].map(
        (record) => exactOwnedProcessIdentity(record).processIdentity,
      ),
      await observeIdentities({
        platform: process.platform,
        timeoutMs: STARTUP_HANDSHAKE_WAIT_MS,
      }),
      process.geteuid?.(),
    );
    if (current.length === 0) identityOnly.clear();
  };

  const markUnhealthy = (error) => {
    if (sealed || stopped) return;
    if (!failure) {
      failure = error;
      reportTerminalFailure(error);
    }
    try {
      const failureReason = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 512);
      checkpointLedger(false, failureReason);
    } catch {
      // The original sampling failure remains the authoritative reason that
      // cleanup cannot claim exact ownership.
    }
  };

  let sampleInFlight;
  const sample = () => {
    if (sampleInFlight) return sampleInFlight;
    sampleInFlight = (async () => {
      if (failure || stopped || sealed) return;
      try {
        const historical = [...known.values()];
        const candidates = await observeProcessClosureCandidates(
          descriptor,
          historical,
          observeMembers,
          performance.now() + STARTUP_HANDSHAKE_WAIT_MS,
        );
        if (failure || stopped || sealed) return;
        const expectedLeader = {
          kernelStartMarker: descriptor.leaderKernelStartMarker,
          pid: descriptor.leaderPid,
          startMarker: descriptor.leaderStartMarker,
        };
        const leaderState = classifyOwnedProcess(
          expectedLeader,
          candidates,
          "ownership sampling",
        );
        if (leaderState.kind === "reused") {
          throw new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: process group leader generation changed while sampling`,
          );
        }
        const owned = ownedProcessClosure(
          descriptor.groupId,
          candidates,
          historical,
          { seedProcessGroup: leaderState.kind === "current" },
        );
        let changed = false;
        for (const member of owned) {
          const previous = known.get(member.pid);
          const sameGeneration = previous && classifyOwnedProcess(
            previous,
            [member],
            "ownership sampling",
          ).kind === "current";
          const observed = ownedProcessFromMember(
            member,
            sameGeneration ? previous : undefined,
          );
          if (!sameOwnedMetadata(previous, observed)) {
            known.set(member.pid, ledgerProcess(observed));
            identityOnly.delete(member.pid);
            changed = true;
            if (
              known.size + identityOnly.size >
                OWNED_PROCESS_GENERATION_LIMIT
            ) {
              throw new Error(
                `${OWNED_PROCESS_GROUP_ERROR}: ownership ledger limit exceeded`,
              );
            }
          }
        }
        if (changed) checkpointLedger();
      } catch (error) {
        markUnhealthy(error);
      }
    })().finally(() => {
      sampleInFlight = undefined;
    });
    return sampleInFlight;
  };

  const admit = (record) => {
    if (failure || stopped || sealed) return;
    const previous = known.get(record.pid);
    if (
      previous &&
      previous.startMarker === record.startMarker &&
      previous.kernelStartMarker === record.kernelStartMarker &&
      previous.parentPid === record.parentPid &&
      previous.groupId === record.groupId &&
      previous.sessionId === record.sessionId
    ) {
      return;
    }
    known.set(record.pid, ledgerProcess(record));
    identityOnly.delete(record.pid);
    if (known.size + identityOnly.size > OWNED_PROCESS_GENERATION_LIMIT) {
      markUnhealthy(
        new Error(`${OWNED_PROCESS_GROUP_ERROR}: ownership ledger limit exceeded`),
      );
      return;
    }
    ledgerDeltaSequence += 1;
    writeOwnershipLedgerDelta(descriptor, record, ledgerDeltaSequence);
  };

  const admitIdentity = (record) => {
    if (failure || stopped || sealed) return;
    const validated = ledgerIdentityOnlyProcess(record);
    const full = known.get(validated.pid);
    if (full?.kernelStartMarker === validated.kernelStartMarker) return;
    const previous = identityOnly.get(validated.pid);
    if (
      previous?.kernelStartMarker === validated.kernelStartMarker &&
      previous.parentPid === validated.parentPid &&
      previous.parentKernelStartMarker === validated.parentKernelStartMarker
    ) {
      return;
    }
    known.delete(validated.pid);
    identityOnly.set(validated.pid, validated);
    if (known.size + identityOnly.size > OWNED_PROCESS_GENERATION_LIMIT) {
      markUnhealthy(
        new Error(`${OWNED_PROCESS_GROUP_ERROR}: ownership ledger limit exceeded`),
      );
      return;
    }
    ledgerDeltaSequence += 1;
    writeOwnershipIdentityDelta(
      descriptor,
      validated,
      ledgerDeltaSequence,
    );
  };

  checkpointLedger();
  await sample();
  if (failure) throw failure;
  let timer;
  const scheduleNextSample = () => {
    timer = setTimeout(() => {
      void sample().then(() => {
        if (!failure && !stopped && !sealed) scheduleNextSample();
      });
    }, POLL_INTERVAL_MS);
  };
  if (continuousOwnershipSampling && startNativeObserver) {
    nativeObserver = startNativeObserver(
      descriptor,
      known,
      { admit, fail: markUnhealthy, seal: admitIdentity },
    );
    try {
      await nativeObserver.ready();
    } catch (error) {
      markUnhealthy(error);
      throw error;
    }
    if (
      process.env.NODE_ENV === "test" &&
      qaEnvironmentValue(
        process.env,
        "TEST_OWNERSHIP_MONITOR_RUNTIME_FAILURE",
      ) === "1" &&
      qaEnvironmentValue(
        process.env,
        "TEST_REQUEST_TERMINATION_BEFORE_MONITOR_FAILURE",
      ) !== "1"
    ) {
      injectedRuntimeFailureTimer = setTimeout(
        () => {
          markUnhealthy(
            new Error(
              `${OWNED_PROCESS_GROUP_ERROR}: injected ownership monitor runtime failure`,
            ),
          );
        },
        50,
      );
    }
  } else if (continuousOwnershipSampling) {
    scheduleNextSample();
  }
  return {
    terminalFailure,
    async admitCommandGate(expected) {
      if (nativeObserver) await nativeObserver.barrier();
      else {
        // An in-flight census may predate the command's startup handshake.
        // Finish it, then observe again before deciding command ownership.
        if (sampleInFlight) await sampleInFlight;
        await sample();
      }
      if (failure) throw failure;
      const observed = known.get(expected.pid);
      const leader = known.get(descriptor.leaderPid);
      if (
        !observed ||
        !leader ||
        observed.groupId !== descriptor.groupId ||
        observed.parentPid !== descriptor.leaderPid
      ) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: command gate was not admitted by the ownership observer`,
        );
      }
      if (process.env.NODE_ENV === "test") {
        const admissionDelayMs = boundedMilliseconds(
          qaEnvironmentValue(
            process.env,
            "TEST_COMMAND_GATE_ADMISSION_DELAY_MS",
          ),
          0,
          "DURE_QA_TEST_COMMAND_GATE_ADMISSION_DELAY_MS",
        );
        if (admissionDelayMs > 0) {
          fs.writeFileSync(
            `${descriptor.descriptorPath}.command-gate-admission`,
            `${expected.pid}\n`,
            { flag: "wx", mode: 0o600 },
          );
          await sleep(admissionDelayMs);
        }
      }
      return observed;
    },
    assertHealthy() {
      if (failure) throw failure;
    },
    invalidate(error) {
      markUnhealthy(error);
    },
    async sealCleanupHandoff(publishFrozen) {
      if (stopped) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: ownership monitor is already stopped`,
        );
      }
      if (failure) throw failure;
      if (
        process.platform === "linux" &&
        descriptor.terminateDetachedOwnedGenerations === true &&
        descriptor.hardContainmentKind !==
          HARD_CONTAINMENT_KINDS.get("linux")
      ) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: Linux cleanup handoff requires subreaper containment`,
        );
      }
      const settleIdentityOnly = async () => {
        const deadline = Date.now() + PROCESS_IDENTITY_WAIT_MS;
        while (true) {
          if (nativeObserver) await nativeObserver.barrier();
          else await sample();
          if (failure) throw failure;
          for (const expected of identityOnly.values()) {
            if (processController.generationState(expected) === "gone") {
              identityOnly.delete(expected.pid);
            }
          }
          if (identityOnly.size === 0) return;
          if (Date.now() >= deadline) {
            throw new Error(
              `${OWNED_PROCESS_GROUP_ERROR}: live identity-only ownership remained unresolved while sealing cleanup handoff`,
            );
          }
          await sleep(POLL_INTERVAL_MS);
        }
      };
      const stoppedBySeal = new Map();
      try {
        for (let pass = 0; pass < MAX_FREEZE_PASSES; pass += 1) {
          await settleIdentityOnly();
          const before = cleanupHandoffProcesses(
            descriptor,
            known.values(),
            processController,
          );
          if (!before.some(({ pid }) => pid === descriptor.leaderPid)) {
            throw new Error(
              `${OWNED_PROCESS_GROUP_ERROR}: cleanup handoff lost its exact lead`,
            );
          }
          if (
            process.env.NODE_ENV === "test" &&
            qaEnvironmentValue(
              process.env,
              "TEST_CLEANUP_HANDOFF_SEAL_FAILURE",
            ) === "1"
          ) {
            throw new Error(
              `${OWNED_PROCESS_GROUP_ERROR}: injected cleanup handoff seal failure`,
            );
          }
          const lateForkTrigger = qaEnvironmentValue(
            process.env,
            "TEST_CLEANUP_HANDOFF_LATE_FORK_TRIGGER",
          );
          if (
            pass === 0 &&
            process.env.NODE_ENV === "test" &&
            lateForkTrigger
          ) {
            if (!path.isAbsolute(lateForkTrigger)) {
              throw new Error(
                `${OWNED_PROCESS_GROUP_ERROR}: late-fork trigger must be absolute`,
              );
            }
            const acknowledgement = `${lateForkTrigger}.ack`;
            fs.writeFileSync(lateForkTrigger, "fork\n", {
              flag: "wx",
              mode: 0o600,
            });
            const deadline = Date.now() + PROCESS_IDENTITY_WAIT_MS;
            while (!fs.existsSync(acknowledgement) && Date.now() < deadline) {
              await sleep(POLL_INTERVAL_MS);
            }
            if (!fs.existsSync(acknowledgement)) {
              throw new Error(
                `${OWNED_PROCESS_GROUP_ERROR}: late-fork fixture was not acknowledged`,
              );
            }
          }
          const nonLeaders = exactTerminationOrder(
            before,
            descriptor.leaderPid,
          ).filter(({ pid }) => pid !== descriptor.leaderPid);
          for (const expected of nonLeaders) {
            const state = processController.generationState(expected);
            if (state !== "running") continue;
            if (processController.signalGeneration(expected, "SIGSTOP")) {
              stoppedBySeal.set(expected.pid, expected);
            }
          }
          const running = await waitForExactKernelGenerationsStopped(
            nonLeaders,
            gracePeriods(process.env).termGraceMs,
            processController,
          );
          if (running.length > 0) {
            throw new Error(
              `${OWNED_PROCESS_GROUP_ERROR}: cleanup handoff generations did not stop: ` +
                running.map(({ pid }) => pid).join(","),
            );
          }
          await settleIdentityOnly();
          const sealedProcesses = cleanupHandoffProcesses(
            descriptor,
            known.values(),
            processController,
          );
          if (
            ownedProcessGenerationDigestV1(before) ===
            ownedProcessGenerationDigestV1(sealedProcesses)
          ) {
            const frozen = frozenProcessSnapshot(
              descriptor,
              sealedProcesses,
            );
            clearTimeout(timer);
            sealed = true;
            try {
              checkpointLedger();
              publishFrozen(frozen);
            } catch (error) {
              sealed = false;
              if (
                continuousOwnershipSampling &&
                !nativeObserver &&
                !failure &&
                !stopped
              ) {
                scheduleNextSample();
              }
              throw error;
            }
            return Object.freeze({ frozen, kind: "sealed-cleanup-handoff" });
          }
        }
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: ownership changed while sealing cleanup handoff`,
        );
      } catch (error) {
        const rollbackFailures = [];
        for (const expected of exactTerminationOrder(
          stoppedBySeal.values(),
          descriptor.leaderPid,
        )) {
          try {
            processController.signalGeneration(expected, "SIGCONT");
          } catch (rollbackFailure) {
            rollbackFailures.push(rollbackFailure);
          }
        }
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [error, ...rollbackFailures],
            `${OWNED_PROCESS_GROUP_ERROR}: cleanup handoff seal and rollback both failed`,
          );
        }
        throw error;
      }
    },
    async stop() {
      if (stopped) {
        if (failure) throw failure;
        return;
      }
      clearTimeout(timer);
      clearTimeout(injectedRuntimeFailureTimer);
      if (
        process.env.NODE_ENV === "test" &&
        qaEnvironmentValue(
          process.env,
          "TEST_OWNERSHIP_MONITOR_STOP_FAILURE",
        ) === "1"
      ) {
        const injectedStopFailure = new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: injected ownership monitor stop failure`,
        );
        if (sealed) {
          failure ??= injectedStopFailure;
          reportTerminalFailure(failure);
        } else {
          markUnhealthy(injectedStopFailure);
        }
      }
      if (nativeObserver) await nativeObserver.stop();
      else if (!sealed) await sample();
      stopped = true;
      clearTimeout(timer);
      if (failure) throw failure;
      if (!sealed) {
        try {
          await expireStoppedIdentityOnlyProcesses();
        } catch (error) {
          failure = error;
          reportTerminalFailure(error);
          throw error;
        }
        checkpointLedger();
      }
    },
  };
}

export async function recoverIdentityOnlyOwnedProcessTree(
  descriptor,
  {
    assertAuthorityCurrent = () => {},
    environment = process.env,
    observeIdentities = observeCurrentUserProcessIdentities,
    platform = process.platform,
    signalGeneration = signalProcessGenerationSync,
    wait = sleep,
  } = {},
) {
  assertAuthorityCurrent();
  // Group-only cleanup leaves seals with the producer. Its final closed census
  // may expire them after it stops; they never authorize detached signals.
  if (descriptor.terminateDetachedOwnedGenerations !== true) return false;
  const view = readOwnershipLedgerSnapshot(descriptor, {
    allowUnhealthyForCleanup: true,
  });
  if (view.identityOnlyProcesses.length === 0) return false;
  if (!view.publicationComplete) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: incomplete identity-only ownership delta`,
    );
  }
  if (platform !== "darwin") {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: identity-only ownership recovery is unsupported`,
    );
  }

  const chains = classifyIdentityOnlyProcessChains(
    view.processes,
    view.identityOnlyProcesses,
  );
  const effectiveUid = process.geteuid?.();
  const observeIdentityCensus = ({ timeoutMs }) =>
    observeIdentities({ platform, timeoutMs });
  if (chains.incomplete.length > 0) {
    // A boot-bound generation missing from a closed census cannot return or
    // fork. Its empty current closure is therefore safe to expire even when a
    // later owned generation reused the recorded parent PID.
    const currentUnresolved = identityOwnedRelations(
      chains.incomplete.map(
        (record) => exactOwnedProcessIdentity(record).processIdentity,
      ),
      await observeIdentityCensus({ timeoutMs: STARTUP_HANDSHAKE_WAIT_MS }),
      effectiveUid,
    );
    assertAuthorityCurrent();
    if (currentUnresolved.length > 0) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: identity-only ownership chain is incomplete`,
      );
    }
  }

  await terminateIdentityOwnedTree({
    assertCurrent: assertAuthorityCurrent,
    effectiveUid,
    killGraceMs: gracePeriods(environment).killGraceMs,
    leaderPid: descriptor.leaderPid,
    maxPasses: MAX_FREEZE_PASSES,
    observe: observeIdentityCensus,
    pollIntervalMs: POLL_INTERVAL_MS,
    seedIdentities: [...view.processes, ...chains.complete].map(
      (record) => exactOwnedProcessIdentity(record).processIdentity,
    ),
    signal: signalGeneration,
    timeoutMs: STARTUP_HANDSHAKE_WAIT_MS,
    wait,
  });

  assertAuthorityCurrent();
  writeOwnershipLedger(descriptor, view.processes);
  removeOwnershipLedgerDeltas(descriptor.descriptorPath);
  return true;
}

async function terminateOwnedDescriptorProcesses(
  descriptor,
  { allowUnhealthyLedger = false } = {},
) {
  if (
    process.env.NODE_ENV === "test" &&
    qaEnvironmentValue(
      process.env,
      "TEST_EXACT_TERMINATION_FAILURE",
    ) === "1"
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: injected exact termination failure`,
    );
  }
  const requested = readFrozenTerminationRequest(descriptor);
  if (requested) {
    // The caller already froze this exact tree. Consume its command input
    // without reopening an unrelated whole-user census in the live owner.
    await terminateFrozenOwnedProcessTree(descriptor, requested, process.env, {
      ownedProcesses: readOwnershipLedger(descriptor, {
        allowUnhealthyForCleanup: allowUnhealthyLedger,
      }),
    });
    return;
  }
  if (await recoverIdentityOnlyOwnedProcessTree(descriptor)) return;
  const readLedger = allowUnhealthyLedger
    ? (currentDescriptor) =>
        readOwnershipLedger(currentDescriptor, {
          allowUnhealthyForCleanup: true,
        })
    : readOwnershipLedger;
  const frozen = await freezeOwnedProcessTree(descriptor, { readLedger });
  await terminateFrozenOwnedProcessTree(descriptor, frozen);
}

export async function stopOwnershipMonitorThenCleanup(
  ownershipMonitor,
  cleanup,
) {
  let monitorFailure;
  try {
    await ownershipMonitor.stop();
  } catch (error) {
    monitorFailure = error;
  }

  try {
    await cleanup(monitorFailure);
  } catch (cleanupFailure) {
    if (monitorFailure) {
      throw new AggregateError(
        [monitorFailure, cleanupFailure],
        `${OWNED_PROCESS_GROUP_ERROR}: ownership monitor and cleanup both failed`,
      );
    }
    throw cleanupFailure;
  }

  if (monitorFailure) throw monitorFailure;
}

export async function stopOwnershipMonitorThenHandoffOnTerminationFailure(
  ownershipMonitor,
  terminate,
  sealedHandoff,
) {
  let monitorFailure;
  try {
    await ownershipMonitor.stop();
  } catch (error) {
    monitorFailure = error;
  }

  try {
    await terminate(monitorFailure);
  } catch (terminationFailure) {
    const cause = monitorFailure
      ? new AggregateError(
          [monitorFailure, terminationFailure],
          `${OWNED_PROCESS_GROUP_ERROR}: ownership monitor and termination both failed`,
        )
      : terminationFailure;
    if (sealedHandoff?.kind === "sealed-cleanup-handoff") {
      return new OwnedProcessCleanupHandoffError(cause);
    }
    throw cause;
  }

  if (monitorFailure) throw monitorFailure;
  return undefined;
}

export function releaseLeadForCleanupHandoff(child) {
  child.channel?.unref?.();
  child.stdio?.[LIVENESS_WITNESS_FD]?.unref?.();
  if (child.connected) child.disconnect();
  child.unref();
}

export async function supervise(
  descriptorPath,
  command,
  args,
  {
    beforeWitnessCheck = async () => {},
    commandCancellationPath: requestedCommandCancellationPath,
    commandTimeoutMs: requestedCommandTimeoutMs,
    continuousOwnershipSampling = true,
    hardContainment = false,
    livenessWitnessWaitMs = LIVENESS_WITNESS_WAIT_MS,
    onVerifiedCleanupHandoff,
    publishDescriptor = writeDescriptor,
    removeDescriptorOnExit = false,
    spawnCommand = spawn,
    terminateDetachedOwnedGenerations = false,
  } = {},
) {
  if (!command) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: expected a command after --`,
    );
  }
  const commandTimeoutMs = commandTimeoutMilliseconds(
    requestedCommandTimeoutMs,
  );
  const commandCancellationPath = requestedCommandCancellationPath
    ? path.resolve(requestedCommandCancellationPath)
    : undefined;
  if (commandCancellationPath === path.resolve(descriptorPath)) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: command cancellation path must differ from the descriptor`,
    );
  }
  const launchOwnerPid = process.ppid;
  const processController = exactProcessControllerForDescriptor(
    descriptorPath,
  );
  let launchOwner;
  try {
    launchOwner = await waitForProcessIdentity(launchOwnerPid);
  } catch (error) {
    fs.rmSync(macosProcessMarkerToolPath(descriptorPath), { force: true });
    throw error;
  }
  const leadArguments = [
    fileURLToPath(import.meta.url),
    "lead",
    path.resolve(descriptorPath),
    "--",
    command,
    ...args,
  ];
  const usesLinuxSubreaper = process.platform === "linux" && hardContainment;
  const leadExecutable = usesLinuxSubreaper
    ? "python3"
    : process.execPath;
  const leadExecutableArguments = usesLinuxSubreaper
    ? [
        LINUX_PROCESS_BOUNDARY,
        "subreaper-exec",
        process.execPath,
        ...leadArguments,
      ]
    : leadArguments;
  const child = spawnCommand(leadExecutable, leadExecutableArguments, {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      DURE_QA_LAUNCH_OWNER_KERNEL_START_MARKER:
        launchOwner.kernelStartMarker,
      DURE_QA_LAUNCH_OWNER_PID: String(launchOwner.pid),
      DURE_QA_LAUNCH_OWNER_START_MARKER:
        launchOwner.startMarker,
      DURE_QA_LIVENESS_WITNESS_FD: String(LIVENESS_WITNESS_FD),
      HEBBIAN_QA_LAUNCH_OWNER_KERNEL_START_MARKER:
        launchOwner.kernelStartMarker,
      HEBBIAN_QA_LAUNCH_OWNER_PID: String(launchOwner.pid),
      HEBBIAN_QA_LAUNCH_OWNER_START_MARKER:
        launchOwner.startMarker,
      HEBBIAN_QA_LIVENESS_WITNESS_FD: String(LIVENESS_WITNESS_FD),
    },
    stdio: ["inherit", "inherit", "inherit", "pipe", "ipc"],
  });
  const leaderExit = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => {
      finish({ signal: null, spawnError: error, status: null });
    });
    child.once("exit", (status, signal) => {
      finish({ signal, spawnError: null, status });
    });
  });
  const witness = inheritedLivenessWitness(child);
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    if (child.connected) child.disconnect();
    const result = await leaderExit;
    throw result.spawnError ?? new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: command started without a process identity`,
    );
  }

  let descriptor;
  let commandOutcome;
  let leader;
  let ledgerSampler;
  let ownerMonitor;
  let commandCancellationMonitor;
  let commandTimeoutTimer;
  let commandLifecycleOpen = true;
  let commandTimedOut = false;
  let injectedTerminationTimer;
  let injectedOverlappingMonitorFailure = false;
  let requestedSignal = null;
  let termination;
  let reportTerminationOutcome;
  const terminationOutcome = new Promise((resolve) => {
    reportTerminationOutcome = resolve;
  });
  const signalHandlers = new Map();
  const requestTermination = (signal) => {
    requestedSignal ??= signal;
    if (descriptor && !termination) {
      termination =
        process.env.NODE_ENV === "test" &&
        signal === "SIGHUP" &&
        qaEnvironmentValue(
          process.env,
          "TEST_OWNER_LOSS_TERMINATION_FAILURE",
        ) === "1"
          ? Promise.reject(
              new Error(
                `${OWNED_PROCESS_GROUP_ERROR}: injected owner-loss termination failure`,
              ),
            )
          : terminateOwnedDescriptorProcesses(descriptor, {
              allowUnhealthyLedger: true,
            });
      reportTerminationOutcome(
        termination.then(
          () => ({ kind: "termination" }),
          (error) => ({ error, kind: "termination-failure" }),
        ),
      );
      if (
        !injectedOverlappingMonitorFailure &&
        ledgerSampler &&
        process.env.NODE_ENV === "test" &&
        qaEnvironmentValue(
          process.env,
          "TEST_REQUEST_TERMINATION_BEFORE_MONITOR_FAILURE",
        ) === "1" &&
        qaEnvironmentValue(
          process.env,
          "TEST_OWNERSHIP_MONITOR_RUNTIME_FAILURE",
        ) === "1"
      ) {
        injectedOverlappingMonitorFailure = true;
        // Keep this overlap causally ordered instead of relying on two wall
        // clock timers. Under an admitted full script gate, startup can be
        // delayed long enough for a nominally later timer to fire before the
        // termination hook even exists.
        ledgerSampler.invalidate(
          new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: injected ownership monitor runtime failure after termination request`,
          ),
        );
      }
    }
  };
  const stopRuntimeMonitors = () => {
    commandLifecycleOpen = false;
    if (ownerMonitor) {
      clearInterval(ownerMonitor);
      ownerMonitor = undefined;
    }
    clearInterval(commandCancellationMonitor);
    clearTimeout(injectedTerminationTimer);
    clearTimeout(commandTimeoutTimer);
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };
  try {
    const publishedLeader = startupLeaderFromMessage(
      await waitForLeadStartupIdentity(child),
      child.pid,
    );
    const observedLeader = await waitForProcessIdentity(child.pid);
    if (
      !observedLeader ||
      observedLeader.groupId !== publishedLeader.groupId ||
      observedLeader.parentPid !== publishedLeader.parentPid ||
      observedLeader.sessionId !== publishedLeader.sessionId ||
      observedLeader.startMarker !== publishedLeader.startMarker ||
      observedLeader.kernelStartMarker !==
        publishedLeader.kernelStartMarker
    ) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: startup leader identity changed before publication`,
      );
    }
    leader = observedLeader;
    const supervisor = await waitForProcessIdentity(process.pid);
    if (!leader || !supervisor) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: process generation disappeared during launch`,
      );
    }
    descriptor = {
      descriptorPath: path.resolve(descriptorPath),
      groupId: child.pid,
      ...(hardContainment &&
      HARD_CONTAINMENT_KINDS.has(process.platform)
        ? {
            hardContainmentKind:
              HARD_CONTAINMENT_KINDS.get(process.platform),
          }
        : {}),
      leaderKernelStartMarker: leader.kernelStartMarker,
      leaderPid: child.pid,
      leaderStartMarker: leader.startMarker,
      schemaVersion: SCHEMA_VERSION,
      livenessWitnessVersion: LIVENESS_WITNESS_VERSION,
      supervisorPid: process.pid,
      supervisorKernelStartMarker: supervisor.kernelStartMarker,
      supervisorStartMarker: supervisor.startMarker,
      terminateDetachedOwnedGenerations,
    };
    ledgerSampler = await startOwnershipLedgerSampler(
      descriptor,
      [leader],
      continuousOwnershipSampling,
    );
    publishDescriptor(descriptorPath, descriptor);
    if (
      process.env.NODE_ENV === "test" &&
      qaEnvironmentValue(
        process.env,
        "TEST_OWNERSHIP_MONITOR_FAIL_BEFORE_ACK",
      ) === "1"
    ) {
      const injectedFailure = new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: injected ownership monitor startup failure`,
      );
      ledgerSampler.invalidate(injectedFailure);
      throw injectedFailure;
    }
    if (
      process.ppid !== launchOwnerPid ||
      !exactGenerationIsLive(
        launchOwner,
        processController,
      )
    ) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: launch owner disappeared before command readiness`,
      );
    }
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      const handler = () => requestTermination(signal);
      process.on(signal, handler);
      signalHandlers.set(signal, handler);
    }
    if (
      process.env.NODE_ENV === "test" &&
      qaEnvironmentValue(
        process.env,
        "TEST_REQUEST_TERMINATION_BEFORE_MONITOR_FAILURE",
      ) === "1"
    ) {
      injectedTerminationTimer = setTimeout(
        () => requestTermination("SIGTERM"),
        0,
      );
    }
    const ownerMonitorIntervalMs = boundedMilliseconds(
      qaEnvironmentValue(
        process.env,
        "TEST_OWNER_MONITOR_INTERVAL_MS",
      ),
      100,
      "DURE_QA_TEST_OWNER_MONITOR_INTERVAL_MS",
    );
    ownerMonitor = setInterval(() => {
      // The kernel reparents this already-running supervisor when its launch
      // owner exits; PID reuse cannot make it a child of the replacement.
      // The exact owner generation was established above, so polling `ppid`
      // detects later loss without spawning a full process census or helper.
      if (process.ppid !== launchOwnerPid) {
        requestTermination("SIGHUP");
      }
    }, ownerMonitorIntervalMs);
    const requestCommandCancellation = () => {
      if (commandCancellationPath && fs.existsSync(commandCancellationPath)) {
        requestTermination("SIGTERM");
      }
    };
    if (commandCancellationPath) {
      commandCancellationMonitor = setInterval(
        requestCommandCancellation,
        POLL_INTERVAL_MS,
      );
      requestCommandCancellation();
    }
    commandOutcome = waitForLeadCommandOutcome(child, leader, async (gate) => {
      const admittedGate = await ledgerSampler.admitCommandGate(gate);
      if (!commandLifecycleOpen) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: command admission completed after lifecycle closure`,
        );
      }
      requestCommandCancellation();
      if (requestedSignal !== null) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: command execution was cancelled before admission`,
        );
      }
      if (
        process.ppid !== launchOwnerPid ||
        !exactGenerationIsLive(
          launchOwner,
          processController,
        )
      ) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: launch owner disappeared before command execution`,
        );
      }
      if (commandTimeoutMs !== undefined) {
        commandTimeoutTimer = setTimeout(() => {
          if (!commandLifecycleOpen || requestedSignal !== null) return;
          commandTimedOut = true;
          requestTermination("SIGTERM");
        }, commandTimeoutMs);
      }
      return admittedGate;
    });
    if (requestedSignal === null) {
      await acknowledgeLeadStartup(child, leader, launchOwner);
    }
  } catch (error) {
    const startupSignal = requestedSignal;
    try {
      stopRuntimeMonitors();
      const cleanupStartup = async (monitorFailure) => {
        if (descriptor) {
          termination ??= terminateOwnedDescriptorProcesses(descriptor, {
            allowUnhealthyLedger:
              monitorFailure !== undefined || ledgerSampler === undefined,
          });
          await termination;
        } else if (leader) {
          signalExactProcess(leader, "SIGKILL", processController);
        } else if (child.connected) {
          child.disconnect();
        }
        const rollbackOutcome = await Promise.race([
          leaderExit,
          sleep(PROCESS_IDENTITY_WAIT_MS).then(() => null),
        ]);
        if (!rollbackOutcome) {
          throw new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: unproven startup leader did not exit after handshake closure`,
          );
        }
        if (descriptor) {
          removeOwnershipLedgerDeltas(descriptor.descriptorPath);
          fs.rmSync(ownershipLedgerPath(descriptor.descriptorPath), {
            force: true,
          });
          fs.rmSync(macosProcessMarkerToolPath(descriptor.descriptorPath), {
            force: true,
          });
        } else {
          fs.rmSync(macosProcessMarkerToolPath(descriptorPath), { force: true });
        }
      };
      if (ledgerSampler) {
        await stopOwnershipMonitorThenCleanup(
          ledgerSampler,
          cleanupStartup,
        );
      } else {
        await cleanupStartup(descriptor ? error : undefined);
      }
    } catch (cleanupError) {
      child.unref();
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: launch failed and rollback failed: ${
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
        }`,
        { cause: error },
      );
    }
    if (startupSignal) {
      if (removeDescriptorOnExit && descriptor) {
        removeOwnedDescriptor(descriptor.descriptorPath, descriptor);
      }
      return commandTimedOut ? 124 : signalExitCode(startupSignal);
    }
    throw error;
  }

  const supervisedOutcome = await Promise.race([
    commandOutcome.then((result) => ({ kind: "command", result })),
    leaderExit.then((result) => ({ kind: "leader", result })),
    ledgerSampler.terminalFailure.then((error) => ({
      error,
      kind: "ownership-monitor-failure",
    })),
    terminationOutcome,
  ]);
  const result = supervisedOutcome.result;
  clearTimeout(commandTimeoutTimer);
  let sealedCleanupHandoff;
  let cleanupSealFailure;
  let reaperFailure;
  let reaperUsedSealedSnapshot = false;
  if (supervisedOutcome.kind === "termination-failure") {
    try {
      sealedCleanupHandoff = await ledgerSampler.sealCleanupHandoff((frozen) =>
        writeAtomicJson(
          cleanupHandoffSnapshotPath(descriptor.descriptorPath),
          frozen,
        ),
      );
    } catch (error) {
      cleanupSealFailure = new AggregateError(
        [supervisedOutcome.error, error],
        `${OWNED_PROCESS_GROUP_ERROR}: termination failed before cleanup handoff could be sealed`,
      );
    }
    if (sealedCleanupHandoff) {
      reaperUsedSealedSnapshot = true;
      try {
        await beforeWitnessCheck({
          descriptor,
          ownedProcesses: sealedCleanupHandoff.frozen.processes,
          requestedSignal,
        });
      } catch (error) {
        reaperFailure = error;
      }
    }
  }
  stopRuntimeMonitors();
  let cleanupHandoffFailure;
  try {
    cleanupHandoffFailure =
      await stopOwnershipMonitorThenHandoffOnTerminationFailure(
        ledgerSampler,
        async (monitorFailure) => {
          if (cleanupSealFailure) throw cleanupSealFailure;
          await (termination ??
            terminateOwnedDescriptorProcesses(descriptor, {
              allowUnhealthyLedger: monitorFailure !== undefined,
            }));
        },
        sealedCleanupHandoff,
      );
    if (!cleanupHandoffFailure) {
      // The observer can seal one final identity-only fork after termination
      // begins. Reconcile that tail only after its producer has stopped, so
      // retirement reads one complete canonical ledger.
      await recoverIdentityOnlyOwnedProcessTree(descriptor);
    }
  } catch (error) {
    if (!reaperFailure) throw error;
    throw new AggregateError(
      [reaperFailure, error],
      `${OWNED_PROCESS_GROUP_ERROR}: reaper and cleanup handoff both failed`,
    );
  } finally {
    releaseLeadForCleanupHandoff(child);
  }
  try {
    if (!reaperUsedSealedSnapshot) {
      await beforeWitnessCheck({
        descriptor,
        ownedProcesses: readOwnedProcessLedgerForRetirement(descriptor),
        requestedSignal,
      });
    }
  } catch (error) {
    if (!cleanupHandoffFailure) throw error;
    reaperFailure = error;
  }
  let witnessFailure;
  try {
    await witness.assertClosedWithin(
      boundedMilliseconds(
        livenessWitnessWaitMs,
        LIVENESS_WITNESS_WAIT_MS,
        "liveness witness wait",
      ),
    );
  } catch (error) {
    if (!cleanupHandoffFailure) throw error;
    witnessFailure = error;
  }
  if (cleanupHandoffFailure) {
    let completionFailure;
    if (!reaperFailure && !witnessFailure) {
      try {
        if (
          process.env.NODE_ENV === "test" &&
          qaEnvironmentValue(
            process.env,
            "TEST_CLEANUP_HANDOFF_COMPLETION_OBSERVATION_FAILURE",
          ) === "1"
        ) {
          throw new Error(
            `${OWNED_PROCESS_GROUP_ERROR}: injected sealed cleanup completion observation failure`,
          );
        }
        await verifySealedCleanupHandoffExited(
          sealedCleanupHandoff.frozen,
          processController,
          gracePeriods(process.env).killGraceMs,
        );
        if (onVerifiedCleanupHandoff) {
          await onVerifiedCleanupHandoff();
        } else {
          removeOwnedDescriptor(descriptor.descriptorPath, descriptor);
        }
      } catch (error) {
        completionFailure = error;
      }
    }
    if (reaperFailure || witnessFailure || completionFailure) {
      throw new AggregateError(
        [
          cleanupHandoffFailure,
          reaperFailure,
          witnessFailure,
          completionFailure,
        ].filter(Boolean),
        `${OWNED_PROCESS_GROUP_ERROR}: cleanup handoff did not reach verified completion`,
      );
    }
    throw cleanupHandoffFailure;
  }
  if (
    removeDescriptorOnExit ||
    !exactGenerationIsLive(launchOwner, processController)
  ) {
    removeOwnedDescriptor(descriptor.descriptorPath, descriptor);
  }

  if (commandTimedOut) return 124;
  if (requestedSignal) return signalExitCode(requestedSignal);
  if (result.spawnError) throw result.spawnError;
  if (result.signal) return signalExitCode(result.signal);
  return result.status ?? 1;
}

async function leadOwnedProcessGroup(descriptorPath, command, args) {
  const witnessFd = Number(
    qaEnvironmentValue(process.env, "LIVENESS_WITNESS_FD"),
  );
  if (witnessFd !== LIVENESS_WITNESS_FD) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: inherited liveness witness is unavailable`,
    );
  }
  const launchOwner = startupLaunchOwnerFromEnvironment(process.env);
  const processController = exactProcessControllerForDescriptor(
    descriptorPath,
  );
  const leader = await waitForProcessIdentity(process.pid);
  if (!leader || leader.groupId !== process.pid) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: startup leader could not prove its exact process generation`,
    );
  }
  const supervisorDisconnected = waitForSupervisorDisconnect();
  try {
    await publishLeadStartupIdentity(leader, launchOwner);
  } catch (error) {
    if (!process.connected) {
      if (fs.existsSync(descriptorPath)) {
        return awaitDisconnectedSupervisorCleanup(
          descriptorPath,
          leader.parentPid,
          launchOwner,
          processController,
        );
      }
      fs.rmSync(macosProcessMarkerToolPath(descriptorPath), { force: true });
    }
    throw error;
  }
  if (qaEnvironmentValue(process.env, "TEST_ACK_MARKER") === "1") {
    fs.writeFileSync(
      `${path.resolve(descriptorPath)}.startup-ack`,
      `${process.pid}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }
  const postAcknowledgeDelayMs = boundedMilliseconds(
    qaEnvironmentValue(process.env, "TEST_POST_ACK_DELAY_MS"),
    0,
    "DURE_QA_TEST_POST_ACK_DELAY_MS",
  );
  if (postAcknowledgeDelayMs > 0) {
    await sleep(postAcknowledgeDelayMs);
  }
  const gateExecutable =
    process.platform === "linux"
      ? "python3"
      : macosProcessMarkerToolPath(descriptorPath);
  const gateArguments =
    process.platform === "linux"
      ? [LINUX_PROCESS_BOUNDARY, "exec-gate", command, ...args]
      : ["exec-gate", command, ...args];
  const child = spawn(
    gateExecutable,
    gateArguments,
    {
      cwd: process.cwd(),
      detached: false,
      env: process.env,
      // fd 0 is reserved for the admission gate until exec. Preserve the
      // lead's actual stdin on fd 4; `"inherit"` here would inherit lead fd 4,
      // which is its supervisor IPC channel.
      stdio: ["pipe", "inherit", "inherit", witnessFd, 0],
    },
  );
  const commandOutcome = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => {
      finish({ signal: null, spawnError: error, status: null });
    });
    child.once("exit", (status, signal) => {
      finish({ signal, spawnError: null, status });
    });
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: command gate has no process identity`,
    );
  }
  const gate = { pid: child.pid };
  await publishCommandGateIdentity(gate, leader);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      child.stdin.off("finish", onFinish);
      reject(error);
    };
    const onFinish = () => {
      child.stdin.off("error", onError);
      resolve();
    };
    child.stdin.once("error", onError);
    child.stdin.once("finish", onFinish);
    child.stdin.end("G");
  });
  const first = await Promise.race([
    commandOutcome.then((result) => ({ kind: "command-outcome", result })),
    supervisorDisconnected.then(() => ({
      kind: "supervisor-disconnected",
    })),
  ]);
  if (first.kind === "supervisor-disconnected") {
    child.unref();
    return awaitDisconnectedSupervisorCleanup(
      descriptorPath,
      leader.parentPid,
      launchOwner,
      processController,
    );
  }
  const { result } = first;
  if (!process.connected) {
    return awaitDisconnectedSupervisorCleanup(
      descriptorPath,
      leader.parentPid,
      launchOwner,
      processController,
    );
  }
  try {
    await publishLeadCommandOutcome(leader, result);
  } catch (error) {
    if (!process.connected) {
      return awaitDisconnectedSupervisorCleanup(
        descriptorPath,
        leader.parentPid,
        launchOwner,
        processController,
      );
    }
    throw error;
  }
  await supervisorDisconnected;
  return awaitDisconnectedSupervisorCleanup(
    descriptorPath,
    leader.parentPid,
    launchOwner,
    processController,
  );
}

async function terminateFromDescriptor(descriptorPath, expectedSupervisorPid) {
  if (!fs.existsSync(descriptorPath)) return;
  const descriptor = readOwnedProcessGroup(
    descriptorPath,
    expectedSupervisorPid,
  );
  await terminateOwnedDescriptorProcesses(descriptor);
  await waitForSupervisorAndComplete(descriptor);
}

export async function terminateSealedCleanupHandoff(
  descriptor,
  frozen,
  processController,
  environment = process.env,
  { waitForLeaderExit = true } = {},
) {
  const leader = frozen.processes.find(
    (expected) =>
      expected.pid === descriptor.leaderPid &&
      expected.startMarker === descriptor.leaderStartMarker &&
      expected.kernelStartMarker === descriptor.leaderKernelStartMarker,
  );
  if (!leader) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: sealed cleanup handoff has no exact leader`,
    );
  }
  assertCleanupHandoffProcessAuthority(descriptor, frozen.processes);

  const nonLeaders = exactTerminationOrder(
    frozen.processes,
    descriptor.leaderPid,
  ).filter(({ pid }) => pid !== descriptor.leaderPid);
  const liveNonLeaders = [];
  for (const expected of nonLeaders) {
    const state = processController.generationState(expected);
    if (state === "gone") continue;
    if (state !== "quiescent") {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: sealed cleanup generation is no longer quiescent`,
      );
    }
    liveNonLeaders.push(expected);
  }

  // The sampler's barrier sealed every captured descendant while stopped.
  // Keep the exact lead runnable only as the cleanup anchor so Linux can reap
  // adopted descendants. The sealed lead can only await this successor. The
  // successor consumes the immutable nonleader set before retiring a live lead.
  let leaderState = processController.generationState(leader);
  if (
    leaderState !== "gone" &&
    leaderState !== "running" &&
    leaderState !== "quiescent"
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: sealed cleanup lead state is unavailable`,
    );
  }
  if (leaderState === "quiescent") {
    if (!processController.signalGeneration(leader, "SIGCONT")) {
      leaderState = processController.generationState(leader);
      if (leaderState !== "gone") {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: sealed cleanup handoff lost its exact lead`,
        );
      }
    } else {
      leaderState = await waitForExactKernelGenerationRunning(
        leader,
        gracePeriods(environment).termGraceMs,
        processController,
      );
      if (leaderState !== "running" && leaderState !== "gone") {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: sealed cleanup lead did not resume`,
        );
      }
    }
  }
  for (const expected of liveNonLeaders) {
    processController.signalGeneration(expected, "SIGKILL");
  }
  const surviving = await waitForExactKernelGenerationsExit(
    liveNonLeaders,
    gracePeriods(environment).killGraceMs,
    processController,
  );
  if (surviving.length > 0) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: sealed cleanup generations survived SIGKILL: ` +
        surviving.map(({ pid }) => pid).join(","),
    );
  }
  if (
    environment.NODE_ENV === "test" &&
    qaEnvironmentValue(
      environment,
      "TEST_CLEANUP_HANDOFF_SUCCESSOR_PRE_LEADER_FAILURE",
    ) === "1"
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: injected cleanup successor failure before lead retirement`,
    );
  }
  // Signal a surviving lead only after every other exact generation is gone.
  // The supervisor combines its inherited witness with a final read-only check
  // of this sealed snapshot before invoking its caller-owned completion action.
  if (leaderState === "gone") return;
  processController.signalGeneration(leader, "SIGKILL");
  if (!waitForLeaderExit) return;
  const liveLeader = await waitForExactKernelGenerationsExit(
    [leader],
    gracePeriods(environment).killGraceMs,
    processController,
  );
  if (liveLeader.length > 0) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: sealed cleanup leader survived SIGKILL`,
    );
  }
}

async function terminateAfterOwnerExit(
  descriptorPath,
  expectedSupervisorPid,
  launchOwner,
) {
  const descriptor = readOwnedProcessGroup(
    descriptorPath,
    expectedSupervisorPid,
  );
  const snapshot = cleanupHandoffSnapshotPath(descriptor.descriptorPath);
  let frozen;
  let missingSnapshotCause;
  try {
    frozen = readFrozenProcessTree(snapshot, descriptor);
  } catch (cause) {
    if (
      cause?.code !== "ENOENT" ||
      descriptor.terminateDetachedOwnedGenerations === true
    ) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: exact successor cleanup requires a valid sealed snapshot`,
        { cause },
      );
    }
    missingSnapshotCause = cause;
  }
  const processController = exactProcessControllerForDescriptor(
    descriptor.descriptorPath,
  );
  if (
    exactGenerationIsLive(
      launchOwner,
      processController,
    )
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: launch owner is still live before successor cleanup`,
    );
  }
  const expectedSupervisor = {
    kernelStartMarker: descriptor.supervisorKernelStartMarker,
    pid: descriptor.supervisorPid,
    startMarker: descriptor.supervisorStartMarker,
  };
  const supervisorIsLive = exactGenerationIsLive(
    expectedSupervisor,
    processController,
  );
  if (!frozen) {
    if (supervisorIsLive) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: exact successor cleanup requires a valid sealed snapshot`,
        { cause: missingSnapshotCause },
      );
    }
    const expectedLeader = {
      kernelStartMarker: descriptor.leaderKernelStartMarker,
      pid: descriptor.leaderPid,
      startMarker: descriptor.leaderStartMarker,
    };
    if (
      !exactGenerationIsLive(
        expectedLeader,
        processController,
      )
    ) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: hard-crash cleanup lost its exact group leader`,
      );
    }
    frozen = await freezeOwnedProcessTree(descriptor, {
      includeDetachedOwnedGenerations: false,
      processController,
      publishFrozen: (value) => writeAtomicJson(snapshot, value),
    });
  }
  await terminateSealedCleanupHandoff(
    descriptor,
    frozen,
    processController,
    process.env,
    { waitForLeaderExit: !supervisorIsLive },
  );
}

async function waitForSupervisorExit(
  descriptor,
  timeoutMs = DEFAULT_TERM_GRACE_MS + DEFAULT_KILL_GRACE_MS,
) {
  if (!descriptor.supervisorKernelStartMarker) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: descriptor has no supervisor generation`,
    );
  }
  const expectedSupervisor = {
    kernelStartMarker: descriptor.supervisorKernelStartMarker,
    pid: descriptor.supervisorPid,
  };
  const live = await waitForExactProcessExit(
    [expectedSupervisor],
    timeoutMs,
  );
  if (live.length > 0) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: exact supervisor did not exit`,
    );
  }
}

async function waitForSupervisorAndComplete(descriptor) {
  await waitForSupervisorExit(descriptor);
  removeOwnedDescriptor(descriptor.descriptorPath, descriptor);
}

async function freezeFromDescriptor(
  descriptorPath,
  expectedSupervisorPid,
  snapshotPath,
  includeDetachedOwnedGenerations = true,
) {
  const descriptor = readOwnedProcessGroup(
    descriptorPath,
    expectedSupervisorPid,
  );
  await freezeOwnedProcessTree(descriptor, {
    includeDetachedOwnedGenerations,
    publishFrozen: (frozen) => writeAtomicJson(snapshotPath, frozen),
  });
}

async function terminateFrozenFromDescriptor(
  descriptorPath,
  expectedSupervisorPid,
  snapshotPath,
) {
  const descriptor = readOwnedProcessGroup(
    descriptorPath,
    expectedSupervisorPid,
  );
  const frozen = readFrozenProcessTree(snapshotPath, descriptor);
  const processController = exactProcessControllerForDescriptor(
    descriptor.descriptorPath,
  );
  const expectedSupervisor = {
    kernelStartMarker: descriptor.supervisorKernelStartMarker,
    pid: descriptor.supervisorPid,
    startMarker: descriptor.supervisorStartMarker,
  };
  const supervisorState = processController.generationState(
    expectedSupervisor,
  );
  if (supervisorState !== "gone") {
    if (supervisorState !== "running") {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: frozen cleanup supervisor is not running`,
      );
    }
    await observeFrozenOwnedProcessTree(descriptor, frozen);
    publishFrozenTerminationRequest(descriptor, frozen);
    // The live supervisor owns both the ledger and the lead IPC lifecycle.
    // Ask it to terminate its tree so an externally killed lead cannot look
    // identical to an uncommanded protocol disconnect.
    if (
      !processController.signalGeneration(expectedSupervisor, "SIGTERM") &&
      processController.generationState(expectedSupervisor) !== "gone"
    ) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: exact frozen cleanup request was not delivered`,
      );
    }
    await waitForSupervisorExit(
      descriptor,
      ledgerProducerExitGraceMs(process.env),
    );
    return;
  }
  await terminateFrozenOwnedProcessTree(descriptor, frozen);
}

async function verifyExitedFromDescriptor(
  descriptorPath,
  expectedSupervisorPid,
) {
  const descriptor = readOwnedProcessGroup(
    descriptorPath,
    expectedSupervisorPid,
  );
  return verifyOwnedProcessTreeExited(descriptor);
}

async function livePidBelongsToOwnedTree(
  descriptorPath,
  expectedSupervisorPid,
  rawPid,
) {
  const descriptor = readOwnedProcessGroup(
    descriptorPath,
    expectedSupervisorPid,
  );
  const pid = positiveInteger(rawPid, "foreground process pid");
  const pointScope = { kind: "point", pids: [pid] };
  const pointMembers = observationMembers(
    await observeProcessMembers(pointScope, {
      timeoutMs: PROCESS_IDENTITY_WAIT_MS,
    }),
    { kind: "point", requestedPids: [pid] },
    "foreground process identity",
  );
  const foreground = pointMembers.find((member) => member.pid === pid);
  if (isDepartedProcessMember(foreground)) return false;
  return readOwnershipLedger(descriptor).some((expected) =>
    classifyOwnedProcess(expected, pointMembers, "foreground ownership").kind ===
      "current"
  );
}

async function completeFromDescriptor(
  descriptorPath,
  expectedSupervisorPid,
) {
  const descriptor = readOwnedProcessGroup(
    descriptorPath,
    expectedSupervisorPid,
  );
  await verifyOwnedProcessTreeExited(descriptor);
  removeOwnedDescriptor(descriptor.descriptorPath, descriptor);
}

function parseRunArguments(args) {
  const separator = args.indexOf("--");
  if (separator !== 1) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: usage: run|run-observed|run-contained <descriptor> -- <command> [args...]`,
    );
  }
  return {
    args: args.slice(separator + 2),
    command: args[separator + 1],
    descriptorPath: path.resolve(args[0]),
  };
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "lead") {
    if (!args[0] || args[1] !== "--" || !args[2]) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: usage: lead <descriptor> -- <command> [args...]`,
      );
    }
    process.exitCode = await leadOwnedProcessGroup(
      path.resolve(args[0]),
      args[2],
      args.slice(3),
    );
    return;
  }
  if (
    operation === "run" ||
    operation === "run-observed" ||
    operation === "run-contained"
  ) {
    if (operation === "run-contained" && process.platform !== "linux") {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: hard containment is unavailable on ${process.platform}`,
      );
    }
    const parsed = parseRunArguments(args);
    process.exitCode = await supervise(
      parsed.descriptorPath,
      parsed.command,
      parsed.args,
      {
        hardContainment: operation === "run-contained",
        terminateDetachedOwnedGenerations: operation !== "run",
      },
    );
    return;
  }
  if (operation === "inspect") {
    const [descriptorPath, expectedSupervisorPid] = args;
    const descriptor = readOwnedProcessGroup(
      path.resolve(descriptorPath),
      expectedSupervisorPid,
    );
    process.stdout.write(String(descriptor.groupId));
    return;
  }
  if (operation === "contains-live-pid") {
    const [descriptorPath, expectedSupervisorPid, pid] = args;
    process.exitCode = (await livePidBelongsToOwnedTree(
      path.resolve(descriptorPath),
      expectedSupervisorPid,
      pid,
    ))
      ? 0
      : 1;
    return;
  }
  if (operation === "terminate") {
    const [descriptorPath, expectedSupervisorPid] = args;
    await terminateFromDescriptor(
      path.resolve(descriptorPath),
      expectedSupervisorPid,
    );
    return;
  }
  if (operation === "terminate-after-owner-exit") {
    const [
      descriptorPath,
      expectedSupervisorPid,
      launchOwnerPid,
      launchOwnerStartMarker,
      launchOwnerKernelStartMarker,
    ] = args;
    await terminateAfterOwnerExit(
      path.resolve(descriptorPath),
      expectedSupervisorPid,
      {
        kernelStartMarker: exactKernelStartMarker(
          launchOwnerKernelStartMarker,
          "cleanup launch owner kernel start marker",
          "cleanup launch ownership",
        ),
        pid: positiveInteger(
          launchOwnerPid,
          "cleanup launch owner pid",
        ),
        startMarker: processStartMarker(
          launchOwnerStartMarker,
          "cleanup launch owner start marker",
        ),
      },
    );
    return;
  }
  if (operation === "freeze" || operation === "freeze-group") {
    const [descriptorPath, expectedSupervisorPid, snapshotPath] = args;
    await freezeFromDescriptor(
      path.resolve(descriptorPath),
      expectedSupervisorPid,
      path.resolve(snapshotPath),
      operation === "freeze",
    );
    return;
  }
  if (operation === "terminate-frozen") {
    const [descriptorPath, expectedSupervisorPid, snapshotPath] = args;
    await terminateFrozenFromDescriptor(
      path.resolve(descriptorPath),
      expectedSupervisorPid,
      path.resolve(snapshotPath),
    );
    return;
  }
  if (operation === "verify-exited") {
    const [descriptorPath, expectedSupervisorPid] = args;
    const receipt = await verifyExitedFromDescriptor(
      path.resolve(descriptorPath),
      expectedSupervisorPid,
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  if (operation === "complete") {
    const [descriptorPath, expectedSupervisorPid] = args;
    await completeFromDescriptor(
      path.resolve(descriptorPath),
      expectedSupervisorPid,
    );
    return;
  }
  throw new Error(
    `${OWNED_PROCESS_GROUP_ERROR}: expected run, run-observed, run-contained, inspect, freeze, freeze-group, terminate-frozen, terminate-after-owner-exit, verify-exited, complete, or terminate`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = CLEANUP_FAILURE_EXIT_CODE;
  }
}
