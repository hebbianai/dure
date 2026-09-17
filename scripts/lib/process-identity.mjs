import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWindowsBoundaryMembers,
  parseWindowsProcessIdentity,
  windowsProcessBoundary,
} from "./windows-process-identity.mjs";

export { parseWindowsProcessIdentity };

const PROCESS_OBSERVATION_TIMEOUT_MS = 2_000;
const PROCESS_BOUNDARY_BUILD_TIMEOUT_MS = 30_000;
const PROCESS_BOUNDARY_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const PROCESS_POINT_BATCH_SIZE = 256;
const PROCESS_PATH_UTF8 = new TextDecoder("utf-8", { fatal: true });
const MACOS_PROCESS_BOUNDARY_SOURCE = fileURLToPath(
  new URL("../native/owned-process-observer.c", import.meta.url),
);
const LINUX_PROCESS_BOUNDARY = fileURLToPath(
  new URL("../native/linux-process-boundary.py", import.meta.url),
);
const MACOS_PROCESS_GENERATION_LIMIT = 32_768;
const MACOS_PROCESS_IDENTITY_PATTERN =
  /^kernel-start-v3:macos:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/iu;
const LINUX_PROCESS_IDENTITY_PATTERN = /^linux:([^:\s]+):(\d+)$/u;
let macosBoundaryPreparation;
let temporarySequence = 0;

function uniquePids(pids) {
  if (
    !Array.isArray(pids) ||
    pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
  ) {
    return null;
  }
  return [...new Set(pids)].sort((left, right) => left - right);
}

export function processPointScope(pids) {
  const requestedPids = uniquePids(pids);
  if (!requestedPids) throw new Error("invalid process members");
  return Object.freeze({
    kind: "point",
    requestedPids: Object.freeze(requestedPids),
  });
}

export function hasProcessPointScope(observation, pids) {
  const expected = processPointScope(pids);
  return observation?.scope?.kind === "point" &&
    Array.isArray(observation.scope.requestedPids) &&
    observation.scope.requestedPids.length === expected.requestedPids.length &&
    observation.scope.requestedPids.every(
      (pid, index) => pid === expected.requestedPids[index],
    );
}

function groupCensusScope(groupId) {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error("invalid process group");
  }
  return Object.freeze({ kind: "group_census", groupId });
}

function currentUserTopologyScope() {
  return Object.freeze({
    evidence: "positive_only",
    kind: "current_user_topology",
  });
}

// A positive generation mismatch refuses enumeration; absence may continue.
// This precondition does not establish a live anchor or signalling authority.
function userCensusScope(expectedProcess, platform) {
  const effectiveUid = process.geteuid?.();
  if (!Number.isSafeInteger(effectiveUid) || effectiveUid < 0) {
    throw new Error("current user identity is unavailable");
  }
  let expected;
  if (expectedProcess !== undefined) {
    const identity = platform === "darwin"
      ? parseMacosProcessIdentity(expectedProcess?.processIdentity)
      : platform === "linux"
      ? parseLinuxProcessIdentity(expectedProcess?.processIdentity)
      : null;
    if (
      !Number.isSafeInteger(expectedProcess?.pid) ||
      expectedProcess.pid <= 1 ||
      !identity
    ) {
      throw new Error("invalid census process precondition");
    }
    expected = Object.freeze({
      pid: expectedProcess.pid,
      processIdentity: identity.processIdentity,
    });
  }
  return Object.freeze({
    effectiveUid,
    evidence: "closed_enumeration",
    kind: "user_census",
    ...(expected ? { expectedProcess: expected } : {}),
  });
}

function completeObservation(scope, members) {
  return Object.freeze({
    status: "complete",
    scope,
    members: Object.freeze(members.map((member) => Object.freeze(member))),
  });
}

function incompleteObservation(scope, reason, diagnostic) {
  const detail = boundedDiagnostic(diagnostic);
  return Object.freeze({
    status: "incomplete",
    scope,
    reason,
    ...(detail ? { diagnostic: detail } : {}),
  });
}

function observationScope(request, platform) {
  if (request?.kind === "point") return processPointScope(request.pids);
  if (request?.kind === "group_census") {
    return groupCensusScope(request.groupId);
  }
  if (request?.kind === "user_census") {
    return userCensusScope(request.expectedProcess, platform);
  }
  throw new Error("invalid process observation scope");
}

function platformBoundary(platform, executable) {
  if (platform === "darwin") return { file: executable, prefix: [] };
  if (platform === "linux") {
    return { file: "python3", prefix: [LINUX_PROCESS_BOUNDARY] };
  }
  if (platform === "win32") {
    return windowsProcessBoundary();
  }
  return null;
}

export function parseMacosProcessIdentity(value) {
  const match = typeof value === "string"
    ? value.match(MACOS_PROCESS_IDENTITY_PATTERN)
    : null;
  if (!match) return null;
  const bootSession = match[1].toLowerCase();
  const uniqueId = match[2];
  return Object.freeze({
    bootSession,
    processIdentity:
      `kernel-start-v3:macos:${bootSession}:${uniqueId}`,
    uniqueId,
  });
}

export function parseLinuxProcessIdentity(value) {
  const match = typeof value === "string"
    ? value.match(LINUX_PROCESS_IDENTITY_PATTERN)
    : null;
  if (!match) return null;
  const bootId = match[1];
  const startTicks = match[2];
  return Object.freeze({
    bootId,
    processIdentity: `linux:${bootId}:${startTicks}`,
    startTicks,
  });
}

export function macosProcessBoundaryCompileArguments(executable) {
  return [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-DMAX_OWNED_PROCESSES=${MACOS_PROCESS_GENERATION_LIMIT}`,
    "-o",
    executable,
    MACOS_PROCESS_BOUNDARY_SOURCE,
  ];
}

function macosBoundaryExecutable() {
  const digest = createHash("sha256")
    .update(readFileSync(MACOS_PROCESS_BOUNDARY_SOURCE))
    .digest("hex")
    .slice(0, 20);
  const owner = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `dure-process-boundary-${owner}`, digest);
}

function boundaryProvenanceFailure(reason) {
  const error = new Error(`native process boundary cache is unsafe: ${reason}`);
  error.code = "DEV_PROCESS_BOUNDARY_PROVENANCE_INVALID";
  return error;
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw boundaryProvenanceFailure(`cannot inspect ${path}`);
  }
}

function validateMacosBoundaryProvenance(executable, artifactRequired = false) {
  if (typeof process.getuid !== "function") {
    throw boundaryProvenanceFailure("current user identity is unavailable");
  }
  const owner = process.getuid();
  const directory = dirname(executable);
  let directoryMetadata = lstatIfPresent(directory);
  if (!directoryMetadata) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    directoryMetadata = lstatIfPresent(directory);
  }
  if (
    !directoryMetadata?.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    directoryMetadata.uid !== owner ||
    (directoryMetadata.mode & 0o077) !== 0
  ) {
    throw boundaryProvenanceFailure(
      "directory must be an owner-only, non-symlink directory",
    );
  }

  const executableMetadata = lstatIfPresent(executable);
  if (!executableMetadata) {
    if (artifactRequired) {
      throw boundaryProvenanceFailure("executable is missing");
    }
    return false;
  }
  if (
    !executableMetadata.isFile() ||
    executableMetadata.isSymbolicLink() ||
    executableMetadata.uid !== owner ||
    (executableMetadata.mode & 0o100) === 0 ||
    (executableMetadata.mode & 0o022) !== 0
  ) {
    throw boundaryProvenanceFailure(
      "executable must be an owned regular executable without shared write access",
    );
  }
  return true;
}

function boundedDiagnostic(value) {
  return String(value ?? "")
    .trim()
    .replaceAll(/\s+/gu, " ")
    .slice(0, 256);
}

function boundaryFailure(result, operation) {
  return new Error(
    `${operation} failed (status=${result.status ?? "none"}, ` +
      `signal=${result.signal ?? "none"}, error=${result.error?.code ?? "none"}, ` +
      `stderr=${boundedDiagnostic(result.stderr) || "none"})`,
  );
}

export async function requireNativeProcessGroupSupport(
  platform = process.platform,
) {
  if (platform === "darwin") await prepareMacosBoundary();
  if (platform !== "linux") return;
  const boundary = platformBoundary(platform, null);
  const result = await runBounded(
    boundary.file,
    [...boundary.prefix, "self-check"],
    {
      timeoutMs: PROCESS_OBSERVATION_TIMEOUT_MS,
      maxBuffer: PROCESS_BOUNDARY_MAX_BUFFER_BYTES,
    },
  );
  if (
    result.status !== 0 ||
    result.timedOut ||
    result.overflow ||
    result.error
  ) {
    const error = boundaryFailure(
      result,
      "Linux process boundary self-check",
    );
    error.code = "DEV_PROCESS_GROUP_UNSUPPORTED";
    throw error;
  }
}

function runBounded(file, args, { timeoutMs, maxBuffer }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let error;
    let timedOut = false;
    let overflow = false;
    const terminate = (reason) => {
      if (reason === "timeout") timedOut = true;
      if (reason === "overflow") overflow = true;
      child.kill("SIGKILL");
    };
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBuffer) {
        terminate("overflow");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (value) => {
      error = value;
    });
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        error,
        timedOut,
        overflow,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function preparationTimeoutError() {
  const error = new Error("native process boundary preparation timed out");
  error.code = "DEV_PROCESS_OBSERVATION_TIMEOUT";
  return error;
}

function waitForPreparation(preparing, timeoutMs) {
  let timeout;
  return Promise.race([
    preparing,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(preparationTimeoutError()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function prepareMacosBoundary(
  timeoutMs = PROCESS_BOUNDARY_BUILD_TIMEOUT_MS,
) {
  const executable = macosBoundaryExecutable();
  if (validateMacosBoundaryProvenance(executable)) return executable;
  if (!macosBoundaryPreparation) {
    const preparing = (async () => {
      const temporary =
        `${executable}.${process.pid}.${temporarySequence++}.tmp`;
      try {
        const result = await runBounded(
          "cc",
          macosProcessBoundaryCompileArguments(temporary),
          {
            timeoutMs: PROCESS_BOUNDARY_BUILD_TIMEOUT_MS,
            maxBuffer: PROCESS_BOUNDARY_MAX_BUFFER_BYTES,
          },
        );
        if (result.status !== 0) {
          throw boundaryFailure(result, "native process boundary build");
        }
        chmodSync(temporary, 0o700);
        validateMacosBoundaryProvenance(temporary, true);
        renameSync(temporary, executable);
        validateMacosBoundaryProvenance(executable, true);
        return executable;
      } finally {
        rmSync(temporary, { force: true });
      }
    })();
    macosBoundaryPreparation = preparing;
    const release = () => {
      if (macosBoundaryPreparation === preparing) {
        macosBoundaryPreparation = undefined;
      }
    };
    void preparing.then(release, release);
  }
  return waitForPreparation(macosBoundaryPreparation, timeoutMs);
}

function prepareMacosBoundarySync(
  timeoutMs = PROCESS_BOUNDARY_BUILD_TIMEOUT_MS,
) {
  const executable = macosBoundaryExecutable();
  if (validateMacosBoundaryProvenance(executable)) return executable;
  const temporary = `${executable}.${process.pid}.${temporarySequence++}.tmp`;
  try {
    const result = spawnSync(
      "cc",
      macosProcessBoundaryCompileArguments(temporary),
      {
        detached: true,
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: PROCESS_BOUNDARY_MAX_BUFFER_BYTES,
        timeout: Math.min(PROCESS_BOUNDARY_BUILD_TIMEOUT_MS, timeoutMs),
      },
    );
    if (result.status !== 0) {
      throw boundaryFailure(result, "native process boundary build");
    }
    chmodSync(temporary, 0o700);
    validateMacosBoundaryProvenance(temporary, true);
    renameSync(temporary, executable);
    validateMacosBoundaryProvenance(executable, true);
    return executable;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function observationArguments(scope, includeCwd = false) {
  if (scope.kind === "point") {
    return [
      includeCwd ? "observe-point-cwd" : "observe-point",
      ...scope.requestedPids.map(String),
    ];
  }
  if (scope.kind === "group_census") {
    return ["observe-group", String(scope.groupId)];
  }
  if (scope.kind === "current_user_topology") {
    return ["observe-user-topology"];
  }
  if (scope.kind === "user_census") {
    if (!scope.expectedProcess) return ["observe-user-census"];
    const { pid, processIdentity } = scope.expectedProcess;
    const identity = parseMacosProcessIdentity(processIdentity) ??
      parseLinuxProcessIdentity(processIdentity);
    return [
      "observe-user-census",
      String(pid),
      identity.bootSession ?? identity.bootId,
      identity.uniqueId ?? identity.startTicks,
    ];
  }
  throw new Error("invalid process observation scope");
}

function observationBatches(scope) {
  if (
    scope.kind !== "point" ||
    scope.requestedPids.length <= PROCESS_POINT_BATCH_SIZE
  ) {
    return [scope];
  }
  const batches = [];
  for (
    let offset = 0;
    offset < scope.requestedPids.length;
    offset += PROCESS_POINT_BATCH_SIZE
  ) {
    batches.push(processPointScope(
      scope.requestedPids.slice(offset, offset + PROCESS_POINT_BATCH_SIZE),
    ));
  }
  return batches;
}

function remainingObservationTimeout(deadline) {
  return Math.ceil(deadline - performance.now());
}

function parseBoundaryMembers(output, scope, platform, includeCwd = false) {
  if (platform === "win32") {
    return includeCwd ? null : parseWindowsBoundaryMembers(output, scope);
  }
  const requested = scope.kind === "point"
    ? new Set(scope.requestedPids)
    : null;
  const members = [];
  const observed = new Set();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(
      /^M (\d+) (\d+) (\d+) (\d+) (live|stopped|zombie) (\S+) (\d+)(?: ([0-9a-f]+|-))?$/u,
    );
    const pid = Number(match?.[1]);
    const parentPid = Number(match?.[2]);
    const groupId = Number(match?.[3]);
    const sessionId = Number(match?.[4]);
    const identity = match?.[6];
    const startedAtUnixSeconds = Number(match?.[7]);
    const encodedCwd = match?.[8];
    const parsedIdentity = platform === "darwin"
      ? parseMacosProcessIdentity(identity)
      : parseLinuxProcessIdentity(identity);
    if (
      !match ||
      includeCwd !== (encodedCwd !== undefined) ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isSafeInteger(groupId) ||
      groupId <= 0 ||
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0 ||
      observed.has(pid) ||
      !parsedIdentity ||
      !Number.isSafeInteger(startedAtUnixSeconds) ||
      startedAtUnixSeconds <= 0 ||
      (requested && !requested.has(pid)) ||
      (scope.kind === "group_census" && groupId !== scope.groupId)
    ) {
      return null;
    }
    let cwd;
    if (includeCwd) {
      if (encodedCwd === "-") {
        if (match[5] !== "zombie") return null;
        cwd = null;
      } else {
        if (encodedCwd.length % 2 !== 0 || encodedCwd.length > 8192) return null;
        try {
          cwd = PROCESS_PATH_UTF8.decode(Buffer.from(encodedCwd, "hex"));
        } catch {
          return null;
        }
        if (!cwd.startsWith("/") || cwd.includes("\0")) return null;
      }
    }
    observed.add(pid);
    members.push({
      pid,
      parentPid,
      groupId,
      sessionId,
      state: match[5],
      processIdentity: parsedIdentity.processIdentity,
      startedAtUnixSeconds,
      ...(includeCwd ? { cwd } : {}),
    });
  }
  return members.sort((left, right) => left.pid - right.pid);
}

async function observeNative(scope, platform, timeoutMs) {
  if (scope.kind === "point" && scope.requestedPids.length === 0) {
    return completeObservation(scope, []);
  }
  const startedAt = performance.now();
  let executable;
  try {
    executable = platform === "darwin"
      ? await prepareMacosBoundary(timeoutMs)
      : null;
  } catch (error) {
    return incompleteObservation(
      scope,
      error?.code === "DEV_PROCESS_OBSERVATION_TIMEOUT" ||
          performance.now() - startedAt >= timeoutMs
        ? "process_member_observation_timeout"
        : "process_member_observation_failed",
      error?.message ?? error,
    );
  }
  const boundary = platformBoundary(platform, executable);
  if (!boundary) {
    return incompleteObservation(scope, "process_member_adapter_unavailable");
  }
  let result;
  try {
    const remaining = Math.ceil(timeoutMs - (performance.now() - startedAt));
    if (remaining <= 0) {
      return incompleteObservation(
        scope,
        "process_member_observation_timeout",
      );
    }
    result = await runBounded(
      boundary.file,
      [...boundary.prefix, ...observationArguments(scope)],
      {
        timeoutMs: remaining,
        maxBuffer: PROCESS_BOUNDARY_MAX_BUFFER_BYTES,
      },
    );
  } catch (error) {
    return incompleteObservation(
      scope,
      "process_member_observation_failed",
      error?.message ?? error,
    );
  }
  if (result.status !== 0 || result.timedOut || result.overflow) {
    return incompleteObservation(
      scope,
      result.timedOut
        ? "process_member_observation_timeout"
        : scope.expectedProcess && result.status === 4 &&
            !result.error && !result.signal && !result.overflow
        ? "process_generation_changed"
        : "process_member_observation_failed",
      boundaryFailure(result, "native process observation").message,
    );
  }
  const members = parseBoundaryMembers(result.stdout, scope, platform);
  return members
    ? completeObservation(scope, members)
    : incompleteObservation(scope, "process_member_unparseable");
}

function observeNativeSync(
  scope,
  platform,
  timeoutMs = PROCESS_OBSERVATION_TIMEOUT_MS,
  includeCwd = false,
) {
  if (scope.kind === "point" && scope.requestedPids.length === 0) {
    return completeObservation(scope, []);
  }
  const startedAt = performance.now();
  try {
    const executable = platform === "darwin"
      ? prepareMacosBoundarySync(timeoutMs)
      : null;
    const boundary = platformBoundary(platform, executable);
    if (!boundary) {
      return incompleteObservation(scope, "process_member_adapter_unavailable");
    }
    const remaining = Math.ceil(timeoutMs - (performance.now() - startedAt));
    if (remaining <= 0) {
      return incompleteObservation(
        scope,
        "process_member_observation_timeout",
      );
    }
    const result = spawnSync(
      boundary.file,
      [...boundary.prefix, ...observationArguments(scope, includeCwd)],
      {
        detached: true,
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: PROCESS_BOUNDARY_MAX_BUFFER_BYTES,
        timeout: remaining,
      },
    );
    if (result.error?.code === "ETIMEDOUT") {
      return incompleteObservation(
        scope,
        "process_member_observation_timeout",
        boundaryFailure(result, "native process observation").message,
      );
    }
    if (result.status !== 0 || result.error) {
      return incompleteObservation(
        scope,
        "process_member_observation_failed",
        boundaryFailure(result, "native process observation").message,
      );
    }
    const members = parseBoundaryMembers(
      result.stdout,
      scope,
      platform,
      includeCwd,
    );
    return members
      ? completeObservation(scope, members)
      : incompleteObservation(scope, "process_member_unparseable");
  } catch (error) {
    return incompleteObservation(
      scope,
      performance.now() - startedAt >= timeoutMs
        ? "process_member_observation_timeout"
        : "process_member_observation_failed",
      error?.message ?? error,
    );
  }
}

export async function observeProcessMembers(
  request,
  {
    platform = process.platform,
    timeoutMs = PROCESS_OBSERVATION_TIMEOUT_MS,
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("process observation timeout must be positive");
  }
  const scope = observationScope(request, platform);
  const deadline = performance.now() + timeoutMs;
  const members = [];
  for (const batch of observationBatches(scope)) {
    const remaining = remainingObservationTimeout(deadline);
    if (remaining <= 0) {
      return incompleteObservation(scope, "process_member_observation_timeout");
    }
    const observation = await observeNative(batch, platform, remaining);
    if (observation.status !== "complete") {
      return incompleteObservation(
        scope,
        observation.reason,
        observation.diagnostic,
      );
    }
    members.push(...observation.members);
  }
  return completeObservation(scope, members);
}

function parseMacosIdentityRelations(output) {
  const relations = [];
  const observed = new Set();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(
      /^I (\d+) ([0-9a-f-]{36}) (\d+) (\d+)$/u,
    );
    const pid = Number(match?.[1]);
    const bootSession = match?.[2];
    const uniqueId = match?.[3];
    const parentUniqueId = match?.[4];
    const identity = parseMacosProcessIdentity(
      `kernel-start-v3:macos:${bootSession}:${uniqueId}`,
    );
    const parentIdentity = parentUniqueId === "0"
      ? null
      : parseMacosProcessIdentity(
          `kernel-start-v3:macos:${bootSession}:${parentUniqueId}`,
        );
    if (
      !match ||
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      observed.has(pid) ||
      !identity ||
      (parentUniqueId !== "0" && !parentIdentity)
    ) {
      return null;
    }
    observed.add(pid);
    relations.push({
      parentProcessIdentity: parentIdentity?.processIdentity ?? null,
      pid,
      processIdentity: identity.processIdentity,
    });
  }
  return relations.sort((left, right) => left.pid - right.pid);
}

export async function observeCurrentUserProcessIdentities(
  {
    platform = process.platform,
    timeoutMs = PROCESS_OBSERVATION_TIMEOUT_MS,
  } = {},
) {
  const scope = {
    effectiveUid: process.geteuid?.(),
    evidence: "closed_enumeration",
    kind: "user_identity_census",
  };
  if (platform !== "darwin") {
    return {
      reason: "process_identity_census_unsupported",
      scope,
      status: "incomplete",
    };
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("process observation timeout must be positive");
  }
  const startedAt = performance.now();
  let executable;
  try {
    executable = await prepareMacosBoundary(timeoutMs);
  } catch {
    return {
      reason: performance.now() - startedAt >= timeoutMs
        ? "process_identity_census_timeout"
        : "process_identity_census_failed",
      scope,
      status: "incomplete",
    };
  }
  const remaining = Math.ceil(timeoutMs - (performance.now() - startedAt));
  if (remaining <= 0) {
    return {
      reason: "process_identity_census_timeout",
      scope,
      status: "incomplete",
    };
  }
  try {
    const result = await runBounded(
      executable,
      ["observe-user-identities"],
      {
        timeoutMs: remaining,
        maxBuffer: PROCESS_BOUNDARY_MAX_BUFFER_BYTES,
      },
    );
    if (result.status !== 0 || result.timedOut || result.overflow) {
      return {
        reason: result.timedOut
          ? "process_identity_census_timeout"
          : "process_identity_census_failed",
        scope,
        status: "incomplete",
      };
    }
    const relations = parseMacosIdentityRelations(result.stdout);
    return relations
      ? { relations, scope, status: "complete" }
      : {
          reason: "process_identity_census_unparseable",
          scope,
          status: "incomplete",
        };
  } catch {
    return {
      reason: "process_identity_census_failed",
      scope,
      status: "incomplete",
    };
  }
}

export async function observeProcessIdentity(pid, options) {
  const observation = await observeProcessMembers(
    { kind: "point", pids: [pid] },
    options,
  );
  return observation.status === "complete"
    ? observation.members[0]?.processIdentity ?? null
    : null;
}

export async function observeProcessGroupId(pid, options) {
  const observation = await observeProcessMembers(
    { kind: "point", pids: [pid] },
    options,
  );
  return observation.status === "complete"
    ? observation.members[0]?.groupId ?? null
    : null;
}

export function processMemberFromObservation(pid, observation) {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    observation?.status !== "complete" ||
    !Array.isArray(observation.members) ||
    observation.scope?.kind !== "point" ||
    !Array.isArray(observation.scope.requestedPids) ||
    !observation.scope.requestedPids.includes(pid) ||
    observation.members.some(
      (member) => !observation.scope.requestedPids.includes(member?.pid),
    )
  ) {
    return { status: "unknown" };
  }
  const matches = observation.members.filter((member) => member?.pid === pid);
  if (matches.length > 1) return { status: "unknown" };
  const member = matches[0];
  if (!member || member.state === "zombie") return { status: "departed" };
  if (
    !["live", "stopped"].includes(member.state) ||
    typeof member.processIdentity !== "string"
  ) {
    return { status: "unknown" };
  }
  return { member, status: "present" };
}

export function processLivenessFromObservation(owner, observation) {
  if (!owner) return "stale";
  const observed = processMemberFromObservation(owner.pid, observation);
  if (observed.status === "unknown") return "unknown";
  if (observed.status === "departed") return "stale";
  return observed.member.processIdentity === owner.processIdentity
    ? "active"
    : "stale";
}

export async function observeProcessLiveness(owner, options) {
  if (!owner) return "stale";
  return processLivenessFromObservation(
    owner,
    await observeProcessMembers(
      { kind: "point", pids: [owner.pid] },
      options,
    ),
  );
}

function exactSignalArguments(owner, signal, platform) {
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.processIdentity !== "string"
  ) {
    throw new Error("invalid exact process identity");
  }
  const signalNumber = osConstants.signals[signal];
  if (!Number.isSafeInteger(signalNumber) || signalNumber <= 0) {
    throw new Error("invalid exact process signal");
  }
  if (platform === "darwin") {
    const identity = parseMacosProcessIdentity(owner.processIdentity);
    if (!identity) {
      const error = new Error("invalid macOS process identity");
      error.code = "DEV_PROCESS_IDENTITY_UNAVAILABLE";
      throw error;
    }
    return [
      "signal",
      String(owner.pid),
      identity.bootSession,
      identity.uniqueId,
      String(signalNumber),
    ];
  }
  if (platform === "linux") {
    const identity = parseLinuxProcessIdentity(owner.processIdentity);
    if (!identity) throw new Error("invalid Linux process identity");
    return [
      "signal-identity",
      String(owner.pid),
      identity.bootId,
      identity.startTicks,
      String(signalNumber),
    ];
  }
  throw new Error("exact process signaling is unsupported");
}

function exactSignalResult(result) {
  if (result.status === 0) return true;
  if (result.status === 3) return false;
  const error = result.status === 4
    ? new Error("refusing to signal a reused process generation")
    : boundaryFailure(result, "exact process signal");
  error.code = result.status === 4
    ? "DEV_PROCESS_IDENTITY_UNAVAILABLE"
    : "DEV_PROCESS_SIGNAL_FAILED";
  throw error;
}

export async function signalProcessGeneration(
  owner,
  signal,
  { timeoutMs = PROCESS_OBSERVATION_TIMEOUT_MS } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("process signal timeout must be positive");
  }
  const platform = process.platform;
  const executable = platform === "darwin"
    ? await prepareMacosBoundary()
    : null;
  const boundary = platformBoundary(platform, executable);
  if (!boundary) throw new Error("exact process signaling is unsupported");
  const result = await runBounded(
    boundary.file,
    [...boundary.prefix, ...exactSignalArguments(owner, signal, platform)],
    {
      timeoutMs,
      maxBuffer: PROCESS_BOUNDARY_MAX_BUFFER_BYTES,
    },
  );
  return exactSignalResult(result);
}

export function signalProcessGenerationSync(owner, signal) {
  const platform = process.platform;
  const executable = platform === "darwin"
    ? prepareMacosBoundarySync()
    : null;
  const boundary = platformBoundary(platform, executable);
  if (!boundary) throw new Error("exact process signaling is unsupported");
  const result = spawnSync(
    boundary.file,
    [...boundary.prefix, ...exactSignalArguments(owner, signal, platform)],
    {
      detached: true,
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: PROCESS_BOUNDARY_MAX_BUFFER_BYTES,
      timeout: PROCESS_OBSERVATION_TIMEOUT_MS,
    },
  );
  return exactSignalResult(result);
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function processMemberSnapshots(
  pids,
  platform = process.platform,
  { includeCwd = false } = {},
) {
  const requested = uniquePids(pids);
  if (!requested) {
    return { status: "incomplete", reason: "invalid_process_members" };
  }
  const scope = processPointScope(requested);
  const deadline = performance.now() + PROCESS_OBSERVATION_TIMEOUT_MS;
  const members = [];
  for (const batch of observationBatches(scope)) {
    const remaining = remainingObservationTimeout(deadline);
    if (remaining <= 0) {
      return incompleteObservation(scope, "process_member_observation_timeout");
    }
    const observation = observeNativeSync(batch, platform, remaining, includeCwd);
    if (observation.status !== "complete") {
      return incompleteObservation(
        scope,
        observation.reason,
        observation.diagnostic,
      );
    }
    members.push(...observation.members);
  }
  return completeObservation(scope, members);
}

export function processCurrentUserTopology(platform = process.platform) {
  return observeNativeSync(currentUserTopologyScope(), platform);
}

export function processIdentity(pid) {
  const observation = processMemberSnapshots([pid]);
  return observation.status === "complete"
    ? observation.members[0]?.processIdentity ?? null
    : null;
}

export function processGroupId(pid) {
  const observation = processMemberSnapshots([pid]);
  return observation.status === "complete"
    ? observation.members[0]?.groupId ?? null
    : null;
}

export function processGroupMemberStates(groupId) {
  try {
    return observeNativeSync(groupCensusScope(groupId), process.platform);
  } catch {
    return { status: "incomplete", reason: "invalid_process_group" };
  }
}

export function processLiveness(owner, alive, identity) {
  if (!owner || !alive(owner.pid)) return "stale";
  const observed = identity(owner.pid);
  if (!observed) return "unknown";
  return observed === owner.processIdentity ? "active" : "stale";
}
