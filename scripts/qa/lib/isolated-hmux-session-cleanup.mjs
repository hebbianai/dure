#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  processMemberFromObservation,
  processMemberSnapshots,
} from "../../lib/process-identity.mjs";
import {
  exactOwnedProcessIdentity,
  readOwnedProcessGroup,
  readOwnedProcessLedger,
} from "./owned-process-group.mjs";
import { qaEnvironmentValue } from "./qa-environment.mjs";

const MAX_SCANNED_ENTRIES = 2_048;
const MAX_MANIFESTS = 256;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DEPTH = 6;
const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 30_000;
const POLL_MS = 50;
const QUIESCENT_PASSES = 3;
const COMMAND_TIMEOUT_MS = 7_000;
const CLEANUP_INCOMPLETE_REASON = "process_session_cleanup_incomplete";
const MAX_PROCESS_OWNERS = 4;
const OWNERSHIP_DEPARTED = "departed";

function cleanupError(message) {
  return new Error(`isolated_hmux_cleanup_refused: ${message}`);
}

function boundedString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    [...value].some((character) => character < " ")
  ) {
    throw cleanupError(`invalid ${label}`);
  }
  return value;
}

function positivePid(value, label) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw cleanupError(`invalid ${label}`);
  }
  return pid;
}

function processProof(value, label) {
  if (typeof value !== "object" || value === null) {
    throw cleanupError(`missing ${label} process proof`);
  }
  return {
    process_id: positivePid(value.process_id, `${label} process id`),
    start_marker: boundedString(value.start_marker, `${label} start marker`),
  };
}

function assertOwnedDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw cleanupError(`${label} is not a direct directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw cleanupError(`${label} is owned by another user`);
  }
  return { resolved, stat };
}

export function assertIsolatedCleanupBoundary(stateRoot, discoveryRoot) {
  const state = assertOwnedDirectory(stateRoot, "state root");
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (
    fs.realpathSync(path.dirname(state.resolved)) !== temporaryRoot ||
    !["dure-", "hebbian-"].some((prefix) =>
      path.basename(state.resolved).startsWith(prefix),
    )
  ) {
    throw cleanupError("state root is outside the direct QA temp boundary");
  }
  const discovery = assertOwnedDirectory(discoveryRoot, "discovery root");
  if (
    fs.realpathSync(path.dirname(discovery.resolved)) !==
      fs.realpathSync(state.resolved) ||
    discovery.resolved !== path.join(state.resolved, "hmux-discovery")
  ) {
    throw cleanupError("discovery root is not the authorized QA child");
  }
  return {
    discoveryRoot: discovery.resolved,
    discoveryRootIdentity: {
      device: String(discovery.stat.dev),
      inode: String(discovery.stat.ino),
    },
    stateRoot: state.resolved,
    stateRootIdentity: {
      device: String(state.stat.dev),
      inode: String(state.stat.ino),
    },
  };
}

export function processOwnershipGuard(
  boundary,
  processOwners,
  {
    observeMembers = processMemberSnapshots,
    readGroup = readOwnedProcessGroup,
    readLedger = readOwnedProcessLedger,
  } = {},
) {
  if (!Array.isArray(processOwners) || processOwners.length > MAX_PROCESS_OWNERS) {
    throw cleanupError("process owner limit exceeded");
  }
  const processesByPid = new Map();
  for (const owner of processOwners) {
    const descriptorPath = path.resolve(owner.descriptorPath);
    const stat = fs.lstatSync(descriptorPath);
    if (
      path.dirname(descriptorPath) !== boundary.stateRoot ||
      !stat.isFile() ||
      stat.isSymbolicLink()
    ) {
      throw cleanupError("process owner descriptor is outside the QA state root");
    }
    const descriptor = readGroup(
      descriptorPath,
      positivePid(owner.supervisorPid, "process owner supervisor"),
    );
    for (const process of readLedger(descriptor)) {
      const candidates = processesByPid.get(process.pid) ?? [];
      candidates.push(process);
      processesByPid.set(process.pid, candidates);
    }
  }

  return {
    assertOwned(process, status) {
      const candidates = processesByPid.get(process.process_id) ?? [];
      if (candidates.length === 0) {
        throw cleanupError(
          `manifest process ${process.process_id} is not owned by this QA run`,
        );
      }
      if (status === "live") {
        const observed = processMemberFromObservation(
          process.process_id,
          observeMembers([process.process_id]),
        );
        if (observed.status === "unknown") {
          throw cleanupError(
            `manifest process ${process.process_id} identity observation is incomplete`,
          );
        }
        if (observed.status === "departed") {
          return OWNERSHIP_DEPARTED;
        }
        if (
          !candidates.some(
            (expected) =>
              exactOwnedProcessIdentity(expected).processIdentity ===
              observed.member.processIdentity,
          )
        ) {
          throw cleanupError(
            `manifest process ${process.process_id} is not the live generation owned by this QA run`,
          );
        }
      }
    },
  };
}

function manifestFiles(root) {
  const queue = [{ depth: 0, directory: root }];
  const manifests = [];
  let scanned = 0;
  while (queue.length > 0) {
    const { depth, directory } = queue.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES) {
        throw cleanupError("discovery scan limit exceeded");
      }
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === "manifest.json") {
        manifests.push(entryPath);
        if (manifests.length > MAX_MANIFESTS) {
          throw cleanupError("manifest limit exceeded");
        }
      } else if (entry.isDirectory() && depth < MAX_DEPTH) {
        queue.push({ depth: depth + 1, directory: entryPath });
      }
    }
  }
  return manifests;
}

function mismatchedFenceFields(left, right) {
  return [
    "workspace_id",
    "session_id",
    "runner_principal",
    "runner_instance",
    "channel_epoch",
    "host_instance_id",
    "terminal_epoch",
  ].filter((field) =>
    field === "channel_epoch"
      ? left[field] !== String(right?.[field])
      : left[field] !== right?.[field],
  );
}

function cleanupTarget(file) {
  const stat = fs.statSync(file);
  if (stat.size <= 0 || stat.size > MAX_MANIFEST_BYTES) {
    throw cleanupError("manifest size is invalid");
  }
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !["starting", "ready", "exited"].includes(envelope?.lifecycle) ||
    typeof envelope?.manifest !== "object" ||
    envelope.manifest === null
  ) {
    throw cleanupError("manifest envelope is invalid");
  }
  const manifest = envelope.manifest;
  const common = manifest.common;
  const lifetime = common?.lifetime;
  if (typeof common !== "object" || common === null) {
    throw cleanupError("manifest common identity is missing");
  }
  const channelEpoch = Number(lifetime?.channel_epoch);
  if (!Number.isSafeInteger(channelEpoch) || channelEpoch < 0) {
    throw cleanupError("manifest channel epoch is invalid");
  }
  const baseFence = {
    // ManifestCommon predates the lossless JSON-u64 wire adapter and stores
    // this value as a number. SessionFence uses canonical decimal text, both
    // in an exited tombstone and in the CLI's expected-fence JSON.
    channel_epoch: String(channelEpoch),
    host_instance_id: boundedString(
      common.host_instance_id,
      "host instance id",
    ),
    runner_instance: boundedString(
      lifetime?.runner_instance,
      "runner instance",
    ),
    runner_principal: boundedString(
      lifetime?.runner_principal,
      "runner principal",
    ),
    session_id: boundedString(lifetime?.session_id, "session id"),
    workspace_id: boundedString(lifetime?.workspace_id, "workspace id"),
  };
  const sessionClass = common.session_class ?? "managed";
  if (!["managed", "standalone"].includes(sessionClass)) {
    throw cleanupError("manifest session class is invalid");
  }
  const hostProcess = processProof(common.host_process, "host");
  if (envelope.lifecycle === "starting") {
    return {
      fence: undefined,
      hostProcess,
      lifecycle: envelope.lifecycle,
      providerProcess: undefined,
      sessionClass,
      ...baseFence,
    };
  }
  const terminalEpoch = boundedString(
    envelope.lifecycle === "ready"
      ? manifest.terminal_epoch
      : manifest.tombstone?.fence?.terminal_epoch,
    "terminal epoch",
  );
  const fence = { ...baseFence, terminal_epoch: terminalEpoch };
  const fenceMismatches =
    envelope.lifecycle === "exited"
      ? mismatchedFenceFields(fence, manifest.tombstone?.fence)
      : [];
  if (fenceMismatches.length > 0) {
    throw cleanupError(
      `exited tombstone fence does not match its manifest: ${fenceMismatches.join(", ")}`,
    );
  }
  const providerProcess = processProof(
    envelope.lifecycle === "ready"
      ? manifest.provider_process
      : manifest.tombstone?.provider_process,
    "provider",
  );
  const exitReason =
    envelope.lifecycle === "exited"
      ? boundedString(manifest.tombstone?.exit?.reason, "exit reason")
      : undefined;
  if (
    exitReason
      ?.split("; ")
      .some((reason) => reason === CLEANUP_INCOMPLETE_REASON)
  ) {
    throw cleanupError("Host reported incomplete provider process cleanup");
  }
  return {
    exitReason,
    fence,
    hostProcess,
    lifecycle: envelope.lifecycle,
    providerProcess,
    sessionClass,
    ...baseFence,
    terminal_epoch: terminalEpoch,
  };
}

export function collectIsolatedHmuxCleanupTargets(discoveryRoot) {
  const root = path.resolve(discoveryRoot);
  return manifestFiles(root)
    .map(cleanupTarget)
    .sort((left, right) =>
      [left.workspace_id, left.session_id, left.host_instance_id]
        .join("\0")
        .localeCompare(
          [right.workspace_id, right.session_id, right.host_instance_id].join(
            "\0",
          ),
        ),
    );
}

function targetIdentity(target) {
  return [
    target.workspace_id,
    target.session_id,
    target.runner_principal,
    target.runner_instance,
    String(target.channel_epoch),
    target.host_instance_id,
    target.terminal_epoch ?? "starting",
  ].join("\0");
}

function processIdentity(process) {
  return `${process.process_id}\0${process.start_marker}`;
}

function runJson(command, args, options = {}) {
  const result = (options.spawnSync ?? spawnSync)(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
  if (result.error) {
    throw cleanupError(
      `command failed to start: ${result.error.message ?? String(result.error)}`,
    );
  }
  if (result.status !== 0) {
    throw cleanupError(
      `command exited ${result.status}: ${String(result.stderr ?? "").trim()}`,
    );
  }
  try {
    return JSON.parse(String(result.stdout));
  } catch (error) {
    throw cleanupError(
      `command returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function probeProcess(cli, discoveryRoot, process, options) {
  const response = runJson(
    cli,
    [
      "--discovery-root",
      discoveryRoot,
      "--json",
      "process",
      "probe",
      String(process.process_id),
      process.start_marker,
    ],
    options,
  );
  if (
    response?.schemaVersion !== 1 ||
    !["live", "absent"].includes(response.status) ||
    Number(response.process?.process_id) !== process.process_id ||
    response.process?.start_marker !== process.start_marker
  ) {
    throw cleanupError("process probe receipt does not match its request");
  }
  return response.status;
}

function terminateReadySession(cli, runtime, discoveryRoot, target, waitMs, options) {
  const response = runJson(
    cli,
    [
      "--discovery-root",
      discoveryRoot,
      "--json",
      "kill",
      target.session_id,
      "--workspace",
      target.workspace_id,
      "--expected-fence-json",
      JSON.stringify(target.fence),
      "--runtime",
      runtime,
      "--timeout-ms",
      String(Math.max(100, Math.min(waitMs, MAX_WAIT_MS))),
    ],
    options,
  );
  if (
    response?.ok !== true ||
    response.sessionId !== target.session_id ||
    response.sessionClass !== target.sessionClass
  ) {
    throw cleanupError("termination receipt does not match its request");
  }
}

function assertExecutable(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw cleanupError(`${label} is not a direct executable`);
  }
  return resolved;
}

function boundedWait(value) {
  if (value === undefined || value === "") return DEFAULT_WAIT_MS;
  const wait = Number(value);
  if (!Number.isSafeInteger(wait) || wait < 0 || wait > MAX_WAIT_MS) {
    throw cleanupError("wait must be between 0 and 30000ms");
  }
  return wait;
}

export async function reapIsolatedHmuxSessions(
  {
    discoveryRoot,
    hmuxCli,
    hmuxRuntime,
    processOwners = [],
    stateRoot,
    waitMs = DEFAULT_WAIT_MS,
  },
  options = {},
) {
  const boundary = assertIsolatedCleanupBoundary(stateRoot, discoveryRoot);
  const cli = assertExecutable(hmuxCli, "hmux CLI");
  const runtime = assertExecutable(hmuxRuntime, "hmux runtime");
  const ownership =
    options.ownershipGuard ?? processOwnershipGuard(boundary, processOwners);
  const startedAt = Date.now();
  const deadline = startedAt + boundedWait(waitMs);
  const observedTargets = new Map();
  const observedProcesses = new Map();
  const terminated = new Set();
  let stableFingerprint;
  let stablePasses = 0;

  do {
    const current = collectIsolatedHmuxCleanupTargets(boundary.discoveryRoot);
    const currentProcessStatuses = new Map();
    const liveProcesses = [];
    for (const target of current) {
      observedTargets.set(targetIdentity(target), target);
      for (const process of [
        target.hostProcess,
        ...(target.providerProcess ? [target.providerProcess] : []),
      ]) {
        const identity = processIdentity(process);
        observedProcesses.set(identity, process);
        const status = probeProcess(
          cli,
          boundary.discoveryRoot,
          process,
          options,
        );
        // An exited tombstone is observation-only: Hmux has already retired
        // the session and cleanup never signals either recorded PID. A Host
        // can remain live for its bounded exit grace after its short-lived
        // setsid parent escaped the ownership sampler. Keep waiting for that
        // exact Hmux generation to disappear; active sessions still require
        // the independent QA ownership ledger before any fenced stop.
        const ownershipStatus =
          target.lifecycle === "exited"
            ? undefined
            : ownership.assertOwned(process, status);
        const effectiveStatus =
          ownershipStatus === OWNERSHIP_DEPARTED
            ? OWNERSHIP_DEPARTED
            : status;
        currentProcessStatuses.set(identity, effectiveStatus);
        if (effectiveStatus === "live") liveProcesses.push(process);
      }
      if (target.lifecycle === "ready") {
        const processStatuses = [
          target.hostProcess,
          target.providerProcess,
        ].map((process) =>
          currentProcessStatuses.get(processIdentity(process)),
        );
        if (processStatuses.includes(OWNERSHIP_DEPARTED)) {
          continue;
        }
        if (processStatuses.some((status) => status !== "live")) {
          throw cleanupError(
            "ready session process generation is not live under QA ownership",
          );
        }
        const identity = targetIdentity(target);
        if (!terminated.has(identity)) {
          terminateReadySession(
            cli,
            runtime,
            boundary.discoveryRoot,
            target,
            Math.max(100, deadline - Date.now()),
            options,
          );
          terminated.add(identity);
        }
      }
    }

    for (const process of observedProcesses.values()) {
      const identity = processIdentity(process);
      if (currentProcessStatuses.has(identity)) continue;
      if (
        probeProcess(cli, boundary.discoveryRoot, process, options) === "live"
      ) {
        liveProcesses.push(process);
      }
    }
    const fingerprint = JSON.stringify(
      current.map((target) => [
        target.lifecycle,
        targetIdentity(target),
        processIdentity(target.hostProcess),
        target.providerProcess
          ? processIdentity(target.providerProcess)
          : "",
      ]),
    );
    const hasActiveSession = current.some(
      (target) =>
        target.lifecycle === "starting" || target.lifecycle === "ready",
    );
    if (
      liveProcesses.length === 0 &&
      !hasActiveSession &&
      fingerprint === stableFingerprint
    ) {
      stablePasses += 1;
    } else if (liveProcesses.length === 0 && !hasActiveSession) {
      stableFingerprint = fingerprint;
      stablePasses = 1;
    } else {
      stableFingerprint = undefined;
      stablePasses = 0;
    }
    if (stablePasses >= QUIESCENT_PASSES) {
      return {
        observedProcesses: observedProcesses.size,
        observedSessions: observedTargets.size,
        schema: "dure-qa-hmux-reap/v1",
        stateRootIdentity: boundary.stateRootIdentity,
        terminatedSessions: terminated.size,
      };
    }
    await (options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))))(POLL_MS);
  } while (Date.now() < deadline);

  throw cleanupError(
    "session generations did not become quiescent before the deadline",
  );
}

async function main() {
  const [
    command,
    stateRoot,
    discoveryRoot,
    hmuxCli,
    hmuxRuntime,
    ...ownerArguments
  ] = process.argv.slice(2);
  if (
    command !== "reap" ||
    !stateRoot ||
    !discoveryRoot ||
    !hmuxCli ||
    !hmuxRuntime ||
    ownerArguments.length % 2 !== 0
  ) {
    throw new Error(
      "usage: isolated-hmux-session-cleanup.mjs reap <state-root> <discovery-root> <hmux-cli> <hmux-runtime> [<owner-descriptor> <owner-supervisor-pid>]...",
    );
  }
  const processOwners = [];
  for (let index = 0; index < ownerArguments.length; index += 2) {
    processOwners.push({
      descriptorPath: ownerArguments[index],
      supervisorPid: ownerArguments[index + 1],
    });
  }
  const result = await reapIsolatedHmuxSessions({
    discoveryRoot,
    hmuxCli,
    hmuxRuntime,
    processOwners,
    stateRoot,
    waitMs: boundedWait(
      qaEnvironmentValue(process.env, "HMUX_STOP_GRACE_MS"),
    ),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
