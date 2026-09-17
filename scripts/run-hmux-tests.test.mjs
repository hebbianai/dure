import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  authorizeIsolatedRootRetirement,
  retireIsolatedRoot,
} from "./qa/lib/isolated-root-retirement.mjs";
import { reapHmuxTestState } from "./qa/lib/hmux-test-state-cleanup.mjs";
import {
  processLivenessFromObservation,
  processMemberFromObservation,
  processMemberSnapshots,
} from "./lib/process-identity.mjs";
import {
  commandAfterSeparator,
  hmuxTestBinaries,
  hmuxTestRetirementJournalRoot,
  reapStaleHmuxTestStates,
  runGuardian,
} from "./run-hmux-tests.mjs";
import {
  exactOwnedProcessIdentity,
  freezeOwnedProcessTree,
  observeExactProcessGeneration,
  readOwnedProcessGroup,
  readOwnedProcessLedgerForCleanup,
  startOwnershipLedgerSampler,
  terminateFrozenOwnedProcessTree,
} from "./qa/lib/owned-process-group.mjs";

// These cases exercise cleanup authority, independently of the operator's
// host-pressure policy. Child-process fixtures use an explicit policy below.
vi.mock("./lib/host-resource-admission.mjs", () => ({
  waitForHostResources: async () => {},
}));

const directory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(directory, "run-hmux-tests.mjs");
const processGroupRunner = path.join(
  directory,
  "qa/lib/owned-process-group.mjs",
);
const temporaryDirectories = [];
const trackedLaunchers = new Map();
const GUARDIAN_RETIREMENT_WAIT_MS = 45_000;

function temporaryDirectory() {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync("/tmp"), "hmux-test-runner-test."),
  );
  temporaryDirectories.push(root);
  return root;
}

function guardianFixtureEnvironment(root, overrides = {}) {
  return {
    ...process.env,
    DURE_HOST_RESOURCE_POLICY: path.join(root, "absent-host-resource-policy.json"),
    HMUX_GHOSTTY_VT_PROOF_PREFIX: path.join(
      root,
      "unavailable-ghostty-vt-proof",
    ),
    ...overrides,
  };
}

function fakeKernelMarker() {
  return process.platform === "darwin"
    ? "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:101"
    : "kernel-start-v2:linux:test-boot:101";
}

function sealedSuccessorFixture() {
  const temporaryBoundary = temporaryDirectory();
  const stateRoot = fs.mkdtempSync(
    path.join(temporaryBoundary, "dure-hmux-test."),
  );
  fs.chmodSync(stateRoot, 0o700);
  const descriptorPath = path.join(stateRoot, "test-process-group.json");
  const kernelMarker = fakeKernelMarker();
  const descriptor = {
    groupId: 41_001,
    leaderKernelStartMarker: kernelMarker,
    leaderPid: 41_001,
    leaderStartMarker: "ps-lstart-v1:leader",
    livenessWitnessVersion: "inherited-fd-v1",
    schemaVersion: 1,
    supervisorKernelStartMarker: kernelMarker,
    supervisorPid: 40_001,
    supervisorStartMarker: "ps-lstart-v1:supervisor",
    terminateDetachedOwnedGenerations: true,
  };
  const leader = {
    groupId: descriptor.groupId,
    kernelStartMarker: descriptor.leaderKernelStartMarker,
    parentPid: descriptor.supervisorPid,
    pid: descriptor.leaderPid,
    sessionId: descriptor.groupId,
    startMarker: descriptor.leaderStartMarker,
  };
  const frozen = {
    groupId: descriptor.groupId,
    leaderKernelStartMarker: descriptor.leaderKernelStartMarker,
    leaderPid: descriptor.leaderPid,
    leaderStartMarker: descriptor.leaderStartMarker,
    livenessWitnessVersion: descriptor.livenessWitnessVersion,
    processes: [leader],
    schemaVersion: 1,
    supervisorKernelStartMarker: descriptor.supervisorKernelStartMarker,
    supervisorPid: descriptor.supervisorPid,
    supervisorStartMarker: descriptor.supervisorStartMarker,
    terminateDetachedOwnedGenerations: true,
  };
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(
    `${descriptorPath}.ownership-ledger.json`,
    `${JSON.stringify({ ...frozen, healthy: true })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    `${descriptorPath}.cleanup-handoff-frozen-v1.json`,
    `${JSON.stringify(frozen)}\n`,
    { mode: 0o600 },
  );
  return {
    descriptor,
    descriptorPath,
    kernelMarker,
    stateRoot,
  };
}

function markFixtureGuardianAbsent(stateRoot) {
  const ownerFile = path.join(stateRoot, "hmux-test-owner-v2.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  const liveGuardian = { ...owner.guardianProcess };
  owner.guardianProcess.pid = 2_000_000_000;
  fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  return { liveGuardian, retiredGuardian: owner.guardianProcess };
}

function createStaleOwnedState() {
  const parent = temporaryDirectory();
  const stateRoot = fs.mkdtempSync(path.join(parent, "dure-hmux-test."));
  fs.chmodSync(stateRoot, 0o700);
  const descriptorPath = path.join(stateRoot, "test-process-group.json");
  const guardian = observeExactProcessGeneration();
  expect(guardian).toBeDefined();
  const retiredGuardian = { ...guardian, pid: 2_000_000_000 };
  const environment = {};
  fs.writeFileSync(
    path.join(stateRoot, "hmux-test-owner-v2.json"),
    `${JSON.stringify({
      guardianProcess: retiredGuardian,
      schema: "dure-hmux-test-owner/v2",
      worktreeRoot: fs.realpathSync(path.join(directory, "..")),
    })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    descriptorPath,
    `${JSON.stringify({
      groupId: 2_000_000_001,
      leaderKernelStartMarker: fakeKernelMarker(),
      leaderPid: 2_000_000_001,
      leaderStartMarker: "ps-lstart-v1:leader",
      livenessWitnessVersion: "inherited-fd-v1",
      schemaVersion: 1,
      supervisorKernelStartMarker: retiredGuardian.kernelStartMarker,
      supervisorPid: retiredGuardian.pid,
      supervisorStartMarker: retiredGuardian.startMarker,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    descriptor: readOwnedProcessGroup(descriptorPath, retiredGuardian.pid),
    descriptorPath,
    environment,
    liveGuardian: guardian,
    parent,
    stateRoot,
  };
}

function publishStaleManifest(stateRoot) {
  const manifestDirectory = path.join(
    stateRoot,
    "tmp/fixture/discovery/w_workspace/s_session",
  );
  fs.mkdirSync(manifestDirectory, { recursive: true });
  fs.writeFileSync(path.join(manifestDirectory, "manifest.json"), "{}\n");
}

async function publishCanonicalOwnershipLedger(
  descriptor,
  { failure, initialProcesses = [], updates = [] } = {},
) {
  let observerCallbacks;
  await startOwnershipLedgerSampler(descriptor, initialProcesses, true, {
    observeMembers: async (request) => ({
      members: [],
      scope: request.kind === "point"
        ? {
            kind: "point",
            requestedPids: [...new Set(request.pids)].sort(
              (left, right) => left - right,
            ),
          }
        : request.kind === "group_census"
          ? { groupId: request.groupId, kind: "group_census" }
          : {
              effectiveUid: process.geteuid(),
              evidence: "closed_enumeration",
              kind: "user_census",
              ...(request.expectedProcess ? { expectedProcess: request.expectedProcess } : {}),
            },
      status: "complete",
    }),
    processController: {
      generationState() {
        throw new Error("empty fixture must not observe process state");
      },
    },
    startNativeObserver(_descriptor, _known, callbacks) {
      observerCallbacks = callbacks;
      return {
        async barrier() {},
        async ready() {},
        async stop() {},
      };
    },
  });
  for (const update of updates) {
    if (update.kind === "process") observerCallbacks.admit(update.record);
    else if (update.kind === "identity") observerCallbacks.seal(update.record);
    else throw new Error(`unknown ownership ledger update: ${update.kind}`);
  }
  if (failure) observerCallbacks.fail(failure);
}

async function publishIdentitySealedStaleLedger(
  fixture,
  { reuseParentPid = false } = {},
) {
  const rawDescriptor = JSON.parse(
    fs.readFileSync(fixture.descriptorPath, "utf8"),
  );
  const leader = {
    groupId: rawDescriptor.groupId,
    kernelStartMarker:
      "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:2001",
    parentPid: rawDescriptor.supervisorPid,
    pid: rawDescriptor.leaderPid,
    sessionId: rawDescriptor.groupId,
    startMarker: "ps-lstart-v1:sealed-leader",
  };
  const parent = reuseParentPid
    ? {
        ...leader,
        kernelStartMarker:
          "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:2003",
        parentPid: leader.pid,
        pid: 2_000_000_003,
        startMarker: "ps-lstart-v1:sealed-parent",
      }
    : leader;
  const descriptor = {
    ...rawDescriptor,
    leaderKernelStartMarker: leader.kernelStartMarker,
    leaderStartMarker: leader.startMarker,
    terminateDetachedOwnedGenerations: true,
  };
  fs.writeFileSync(
    fixture.descriptorPath,
    `${JSON.stringify(descriptor)}\n`,
    { mode: 0o600 },
  );
  fixture.descriptor = readOwnedProcessGroup(
    fixture.descriptorPath,
    descriptor.supervisorPid,
  );
  const updates = [
    {
      kind: "identity",
      record: {
        kernelStartMarker:
          "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:2002",
        parentKernelStartMarker: parent.kernelStartMarker,
        parentPid: parent.pid,
        pid: 2_000_000_002,
      },
    },
  ];
  if (reuseParentPid) {
    updates.push({
      kind: "process",
      record: {
        ...parent,
        kernelStartMarker:
          "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:2103",
        startMarker: "ps-lstart-v1:replacement-parent",
      },
    });
  }
  await publishCanonicalOwnershipLedger(fixture.descriptor, {
    failure: new Error("injected observer exit after identity seal"),
    initialProcesses: reuseParentPid ? [leader, parent] : [leader],
    updates,
  });
}

async function expectQuiescentStaleRootRetired(fixture) {
  await expect(
    reapStaleHmuxTestStates(fixture.parent, fixture.environment),
  ).resolves.toEqual([
    {
      state: "quiescent_root_retired",
      stateRoot: fixture.stateRoot,
    },
  ]);
  expect(fs.existsSync(fixture.stateRoot)).toBe(false);
}

function waitFor(condition, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for Hmux test guardian state"));
      } else {
        setTimeout(inspect, 20);
      }
    };
    inspect();
  });
}

function observedProcess(pid) {
  return processMemberFromObservation(
    pid,
    processMemberSnapshots([pid]),
  );
}

async function waitForObservedProcess(pid) {
  let member;
  await waitFor(() => {
    const observed = observedProcess(pid);
    if (observed.status === "present") member = observed.member;
    return observed.status === "present";
  });
  return member;
}

function processGenerationLiveness(generation) {
  const owner = generation?.processIdentity
    ? { pid: generation.pid, processIdentity: generation.processIdentity }
    : exactOwnedProcessIdentity(generation);
  return processLivenessFromObservation(
    owner,
    processMemberSnapshots([owner.pid]),
  );
}

function allGenerationsAreStale(generations) {
  return generations.every(
    (generation) => processGenerationLiveness(generation) === "stale",
  );
}

function waitForChild(child, timeoutMs = 15_000) {
  const lifecycle = trackedLaunchers.get(child)?.lifecycle;
  if (!lifecycle) {
    throw new Error("child close was not observed from spawn time");
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error(`timed out waiting for child ${child.pid} to close`);
      error.code = "DURE_CHILD_CLOSE_TIMEOUT";
      reject(error);
    }, timeoutMs);
    lifecycle.close.then((result) => {
      clearTimeout(timeout);
      if (result.error) {
        reject(result.error);
      } else {
        resolve({ code: result.code, signal: result.signal });
      }
    });
  });
}

function terminateDescriptor(descriptor) {
  if (!fs.existsSync(descriptor)) return;
  const document = JSON.parse(fs.readFileSync(descriptor, "utf8"));
  const result = spawnSync(
    process.execPath,
    [
      processGroupRunner,
      "terminate",
      descriptor,
      String(document.supervisorPid),
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(
      `exact descriptor cleanup failed: status=${result.status} signal=${result.signal} stderr=${result.stderr.trim()}`,
    );
  }
  if (fs.existsSync(descriptor)) {
    throw new Error("exact descriptor cleanup left its descriptor behind");
  }
}

function capturedStateRoot(stateCapture) {
  if (!stateCapture || !fs.existsSync(stateCapture)) return undefined;
  return fs.readFileSync(stateCapture, "utf8").trim();
}

function trackedDescriptor({ descriptor, stateCapture }) {
  if (descriptor) return descriptor;
  const stateRoot = capturedStateRoot(stateCapture);
  return stateRoot
    ? path.join(stateRoot, "test-process-group.json")
    : undefined;
}

async function cleanupTrackedLauncher(launcher, tracking) {
  if (tracking.stateCapture) {
    try {
      await waitFor(
        () => Boolean(capturedStateRoot(tracking.stateCapture)),
        5_000,
      );
    } catch (publicationError) {
      const failures = [publicationError];
      if (!tracking.lifecycle.closed) {
        try {
          const closed = waitForChild(launcher);
          launcher.kill("SIGTERM");
          await closed;
        } catch (closeError) {
          failures.push(closeError);
        }
      }
      throw new AggregateError(
        failures,
        `Hmux state root was not published: ${tracking.stateCapture}`,
      );
    }
  }
  const stateRoot = capturedStateRoot(tracking.stateCapture);
  const temporaryBoundary = stateRoot ? path.dirname(stateRoot) : undefined;
  const retirementIdentity =
    stateRoot && fs.existsSync(stateRoot)
      ? authorizeIsolatedRootRetirement(stateRoot, temporaryBoundary)
      : undefined;

  let closedNaturally = false;
  if (!tracking.cleanupImmediately) {
    try {
      await waitForChild(launcher, 10_000);
      closedNaturally = true;
    } catch (error) {
      if (error?.code !== "DURE_CHILD_CLOSE_TIMEOUT") throw error;
    }
  }

  if (!closedNaturally) {
    const initialDescriptor = trackedDescriptor(tracking);
    if (initialDescriptor && fs.existsSync(initialDescriptor)) {
      terminateDescriptor(initialDescriptor);
    }
  }
  if (
    !closedNaturally &&
    launcher.exitCode === null &&
    launcher.signalCode === null
  ) {
    const closed = waitForChild(launcher);
    launcher.kill("SIGTERM");
    await closed;
  }

  const remainingDescriptor = trackedDescriptor(tracking);
  if (remainingDescriptor && fs.existsSync(remainingDescriptor)) {
    terminateDescriptor(remainingDescriptor);
  }
  if (stateRoot && retirementIdentity && fs.existsSync(stateRoot)) {
    retireIsolatedRoot(
      stateRoot,
      hmuxTestRetirementJournalRoot(temporaryBoundary),
      retirementIdentity,
      { temporaryBoundary },
    );
  }
}

afterEach(async () => {
  const cleanupFailures = [];
  for (const [launcher, tracking] of trackedLaunchers) {
    try {
      await cleanupTrackedLauncher(launcher, tracking);
      trackedLaunchers.delete(launcher);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "Hmux test launcher cleanup failed; temporary evidence was preserved",
    );
  }
  for (const root of temporaryDirectories.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function trackLauncher(launcher, tracking) {
  const lifecycle = {
    closed: false,
    error: undefined,
  };
  lifecycle.close = new Promise((resolve) => {
    launcher.once("error", (error) => {
      lifecycle.error = error;
    });
    launcher.once("close", (code, signal) => {
      lifecycle.closed = true;
      resolve({ code, error: lifecycle.error, signal });
    });
  });
  trackedLaunchers.set(launcher, { ...tracking, lifecycle });
  return launcher;
}

async function startOwnerLossGuardian(extraEnvironment) {
  const root = temporaryDirectory();
  const stateCapture = path.join(root, "state-root.txt");
  const commandPidCapture = path.join(root, "command.pid");
  let stderr = "";
  const launcher = spawn(
    process.execPath,
    [
      runner,
      "--",
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.env.DURE_HMUX_TEST_COMMAND_PID_CAPTURE, `${process.pid}\\n`); setInterval(() => {}, 300000)",
    ],
    {
      cwd: directory,
      env: guardianFixtureEnvironment(root, {
        ...extraEnvironment,
        DURE_HMUX_TEST_COMMAND_PID_CAPTURE: commandPidCapture,
        DURE_HMUX_TEST_STATE_ROOT_CAPTURE: stateCapture,
        DURE_QA_TEST_OWNER_LOSS_TERMINATION_FAILURE: "1",
        NODE_ENV: "test",
      }),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  launcher.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  trackLauncher(launcher, { cleanupImmediately: true, stateCapture });
  await waitFor(
    () =>
      (fs.existsSync(stateCapture) && fs.existsSync(commandPidCapture)) ||
      launcher.exitCode !== null ||
      launcher.signalCode !== null,
  );
  if (!fs.existsSync(stateCapture) || !fs.existsSync(commandPidCapture)) {
    throw new Error(`owner-loss guardian did not become ready: ${stderr}`);
  }
  const stateRoot = fs.readFileSync(stateCapture, "utf8").trim();
  return {
    commandPid: Number(fs.readFileSync(commandPidCapture, "utf8").trim()),
    descriptorPath: path.join(stateRoot, "test-process-group.json"),
    launcher,
    readStderr: () => stderr,
    stateRoot,
  };
}

function releaseFixture(commandRelease) {
  if (!fs.existsSync(commandRelease)) {
    fs.writeFileSync(commandRelease, "release\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
}

async function retireFailedGuardianFixture(
  descriptorPath,
  launcher,
  stateRoot,
) {
  const temporaryBoundary = path.dirname(stateRoot);
  const retirementIdentity = authorizeIsolatedRootRetirement(
    stateRoot,
    temporaryBoundary,
  );
  const descriptor = readOwnedProcessGroup(descriptorPath);
  const frozen = await freezeOwnedProcessTree(descriptor, {
    readLedger: readOwnedProcessLedgerForCleanup,
  });
  await terminateFrozenOwnedProcessTree(descriptor, frozen);
  await waitForChild(launcher);
  retireIsolatedRoot(
    stateRoot,
    hmuxTestRetirementJournalRoot(temporaryBoundary),
    retirementIdentity,
    { temporaryBoundary },
  );
  trackedLaunchers.delete(launcher);
}

describe("Hmux test guardian", () => {
  test("requires an explicit command boundary", () => {
    expect(() => commandAfterSeparator([])).toThrow(
      "expected a command after --",
    );
    expect(commandAfterSeparator(["ignored", "--", "cargo", "test"])).toEqual([
      "cargo",
      "test",
    ]);
  });

  test("the package Hmux gate cannot bypass the guardian", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(directory, "../package.json"), "utf8"),
    );
    expect(packageJson.scripts["hmux:test"]).toBe(
      "node scripts/run-hmux-tests.mjs -- cargo test --locked --manifest-path hmux/Cargo.toml --workspace && node scripts/run-hmux-tests.mjs -- cargo test --locked --manifest-path hmux/Cargo.toml -p hmux-runtime --features terminal-state-stream --test long_history_projection && node scripts/run-hmux-tests.mjs -- cargo test --locked --manifest-path hmux/Cargo.toml -p hmux-runtime --features terminal-state-stream --test standalone_smoke sixteen_terminal_surfaces_progress_while_one_attachment_is_undrained -- --exact && node scripts/qa/hmux-test-guardian-fault-matrix.mjs",
    );
    expect(packageJson.scripts["hmux:clippy"]).toBe(
      "cargo clippy --locked --manifest-path hmux/Cargo.toml --workspace --all-targets -- -D warnings && node scripts/run-hmux-tests.mjs -- cargo clippy --locked --manifest-path hmux/Cargo.toml -p hmux-runtime --features terminal-state-stream --all-targets -- -D warnings",
    );
  });

  test.skipIf(process.platform !== "darwin")(
    "preserves command stdin across the native admission gate",
    async () => {
      const root = temporaryDirectory();
      const descriptor = path.join(root, "stdin-process-group.json");
      let stdout = "";
      let stderr = "";
      const launcher = spawn(
        process.execPath,
        [processGroupRunner, "run", descriptor, "--", "/bin/cat"],
        {
          cwd: directory,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      trackLauncher(launcher, { descriptor });
      launcher.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      launcher.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4_096);
      });
      launcher.stdin.end("hmux-stdin-probe\n");

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          launcher.kill("SIGTERM");
          reject(new Error(`stdin round-trip timed out: ${stderr}`));
        }, 20_000);
        launcher.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        launcher.once("close", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });
      expect(result, stderr).toEqual({ code: 0, signal: null });
      expect(stdout).toBe("hmux-stdin-probe\n");
      trackedLaunchers.delete(launcher);
    },
    25_000,
  );

  test("adopts a concurrent retirement intent without a cleanup failure", async () => {
    const parent = temporaryDirectory();
    const environment = {};
    let observed;
    const status = await runGuardian(["fixture", "argument"], {
      environment,
      temporaryRoot: parent,
      superviseCommand: async (descriptor, command, args, options) => {
        const concurrentSweep = await reapStaleHmuxTestStates(
          parent,
          environment,
        );
        const stateRoot = environment.DURE_HMUX_TEST_STATE_ROOT;
        const retirementIdentity = authorizeIsolatedRootRetirement(
          stateRoot,
          parent,
        );
        expect(() =>
          retireIsolatedRoot(
            stateRoot,
            hmuxTestRetirementJournalRoot(parent),
            retirementIdentity,
            {
              temporaryBoundary: parent,
              onBoundary(step) {
                if (step === "after_journal") {
                  throw new Error("injected concurrent retirement stop");
                }
              },
            },
          ),
        ).toThrow("retirement stopped in prepared");
        observed = {
          args,
          command,
          concurrentSweep,
          descriptor,
          discoveryRoot: environment.HMUX_DISCOVERY_ROOT,
          ownerRecord: JSON.parse(
            fs.readFileSync(
              path.join(
                environment.DURE_HMUX_TEST_STATE_ROOT,
                "hmux-test-owner-v2.json",
              ),
              "utf8",
            ),
          ),
          stateRoot,
          stateRootSurvivedConcurrentSweep: fs.existsSync(
            environment.DURE_HMUX_TEST_STATE_ROOT,
          ),
          temporaryDirectory: environment.TMPDIR,
          zshConfigDirectory: environment.ZDOTDIR,
          options,
        };
        return 23;
      },
    });

    expect(status).toBe(23);
    expect(observed.command).toBe("fixture");
    expect(observed.concurrentSweep).toEqual([]);
    expect(observed.args).toEqual(["argument"]);
    expect(observed.descriptor).toBe(
      path.join(observed.stateRoot, "test-process-group.json"),
    );
    expect(observed.discoveryRoot).toBe(
      path.join(observed.stateRoot, "hmux-discovery"),
    );
    expect(observed.temporaryDirectory).toBe(
      path.join(observed.stateRoot, "tmp"),
    );
    expect(observed.zshConfigDirectory).toBe(
      path.join(observed.stateRoot, "zsh"),
    );
    expect(observed.ownerRecord).toEqual({
      guardianProcess: {
        kernelStartMarker: expect.any(String),
        pid: expect.any(Number),
        startMarker: expect.any(String),
      },
      schema: "dure-hmux-test-owner/v2",
      worktreeRoot: fs.realpathSync(path.join(directory, "..")),
    });
    expect(observed.options).toEqual({
      beforeWitnessCheck: expect.any(Function),
      hardContainment: process.platform === "linux",
      livenessWitnessWaitMs: 5_000,
      onVerifiedCleanupHandoff: expect.any(Function),
      terminateDetachedOwnedGenerations: true,
    });
    expect(observed.stateRootSurvivedConcurrentSweep).toBe(true);
    expect(fs.existsSync(observed.stateRoot)).toBe(false);
    expect(environment).toEqual({});
  });

  test("cleanup uncertainty is typed, nonzero, and preserves its evidence root", async () => {
    const parent = temporaryDirectory();
    const environment = {};
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    diagnostic.mockClear();
    const status = await runGuardian(["fixture"], {
      environment,
      temporaryRoot: parent,
      superviseCommand: async () => {
        throw new Error("injected exact cleanup uncertainty");
      },
    });

    expect(status).toBe(97);
    expect(diagnostic).toHaveBeenCalledOnce();
    const message = diagnostic.mock.calls[0][0];
    expect(message).toContain("hmux_test_guardian_cleanup_failed");
    expect(message).toContain("injected exact cleanup uncertainty");
    const stateRoot = message.split("state_root=")[1];
    expect(fs.statSync(stateRoot).isDirectory()).toBe(true);
    expect(environment).toEqual({});
  });

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "returns status 97 after overlapping monitor and exact termination failures",
    async () => {
      const root = temporaryDirectory();
      const stateCapture = path.join(root, "state-root.txt");
      const commandCompleted = path.join(root, "command-completed.txt");
      let stderr = "";
      const launcher = spawn(
        process.execPath,
        [
          runner,
          "--",
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.env.DURE_HMUX_TEST_COMMAND_COMPLETED, 'status=0\\n')",
        ],
        {
          cwd: directory,
          env: guardianFixtureEnvironment(root, {
            DURE_HMUX_TEST_COMMAND_COMPLETED: commandCompleted,
            DURE_HMUX_TEST_STATE_ROOT_CAPTURE: stateCapture,
            DURE_QA_TEST_EXACT_TERMINATION_FAILURE: "1",
            DURE_QA_TEST_OWNERSHIP_MONITOR_STOP_FAILURE: "1",
            NODE_ENV: "test",
          }),
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      launcher.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });
      trackLauncher(launcher, { cleanupImmediately: true, stateCapture });
      let descriptorPath;
      let stateRoot;
      try {
        await waitFor(
          () =>
            (fs.existsSync(stateCapture) &&
              fs.existsSync(commandCompleted) &&
              stderr.includes("hmux_test_guardian_cleanup_failed")) ||
            launcher.exitCode !== null ||
            launcher.signalCode !== null,
        );
        expect(fs.existsSync(commandCompleted), stderr).toBe(true);
        expect(fs.readFileSync(commandCompleted, "utf8")).toBe("status=0\n");
        stateRoot = fs.readFileSync(stateCapture, "utf8").trim();
        descriptorPath = path.join(stateRoot, "test-process-group.json");
        const descriptor = readOwnedProcessGroup(descriptorPath);
        const leaderGeneration = {
          kernelStartMarker: descriptor.leaderKernelStartMarker,
          pid: descriptor.leaderPid,
          startMarker: descriptor.leaderStartMarker,
        };

        await waitFor(
          () => launcher.exitCode !== null || launcher.signalCode !== null,
          5_000,
        );
        expect({
          code: launcher.exitCode,
          signal: launcher.signalCode,
        }).toEqual({ code: 97, signal: null });
        await waitFor(() => {
          const leader = observedProcess(descriptor.leaderPid);
          return (
            leader.status === "present" && leader.member?.state === "stopped"
          );
        });

        expect(stderr).toContain(
          "hmux_test_guardian_cleanup_failed: owned_process_group_error: ownership monitor and termination both failed; " +
            `state_root=${stateRoot}`,
        );
        expect(fs.existsSync(stateRoot)).toBe(true);
        expect(fs.existsSync(descriptorPath)).toBe(true);
        expect(processGenerationLiveness(leaderGeneration)).toBe("active");
      } finally {
        if (stateRoot && descriptorPath && fs.existsSync(descriptorPath)) {
          await retireFailedGuardianFixture(
            descriptorPath,
            launcher,
            stateRoot,
          );
        }
      }
    },
    30_000,
  );

  test("the next gate retires a preserved prelaunch root from this worktree", async () => {
    const parent = temporaryDirectory();
    const environment = {};
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    diagnostic.mockClear();
    await runGuardian(["fixture"], {
      environment,
      temporaryRoot: parent,
      superviseCommand: async () => {
        throw new Error("injected prelaunch uncertainty");
      },
    });
    const stateRoot = diagnostic.mock.calls.at(-1)[0].split("state_root=")[1];
    expect(fs.statSync(stateRoot).isDirectory()).toBe(true);
    markFixtureGuardianAbsent(stateRoot);

    const receipts = await reapStaleHmuxTestStates(parent, environment);

    expect(receipts).toEqual([
      { stateRoot, state: "empty_prelaunch_root_retired" },
    ]);
    expect(fs.existsSync(stateRoot)).toBe(false);
  });

  test("stale cleanup retires an unjournaled quarantine through normal authority", async () => {
    const parent = temporaryDirectory();
    const environment = {};
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    diagnostic.mockClear();
    await runGuardian(["fixture"], {
      environment,
      temporaryRoot: parent,
      superviseCommand: async () => {
        throw new Error("injected prelaunch uncertainty");
      },
    });
    const stateRoot = diagnostic.mock.calls.at(-1)[0].split("state_root=")[1];
    markFixtureGuardianAbsent(stateRoot);
    const quarantine = `${stateRoot}.retiring-00000000-0000-0000-0000-000000000000`;
    fs.renameSync(stateRoot, quarantine);

    expect(await reapStaleHmuxTestStates(parent, environment)).toEqual([
      { stateRoot: quarantine, state: "empty_prelaunch_root_retired" },
    ]);
    expect(fs.existsSync(quarantine)).toBe(false);
  });

  test("stale cleanup emits no retired receipt for a legacy reservation", async () => {
    const parent = temporaryDirectory();
    const environment = {};
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    diagnostic.mockClear();
    await runGuardian(["fixture"], {
      environment,
      temporaryRoot: parent,
      superviseCommand: async () => {
        throw new Error("injected pre-rename retirement failure");
      },
    });
    const stateRoot = diagnostic.mock.calls.at(-1)[0].split("state_root=")[1];
    markFixtureGuardianAbsent(stateRoot);
    const rootStat = fs.lstatSync(stateRoot);
    let journal;
    expect(() =>
      retireIsolatedRoot(
        stateRoot,
        hmuxTestRetirementJournalRoot(parent),
        { device: String(rootStat.dev), inode: String(rootStat.ino) },
        {
          temporaryBoundary: parent,
          onBoundary(step, paths) {
            journal = paths.journal;
            if (step === "before_rename") throw new Error("injected stop");
          },
        },
      ),
    ).toThrow("retirement stopped in renaming");
    const legacy = JSON.parse(fs.readFileSync(journal, "utf8"));
    fs.writeFileSync(
      journal,
      `${JSON.stringify({
        ...legacy,
        schema: "dure-qa-root-retirement/v1",
        state: "renaming",
      })}\n`,
      { mode: 0o600 },
    );

    expect(
      await reapStaleHmuxTestStates(parent, environment, {
        ownerGenerationIsLive: () => false,
      }),
    ).toEqual([]);
    expect(fs.statSync(stateRoot).isDirectory()).toBe(true);
    expect(fs.statSync(journal).isFile()).toBe(true);

    fs.writeFileSync(journal, "{}\n", { mode: 0o600 });
    await expect(
      reapStaleHmuxTestStates(parent, environment),
    ).rejects.toThrow("malformed recovery journal");
    expect(fs.statSync(stateRoot).isDirectory()).toBe(true);

    fs.rmSync(journal);
    fs.mkdirSync(journal, { mode: 0o700 });
    await expect(
      reapStaleHmuxTestStates(parent, environment),
    ).rejects.toThrow("invalid recovery journal");
    expect(fs.statSync(stateRoot).isDirectory()).toBe(true);
  });

  test("a reaped stale manifest cannot hide a live exact ledger generation", async () => {
    const fixture = createStaleOwnedState();
    await publishCanonicalOwnershipLedger(fixture.descriptor, {
      initialProcesses: [fixture.liveGuardian],
    });
    publishStaleManifest(fixture.stateRoot);
    expect(processGenerationLiveness(fixture.liveGuardian)).toBe("active");

    await expect(
      reapStaleHmuxTestStates(fixture.parent, fixture.environment, {
        reapState: async ({ ownedProcessSnapshot }) => {
          expect(ownedProcessSnapshot.ledger).toEqual([
            expect.objectContaining({
              groupId: fixture.liveGuardian.groupId,
              kernelStartMarker: fixture.liveGuardian.kernelStartMarker,
              pid: fixture.liveGuardian.pid,
              startMarker: fixture.liveGuardian.startMarker,
            }),
          ]);
          return {
            observedProcesses: 2,
            observedSessions: 1,
            schema: "dure-hmux-test-reap/v1",
          };
        },
      }),
    ).rejects.toThrow("exact generations still live");
    expect(fs.existsSync(fixture.stateRoot)).toBe(true);
  });

  test("stale cleanup consumes committed ownership deltas before retiring their artifacts", async () => {
    const fixture = createStaleOwnedState();
    const live = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 300000)"],
      { stdio: "ignore" },
    );
    const closed = new Promise((resolve) => live.once("close", resolve));
    let generation;
    try {
      await waitFor(() => {
        generation = observeExactProcessGeneration(live.pid);
        return generation;
      });
      await publishCanonicalOwnershipLedger(fixture.descriptor, {
        updates: [{ kind: "process", record: generation }],
      });
      const ledgerPath = `${fixture.descriptorPath}.ownership-ledger.json`;
      const deltaRoot = `${fixture.descriptorPath}.ownership-ledger-deltas-v1`;
      const deltaArtifacts = fs
        .readdirSync(deltaRoot)
        .map((entry) => path.join(deltaRoot, entry));
      const ownershipArtifacts = [
        fixture.descriptorPath,
        ledgerPath,
        deltaRoot,
        ...deltaArtifacts,
      ];

      await expect(
        reapStaleHmuxTestStates(fixture.parent, fixture.environment),
      ).rejects.toThrow("exact generations still live");
      expect(processGenerationLiveness(generation)).toBe("active");
      expect(fs.existsSync(fixture.stateRoot)).toBe(true);
      expect(ownershipArtifacts.every((artifact) => fs.existsSync(artifact)))
        .toBe(true);

      live.kill("SIGKILL");
      await closed;
      expect(processGenerationLiveness(generation)).toBe("stale");
      await expect(
        reapStaleHmuxTestStates(fixture.parent, fixture.environment),
      ).resolves.toEqual([
        {
          state: "quiescent_root_retired",
          stateRoot: fixture.stateRoot,
        },
      ]);
      expect(fs.existsSync(fixture.stateRoot)).toBe(false);
      expect(ownershipArtifacts.some((artifact) => fs.existsSync(artifact)))
        .toBe(false);
    } finally {
      if (live.exitCode === null && live.signalCode === null) {
        live.kill("SIGKILL");
        await closed;
      }
    }
  });

  test.runIf(process.platform === "darwin")(
    "the next guardian sweep recovers an identity-sealed stale root",
    async () => {
      const fixture = createStaleOwnedState();
      await publishIdentitySealedStaleLedger(fixture);
      await expectQuiescentStaleRootRetired(fixture);
    },
  );

  test.runIf(process.platform === "darwin")(
    "the next guardian sweep expires a stale seal after its parent pid is reused",
    async () => {
      const fixture = createStaleOwnedState();
      await publishIdentitySealedStaleLedger(fixture, {
        reuseParentPid: true,
      });
      await expectQuiescentStaleRootRetired(fixture);
    },
  );

  test.each([
    {
      expected: "ownership ledger is unavailable or unhealthy",
      label: "unhealthy base",
      mutate(descriptorPath) {
        const ledgerPath = `${descriptorPath}.ownership-ledger.json`;
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
        fs.writeFileSync(
          ledgerPath,
          `${JSON.stringify({
            ...ledger,
            failureReason: "injected ownership monitor failure",
            healthy: false,
          })}\n`,
          { mode: 0o600 },
        );
      },
    },
    {
      expected: "incomplete ownership ledger delta",
      label: "interrupted delta publication",
      mutate(descriptorPath) {
        const deltaRoot = `${descriptorPath}.ownership-ledger-deltas-v1`;
        fs.mkdirSync(deltaRoot, { mode: 0o700 });
        fs.writeFileSync(
          path.join(deltaRoot, `00000001.json.${process.pid}.tmp`),
          "{}\n",
          { mode: 0o600 },
        );
      },
    },
  ])(
    "stale cleanup refuses $label authority before reaping or root retirement",
    async ({ expected, mutate }) => {
      const fixture = createStaleOwnedState();
      await publishCanonicalOwnershipLedger(fixture.descriptor);
      publishStaleManifest(fixture.stateRoot);
      mutate(fixture.descriptorPath);
      const artifacts = fs.readdirSync(fixture.stateRoot).sort();
      const reapState = vi.fn(async () => ({
        observedProcesses: 0,
        observedSessions: 1,
        schema: "dure-hmux-test-reap/v1",
      }));

      await expect(
        reapStaleHmuxTestStates(fixture.parent, fixture.environment, {
          reapState,
        }),
      ).rejects.toThrow(expected);
      expect(reapState).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.stateRoot)).toBe(true);
      expect(fs.readdirSync(fixture.stateRoot).sort()).toEqual(artifacts);
    },
  );

  test("build and cleanup resolve the same explicit Cargo target", () => {
    const targetRoot = temporaryDirectory();
    const triple = "aarch64-apple-darwin";
    const suffix = process.platform === "win32" ? ".exe" : "";
    expect(hmuxTestBinaries({ CARGO_TARGET_DIR: targetRoot, CARGO_BUILD_TARGET: triple })).toEqual({
      hmuxCli: path.join(targetRoot, triple, `debug/hmux${suffix}`),
      hmuxRuntime: path.join(targetRoot, triple, `debug/hmux-runtime${suffix}`),
    });
  });

  test("stale cleanup uses the selected immutable runtime pair", async () => {
    const fixture = createStaleOwnedState();
    await publishCanonicalOwnershipLedger(fixture.descriptor);
    publishStaleManifest(fixture.stateRoot);
    const hmuxCli = path.join(fixture.parent, "artifact/bin/hmux");
    const hmuxRuntime = path.join(fixture.parent, "artifact/bin/hmux-runtime");
    fixture.environment.DURE_QA_HMUX_BIN = hmuxCli;
    fixture.environment.DURE_QA_HMUX_RUNTIME = hmuxRuntime;
    const reapState = vi.fn(async () => ({ observedSessions: 1, observedProcesses: 0 }));

    const receipts = await reapStaleHmuxTestStates(fixture.parent, fixture.environment, { reapState });

    expect(reapState).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hmuxCli, hmuxRuntime }));
    expect(receipts).toEqual([expect.objectContaining({ state: "sessions_reaped" })]);
    expect(fs.existsSync(fixture.stateRoot)).toBe(false);
  });

  test("stale cleanup passes its captured root identity to the real reaper", async () => {
    const fixture = createStaleOwnedState();
    await publishCanonicalOwnershipLedger(fixture.descriptor);
    publishStaleManifest(fixture.stateRoot);
    const initial = fs.lstatSync(fixture.stateRoot);
    const original = `${fixture.stateRoot}.original`;
    const sentinel = path.join(fixture.stateRoot, "replacement.txt");
    const reapState = vi.fn(async (context) => {
      expect(context.expectedStateRootIdentity).toMatchObject({
        device: String(initial.dev),
        inode: String(initial.ino),
      });
      fs.renameSync(fixture.stateRoot, original);
      fs.mkdirSync(fixture.stateRoot, { mode: 0o700 });
      fs.writeFileSync(sentinel, "replacement\n", { mode: 0o600 });
      return reapHmuxTestState(context);
    });

    await expect(
      reapStaleHmuxTestStates(fixture.parent, fixture.environment, {
        reapState,
      }),
    ).rejects.toThrow("state root generation changed after authorization");
    expect(reapState).toHaveBeenCalledOnce();
    expect(fs.readFileSync(sentinel, "utf8")).toBe("replacement\n");
    expect(fs.existsSync(original)).toBe(true);
  });

  test("a reaper failure grants no authority to a forged completion artifact", async () => {
    const root = temporaryDirectory();
    const stateCapture = path.join(root, "reaper-state-root.txt");
    const commandPidCapture = path.join(root, "reaper-command.pid");
    const missingTarget = path.join(root, "missing-hmux-target");
    let launcherStderr = "";
    const source = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "fs.writeFileSync(process.env.DURE_HMUX_TEST_COMMAND_PID_CAPTURE, String(process.pid));",
      'const manifest = path.join(process.env.HMUX_DISCOVERY_ROOT, "w_workspace", "s_session", "manifest.json");',
      "fs.mkdirSync(path.dirname(manifest), { recursive: true });",
      'fs.writeFileSync(manifest, "{}\\n");',
      'fs.writeFileSync(path.join(process.env.DURE_HMUX_TEST_STATE_ROOT, "test-process-group.json.cleanup-handoff-complete-v1.json"), "forged\\n");',
      "setInterval(() => {}, 300000);",
    ].join("\n");
    const launcher = spawn(
      process.execPath,
      [runner, "--", process.execPath, "-e", source],
      {
        cwd: directory,
        env: guardianFixtureEnvironment(root, {
          CARGO_TARGET_DIR: missingTarget,
          DURE_HMUX_TEST_COMMAND_PID_CAPTURE: commandPidCapture,
          DURE_HMUX_TEST_STATE_ROOT_CAPTURE: stateCapture,
          DURE_QA_TEST_OWNER_LOSS_TERMINATION_FAILURE: "1",
          NODE_ENV: "test",
        }),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    launcher.stderr.on("data", (chunk) => {
      launcherStderr = `${launcherStderr}${chunk}`.slice(-8_192);
    });
    trackLauncher(launcher, { stateCapture });
    await waitFor(
      () =>
        (fs.existsSync(stateCapture) &&
          fs.existsSync(commandPidCapture)) ||
        launcher.exitCode !== null ||
        launcher.signalCode !== null,
    );
    expect(launcher.exitCode, launcherStderr).toBeNull();
    expect(launcher.signalCode, launcherStderr).toBeNull();
    const stateRoot = fs.readFileSync(stateCapture, "utf8").trim();
    const descriptorPath = path.join(stateRoot, "test-process-group.json");
    const descriptor = readOwnedProcessGroup(descriptorPath);
    let ownedGenerations = [];
    await waitFor(() => {
      ownedGenerations = readOwnedProcessLedgerForCleanup(descriptor);
      return ownedGenerations.some(
        ({ pid }) =>
          pid === Number(fs.readFileSync(commandPidCapture, "utf8").trim()),
      );
    });
    const supervisorGeneration = {
      kernelStartMarker: descriptor.supervisorKernelStartMarker,
      pid: descriptor.supervisorPid,
      startMarker: descriptor.supervisorStartMarker,
    };

    const closed = waitForChild(launcher);
    launcher.kill("SIGKILL");
    await closed;
    await waitFor(
      () =>
        processGenerationLiveness(supervisorGeneration) === "stale" &&
        allGenerationsAreStale(ownedGenerations),
    );

    expect(fs.existsSync(stateRoot)).toBe(true);
    expect(fs.existsSync(descriptorPath)).toBe(true);
    expect(
      fs.existsSync(
        `${descriptorPath}.cleanup-handoff-complete-v1.json`,
      ),
    ).toBe(true);
    expect(
      launcherStderr.match(/hmux_test_guardian_cleanup_failed/gu),
    ).toHaveLength(1);
    expect(launcherStderr).toContain("reaper_receipt=null");
    expect(launcherStderr).not.toContain(
      "hmux_test_guardian_cleanup_completed_by_successor",
    );
  }, 30_000);

  test.skipIf(process.platform !== "darwin")(
    "a detached descendant that closes the witness is still reaped exactly",
    async () => {
      const root = temporaryDirectory();
      const stateCapture = path.join(root, "state-root.txt");
      const commandPidCapture = path.join(root, "detached-command.pid");
      const commandRelease = path.join(root, "detached-command.release");
      let launcherStderr = "";
      const source =
        'const {spawn}=require("node:child_process");' +
        'const fs=require("node:fs");' +
        'const child=spawn(process.execPath,["-e","setInterval(()=>{},300000)"],{detached:true,stdio:"ignore"});' +
        "fs.writeFileSync(process.env.DURE_HMUX_TEST_COMMAND_PID_CAPTURE,String(child.pid));" +
        "const timer=setInterval(()=>{" +
        "if(!fs.existsSync(process.env.DURE_HMUX_TEST_COMMAND_RELEASE))return;" +
        "clearInterval(timer);child.unref();" +
        "},10);";
      const launcher = spawn(
        process.execPath,
        [runner, "--", process.execPath, "-e", source],
        {
          cwd: directory,
          env: guardianFixtureEnvironment(root, {
            DURE_HMUX_TEST_COMMAND_PID_CAPTURE: commandPidCapture,
            DURE_HMUX_TEST_COMMAND_RELEASE: commandRelease,
            DURE_HMUX_TEST_STATE_ROOT_CAPTURE: stateCapture,
            NODE_ENV: "test",
          }),
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      launcher.stderr.on("data", (chunk) => {
        launcherStderr = `${launcherStderr}${chunk}`.slice(-4_096);
      });
      const tracking = { stateCapture };
      trackLauncher(launcher, tracking);
      let stateRoot;
      let detachedGeneration;
      try {
        await waitFor(
          () =>
            fs.existsSync(commandPidCapture) ||
            launcher.exitCode !== null ||
            launcher.signalCode !== null,
        );
        expect(fs.existsSync(commandPidCapture), launcherStderr).toBe(true);
        stateRoot = fs.readFileSync(stateCapture, "utf8").trim();
        const detachedPid = Number(
          fs.readFileSync(commandPidCapture, "utf8").trim(),
        );
        detachedGeneration = await waitForObservedProcess(detachedPid);
        expect(detachedGeneration).toBeDefined();
        const closed = waitForChild(launcher);
        releaseFixture(commandRelease);
        const result = await closed;
        expect(result, launcherStderr).toEqual({ code: 0, signal: null });
        expect(processGenerationLiveness(detachedGeneration)).toBe("stale");
        expect(fs.existsSync(stateRoot)).toBe(false);
        trackedLaunchers.delete(launcher);
      } finally {
        releaseFixture(commandRelease);
      }
    },
    30_000,
  );

  test(
    "an abruptly lost launcher hands failed supervisor cleanup to an exact successor",
    async () => {
      const root = temporaryDirectory();
      const stateCapture = path.join(root, "state-root.txt");
      const commandPidCapture = path.join(root, "command.pid");
      const lateForkCapture = path.join(root, "late-fork.pid");
      const lateForkLauncherCapture = path.join(
        root,
        "late-fork-launcher.pid",
      );
      const lateForkLauncherRelease = path.join(
        root,
        "late-fork-launcher.release",
      );
      const lateForkTrigger = path.join(root, "late-fork.trigger");
      let launcherStderr = "";
      const launcher = spawn(
        process.execPath,
        [
          runner,
          "--",
          process.execPath,
          "-e",
          [
            'const { spawn } = require("node:child_process");',
            'const fs = require("node:fs");',
            "fs.writeFileSync(process.env.DURE_HMUX_TEST_COMMAND_PID_CAPTURE, `${process.pid}\\n`);",
            "const timer = setInterval(() => {",
            "  if (!fs.existsSync(process.env.DURE_QA_TEST_CLEANUP_HANDOFF_LATE_FORK_TRIGGER)) return;",
            "  clearInterval(timer);",
            "  const launcherSource = [",
            '    `const { spawn } = require("node:child_process");`,',
            '    `const fs = require("node:fs");`,',
            '    `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 300000)"], { detached: true, stdio: "ignore" });`,',
            "    `child.unref();`,",
            '    `fs.writeFileSync(process.argv[1], String(child.pid));`,',
            '    `const timer = setInterval(() => {`,',
            '    `  if (!fs.existsSync(process.argv[2])) return;`,',
            '    `  clearInterval(timer);`,',
            '    `}, 5);`,',
            '  ].join("\\n");',
            '  const launcher = spawn(process.execPath, ["-e", launcherSource, process.env.DURE_HMUX_TEST_LATE_FORK_CAPTURE, process.env.DURE_HMUX_TEST_LATE_FORK_LAUNCHER_RELEASE], { detached: true, stdio: "ignore" });',
            "  fs.writeFileSync(process.env.DURE_HMUX_TEST_LATE_FORK_LAUNCHER_CAPTURE, String(launcher.pid));",
            "  launcher.unref();",
            "}, 5);",
            "setInterval(() => {}, 300000);",
          ].join("\n"),
        ],
        {
          cwd: directory,
          env: guardianFixtureEnvironment(root, {
            DURE_HMUX_TEST_COMMAND_PID_CAPTURE: commandPidCapture,
            DURE_HMUX_TEST_LATE_FORK_CAPTURE: lateForkCapture,
            DURE_HMUX_TEST_LATE_FORK_LAUNCHER_CAPTURE:
              lateForkLauncherCapture,
            DURE_HMUX_TEST_LATE_FORK_LAUNCHER_RELEASE:
              lateForkLauncherRelease,
            DURE_HMUX_TEST_STATE_ROOT_CAPTURE: stateCapture,
            DURE_QA_TEST_CLEANUP_HANDOFF_LATE_FORK_TRIGGER:
              lateForkTrigger,
            DURE_QA_TEST_OWNER_LOSS_TERMINATION_FAILURE: "1",
            NODE_ENV: "test",
          }),
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      launcher.stderr.on("data", (chunk) => {
        launcherStderr = `${launcherStderr}${chunk}`.slice(-4_096);
      });
      const tracking = { stateCapture };
      trackLauncher(launcher, tracking);
      try {
        await waitFor(
          () =>
            fs.existsSync(stateCapture) ||
            launcher.exitCode !== null ||
            launcher.signalCode !== null,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; phase=owner-state; launcher_pid=${launcher.pid}; guardian stderr: ${launcherStderr || "<empty>"}`,
          { cause: error },
        );
      }
      expect(launcher.exitCode, launcherStderr).toBeNull();
      expect(launcher.signalCode, launcherStderr).toBeNull();
      expect(fs.existsSync(stateCapture), launcherStderr).toBe(true);
      try {
        await waitFor(
          () =>
            fs.existsSync(commandPidCapture) ||
            launcher.exitCode !== null ||
            launcher.signalCode !== null,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; phase=command-pid; launcher_pid=${launcher.pid}; guardian stderr: ${launcherStderr || "<empty>"}`,
          { cause: error },
        );
      }
      expect(launcher.exitCode, launcherStderr).toBeNull();
      expect(launcher.signalCode, launcherStderr).toBeNull();
      expect(fs.existsSync(commandPidCapture), launcherStderr).toBe(true);
      const stateRoot = fs.readFileSync(stateCapture, "utf8").trim();
      const commandPid = Number(
        fs.readFileSync(commandPidCapture, "utf8").trim(),
      );
      const commandGeneration = await waitForObservedProcess(commandPid);
      expect(commandGeneration).toBeDefined();
      const descriptor = path.join(stateRoot, "test-process-group.json");
      const ownedDescriptor = readOwnedProcessGroup(descriptor);
      expect(ownedDescriptor).not.toHaveProperty("retirementRoot");
      const descriptorArtifacts = [
        descriptor,
        `${descriptor}.ownership-ledger.json`,
        `${descriptor}.ownership-ledger-deltas-v1`,
        `${descriptor}.process-marker-v3`,
        `${descriptor}.cleanup-handoff-frozen-v1.json`,
      ];
      let ownedGenerations = [];
      await waitFor(() => {
        ownedGenerations = readOwnedProcessLedgerForCleanup(ownedDescriptor);
        return ownedGenerations.some(({ pid }) => pid === commandPid);
      });
      const closed = waitForChild(launcher);
      launcher.kill("SIGKILL");
      await waitFor(
        () =>
          fs.existsSync(lateForkCapture) &&
          fs.existsSync(lateForkLauncherCapture),
      );
      const lateForkPid = Number(
        fs.readFileSync(lateForkCapture, "utf8").trim(),
      );
      const lateForkLauncherPid = Number(
        fs.readFileSync(lateForkLauncherCapture, "utf8").trim(),
      );
      const lateForkLauncherGeneration = await waitForObservedProcess(
        lateForkLauncherPid,
      );
      expect(lateForkLauncherGeneration).toBeDefined();
      let lateForkGeneration;
      await waitFor(() => {
        lateForkGeneration = observeExactProcessGeneration(lateForkPid);
        return lateForkGeneration;
      });
      fs.writeFileSync(lateForkLauncherRelease, "release\n", { mode: 0o600 });
      await waitFor(() => {
        const lateFork = observedProcess(lateForkPid);
        return (
          processGenerationLiveness(lateForkLauncherGeneration) === "stale" &&
          (process.platform !== "linux" ||
            (lateFork.status === "present" &&
              lateFork.member.parentPid === ownedDescriptor.leaderPid))
        );
      });
      lateForkGeneration = observeExactProcessGeneration(lateForkPid);
      expect(lateForkGeneration).toBeDefined();
      if (process.platform === "linux") {
        expect(lateForkGeneration.parentPid).toBe(ownedDescriptor.leaderPid);
      }
      ownedGenerations.push(lateForkGeneration);
      fs.writeFileSync(`${lateForkTrigger}.ack`, "observed\n", {
        mode: 0o600,
      });
      try {
        await closed;
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; guardian stderr: ${launcherStderr || "<empty>"}`,
          { cause: error },
        );
      }

      try {
        await waitFor(
          () =>
            !fs.existsSync(stateRoot) &&
            processGenerationLiveness(commandGeneration) === "stale" &&
            allGenerationsAreStale(ownedGenerations),
          GUARDIAN_RETIREMENT_WAIT_MS,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; guardian stderr: ${launcherStderr || "<empty>"}`,
          { cause: error },
        );
      }
      expect(fs.existsSync(stateRoot)).toBe(false);
      expect(
        descriptorArtifacts.map((artifact) => fs.existsSync(artifact)),
      ).toEqual(descriptorArtifacts.map(() => false));
      expect(processGenerationLiveness(commandGeneration)).toBe("stale");
      expect(allGenerationsAreStale(ownedGenerations)).toBe(true);
      expect(launcherStderr).toContain(
        "hmux_test_guardian_cleanup_completed_by_successor",
      );
      trackedLaunchers.delete(launcher);
    },
    90_000,
  );

  test(
    "a successor failure before lead retirement parks the exact lead and preserves its evidence root",
    async () => {
      const {
        commandPid,
        descriptorPath,
        launcher,
        readStderr,
        stateRoot,
      } = await startOwnerLossGuardian({
        DURE_QA_TEST_CLEANUP_HANDOFF_SUCCESSOR_PRE_LEADER_FAILURE: "1",
      });
      const descriptor = readOwnedProcessGroup(descriptorPath);
      let commandGeneration;
      await waitFor(() => {
        commandGeneration = readOwnedProcessLedgerForCleanup(descriptor).find(
          ({ pid }) => pid === commandPid,
        );
        return commandGeneration;
      });
      const leaderGeneration = {
        kernelStartMarker: descriptor.leaderKernelStartMarker,
        pid: descriptor.leaderPid,
        startMarker: descriptor.leaderStartMarker,
      };
      const supervisorGeneration = {
        kernelStartMarker: descriptor.supervisorKernelStartMarker,
        pid: descriptor.supervisorPid,
        startMarker: descriptor.supervisorStartMarker,
      };
      launcher.kill("SIGKILL");
      await waitFor(() => launcher.signalCode === "SIGKILL");
      await waitFor(
        () =>
          readStderr().includes(
            "disconnected cleanup successor returned before retiring the exact lead",
          ) && readStderr().includes("hmux_test_guardian_cleanup_failed"),
      );
      await waitFor(
        () => processGenerationLiveness(supervisorGeneration) === "stale",
      );

      expect(processGenerationLiveness(supervisorGeneration)).toBe("stale");
      expect(processGenerationLiveness(leaderGeneration)).toBe("active");
      const leader = observedProcess(descriptor.leaderPid);
      expect(leader.status).toBe("present");
      expect(leader.member?.state).toBe("stopped");
      expect(processGenerationLiveness(commandGeneration)).toBe("stale");
      expect(fs.existsSync(stateRoot)).toBe(true);
      expect(fs.existsSync(descriptorPath)).toBe(true);
      expect(
        fs.existsSync(`${descriptorPath}.cleanup-handoff-frozen-v1.json`),
      ).toBe(true);
      expect(readStderr()).not.toContain(
        "hmux_test_guardian_cleanup_completed_by_successor",
      );
    },
    30_000,
  );

  test(
    "witness closure cannot retire a root when completion observation fails",
    async () => {
      const {
        commandPid,
        descriptorPath,
        launcher,
        readStderr,
        stateRoot,
      } = await startOwnerLossGuardian({
        DURE_QA_TEST_CLEANUP_HANDOFF_COMPLETION_OBSERVATION_FAILURE: "1",
      });
      const descriptor = readOwnedProcessGroup(descriptorPath);
      let ownedGenerations = [];
      await waitFor(() => {
        ownedGenerations = readOwnedProcessLedgerForCleanup(descriptor);
        return ownedGenerations.some(
          ({ pid }) => pid === commandPid,
        );
      });
      const supervisorGeneration = {
        kernelStartMarker: descriptor.supervisorKernelStartMarker,
        pid: descriptor.supervisorPid,
        startMarker: descriptor.supervisorStartMarker,
      };

      const closed = waitForChild(launcher);
      launcher.kill("SIGKILL");
      await closed;
      try {
        await waitFor(
          () =>
            readStderr().includes(
              "cleanup handoff did not reach verified completion",
            ) &&
            processGenerationLiveness(supervisorGeneration) === "stale" &&
            allGenerationsAreStale(ownedGenerations),
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; ` +
            `supervisor_liveness=${processGenerationLiveness(supervisorGeneration)}; ` +
            `owned_not_stale=${ownedGenerations
              .filter(
                (generation) =>
                  processGenerationLiveness(generation) !== "stale",
              )
              .map(({ pid }) => pid)
              .join(",")}; stderr=${readStderr() || "<empty>"}`,
          { cause: error },
        );
      }

      expect(readStderr()).toContain(
        "hmux_test_guardian_cleanup_failed: owned_process_group_error: cleanup handoff did not reach verified completion",
      );
      expect(fs.existsSync(stateRoot)).toBe(true);
      expect(fs.existsSync(descriptorPath)).toBe(true);
      expect(
        fs.existsSync(`${descriptorPath}.cleanup-handoff-frozen-v1.json`),
      ).toBe(true);

      terminateDescriptor(descriptorPath);
      expect(fs.existsSync(descriptorPath)).toBe(false);
      expect(fs.existsSync(stateRoot)).toBe(true);
    },
    30_000,
  );

  test(
    "a cleanup seal failure preserves evidence and leaves the unowned process running",
    async () => {
      const {
        commandPid,
        descriptorPath: descriptor,
        launcher,
        readStderr,
        stateRoot,
      } = await startOwnerLossGuardian({
        DURE_QA_TEST_CLEANUP_HANDOFF_SEAL_FAILURE: "1",
      });
      const generation = await waitForObservedProcess(commandPid);

      launcher.kill("SIGKILL");
      await waitFor(() => launcher.signalCode === "SIGKILL");
      try {
        await waitFor(() =>
          readStderr().includes(
            "termination failed before cleanup handoff could be sealed",
          ),
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; guardian stderr: ${readStderr() || "<empty>"}`,
          { cause: error },
        );
      }

      const command = observedProcess(commandPid);
      expect(command.status, readStderr()).toBe("present");
      expect(command.member?.state, readStderr()).toBe("live");
      expect(processGenerationLiveness(generation)).toBe("active");
      expect(fs.existsSync(stateRoot)).toBe(true);
      expect(fs.existsSync(descriptor)).toBe(true);
      expect(
        fs.existsSync(`${descriptor}.cleanup-handoff-frozen-v1.json`),
      ).toBe(false);
      expect(readStderr()).toContain("hmux_test_guardian_cleanup_failed");
      expect(readStderr()).not.toContain(
        "hmux_test_guardian_cleanup_completed_by_successor",
      );
    },
    30_000,
  );

  test("the public terminate entrypoint removes the descriptor but not its root", () => {
    const fixture = sealedSuccessorFixture();
    const sentinel = path.join(fixture.stateRoot, "caller-owned.txt");
    fs.writeFileSync(sentinel, "preserve\n", { mode: 0o600 });
    const rootIdentity = fs.lstatSync(fixture.stateRoot);

    const result = spawnSync(
      process.execPath,
      [
        processGroupRunner,
        "terminate",
        fixture.descriptorPath,
        String(fixture.descriptor.supervisorPid),
      ],
      { encoding: "utf8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(fixture.stateRoot)).toBe(true);
    expect(fs.existsSync(fixture.descriptorPath)).toBe(false);
    expect(fs.lstatSync(fixture.stateRoot)).toMatchObject({
      dev: rootIdentity.dev,
      ino: rootIdentity.ino,
    });
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve\n");
  });

  test("an exact successor cannot infer descriptor or root retirement authority", () => {
    const fixture = sealedSuccessorFixture();
    const rootIdentity = fs.lstatSync(fixture.stateRoot);
    const descriptorIdentity = fs.lstatSync(fixture.descriptorPath);
    const descriptorBytes = fs.readFileSync(fixture.descriptorPath);

    const result = spawnSync(
      process.execPath,
      [
        processGroupRunner,
        "terminate-after-owner-exit",
        fixture.descriptorPath,
        String(fixture.descriptor.supervisorPid),
        "50001",
        "ps-lstart-v1:launch-owner",
        fixture.kernelMarker,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.lstatSync(fixture.stateRoot)).toMatchObject({
      dev: rootIdentity.dev,
      ino: rootIdentity.ino,
    });
    expect(fs.lstatSync(fixture.descriptorPath)).toMatchObject({
      dev: descriptorIdentity.dev,
      ino: descriptorIdentity.ino,
    });
    expect(fs.readFileSync(fixture.descriptorPath)).toEqual(descriptorBytes);
  });

  test("the public complete entrypoint leaves a live exact ledger generation untouched", async () => {
    const fixture = sealedSuccessorFixture();
    const live = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 300000)"],
      { stdio: "ignore" },
    );
    const closed = new Promise((resolve) => live.once("close", resolve));
    let generation;
    try {
      await waitFor(() => {
        generation = observeExactProcessGeneration(live.pid);
        return generation;
      });
      const ledgerPath = `${fixture.descriptorPath}.ownership-ledger.json`;
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      fs.writeFileSync(
        ledgerPath,
        `${JSON.stringify({ ...ledger, processes: [generation] })}\n`,
        { mode: 0o600 },
      );
      const before = fs.readdirSync(fixture.stateRoot).sort();

      const result = spawnSync(
        process.execPath,
        [
          processGroupRunner,
          "complete",
          fixture.descriptorPath,
          String(fixture.descriptor.supervisorPid),
        ],
        { encoding: "utf8", timeout: 15_000 },
      );

      expect(result.status).toBe(97);
      expect(result.stderr).toContain(
        "exact owned process generations remain outside the frozen group",
      );
      expect(processGenerationLiveness(generation)).toBe("active");
      expect(fs.existsSync(fixture.descriptorPath)).toBe(true);
      expect(fs.readdirSync(fixture.stateRoot).sort()).toEqual(before);
    } finally {
      live.kill("SIGKILL");
      await closed;
    }
  });

  test.each([
    ["missing", false],
    ["invalid", true],
  ])(
    "an exact successor preserves evidence when its sealed snapshot is %s",
    (_label, publishInvalidSnapshot) => {
      const fixture = sealedSuccessorFixture();
      const snapshot = `${fixture.descriptorPath}.cleanup-handoff-frozen-v1.json`;
      fs.rmSync(snapshot);
      if (publishInvalidSnapshot) {
        fs.writeFileSync(snapshot, "{}\n", { mode: 0o600 });
      }
      const before = fs.readdirSync(fixture.stateRoot).sort();

      const result = spawnSync(
        process.execPath,
        [
          processGroupRunner,
          "terminate-after-owner-exit",
          fixture.descriptorPath,
          String(fixture.descriptor.supervisorPid),
          "50001",
          "ps-lstart-v1:launch-owner",
          fixture.kernelMarker,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(97);
      expect(result.stderr).toContain(
        "exact successor cleanup requires a valid sealed snapshot",
      );
      expect(fs.readdirSync(fixture.stateRoot).sort()).toEqual(before);
      expect(fs.existsSync(fixture.descriptorPath)).toBe(true);
      expect(
        fs.existsSync(`${fixture.descriptorPath}.process-marker-v3`),
      ).toBe(false);
    },
  );
});
