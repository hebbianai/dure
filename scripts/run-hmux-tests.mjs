#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchDetachedGuardian } from "./lib/guardian-launcher.mjs";
import { waitForHostResources } from "./lib/host-resource-admission.mjs";
import { requireNativeProcessGroupSupport } from "./lib/process-identity.mjs";
import {
  assertSameRootGeneration,
  authorizeIsolatedRootRetirement,
  retireIsolatedRoot,
  retirementCompleted,
} from "./qa/lib/isolated-root-retirement.mjs";
import {
  findHmuxTestDiscoveryRoots,
  reapHmuxTestState,
} from "./qa/lib/hmux-test-state-cleanup.mjs";
import {
  observeExactProcessGeneration,
  OwnedProcessCleanupHandoffError,
  readOwnedProcessGroup,
  readOwnedProcessLedgerForCleanup,
  readOwnedProcessLedgerForRetirement,
  recoverIdentityOnlyOwnedProcessTree,
  supervise,
} from "./qa/lib/owned-process-group.mjs";
import {
  captureOwnedProcessSnapshot,
  observeOwnedProcessSnapshot,
} from "./qa/lib/owned-process-snapshot.mjs";

const GUARDIAN_ARGUMENT = "--internal-hmux-test-guardian-v1";
const CLEANUP_FAILURE_EXIT_CODE = 97;
const LIVENESS_SETTLE_MS = 5_000;
const OWNED_PROCESS_EXIT_WAIT_MS = 1_000;
const OWNED_PROCESS_POLL_MS = 20;
const OWNER_RECORD_NAME = "hmux-test-owner-v2.json";
const OWNER_RECORD_SCHEMA = "dure-hmux-test-owner/v2";
const MAX_STALE_STATE_ROOTS = 128;
const REPOSITORY_ROOT = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const GHOSTTY_PROOF_MATERIALIZER = path.join(
  REPOSITORY_ROOT,
  "scripts/ensure-ghostty-vt-proof.mjs",
);

export function hmuxTestRetirementJournalRoot(temporaryBoundary) {
  return path.join(
    fs.realpathSync(path.resolve(temporaryBoundary)),
    `.dure-hmux-test-retirement-journals-${process.getuid?.() ?? "owner"}`,
  );
}

function defaultTemporaryRoot() {
  // Hmux appends its runtime directory and a generation-scoped socket name to
  // TMPDIR. Darwin's default per-user temp path is already long enough that a
  // second isolated directory can cross sockaddr_un.sun_path. `/tmp` resolves
  // to the same owner-protected local filesystem while retaining that budget.
  return process.platform === "win32" ? os.tmpdir() : fs.realpathSync("/tmp");
}

function configureLocalGhosttyProof(environment) {
  if (
    environment.HMUX_GHOSTTY_VT_PROOF_PREFIX ||
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    !environment.HOME
  ) {
    return;
  }
  const candidate = execFileSync(
    process.execPath,
    [GHOSTTY_PROOF_MATERIALIZER, "--target", "aarch64-apple-darwin"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "inherit"],
    },
  ).trim();
  if (!path.isAbsolute(candidate)) {
    throw new Error("Ghostty VT materializer returned a relative proof path");
  }
  environment.HMUX_GHOSTTY_VT_PROOF_PREFIX = candidate;
}

export function hmuxTestBinaries(environment) {
  const targetRoot = path.resolve(REPOSITORY_ROOT, environment.CARGO_TARGET_DIR ?? "hmux/target");
  const outputRoot = environment.CARGO_BUILD_TARGET
    ? path.join(targetRoot, environment.CARGO_BUILD_TARGET)
    : targetRoot;
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  return {
    hmuxCli: environment.DURE_QA_HMUX_BIN ?? path.join(outputRoot, `debug/hmux${executableSuffix}`),
    hmuxRuntime: environment.DURE_QA_HMUX_RUNTIME ?? path.join(
      outputRoot,
      `debug/hmux-runtime${executableSuffix}`,
    ),
  };
}

export function commandAfterSeparator(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1 || !argv[separator + 1]) {
    throw new Error("hmux_test_guardian_usage: expected a command after --");
  }
  return argv.slice(separator + 1);
}

function boundedDiagnostic(error) {
  return String(error instanceof Error ? error.message : error)
    .trim()
    .replaceAll(/\s+/gu, " ")
    .slice(0, 1_024);
}

function publishStateRootForTest(stateRoot, environment) {
  const capture = environment.DURE_HMUX_TEST_STATE_ROOT_CAPTURE;
  if (!capture || environment.NODE_ENV !== "test") return;
  if (!path.isAbsolute(capture)) {
    throw new Error(
      "hmux_test_guardian_invalid: test state-root capture must be absolute",
    );
  }
  fs.writeFileSync(capture, `${stateRoot}\n`, { flag: "wx", mode: 0o600 });
}

function writeOwnerRecord(stateRoot, descriptorPath) {
  const guardian = observeExactProcessGeneration();
  if (!guardian) {
    throw new Error(
      "hmux_test_guardian_invalid: guardian process generation is unavailable",
    );
  }
  const record = {
    guardianProcess: {
      kernelStartMarker: guardian.kernelStartMarker,
      pid: guardian.pid,
      startMarker: guardian.startMarker,
    },
    schema: OWNER_RECORD_SCHEMA,
    worktreeRoot: REPOSITORY_ROOT,
  };
  fs.writeFileSync(
    path.join(stateRoot, OWNER_RECORD_NAME),
    `${JSON.stringify(record)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

function readMatchingOwnerRecord(stateRoot, worktreeRoot) {
  const file = path.join(stateRoot, OWNER_RECORD_NAME);
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) {
    throw new Error("hmux_test_stale_cleanup_refused: invalid owner record");
  }
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    record?.schema !== OWNER_RECORD_SCHEMA ||
    record?.worktreeRoot !== worktreeRoot
  ) {
    return undefined;
  }
  const guardian = record.guardianProcess;
  if (
    !guardian ||
    !Number.isSafeInteger(guardian.pid) ||
    guardian.pid <= 1 ||
    typeof guardian.startMarker !== "string" ||
    typeof guardian.kernelStartMarker !== "string"
  ) {
    throw new Error("hmux_test_stale_cleanup_refused: invalid owner generation");
  }
  return record;
}

function staleStateRootBelongsToCurrentUser(stateRoot, temporaryRoot) {
  const stat = fs.lstatSync(stateRoot);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return false;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(path.dirname(stateRoot)) !== fs.realpathSync(temporaryRoot)
  ) {
    throw new Error(
      "hmux_test_stale_cleanup_refused: unsafe state root boundary",
    );
  }
  return true;
}

async function liveLedgerProcesses(
  snapshot,
  {
    observeMembers,
    ...options
  } = {},
) {
  const observation = await observeOwnedProcessSnapshot(snapshot, {
    observeMembers,
    ...options,
  });
  if (observation.status !== "complete") {
    throw new Error(
      `hmux_test_process_observation_unavailable: ${observation.reason}`,
    );
  }
  const observedByPid = new Map(
    observation.members.map((member) => [member.pid, member]),
  );
  return snapshot.candidates
    .filter(({ exact }) => {
      const observed = observedByPid.get(exact.pid);
      return observed?.state !== "zombie" &&
        observed?.processIdentity === exact.processIdentity;
    })
    .map(({ expected }) => expected);
}

async function assertNoLiveLedgerProcesses(snapshot) {
  const live = await liveLedgerProcesses(snapshot);
  if (live.length > 0) {
    throw new Error(
      `hmux_test_stale_cleanup_refused: exact generations still live: ${live
        .map(({ pid }) => pid)
        .join(",")}`,
    );
  }
}

export async function reapStaleHmuxTestStates(
  temporaryRoot,
  environment = process.env,
  {
    ownerGenerationIsLive,
    reapState = reapHmuxTestState,
  } = {},
) {
  const worktreeRoot = REPOSITORY_ROOT;
  const canonicalTemporaryRoot = fs.realpathSync(path.resolve(temporaryRoot));
  const retirementJournalRoot = hmuxTestRetirementJournalRoot(
    canonicalTemporaryRoot,
  );
  const candidates = fs
    .readdirSync(canonicalTemporaryRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("dure-hmux-test."),
    );
  if (candidates.length > MAX_STALE_STATE_ROOTS) {
    throw new Error("hmux_test_stale_cleanup_refused: state root limit exceeded");
  }
  const generationIsLive = ownerGenerationIsLive ??
    (async (_descriptor, expected) => {
      const snapshot = await captureOwnedProcessSnapshot([expected]);
      return (await liveLedgerProcesses(snapshot)).length > 0;
    });
  const receipts = [];
  for (const candidate of candidates) {
    const stateRoot = path.join(canonicalTemporaryRoot, candidate.name);
    if (
      !staleStateRootBelongsToCurrentUser(stateRoot, canonicalTemporaryRoot)
    ) {
      continue;
    }
    const retirementIdentity = authorizeIsolatedRootRetirement(
      stateRoot,
      canonicalTemporaryRoot,
    );
    const assertStateRootCurrent = () =>
      assertSameRootGeneration(stateRoot, retirementIdentity);
    const owner = readMatchingOwnerRecord(stateRoot, worktreeRoot);
    assertStateRootCurrent();
    if (!owner) continue;
    const descriptorPath = path.join(stateRoot, "test-process-group.json");
    const ownerDescriptor = { descriptorPath };
    const ownerIsLive = await generationIsLive(
      ownerDescriptor,
      owner.guardianProcess,
    );
    assertStateRootCurrent();
    if (ownerIsLive) continue;
    const retireStateRoot = () =>
      retirementCompleted(
        retireIsolatedRoot(
          stateRoot,
          retirementJournalRoot,
          retirementIdentity,
          { temporaryBoundary: canonicalTemporaryRoot },
        ),
      );
    if (!fs.existsSync(descriptorPath)) {
      if (
        findHmuxTestDiscoveryRoots(stateRoot, {
          expectedStateRootIdentity: retirementIdentity,
          temporaryRoot: canonicalTemporaryRoot,
          worktreeRoot,
        }).length > 0
      ) {
        throw new Error(
          "hmux_test_stale_cleanup_refused: manifests exist without an owner descriptor",
        );
      }
      if (!retireStateRoot()) continue;
      receipts.push({ stateRoot, state: "empty_prelaunch_root_retired" });
      continue;
    }
    const descriptor = readOwnedProcessGroup(
      descriptorPath,
      owner.guardianProcess.pid,
    );
    assertStateRootCurrent();
    if (
      descriptor.supervisorStartMarker !== owner.guardianProcess.startMarker ||
      descriptor.supervisorKernelStartMarker !==
        owner.guardianProcess.kernelStartMarker
    ) {
      throw new Error(
        "hmux_test_stale_cleanup_refused: descriptor owner generation mismatch",
      );
    }
    await recoverIdentityOnlyOwnedProcessTree(descriptor, {
      assertAuthorityCurrent: assertStateRootCurrent,
    });
    const ownedProcesses = readOwnedProcessLedgerForRetirement(descriptor);
    const ownedProcessSnapshot = await captureOwnedProcessSnapshot(
      ownedProcesses,
    );
    assertStateRootCurrent();
    const discoveryRoots = findHmuxTestDiscoveryRoots(stateRoot, {
      expectedStateRootIdentity: retirementIdentity,
      temporaryRoot: canonicalTemporaryRoot,
      worktreeRoot,
    });
    if (discoveryRoots.length > 0) {
      const receipt = await reapState({
        expectedStateRootIdentity: retirementIdentity,
        ...hmuxTestBinaries(environment),
        ownedProcessSnapshot,
        stateRoot,
        temporaryRoot: canonicalTemporaryRoot,
        worktreeRoot,
      });
      await assertNoLiveLedgerProcesses(ownedProcessSnapshot);
      if (!retireStateRoot()) continue;
      receipts.push({ ...receipt, stateRoot, state: "sessions_reaped" });
      continue;
    }
    await assertNoLiveLedgerProcesses(ownedProcessSnapshot);
    if (!retireStateRoot()) continue;
    receipts.push({ stateRoot, state: "quiescent_root_retired" });
  }
  return receipts;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertOwnedProcessesExited(
  descriptorPath,
  ownedProcessSnapshot,
) {
  if (!fs.existsSync(descriptorPath)) return;
  const descriptor = readOwnedProcessGroup(descriptorPath, process.pid);
  const snapshot = ownedProcessSnapshot ?? await captureOwnedProcessSnapshot(
    readOwnedProcessLedgerForCleanup(descriptor),
  );
  const deadline = performance.now() + OWNED_PROCESS_EXIT_WAIT_MS;
  let live = [];
  do {
    live = await liveLedgerProcesses(snapshot, {
      timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
    });
    if (live.length === 0) return;
    await sleep(OWNED_PROCESS_POLL_MS);
  } while (performance.now() < deadline);
  throw new Error(
    `hmux_test_owned_processes_remain: exact generations still live: ${live
      .map(({ pid }) => pid)
      .join(",")}`,
  );
}

export async function runGuardian(
  command,
  {
    environment = process.env,
    reapState = reapHmuxTestState,
    superviseCommand = supervise,
    temporaryRoot = defaultTemporaryRoot(),
    waitForResources = waitForHostResources,
  } = {},
) {
  await waitForResources({ environment, label: "Hmux QA" });
  await requireNativeProcessGroupSupport();
  await reapStaleHmuxTestStates(temporaryRoot, environment);
  const stateRoot = fs.mkdtempSync(path.join(temporaryRoot, "dure-hmux-test."));
  const discoveryRoot = path.join(stateRoot, "hmux-discovery");
  const shellConfigDirectory = path.join(stateRoot, "zsh");
  const temporaryDirectory = path.join(stateRoot, "tmp");
  const descriptor = path.join(stateRoot, "test-process-group.json");
  fs.chmodSync(stateRoot, 0o700);
  fs.mkdirSync(discoveryRoot, { mode: 0o700 });
  fs.mkdirSync(shellConfigDirectory, { mode: 0o700 });
  fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
  writeOwnerRecord(stateRoot, descriptor);
  publishStateRootForTest(stateRoot, environment);
  const retirementIdentity = authorizeIsolatedRootRetirement(
    stateRoot,
    temporaryRoot,
  );
  const retireStateRoot = () =>
    retireIsolatedRoot(
      stateRoot,
      hmuxTestRetirementJournalRoot(temporaryRoot),
      retirementIdentity,
      { temporaryBoundary: temporaryRoot },
    );

  const previous = {
    discoveryRoot: environment.HMUX_DISCOVERY_ROOT,
    ghosttyProofPrefix: environment.HMUX_GHOSTTY_VT_PROOF_PREFIX,
    stateRoot: environment.DURE_HMUX_TEST_STATE_ROOT,
    temporaryDirectory: environment.TMPDIR,
    zshConfigDirectory: environment.ZDOTDIR,
  };
  environment.DURE_HMUX_TEST_STATE_ROOT = stateRoot;
  environment.HMUX_DISCOVERY_ROOT = discoveryRoot;
  configureLocalGhosttyProof(environment);
  environment.TMPDIR = temporaryDirectory;
  // Hmux safe-shell fixtures must exercise the shell, not the developer's
  // interactive startup files. Those files can launch long-lived helpers
  // which both contaminate the test and escape when they intentionally
  // daemonize. ZDOTDIR is the zsh-supported isolation boundary and leaves
  // HOME unchanged for Cargo and toolchain discovery.
  environment.ZDOTDIR = shellConfigDirectory;
  let reaperAttempted = false;
  let reaperReceipt;
  let ownedProcessSnapshot;

  try {
    await requireNativeProcessGroupSupport();
    const status = await superviseCommand(
      descriptor,
      command[0],
      command.slice(1),
      {
        async beforeWitnessCheck({ ownedProcesses }) {
          ownedProcessSnapshot = await captureOwnedProcessSnapshot(
            ownedProcesses,
          );
          if (
            findHmuxTestDiscoveryRoots(stateRoot, {
              expectedStateRootIdentity: retirementIdentity,
              temporaryRoot,
              worktreeRoot: REPOSITORY_ROOT,
            }).length === 0
          ) {
            return;
          }
          reaperAttempted = true;
          reaperReceipt = await reapState({
            expectedStateRootIdentity: retirementIdentity,
            ...hmuxTestBinaries(environment),
            ownedProcessSnapshot,
            stateRoot,
            temporaryRoot,
            worktreeRoot: REPOSITORY_ROOT,
          });
        },
        hardContainment: process.platform === "linux",
        livenessWitnessWaitMs: LIVENESS_SETTLE_MS,
        onVerifiedCleanupHandoff: retireStateRoot,
        terminateDetachedOwnedGenerations: true,
      },
    );
    await assertOwnedProcessesExited(descriptor, ownedProcessSnapshot);
    retireStateRoot();
    return status;
  } catch (error) {
    const diagnostic = boundedDiagnostic(error);
    if (error instanceof OwnedProcessCleanupHandoffError) {
      console.error(
        `hmux_test_guardian_cleanup_completed_by_successor: ${diagnostic}; ` +
          `state_root=${stateRoot}`,
      );
      return CLEANUP_FAILURE_EXIT_CODE;
    }
    if (reaperAttempted) {
      console.error(
        `hmux_test_guardian_cleanup_failed: ${diagnostic}; ` +
          `reaper_receipt=${JSON.stringify(reaperReceipt ?? null)}; ` +
          `state_root=${stateRoot}`,
      );
      return CLEANUP_FAILURE_EXIT_CODE;
    }
    console.error(
      `hmux_test_guardian_cleanup_failed: ${diagnostic}; ` +
        `state_root=${stateRoot}`,
    );
    return CLEANUP_FAILURE_EXIT_CODE;
  } finally {
    if (previous.discoveryRoot === undefined) {
      delete environment.HMUX_DISCOVERY_ROOT;
    } else {
      environment.HMUX_DISCOVERY_ROOT = previous.discoveryRoot;
    }
    if (previous.ghosttyProofPrefix === undefined) {
      delete environment.HMUX_GHOSTTY_VT_PROOF_PREFIX;
    } else {
      environment.HMUX_GHOSTTY_VT_PROOF_PREFIX = previous.ghosttyProofPrefix;
    }
    if (previous.stateRoot === undefined) {
      delete environment.DURE_HMUX_TEST_STATE_ROOT;
    } else {
      environment.DURE_HMUX_TEST_STATE_ROOT = previous.stateRoot;
    }
    if (previous.temporaryDirectory === undefined) {
      delete environment.TMPDIR;
    } else {
      environment.TMPDIR = previous.temporaryDirectory;
    }
    if (previous.zshConfigDirectory === undefined) {
      delete environment.ZDOTDIR;
    } else {
      environment.ZDOTDIR = previous.zshConfigDirectory;
    }
  }
}

export async function runLauncher(command, { environment = process.env } = {}) {
  return launchDetachedGuardian({
    command,
    environment,
    guardianArgument: GUARDIAN_ARGUMENT,
    scriptUrl: import.meta.url,
  });
}

async function main() {
  const command = commandAfterSeparator(process.argv.slice(2));
  return process.argv[2] === GUARDIAN_ARGUMENT
    ? runGuardian(command)
    : runLauncher(command);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(boundedDiagnostic(error));
      process.exitCode = CLEANUP_FAILURE_EXIT_CODE;
    });
}
