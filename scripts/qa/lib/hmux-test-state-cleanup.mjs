import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectIsolatedHmuxCleanupTargets,
} from "./isolated-hmux-session-cleanup.mjs";
import { assertSameRootGeneration } from "./isolated-root-retirement.mjs";
import {
  exactOwnedProcessIdentity,
  terminateOwnedProcessGroup,
} from "./owned-process-group.mjs";
import {
  observeOwnedProcessSnapshot,
} from "./owned-process-snapshot.mjs";

const DIRECTORY_READ_BUFFER = 32;
const MAX_DISCOVERY_ROOTS = 256;
const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 50;
const QUIESCENT_PASSES = 3;
const COMMAND_TIMEOUT_MS = 7_000;
const OWNER_RECORD_NAME = "hmux-test-owner-v2.json";
const OWNER_RECORD_SCHEMA = "dure-hmux-test-owner/v2";

function cleanupError(message) {
  return new Error(`hmux_test_state_cleanup_refused: ${message}`);
}

function assertExecutable(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw cleanupError(`${label} is not a direct executable`);
  }
  return resolved;
}

function defaultTemporaryRoot() {
  return process.platform === "win32" ? os.tmpdir() : "/tmp";
}

function assertExpectedStateRootIdentity(stateRoot, expected) {
  if (
    typeof expected?.device !== "string" ||
    !/^\d+$/u.test(expected.device) ||
    typeof expected?.inode !== "string" ||
    !/^\d+$/u.test(expected.inode)
  ) {
    throw cleanupError("expected state root identity is invalid");
  }
  try {
    assertSameRootGeneration(stateRoot, expected);
  } catch {
    throw cleanupError("state root generation changed after authorization");
  }
}

function assertStateRoot(
  stateRoot,
  temporaryRoot = defaultTemporaryRoot(),
  worktreeRoot = fs.realpathSync(process.cwd()),
  expectedStateRootIdentity,
) {
  const resolved = path.resolve(stateRoot);
  if (expectedStateRootIdentity) {
    assertExpectedStateRootIdentity(resolved, expectedStateRootIdentity);
  }
  const stat = fs.lstatSync(resolved);
  const resolvedTemporaryRoot = fs.realpathSync(temporaryRoot);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(path.dirname(resolved)) !== resolvedTemporaryRoot ||
    !path.basename(resolved).startsWith("dure-hmux-test.") ||
    (stat.mode & 0o077) !== 0
  ) {
    throw cleanupError("state root is outside the owner-only test boundary");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw cleanupError("state root is owned by another user");
  }
  const ownerFile = path.join(resolved, OWNER_RECORD_NAME);
  const ownerStat = fs.lstatSync(ownerFile);
  if (
    !ownerStat.isFile() ||
    ownerStat.isSymbolicLink() ||
    ownerStat.size <= 0 ||
    ownerStat.size > 4_096
  ) {
    throw cleanupError("state root owner record is invalid");
  }
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  const guardian = owner?.guardianProcess;
  if (
    owner?.schema !== OWNER_RECORD_SCHEMA ||
    owner?.worktreeRoot !== worktreeRoot ||
    !guardian ||
    !Number.isSafeInteger(guardian.pid) ||
    guardian.pid <= 1 ||
    typeof guardian.startMarker !== "string" ||
    typeof guardian.kernelStartMarker !== "string"
  ) {
    throw cleanupError("state root owner record does not match this worktree");
  }
  if (expectedStateRootIdentity) {
    assertExpectedStateRootIdentity(resolved, expectedStateRootIdentity);
  }
  return resolved;
}

function discoveryRootForManifest(file) {
  return path.dirname(path.dirname(path.dirname(file)));
}

function isCanonicalSessionManifest(file) {
  const sessionDirectory = path.dirname(file);
  const workspaceDirectory = path.dirname(sessionDirectory);
  return (
    path.basename(sessionDirectory).startsWith("s_") &&
    path.basename(workspaceDirectory).startsWith("w_")
  );
}

export function findHmuxTestDiscoveryRoots(stateRoot, options = {}) {
  const root = assertStateRoot(
    stateRoot,
    options.temporaryRoot,
    options.worktreeRoot,
    options.expectedStateRootIdentity,
  );
  const discoveryRoots = new Set();
  const deadline = options.deadline ?? performance.now() + DEFAULT_WAIT_MS;
  const assertTimeRemaining = () => {
    if (performance.now() >= deadline) {
      throw cleanupError("state scan deadline exceeded");
    }
  };
  // Stream a complete depth-first observation without a recursive call stack
  // or a whole-tree queue. Package caches can be deeper than session fixtures;
  // depth does not authorize skipping them. The shared deadline still refuses
  // incomplete observations, including OS failures opening a deep directory.
  const directories = [];
  const open = (directory) => {
    assertTimeRemaining();
    directories.push({
      directory,
      entries: fs.opendirSync(directory, { bufferSize: DIRECTORY_READ_BUFFER }),
    });
  };
  try {
    open(root);
    while (directories.length > 0) {
      assertTimeRemaining();
      const { directory, entries } = directories.at(-1);
      const entry = entries.readSync();
      if (entry === null) {
        directories.pop();
        entries.closeSync();
      } else {
        if (entry.isSymbolicLink()) continue;
        const entryPath = path.join(directory, entry.name);
        if (entry.isFile() && entry.name === "manifest.json") {
          if (!isCanonicalSessionManifest(entryPath)) continue;
          const discoveryRoot = discoveryRootForManifest(entryPath);
          const relative = path.relative(root, discoveryRoot);
          if (
            relative === "" ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            throw cleanupError("manifest escaped the test state root");
          }
          discoveryRoots.add(discoveryRoot);
          if (discoveryRoots.size > MAX_DISCOVERY_ROOTS) {
            throw cleanupError("discovery root limit exceeded");
          }
        } else if (entry.isDirectory()) {
          open(entryPath);
        }
      }
    }
  } finally {
    for (const { entries } of directories.reverse()) entries.closeSync();
  }
  if (options.expectedStateRootIdentity) {
    assertExpectedStateRootIdentity(root, options.expectedStateRootIdentity);
  }
  assertTimeRemaining();
  return [...discoveryRoots].sort();
}

function runJson(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error) {
    throw cleanupError(
      `command failed to start: ${result.error.message ?? String(result.error)}`,
    );
  }
  if (result.status !== 0) {
    throw cleanupError(
      `command exited ${result.status}: ${String(result.stderr ?? "")
        .trim()
        .replaceAll(/\s+/gu, " ")
        .slice(0, 512)}`,
    );
  }
  try {
    return JSON.parse(String(result.stdout));
  } catch (error) {
    throw cleanupError(
      `command returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function probeProcess(cli, discoveryRoot, processProof) {
  const receipt = runJson(cli, [
    "--discovery-root",
    discoveryRoot,
    "--json",
    "process",
    "probe",
    String(processProof.process_id),
    processProof.start_marker,
  ]);
  if (
    receipt?.schemaVersion !== 1 ||
    !["live", "absent"].includes(receipt.status) ||
    Number(receipt.process?.process_id) !== processProof.process_id ||
    receipt.process?.start_marker !== processProof.start_marker
  ) {
    throw cleanupError("process probe receipt does not match its request");
  }
  return receipt.status;
}

function terminateReadySession(cli, runtime, discoveryRoot, target, waitMs) {
  const fence = {
    channel_epoch: String(target.channel_epoch),
    host_instance_id: target.host_instance_id,
    runner_instance: target.runner_instance,
    runner_principal: target.runner_principal,
    session_id: target.session_id,
    terminal_epoch: target.terminal_epoch,
    workspace_id: target.workspace_id,
  };
  const receipt = runJson(cli, [
    "--discovery-root",
    discoveryRoot,
    "--json",
    "kill",
    target.session_id,
    "--workspace",
    target.workspace_id,
    "--expected-fence-json",
    JSON.stringify(fence),
    "--runtime",
    runtime,
    "--timeout-ms",
    String(Math.max(100, waitMs)),
  ]);
  if (
    receipt?.ok !== true ||
    receipt.sessionId !== target.session_id ||
    receipt.sessionClass !== target.sessionClass
  ) {
    throw cleanupError("termination receipt does not match its request");
  }
}

function exactOwnedLeader(
  processProof,
  processSnapshot,
  label,
  observation,
) {
  // The target loop's Hmux probe owns the protocol start marker. The frozen
  // ledger supplies its OS generation; this point observation only proves
  // that the exact owned generation still occupies the process-group anchor.
  const owned = processSnapshot.ledger.find(
    ({ pid }) => pid === processProof.process_id,
  );
  if (!owned) {
    throw cleanupError(
      `manifest ${label} generation is absent from the ownership ledger`,
    );
  }
  const expected = exactOwnedProcessIdentity(owned);
  if (observation.status !== "complete") {
    throw cleanupError(`manifest ${label} identity observation is incomplete`);
  }
  const leader = observation.members.find(({ pid }) => pid === expected.pid);
  if (
    !leader ||
    leader.state === "zombie" ||
    leader.processIdentity !== expected.processIdentity ||
    leader.groupId !== leader.pid ||
    leader.pid !== expected.pid
  ) {
    throw cleanupError(
      `manifest ${label} process-group leader changed after ownership publication`,
    );
  }
  return { identity: expected, member: leader };
}

export function planManifestProcessRetirement(
  target,
  processSnapshot,
  observation,
) {
  const host = exactOwnedLeader(
    target.hostProcess,
    processSnapshot,
    "Host",
    observation,
  );
  const provider = target.providerProcess
    ? exactOwnedLeader(
        target.providerProcess,
        processSnapshot,
        "provider",
        observation,
      )
    : undefined;
  const exactOwnedByPid = new Map(
    processSnapshot.ledger.map((owned) => [
      owned.pid,
      exactOwnedProcessIdentity(owned),
    ]),
  );
  const retirementCandidates = [provider, host].filter(Boolean);
  if (host.member.sessionId === host.member.pid) {
    const sessionProcesses = observation.members.filter((member) => {
      const exact = exactOwnedByPid.get(member.pid);
      return (
        member.state !== "zombie" &&
        member.sessionId === host.member.sessionId &&
        member.processIdentity === exact?.processIdentity
      );
    });
    const groupIds = [
      ...new Set(sessionProcesses.map(({ groupId }) => groupId)),
    ]
      .filter((groupId) => groupId > 1)
      .sort((left, right) => left - right);
    for (const groupId of groupIds) {
      const leader = sessionProcesses.find(
        ({ groupId: memberGroup, pid }) =>
          memberGroup === groupId && pid === groupId,
      );
      if (!leader) {
        throw cleanupError(
          `manifest Host session retained an unanchored group ${groupId}`,
        );
      }
      retirementCandidates.push({
        identity: exactOwnedByPid.get(leader.pid),
        member: leader,
      });
    }
  }
  const retiredGroupIds = new Set();
  return retirementCandidates
    .filter(({ member }) => {
      if (retiredGroupIds.has(member.groupId)) return false;
      retiredGroupIds.add(member.groupId);
      return true;
    })
    .map(({ identity }) => identity);
}

async function terminateManifestProcessSession(
  target,
  {
    assertStateRootCurrent,
    observation,
    processSnapshot,
    retireProcessGroup,
  },
) {
  const retirementPlan = planManifestProcessRetirement(
    target,
    processSnapshot,
    observation,
  );
  for (const identity of retirementPlan) {
    assertStateRootCurrent();
    await retireProcessGroup(identity);
  }
}

function observedIdentity(discoveryRoot, processProof) {
  return `${discoveryRoot}\0${processProof.process_id}\0${processProof.start_marker}`;
}

export async function reapHmuxTestState(
  {
    hmuxCli,
    hmuxRuntime,
    observeProcessIdentities: observeIdentities,
    observeProcessMembers: observeMembers,
    ownedProcessSnapshot,
    expectedStateRootIdentity,
    stateRoot,
    temporaryRoot,
    waitMs = DEFAULT_WAIT_MS,
    worktreeRoot,
  },
) {
  if (!Array.isArray(ownedProcessSnapshot?.ledger)) {
    throw cleanupError("ownership ledger snapshot is required");
  }
  const requestedRoot = path.resolve(stateRoot);
  const root = assertStateRoot(
    requestedRoot,
    temporaryRoot,
    worktreeRoot,
    expectedStateRootIdentity,
  );
  const assertStateRootCurrent = () =>
    assertExpectedStateRootIdentity(root, expectedStateRootIdentity);
  const cli = assertExecutable(hmuxCli, "Hmux CLI");
  const runtime = assertExecutable(hmuxRuntime, "Hmux runtime");
  const deadline = performance.now() + waitMs;
  const processSnapshot = ownedProcessSnapshot;
  const retireProcessGroup = (exactLeader) =>
    terminateOwnedProcessGroup(exactLeader, {
      timeoutMs: Math.max(0, Math.floor(deadline - performance.now())),
    });
  const observeOwned = async () => {
    const observation = await observeOwnedProcessSnapshot(processSnapshot, {
      observeIdentities,
      observeMembers,
      timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
    });
    if (observation.status !== "complete") {
      throw cleanupError(
        `owned process observation is incomplete: ${observation.reason}`,
      );
    }
    return observation;
  };
  const terminateManifest = async (target, observation = undefined) =>
    terminateManifestProcessSession(target, {
      assertStateRootCurrent,
      observation: observation ?? (await observeOwned()),
      processSnapshot,
      retireProcessGroup,
    });
  const observed = new Map();
  const terminatedReady = new Set();
  const terminatedStarting = new Set();
  let stableFingerprint;
  let stablePasses = 0;

  do {
    assertStateRootCurrent();
    const discoveryRoots = findHmuxTestDiscoveryRoots(root, {
      deadline,
      expectedStateRootIdentity,
      temporaryRoot,
      worktreeRoot,
    });
    const targets = discoveryRoots.flatMap((discoveryRoot) =>
      collectIsolatedHmuxCleanupTargets(discoveryRoot).map((target) => ({
        discoveryRoot,
        target,
      })),
    );
    for (const { discoveryRoot, target } of targets) {
      for (const processProof of [
        target.hostProcess,
        ...(target.providerProcess ? [target.providerProcess] : []),
      ]) {
        observed.set(
          observedIdentity(discoveryRoot, processProof),
          { discoveryRoot, processProof },
        );
      }
      const identity = [
        discoveryRoot,
        target.workspace_id,
        target.session_id,
        target.host_instance_id,
        target.terminal_epoch ?? "starting",
      ].join("\0");
      const hostStatus = probeProcess(
        cli,
        discoveryRoot,
        target.hostProcess,
      );
      if (
        target.lifecycle === "ready" &&
        hostStatus === "live" &&
        !terminatedReady.has(identity)
      ) {
        if (probeProcess(cli, discoveryRoot, target.providerProcess) !== "live") {
          throw cleanupError("ready provider generation is not live");
        }
        const ownedHost = processSnapshot.ledger.find(
          ({ pid }) => pid === target.hostProcess.process_id,
        );
        const directObservation = ownedHost ? await observeOwned() : undefined;
        const stoppedHost = directObservation
          ? exactOwnedLeader(
              target.hostProcess,
              processSnapshot,
              "Host",
              directObservation,
            ).member.state === "stopped"
          : false;
        if (stoppedHost) {
          await terminateManifest(target, directObservation);
        } else {
          assertStateRootCurrent();
          terminateReadySession(
            cli,
            runtime,
            discoveryRoot,
            target,
            Math.max(100, Math.ceil(deadline - performance.now())),
          );
        }
        terminatedReady.add(identity);
      } else if (
        target.lifecycle === "starting" &&
        hostStatus === "live" &&
        !terminatedStarting.has(identity)
      ) {
        await terminateManifest(target);
        terminatedStarting.add(identity);
      }
    }

    const live = [];
    for (const entry of observed.values()) {
      if (
        probeProcess(cli, entry.discoveryRoot, entry.processProof) ===
        "live"
      ) {
        live.push(entry);
      }
    }
    const fingerprint = JSON.stringify(
      targets.map(({ discoveryRoot, target }) => [
        discoveryRoot,
        target.lifecycle,
        target.workspace_id,
        target.session_id,
        target.host_instance_id,
      ]),
    );
    if (live.length === 0 && fingerprint === stableFingerprint) {
      stablePasses += 1;
    } else if (live.length === 0) {
      stableFingerprint = fingerprint;
      stablePasses = 1;
    } else {
      stableFingerprint = undefined;
      stablePasses = 0;
    }
    if (stablePasses >= QUIESCENT_PASSES) {
      return {
        observedProcesses: observed.size,
        observedSessions: terminatedReady.size + terminatedStarting.size,
        schema: "dure-hmux-test-reap/v1",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (performance.now() < deadline);

  throw cleanupError("test-owned process generations did not become quiescent");
}
