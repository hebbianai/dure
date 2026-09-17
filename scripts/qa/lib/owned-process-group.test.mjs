import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  exactOwnedProcessIdentity,
  exactTerminationOrder,
  freezeOwnedProcessTree,
  macosProcessMarkerCompileArguments,
  observeExactProcessGeneration,
  OwnedProcessCleanupHandoffError,
  OWNED_PROCESS_GENERATION_LIMIT,
  ownedProcessClosure,
  readFrozenProcessTree,
  readOwnedProcessLedger,
  readOwnedProcessLedgerForCleanup,
  readOwnedProcessLedgerForRetirement,
  readOwnedProcessGroup,
  recoverIdentityOnlyOwnedProcessTree,
  releaseLeadForCleanupHandoff,
  signalExactProcess,
  startOwnershipLedgerSampler,
  startupLeaderFromMessage,
  stopOwnershipMonitorThenCleanup,
  stopOwnershipMonitorThenHandoffOnTerminationFailure,
  terminateOwnedProcessGroup,
  terminateFrozenOwnedProcessTree,
  terminateSealedCleanupHandoff,
  verifySealedCleanupHandoffExited,
  verifyOwnedProcessTreeExited,
} from "./owned-process-group.mjs";
import { qaEnvironmentValue } from "./qa-environment.mjs";
import { compileFaultInjectableMacosObserver } from "./owned-process-observer-fixture.mjs";
import {
  macosProcessMarkerToolPath,
  startMacosOwnershipObserver,
} from "./macos-ownership-observer.mjs";
import {
  parseMacosProcessIdentity,
  processGroupMemberStates,
  processLivenessFromObservation,
  processMemberFromObservation,
  processMemberSnapshots,
  signalProcessGenerationSync,
} from "../../lib/process-identity.mjs";

const OWNED_PROCESS_GROUP_MODULE = fileURLToPath(
  new URL("./owned-process-group.mjs", import.meta.url),
);

async function waitForCondition(condition, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for exact process fixture state");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runInjectedOwnershipMonitorFailure(environmentName) {
  const fixtureRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "dure-owned-monitor-fault-"),
  );
  const descriptorPath = path.join(fixtureRoot, "group.json");
  let descriptor;
  let ledgerProcesses = [];
  try {
    const overlapFailure =
      environmentName ===
      "DURE_QA_TEST_TERMINATION_AND_MONITOR_FAILURE";
    const result = spawnSync(
      process.execPath,
      [
        OWNED_PROCESS_GROUP_MODULE,
        "run",
        descriptorPath,
        "--",
        process.execPath,
        "-e",
        environmentName ===
          "DURE_QA_TEST_OWNERSHIP_MONITOR_RUNTIME_FAILURE" ||
        environmentName ===
          "DURE_QA_TEST_NATIVE_OWNERSHIP_OBSERVER_RUNTIME_EXIT" ||
        overlapFailure
          ? "setTimeout(() => {}, 10000)"
          : "setTimeout(() => {}, 25)",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          [environmentName]: "1",
          ...(overlapFailure
            ? {
                DURE_QA_TEST_OWNERSHIP_MONITOR_RUNTIME_FAILURE: "1",
                DURE_QA_TEST_REQUEST_TERMINATION_BEFORE_MONITOR_FAILURE:
                  "1",
              }
            : {}),
          NODE_ENV: "test",
        },
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(97);
    const expectedFailure = overlapFailure
      ? "injected ownership monitor runtime failure after termination request"
      : environmentName ===
          "DURE_QA_TEST_NATIVE_OWNERSHIP_OBSERVER_RUNTIME_EXIT"
        ? "ownership observer exited status=none signal=SIGTERM"
        : "injected ownership monitor";
    expect(result.stderr).toContain(expectedFailure);

    descriptor = readOwnedProcessGroup(descriptorPath);
    const ledgerPath = `${descriptorPath}.ownership-ledger.json`;
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      expect(ledger.healthy).toBe(false);
      expect(ledger.processes.length).toBeGreaterThan(0);
      if (overlapFailure) {
        expect(ledger.failureReason).toContain(
          "injected ownership monitor runtime failure after termination request",
        );
      }
      ledgerProcesses = ledger.processes;
    } else {
      expect(environmentName).toBe(
        "DURE_QA_TEST_OWNERSHIP_MONITOR_FAIL_BEFORE_ACK",
      );
      ledgerProcesses = [
        {
          kernelStartMarker: descriptor.leaderKernelStartMarker,
          pid: descriptor.leaderPid,
          startMarker: descriptor.leaderStartMarker,
        },
      ];
    }
    const identities = ledgerProcesses.map(exactOwnedProcessIdentity);
    const observation = processMemberSnapshots(
      identities.map(({ pid }) => pid),
    );
    for (const identity of identities) {
      expect(processLivenessFromObservation(identity, observation)).toBe(
        "stale",
      );
    }
    expect(
      fs.existsSync(`${descriptorPath}.ownership-ledger-deltas-v1`),
    ).toBe(false);
  } finally {
    if (descriptor) {
      for (const expected of exactTerminationOrder(
        ledgerProcesses,
        descriptor.leaderPid,
      )) {
        signalProcessGenerationSync(
          exactOwnedProcessIdentity(expected),
          "SIGKILL",
        );
      }
    }
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

function fakeOwnershipObserver(stdin = new PassThrough()) {
  const observer = new EventEmitter();
  observer.exitCode = null;
  observer.signalCode = null;
  observer.stdin = stdin;
  observer.stdout = new PassThrough();
  observer.stderr = new PassThrough();
  return observer;
}

function observeMembersFrom(readMembers) {
  return async (request) => {
    const members = readMembers();
    if (request.kind === "user_census") {
      return {
        status: "complete",
        scope: {
          effectiveUid: process.geteuid(),
          evidence: "closed_enumeration",
          kind: "user_census",
          ...(request.expectedProcess ? { expectedProcess: request.expectedProcess } : {}),
        },
        members,
      };
    }
    if (request.kind === "group_census") {
      return {
        status: "complete",
        scope: { groupId: request.groupId, kind: "group_census" },
        members: members.filter(
          ({ groupId }) => groupId === request.groupId,
        ),
      };
    }
    const requestedPids = [...new Set(request.pids)].sort(
      (left, right) => left - right,
    );
    return {
      status: "complete",
      scope: { kind: "point", requestedPids },
      members: members.filter(({ pid }) => requestedPids.includes(pid)),
    };
  };
}

function startFakeOwnershipObserver(observer, fail = vi.fn()) {
  const running = startMacosOwnershipObserver(
    {
      descriptorPath: "/tmp/dure-owned-process-observer-test",
      leaderKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9001",
      leaderPid: 41001,
    },
    new Map(),
    { admit: vi.fn(), fail, spawnObserver: () => observer },
  );
  observer.stdout.write("R 1\n");
  return { fail, running };
}

function exitVerificationFixture() {
  const fixtureRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "dure-owned-exit-verify-"),
  );
  const descriptorPath = path.join(fixtureRoot, "group.json");
  const descriptor = {
    descriptorPath,
    groupId: 41_001,
    leaderKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9001",
    leaderPid: 41_001,
    leaderStartMarker: "ps-lstart-v1:leader",
    livenessWitnessVersion: "inherited-fd-v1",
    supervisorKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9000",
    supervisorPid: 40_001,
    supervisorStartMarker: "ps-lstart-v1:supervisor",
    terminateDetachedOwnedGenerations: false,
  };
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(`${descriptorPath}.ownership-ledger.json`, "{}\n");
  return { descriptor, fixtureRoot };
}

function pidReuseIdentityLedger(descriptor) {
  const replacementParent = {
    groupId: descriptor.groupId,
    kernelStartMarker:
      "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9103",
    parentPid: descriptor.leaderPid,
    pid: 41_003,
    sessionId: descriptor.groupId,
    startMarker: "ps-lstart-v1:replacement-parent",
  };
  return {
    ...descriptor,
    healthy: true,
    identityOnlyProcesses: [
      {
        kernelStartMarker:
          "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9002",
        parentKernelStartMarker:
          "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9003",
        parentPid: replacementParent.pid,
        pid: 41_002,
      },
    ],
    processes: [
      {
        groupId: descriptor.groupId,
        kernelStartMarker: descriptor.leaderKernelStartMarker,
        parentPid: descriptor.supervisorPid,
        pid: descriptor.leaderPid,
        sessionId: descriptor.groupId,
        startMarker: descriptor.leaderStartMarker,
      },
      replacementParent,
    ],
    schemaVersion: 1,
  };
}

function userIdentityCensus(relations) {
  return {
    relations,
    scope: {
      effectiveUid: process.geteuid?.(),
      evidence: "closed_enumeration",
      kind: "user_identity_census",
    },
    status: "complete",
  };
}

function verifyFixtureProcessesExited(descriptor) {
  return verifyOwnedProcessTreeExited(
    descriptor,
    {
      DURE_QA_PROCESS_KILL_GRACE_MS: "0",
      DURE_QA_PROCESS_LEDGER_PRODUCER_EXIT_GRACE_MS: "0",
      DURE_QA_PROCESS_TERM_GRACE_MS: "0",
    },
    {
      readLedger: () => [],
      sleepForLedgerStability: async () => {},
    },
  );
}

describe("owned process exit verification", () => {
  test.runIf(["darwin", "linux"].includes(process.platform))(
    "observes live and exited generations through the canonical boundary",
    async () => {
      const { descriptor, fixtureRoot } = exitVerificationFixture();
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
      );
      const childClosed = new Promise((resolve) => child.once("close", resolve));
      let member;

      try {
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        await waitForCondition(() => {
          const observation = processMemberSnapshots([child.pid]);
          member = observation.status === "complete"
            ? observation.members[0]
            : undefined;
          return member !== undefined;
        });
        const exactDescriptor = {
          ...descriptor,
          supervisorKernelStartMarker:
            member.processIdentity.startsWith("linux:")
              ? `kernel-start-v2:${member.processIdentity}`
              : member.processIdentity,
          supervisorPid: child.pid,
        };

        await expect(
          verifyFixtureProcessesExited(exactDescriptor),
        ).rejects.toThrow("ownership ledger producer is still live");

        child.kill("SIGKILL");
        await childClosed;
        await expect(
          verifyFixtureProcessesExited(exactDescriptor),
        ).resolves.toMatchObject({
          capability: "exact_process_observation_v1",
          ownedGenerations: { count: 0 },
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await childClosed;
        }
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
  );

  test.runIf(process.platform === "linux")(
    "allows an absent persisted Linux v1 generation to converge to exited",
    async () => {
      const { descriptor, fixtureRoot } = exitVerificationFixture();
      try {
        await expect(
          verifyFixtureProcessesExited({
            ...descriptor,
            supervisorKernelStartMarker: "kernel-start-v1:linux:1",
            supervisorPid: 2_147_483_647,
          }),
        ).resolves.toMatchObject({
          capability: "exact_process_observation_v1",
          ownedGenerations: { count: 0 },
        });
      } finally {
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
  );

  test("keeps exact ledger-producer observation beyond nominal signal grace", async () => {
    const { descriptor, fixtureRoot } = exitVerificationFixture();
    const waitForExit = vi.fn(async (processes, timeoutMs) => {
      expect(processes).toEqual([
        {
          kernelStartMarker: descriptor.supervisorKernelStartMarker,
          pid: descriptor.supervisorPid,
        },
      ]);
      return timeoutMs >= 30_000 ? [] : processes;
    });

    try {
      await expect(
        verifyOwnedProcessTreeExited(
          descriptor,
          {
            DURE_QA_PROCESS_KILL_GRACE_MS: "1000",
            DURE_QA_PROCESS_TERM_GRACE_MS: "2000",
          },
          {
            readLedger: () => [],
            sleepForLedgerStability: async () => {},
            waitForExit,
          },
        ),
      ).resolves.toMatchObject({
        capability: "exact_process_observation_v1",
        descriptor: {
          supervisor: {
            kernelStartMarker: descriptor.supervisorKernelStartMarker,
            pid: descriptor.supervisorPid,
            startMarker: descriptor.supervisorStartMarker,
          },
        },
      });
      expect(waitForExit).toHaveBeenCalledOnce();
      expect(waitForExit.mock.calls[0][1]).toBe(30_000);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("fails closed when the exact ledger producer outlives its extended bound", async () => {
    const { descriptor, fixtureRoot } = exitVerificationFixture();
    const waitForExit = vi.fn(async (processes) => processes);

    try {
      await expect(
        verifyOwnedProcessTreeExited(
          descriptor,
          {
            DURE_QA_PROCESS_KILL_GRACE_MS: "0",
            DURE_QA_PROCESS_LEDGER_PRODUCER_EXIT_GRACE_MS: "75",
            DURE_QA_PROCESS_TERM_GRACE_MS: "0",
          },
          { waitForExit },
        ),
      ).rejects.toThrow(
        "ownership ledger producer is still live after exact-generation wait " +
          "(pid=40001; timeoutMs=75)",
      );
      expect(waitForExit.mock.calls[0][1]).toBe(75);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});

describe("macOS ownership observer lifecycle", () => {
  test("builds the native observer with the Node ledger generation limit", () => {
    const compileArguments = macosProcessMarkerCompileArguments("/tmp/observer");
    expect(compileArguments).toContain(
      `-DMAX_OWNED_PROCESSES=${OWNED_PROCESS_GENERATION_LIMIT}`,
    );
    expect(compileArguments).not.toContain(
      "-DDURE_OWNERSHIP_OBSERVER_FAULT_INJECTION=1",
    );
  });

  test("accepts the 5,200 exact generations produced by a cold Cargo build", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-owned-ledger-capacity-"),
    );
    const descriptorPath = path.join(fixtureRoot, "group.json");
    const descriptor = {
      descriptorPath,
      groupId: 41_001,
      leaderKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9001",
      leaderPid: 41_001,
      leaderStartMarker: "ps-lstart-v1:leader",
      livenessWitnessVersion: "inherited-fd-v1",
      supervisorKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9000",
      supervisorPid: 40_001,
      supervisorStartMarker: "ps-lstart-v1:supervisor",
    };
    const processes = Array.from({ length: 5_200 }, (_, index) => ({
      groupId: descriptor.groupId,
      kernelStartMarker: `kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:${10_000 + index}`,
      parentPid: descriptor.leaderPid,
      pid: 50_000 + index,
      sessionId: descriptor.groupId,
      startMarker: `ps-lstart-v1:cold-build-${index}`,
    }));

    try {
      fs.writeFileSync(
        `${descriptorPath}.ownership-ledger.json`,
        JSON.stringify({
          groupId: descriptor.groupId,
          healthy: true,
          leaderKernelStartMarker: descriptor.leaderKernelStartMarker,
          leaderStartMarker: descriptor.leaderStartMarker,
          livenessWitnessVersion: descriptor.livenessWitnessVersion,
          processes,
          schemaVersion: 1,
          supervisorKernelStartMarker:
            descriptor.supervisorKernelStartMarker,
          supervisorPid: descriptor.supervisorPid,
          supervisorStartMarker: descriptor.supervisorStartMarker,
          terminateDetachedOwnedGenerations: false,
        }),
      );

      expect(readOwnedProcessLedger(descriptor)).toHaveLength(5_200);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("drains an exact identity seal before reporting observer close", async () => {
    const observer = fakeOwnershipObserver();
    const admit = vi.fn();
    const fail = vi.fn();
    const seal = vi.fn();
    const leader = {
      kernelStartMarker:
        "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9001",
    };
    const running = startMacosOwnershipObserver(
      {
        descriptorPath: "/tmp/dure-owned-process-observer-seal-test",
        leaderKernelStartMarker: leader.kernelStartMarker,
        leaderPid: 41_001,
      },
      new Map([[41_001, leader]]),
      { admit, fail, seal, spawnObserver: () => observer },
    );

    observer.stdout.write("R 1\n");
    await running.ready();
    observer.exitCode = 15;
    observer.emit("exit", 15, null);
    observer.stdout.write("S 41002 9002 41001 9001\n");
    observer.emit("close", 15, null);
    expect(seal).toHaveBeenCalledWith({
      kernelStartMarker:
        "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9002",
      parentKernelStartMarker: leader.kernelStartMarker,
      parentPid: 41_001,
      pid: 41_002,
    });
    expect(admit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
  });

  test("only cleanup accepts a diagnosed unhealthy exact-generation ledger", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-owned-unhealthy-ledger-"),
    );
    const descriptorPath = path.join(fixtureRoot, "group.json");
    const descriptor = {
      descriptorPath,
      groupId: 41_001,
      leaderKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9001",
      leaderPid: 41_001,
      leaderStartMarker: "ps-lstart-v1:leader",
      livenessWitnessVersion: "inherited-fd-v1",
      supervisorKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9000",
      supervisorPid: 40_001,
      supervisorStartMarker: "ps-lstart-v1:supervisor",
    };
    const ledger = {
      failureReason: "injected ownership monitor failure",
      groupId: descriptor.groupId,
      healthy: false,
      leaderKernelStartMarker: descriptor.leaderKernelStartMarker,
      leaderStartMarker: descriptor.leaderStartMarker,
      livenessWitnessVersion: descriptor.livenessWitnessVersion,
      processes: [
        {
          groupId: descriptor.groupId,
          kernelStartMarker: descriptor.leaderKernelStartMarker,
          parentPid: descriptor.supervisorPid,
          pid: descriptor.leaderPid,
          sessionId: descriptor.groupId,
          startMarker: descriptor.leaderStartMarker,
        },
      ],
      schemaVersion: 1,
      supervisorKernelStartMarker: descriptor.supervisorKernelStartMarker,
      supervisorPid: descriptor.supervisorPid,
      supervisorStartMarker: descriptor.supervisorStartMarker,
      terminateDetachedOwnedGenerations: false,
    };

    try {
      fs.writeFileSync(
        `${descriptorPath}.ownership-ledger.json`,
        JSON.stringify(ledger),
      );
      expect(() => readOwnedProcessLedger(descriptor)).toThrow(
        "ownership ledger is unavailable or unhealthy",
      );
      expect(readOwnedProcessLedgerForCleanup(descriptor)).toHaveLength(1);

      delete ledger.failureReason;
      fs.writeFileSync(
        `${descriptorPath}.ownership-ledger.json`,
        JSON.stringify(ledger),
      );
      expect(() => readOwnedProcessLedgerForCleanup(descriptor)).toThrow(
        "ownership ledger is unavailable or unhealthy",
      );

      ledger.failureReason = "injected ownership monitor failure";
      ledger.identityOnlyProcesses = [
        {
          kernelStartMarker:
            "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9002",
          parentKernelStartMarker:
            "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9003",
          parentPid: 41_003,
          pid: 41_002,
        },
      ];
      fs.writeFileSync(
        `${descriptorPath}.ownership-ledger.json`,
        JSON.stringify(ledger),
      );
      expect(() => readOwnedProcessLedgerForCleanup(descriptor)).toThrow(
        "identity-only ownership chain is incomplete",
      );
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("expires an exited identity-only seal after its parent pid is reused", async () => {
    const { descriptor, fixtureRoot } = exitVerificationFixture();
    descriptor.terminateDetachedOwnedGenerations = true;
    const signalGeneration = vi.fn(() => false);
    const observeIdentities = vi.fn(async () => userIdentityCensus([]));

    try {
      fs.writeFileSync(
        `${descriptor.descriptorPath}.ownership-ledger.json`,
        `${JSON.stringify(pidReuseIdentityLedger(descriptor))}\n`,
      );

      await expect(
        recoverIdentityOnlyOwnedProcessTree(descriptor, {
          observeIdentities,
          platform: "darwin",
          signalGeneration,
          wait: async () => {},
        }),
      ).resolves.toBe(true);
      expect(signalGeneration).not.toHaveBeenCalled();
      expect(observeIdentities).toHaveBeenCalled();
      expect(
        JSON.parse(
          fs.readFileSync(
            `${descriptor.descriptorPath}.ownership-ledger.json`,
            "utf8",
          ),
        ).identityOnlyProcesses,
      ).toEqual([]);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test.each([
    [
      "generation",
      (unresolved) => ({
        parentProcessIdentity: unresolved.parentKernelStartMarker,
        pid: unresolved.pid,
        processIdentity: unresolved.kernelStartMarker,
      }),
    ],
    [
      "descendant",
      (unresolved) => ({
        parentProcessIdentity: unresolved.kernelStartMarker,
        pid: 41_004,
        processIdentity:
          "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9004",
      }),
    ],
  ])("keeps a live unresolved identity-only %s fail-closed", async (_, relation) => {
    const { descriptor, fixtureRoot } = exitVerificationFixture();
    descriptor.terminateDetachedOwnedGenerations = true;
    const ledger = pidReuseIdentityLedger(descriptor);
    const unresolved = ledger.identityOnlyProcesses[0];
    const signalGeneration = vi.fn();
    const observeIdentities = vi.fn(async () =>
      userIdentityCensus([relation(unresolved)])
    );

    try {
      fs.writeFileSync(
        `${descriptor.descriptorPath}.ownership-ledger.json`,
        `${JSON.stringify(ledger)}\n`,
      );

      await expect(
        recoverIdentityOnlyOwnedProcessTree(descriptor, {
          observeIdentities,
          platform: "darwin",
          signalGeneration,
          wait: async () => {},
        }),
      ).rejects.toThrow("identity-only ownership chain is incomplete");
      expect(signalGeneration).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          fs.readFileSync(
            `${descriptor.descriptorPath}.ownership-ledger.json`,
            "utf8",
          ),
        ).identityOnlyProcesses,
      ).toHaveLength(1);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("keeps ownership conservative when atomic rename removes an interrupted delta", () => {
    const { descriptor, fixtureRoot } = exitVerificationFixture();
    const deltaRoot = `${descriptor.descriptorPath}.ownership-ledger-deltas-v1`;
    const temporaryName = `00000001.json.${process.pid}.tmp`;
    const temporaryPath = path.join(deltaRoot, temporaryName);
    let readDirectory;
    const committed = {
      groupId: descriptor.groupId,
      kernelStartMarker: descriptor.leaderKernelStartMarker,
      parentPid: descriptor.supervisorPid,
      pid: descriptor.leaderPid,
      sessionId: descriptor.groupId,
      startMarker: descriptor.leaderStartMarker,
    };
    try {
      fs.writeFileSync(
        `${descriptor.descriptorPath}.ownership-ledger.json`,
        `${JSON.stringify({
          ...descriptor,
          healthy: true,
          processes: [committed],
          schemaVersion: 1,
          terminateDetachedOwnedGenerations: false,
        })}\n`,
        { mode: 0o600 },
      );
      fs.mkdirSync(deltaRoot, { mode: 0o700 });
      fs.writeFileSync(temporaryPath, "{}\n", { mode: 0o600 });
      const readDirectorySync = fs.readdirSync;
      readDirectory = vi
        .spyOn(fs, "readdirSync")
        .mockImplementation((target, options) => {
          const entries = readDirectorySync.call(fs, target, options);
          if (path.resolve(String(target)) !== path.resolve(deltaRoot)) {
            return entries;
          }
          if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
          return [temporaryName];
        });

      expect(readOwnedProcessLedger(descriptor)).toEqual([committed]);
      expect(readOwnedProcessLedgerForCleanup(descriptor)).toEqual([
        committed,
      ]);
      expect(() => readOwnedProcessLedgerForRetirement(descriptor)).toThrow(
        "incomplete ownership ledger delta",
      );
    } finally {
      readDirectory?.mockRestore();
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("a terminal observer failure rejects every later barrier", async () => {
    const observer = fakeOwnershipObserver();
    const { fail, running } = startFakeOwnershipObserver(observer);
    await running.ready();

    observer.exitCode = 19;
    observer.emit("exit", 19, null);
    observer.emit("close", 19, null);

    await expect(running.barrier()).rejects.toThrow(
      "ownership observer exited status=19 signal=none",
    );
    expect(fail).toHaveBeenCalledOnce();
  });

  test("a barrier write failure is typed instead of hanging", async () => {
    const input = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("injected EPIPE"));
      },
    });
    const observer = fakeOwnershipObserver(input);
    const { fail, running } = startFakeOwnershipObserver(observer);
    await running.ready();

    await expect(running.barrier()).rejects.toThrow("injected EPIPE");
    expect(fail).toHaveBeenCalledOnce();
  });

  test("a malformed observer frame fails every later barrier", async () => {
    const observer = fakeOwnershipObserver();
    const { fail, running } = startFakeOwnershipObserver(observer);
    await running.ready();

    observer.stdout.write("not-an-observer-frame\n");

    await expect(running.barrier()).rejects.toThrow(
      "ownership observer returned a malformed frame",
    );
    expect(fail).toHaveBeenCalledOnce();
  });

  test("a truncated observer frame fails stop after the final barrier", async () => {
    const observer = fakeOwnershipObserver();
    observer.stdin.on("data", (chunk) => {
      const message = chunk.toString();
      const barrier = message.match(/^barrier (\d+)\n$/u);
      if (barrier) {
        observer.stdout.write(`B ${barrier[1]}\npartial`);
        return;
      }
      if (message === "stop\n") {
        observer.exitCode = 0;
        observer.emit("exit", 0, null);
        observer.emit("close", 0, null);
      }
    });
    const { fail, running } = startFakeOwnershipObserver(observer);
    await running.ready();

    await expect(running.stop()).rejects.toThrow(
      "ownership observer left a partial frame",
    );
    expect(fail).not.toHaveBeenCalled();
  });

  test.runIf(process.platform === "darwin")(
    "native identity faults fail closed while sealed metadata faults stay recoverable",
    () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-observer-fault-"),
      );
      try {
        const executable = compileFaultInjectableMacosObserver(
          path.join(fixtureRoot, "ownership-observer"),
        );
        const identity = spawnSync(
          executable,
          ["read", String(process.pid)],
          { encoding: "utf8" },
        );
        expect(identity.error).toBeUndefined();
        expect(identity.status).toBe(0);
        const processIdentity = parseMacosProcessIdentity(
          identity.stdout.trim(),
        );
        expect(processIdentity).not.toBeNull();

        for (const [fault, expectedStatus] of [
          ["identity-esrch", 3],
          ["identity-eperm", 5],
          ["identity-eio", 5],
        ]) {
          const result = spawnSync(
            executable,
            ["read", String(process.pid)],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT: fault,
              },
            },
          );
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(expectedStatus);
        }

        const inconsistentPoint = spawnSync(
          executable,
          ["observe-point", String(process.pid)],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT:
                "member-session-drift",
            },
          },
        );
        expect(inconsistentPoint.error).toBeUndefined();
        expect(inconsistentPoint.status).toBe(15);

        const sessionDrift = spawnSync(
          executable,
          [
            "watch",
            String(process.pid),
            processIdentity.bootSession,
            processIdentity.uniqueId,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT:
                "member-session-drift",
            },
            input: "barrier 1\nstop\n",
            timeout: 10_000,
          },
        );
        expect(sessionDrift.error).toBeUndefined();
        expect(sessionDrift.status).toBe(0);
        expect(sessionDrift.stderr).toContain(
          "observer process session drift",
        );
        expect(sessionDrift.stdout).toMatch(
          /^S \d+ \d+ \d+ \d+\nR 1\nB 1\n$/u,
        );

        const bsdUnavailable = spawnSync(
          executable,
          [
            "watch",
            String(process.pid),
            processIdentity.bootSession,
            processIdentity.uniqueId,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT: "bsd-eperm",
            },
            input: "barrier 1\nstop\n",
            timeout: 10_000,
          },
        );
        expect(bsdUnavailable.error).toBeUndefined();
        expect(bsdUnavailable.status).toBe(0);
        expect(bsdUnavailable.stderr).toContain(
          "injected proc_bsdinfo",
        );
        expect(bsdUnavailable.stdout).toMatch(
          /^S \d+ \d+ \d+ \d+\nR 1\nB 1\n$/u,
        );

        for (const fault of [
          "child-census-capacity",
          "system-census-capacity",
        ]) {
          const result = spawnSync(
            executable,
            [
              "watch",
              String(process.pid),
              processIdentity.bootSession,
              processIdentity.uniqueId,
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT: fault,
              },
              input: "barrier 1\n",
              timeout: 5_000,
            },
          );
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(8);
        }
      } finally {
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
  );

  test.runIf(process.platform === "darwin")(
    "an identity-sealed descendant survives metadata loss only until exact cleanup",
    async () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-observer-bsd-loss-"),
      );
      const descriptorPath = path.join(fixtureRoot, "group.json");
      const childPidPath = path.join(fixtureRoot, "child.pid");
      const releasePath = path.join(fixtureRoot, "release");
      const executable = macosProcessMarkerToolPath(descriptorPath);
      compileFaultInjectableMacosObserver(executable);
      const source = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        "const [childPidPath, releasePath] = process.argv.slice(1);",
        "const child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 300000)\"], { detached: true, stdio: \"ignore\" });",
        "child.unref();",
        "fs.writeFileSync(childPidPath, `${child.pid}\\n`);",
        "const timer = setInterval(() => {",
        "  if (!fs.existsSync(releasePath)) return;",
        "  clearInterval(timer);",
        "}, 20);",
      ].join("\n");
      let stderr = "";
      let childGeneration;
      const runner = spawn(
        process.execPath,
        [
          OWNED_PROCESS_GROUP_MODULE,
          "run-observed",
          descriptorPath,
          "--",
          process.execPath,
          "-e",
          source,
          childPidPath,
          releasePath,
        ],
        {
          env: {
            ...process.env,
            DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT:
              "bsd-eperm-after-barrier",
            NODE_ENV: "test",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      runner.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });
      const closed = new Promise((resolve, reject) => {
        runner.once("error", reject);
        runner.once("close", (code, signal) => resolve({ code, signal }));
      });

      try {
        await waitForCondition(
          () => fs.existsSync(childPidPath) || runner.exitCode !== null,
        );
        expect(runner.exitCode, stderr).toBeNull();
        const childPid = Number(fs.readFileSync(childPidPath, "utf8").trim());
        await waitForCondition(() => {
          childGeneration = observeExactProcessGeneration(childPid);
          return Boolean(childGeneration);
        });
        await waitForCondition(() => {
          if (!fs.existsSync(descriptorPath)) return false;
          const descriptor = readOwnedProcessGroup(descriptorPath);
          try {
            readOwnedProcessLedgerForRetirement(descriptor);
            return false;
          } catch (error) {
            return String(error).includes(
              "identity-only ownership requires exact recovery",
            );
          }
        });
        fs.writeFileSync(releasePath, "release\n", { mode: 0o600 });

        await expect(closed).resolves.toEqual({ code: 0, signal: null });
        expect(
          processLivenessFromObservation(
            exactOwnedProcessIdentity(childGeneration),
            processMemberSnapshots([childGeneration.pid]),
          ),
        ).toBe("stale");
        const recoveredDescriptor = readOwnedProcessGroup(descriptorPath);
        expect(() =>
          readOwnedProcessLedgerForRetirement(recoveredDescriptor)
        ).not.toThrow();
        expect(
          fs.existsSync(`${descriptorPath}.ownership-ledger-deltas-v1`),
        ).toBe(false);
      } finally {
        if (!fs.existsSync(releasePath)) {
          fs.writeFileSync(releasePath, "release\n", { mode: 0o600 });
        }
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill("SIGKILL");
          await closed.catch(() => {});
        }
        if (childGeneration) {
          signalProcessGenerationSync(
            exactOwnedProcessIdentity(childGeneration),
            "SIGKILL",
          );
        }
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
    30_000,
  );

  test("an observer stop failure cannot bypass owned process cleanup", async () => {
    const order = [];
    const observerFailure = new Error("injected observer failure");

    await expect(
      stopOwnershipMonitorThenCleanup(
        {
          async stop() {
            order.push("monitor-stop");
            throw observerFailure;
          },
        },
        async () => {
          order.push("exact-cleanup");
        },
      ),
    ).rejects.toBe(observerFailure);
    expect(order).toEqual(["monitor-stop", "exact-cleanup"]);
  });

  test("reports both observer and cleanup failures after attempting cleanup", async () => {
    const observerFailure = new Error("injected observer failure");
    const cleanupFailure = new Error("injected cleanup failure");

    await expect(
      stopOwnershipMonitorThenCleanup(
        { stop: async () => Promise.reject(observerFailure) },
        async () => Promise.reject(cleanupFailure),
      ),
    ).rejects.toMatchObject({
      errors: [observerFailure, cleanupFailure],
      message: expect.stringContaining(
        "ownership monitor and cleanup both failed",
      ),
    });
  });

  test.runIf(process.platform === "darwin")(
    "a stop failure exits after exact cleanup instead of orphaning the leader",
    async () => {
      await runInjectedOwnershipMonitorFailure(
        "DURE_QA_TEST_OWNERSHIP_MONITOR_STOP_FAILURE",
      );
    },
  );

  test.runIf(process.platform === "darwin")(
    "a pre-ack observer failure rolls startup back without orphaning the leader",
    async () => {
      await runInjectedOwnershipMonitorFailure(
        "DURE_QA_TEST_OWNERSHIP_MONITOR_FAIL_BEFORE_ACK",
      );
    },
  );

  test.runIf(process.platform === "darwin")(
    "a runtime observer failure interrupts a live command and cleans every exact generation",
    async () => {
      await runInjectedOwnershipMonitorFailure(
        "DURE_QA_TEST_OWNERSHIP_MONITOR_RUNTIME_FAILURE",
      );
    },
  );

  test.runIf(process.platform === "darwin")(
    "a native observer exit after admission is bounded and leaves no exact generation",
    async () => {
      await runInjectedOwnershipMonitorFailure(
        "DURE_QA_TEST_NATIVE_OWNERSHIP_OBSERVER_RUNTIME_EXIT",
      );
    },
  );

  test.runIf(process.platform === "darwin")(
    "a signal racing a runtime observer failure keeps emergency exact cleanup",
    async () => {
      await runInjectedOwnershipMonitorFailure(
        "DURE_QA_TEST_TERMINATION_AND_MONITOR_FAILURE",
      );
    },
  );
});

describe("hard process containment boundary", () => {
  test.runIf(["darwin", "linux"].includes(process.platform))(
    "an immediate setsid double fork that drops the witness is contained or fails typed",
    async () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-owned-fork-escape-"),
      );
      const descriptorPath = path.join(fixtureRoot, "group.json");
      const grandchildSource = [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const markerRoot = process.argv[1];",
        "setInterval(() => {",
        "  if (!fs.existsSync(path.join(markerRoot, 'cleanup-completed'))) return;",
        "  fs.writeFileSync(path.join(markerRoot, `escaped-${process.pid}`), 'escaped');",
        "  process.exit(0);",
        "}, 10);",
        // Bound a failed fixture independently of the supervisor's cleanup.
        "setTimeout(() => process.exit(0), 15_000);",
      ].join("\n");
      const launcherSource = [
        'const { spawn } = require("node:child_process");',
        "const [grandchildSource, markerRoot] = process.argv.slice(1);",
        "const child = spawn(process.execPath, [\"-e\", grandchildSource, markerRoot], {",
        "  detached: true,",
        "  stdio: \"ignore\",",
        "});",
        "child.unref();",
      ].join("\n");
      const commandSource = [
        'const { spawn } = require("node:child_process");',
        "const [launcherSource, grandchildSource, markerRoot] = process.argv.slice(1);",
        "for (let index = 0; index < 64; index += 1) {",
        "  const child = spawn(process.execPath, [\"-e\", launcherSource, grandchildSource, markerRoot], {",
        "    detached: true,",
        "    stdio: \"ignore\",",
        "  });",
        "  child.unref();",
        "}",
      ].join("\n");

      let cleanupVerified = false;
      try {
        // The same descendant must expose an escape when no owner retires it.
        const controlRoot = path.join(fixtureRoot, "control");
        fs.mkdirSync(controlRoot);
        fs.writeFileSync(path.join(controlRoot, "cleanup-completed"), "ready");
        const control = spawnSync(
          process.execPath,
          ["-e", grandchildSource, controlRoot],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(control.error).toBeUndefined();
        expect(control.status, control.stderr).toBe(0);
        expect(fs.readdirSync(controlRoot).filter(
          (entry) => entry.startsWith("escaped-"),
        )).toHaveLength(1);

        const result = spawnSync(
          process.execPath,
          [
            OWNED_PROCESS_GROUP_MODULE,
            "run-contained",
            descriptorPath,
            "--",
            process.execPath,
            "-e",
            commandSource,
            launcherSource,
            grandchildSource,
            fixtureRoot,
          ],
          {
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        expect(result.error).toBeUndefined();
        // Side effects while the command runs are permitted. Challenge only
        // after the owner has returned its completion receipt.
        fs.writeFileSync(path.join(fixtureRoot, "cleanup-completed"), "ready");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const escaped = fs
          .readdirSync(fixtureRoot)
          .filter((entry) => entry.startsWith("escaped-"));

        if (process.platform === "linux") {
          expect(result.status, result.stderr).toBe(0);
          const ledger = JSON.parse(
            fs.readFileSync(`${descriptorPath}.ownership-ledger.json`, "utf8"),
          );
          expect(
            escaped,
            `cleanup certified ${ledger.processes.length} observed generations`,
          ).toEqual([]);
          const descriptor = JSON.parse(
            fs.readFileSync(descriptorPath, "utf8"),
          );
          const verification = spawnSync(
            process.execPath,
            [
              OWNED_PROCESS_GROUP_MODULE,
              "verify-exited",
              descriptorPath,
              String(descriptor.supervisorPid),
            ],
            { encoding: "utf8", timeout: 15_000 },
          );
          expect(verification.status, verification.stderr).toBe(0);
          expect(JSON.parse(verification.stdout)).toMatchObject({
            capability: "hard_process_containment_v2",
            hardContainment: {
              generationAtomicSignals: true,
              kind: "linux-pidfd-subreaper-v1",
            },
            platform: "linux",
          });
        } else {
          expect(result.status).toBe(97);
          expect(result.stderr).toContain(
            "hard containment is unavailable on darwin",
          );
          expect(escaped).toEqual([]);
          expect(fs.existsSync(descriptorPath)).toBe(false);
        }
        cleanupVerified = true;
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (cleanupVerified) fs.rmSync(fixtureRoot, { force: true, recursive: true });
        else process.stderr.write(`Retained containment fixture: ${fixtureRoot}\n`);
      }
    },
  );

  test.runIf(process.platform === "darwin")(
    "keeps lossy fork observation non-authoritative without aborting the command",
    async () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-owned-observation-"),
      );
      const descriptorPath = path.join(fixtureRoot, "group.json");
      const grandchildSource = "setTimeout(() => process.exit(0), 750)";
      const launcherSource = [
        'const { spawn } = require("node:child_process");',
        "const grandchildSource = process.argv[1];",
        "const child = spawn(process.execPath, [\"-e\", grandchildSource], {",
        "  detached: true,",
        "  stdio: \"ignore\",",
        "});",
        "child.unref();",
      ].join("\n");
      const commandSource = [
        'const { spawn } = require("node:child_process");',
        "const [launcherSource, grandchildSource] = process.argv.slice(1);",
        "for (let index = 0; index < 64; index += 1) {",
        "  const child = spawn(process.execPath, [\"-e\", launcherSource, grandchildSource], {",
        "    detached: true,",
        "    stdio: \"ignore\",",
        "  });",
        "  child.unref();",
        "}",
      ].join("\n");

      try {
        const result = spawnSync(
          process.execPath,
          [
            OWNED_PROCESS_GROUP_MODULE,
            "run-observed",
            descriptorPath,
            "--",
            process.execPath,
            "-e",
            commandSource,
            launcherSource,
            grandchildSource,
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);

        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
        const ledger = JSON.parse(
          fs.readFileSync(`${descriptorPath}.ownership-ledger.json`, "utf8"),
        );
        expect(ledger.healthy).toBe(true);

        const verification = spawnSync(
          process.execPath,
          [
            OWNED_PROCESS_GROUP_MODULE,
            "verify-exited",
            descriptorPath,
            String(descriptor.supervisorPid),
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(verification.status, verification.stderr).toBe(0);
        const receipt = JSON.parse(verification.stdout);
        expect(receipt).toMatchObject({
          capability: "exact_process_observation_v1",
          platform: "darwin",
        });
        expect(receipt).not.toHaveProperty("hardContainment");
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
  );

  test.runIf(process.platform === "darwin")(
    "refuses a hard-containment request before admitting its command",
    () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-owned-hard-refusal-"),
      );
      const descriptorPath = path.join(fixtureRoot, "group.json");
      const marker = path.join(fixtureRoot, "command-ran");
      try {
        const result = spawnSync(
          process.execPath,
          [
            OWNED_PROCESS_GROUP_MODULE,
            "run-contained",
            descriptorPath,
            "--",
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], "ran\\n")',
            marker,
          ],
          { encoding: "utf8", timeout: 5_000 },
        );

        expect(result.status).toBe(97);
        expect(result.stderr).toContain(
          "hard containment is unavailable on darwin",
        );
        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.existsSync(descriptorPath)).toBe(false);
      } finally {
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
  );
});

describe("shared exact process-group termination", () => {
  test.runIf(["darwin", "linux"].includes(process.platform))(
    "routes frozen cleanup through the live supervisor without a false IPC failure",
    async () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-owned-frozen-cleanup-"),
      );
      const descriptorPath = path.join(fixtureRoot, "group.json");
      const frozenPath = path.join(fixtureRoot, "frozen.json");
      let stderr = "";
      const runner = spawn(
        process.execPath,
        [
          OWNED_PROCESS_GROUP_MODULE,
          "run-observed",
          descriptorPath,
          "--",
          process.execPath,
          "-e",
          "setInterval(() => {}, 300000)",
        ],
        {
          env: { ...process.env, NODE_ENV: "test" },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      runner.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });
      const closed = new Promise((resolve, reject) => {
        runner.once("error", reject);
        runner.once("close", (code, signal) => resolve({ code, signal }));
      });

      try {
        await waitForCondition(
          () => fs.existsSync(descriptorPath) || runner.exitCode !== null,
        );
        expect(runner.exitCode, stderr).toBeNull();
        const descriptor = readOwnedProcessGroup(descriptorPath);
        await waitForCondition(() => {
          try {
            return readOwnedProcessLedger(descriptor).length >= 2;
          } catch {
            return false;
          }
        });

        const freeze = spawnSync(
          process.execPath,
          [
            OWNED_PROCESS_GROUP_MODULE,
            "freeze",
            descriptorPath,
            String(runner.pid),
            frozenPath,
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(freeze.status, freeze.stderr).toBe(0);

        const termination = spawnSync(
          process.execPath,
          [
            OWNED_PROCESS_GROUP_MODULE,
            "terminate-frozen",
            descriptorPath,
            String(runner.pid),
            frozenPath,
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(termination.status, termination.stderr).toBe(0);
        await expect(closed).resolves.toEqual({ code: 143, signal: null });
        expect(stderr).not.toContain(
          "startup identity channel closed before command outcome",
        );

        const verification = spawnSync(
          process.execPath,
          [
            OWNED_PROCESS_GROUP_MODULE,
            "verify-exited",
            descriptorPath,
            String(runner.pid),
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(verification.status, verification.stderr).toBe(0);

        const completion = spawnSync(
          process.execPath,
          [
            OWNED_PROCESS_GROUP_MODULE,
            "complete",
            descriptorPath,
            String(runner.pid),
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(completion.status, completion.stderr).toBe(0);
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill("SIGTERM");
          await closed;
        }
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
    30_000,
  );

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "retires an untracked group through its exact leader",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 300000)"],
        { detached: true, stdio: "ignore" },
      );
      const closed = new Promise((resolve) => {
        child.once("close", (status, signal) => resolve({ signal, status }));
      });
      try {
        await waitForCondition(() => {
          const observation = processGroupMemberStates(child.pid);
          return (
            observation.status === "complete" &&
            observation.members.some(
              ({ groupId, pid }) =>
                pid === child.pid && groupId === child.pid,
            )
          );
        });
        const observation = processMemberSnapshots([child.pid]);
        expect(observation.status).toBe("complete");
        const exactLeader = observation.members[0];
        expect(exactLeader).toMatchObject({
          groupId: child.pid,
          pid: child.pid,
          state: "live",
        });

        await terminateOwnedProcessGroup(exactLeader, {
          environment: {
            DURE_QA_PROCESS_KILL_GRACE_MS: "2000",
          },
        });

        await expect(closed).resolves.toMatchObject({ signal: "SIGKILL" });
        const retiredGroup = processGroupMemberStates(child.pid);
        expect(retiredGroup.status).toBe("complete");
        expect(
          retiredGroup.members.some(({ state }) => state !== "zombie"),
        ).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await closed;
        }
      }
    },
  );
});

describe("owned process cleanup handoff", () => {
  async function createIdentityOnlySealFixture() {
    const fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-owned-seal-identity-"),
    );
    const descriptorPath = path.join(fixtureRoot, "group.json");
    const kernelMarker = (id) =>
      process.platform === "darwin"
        ? `kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:${id}`
        : `kernel-start-v2:linux:test-boot:${id}`;
    const leader = {
      groupId: 63_001,
      kernelStartMarker: kernelMarker(63_001),
      parentPid: 63_000,
      pid: 63_001,
      sessionId: 63_001,
      startMarker: "ps-lstart-v1:leader",
    };
    const child = {
      ...leader,
      kernelStartMarker: kernelMarker(63_002),
      parentPid: leader.pid,
      pid: 63_002,
      startMarker: "ps-lstart-v1:child",
    };
    const descriptor = {
      descriptorPath,
      groupId: leader.groupId,
      leaderKernelStartMarker: leader.kernelStartMarker,
      leaderPid: leader.pid,
      leaderStartMarker: leader.startMarker,
      livenessWitnessVersion: "inherited-fd-v1",
      supervisorKernelStartMarker: kernelMarker(leader.parentPid),
      supervisorPid: leader.parentPid,
      supervisorStartMarker: "ps-lstart-v1:supervisor",
      terminateDetachedOwnedGenerations: false,
    };
    const states = new Map([
      [leader.pid, "running"],
      [child.pid, "running"],
    ]);
    const processController = {
      generationState: ({ pid }) => states.get(pid) ?? "gone",
      signalGeneration: vi.fn(({ pid }, signal) => {
        states.set(pid, signal === "SIGSTOP" ? "quiescent" : "running");
        return true;
      }),
    };
    const lifecycle = [];
    const observeIdentities = vi.fn(async () => {
      lifecycle.push("identity-census");
      return userIdentityCensus(
        states.get(child.pid) === "gone"
          ? []
          : [
              {
                parentProcessIdentity: leader.kernelStartMarker,
                pid: child.pid,
                processIdentity: child.kernelStartMarker,
              },
            ],
      );
    });
    let observerCallbacks;
    const barrier = vi.fn(async () => {});
    const startNativeObserver = vi.fn((_descriptor, _known, callbacks) => {
      observerCallbacks = callbacks;
      return {
        barrier,
        ready: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          lifecycle.push("observer-stop");
        }),
      };
    });
    let monitor;
    try {
      monitor = await startOwnershipLedgerSampler(
        descriptor,
        [leader],
        true,
        {
          observeIdentities,
          observeMembers: observeMembersFrom(() => [
            {
              groupId: leader.groupId,
              parentPid: leader.parentPid,
              pid: leader.pid,
              processIdentity: exactOwnedProcessIdentity(leader).processIdentity,
              sessionId: leader.sessionId,
              startedAtUnixSeconds: 1_700_000_000,
              state: "live",
            },
          ]),
          processController,
          startNativeObserver,
        },
      );
      observerCallbacks.seal({
        kernelStartMarker: child.kernelStartMarker,
        parentKernelStartMarker: leader.kernelStartMarker,
        parentPid: leader.pid,
        pid: child.pid,
      });
    } catch (error) {
      if (monitor) await monitor.stop().catch(() => {});
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
      throw error;
    }
    return {
      barrier,
      child,
      descriptor,
      dispose: async () => {
        await monitor.stop().catch(() => {});
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      },
      leader,
      lifecycle,
      markGone: () => states.set(child.pid, "gone"),
      monitor,
      observeIdentities,
      processController,
      promote: () => observerCallbacks.admit(child),
    };
  }

  test.runIf(process.platform === "darwin").each([
    ["expired", true, 0],
    ["live", false, 1],
  ])(
    "checkpoints an identity-only seal as %s only after its producer stops",
    async (_, markGone, expectedIdentityCount) => {
      const fixture = await createIdentityOnlySealFixture();
      try {
        if (markGone) fixture.markGone();

        await expect(
          recoverIdentityOnlyOwnedProcessTree(fixture.descriptor, {
            observeIdentities: fixture.observeIdentities,
            signalGeneration: fixture.processController.signalGeneration,
          }),
        ).resolves.toBe(false);
        expect(fixture.lifecycle).toEqual([]);
        expect(() =>
          readOwnedProcessLedgerForRetirement(fixture.descriptor)
        ).toThrow("identity-only ownership requires exact recovery");
        await fixture.monitor.stop();

        expect(fixture.lifecycle).toEqual([
          "observer-stop",
          "identity-census",
        ]);
        expect(fixture.observeIdentities).toHaveBeenCalledOnce();
        expect(
          fixture.processController.signalGeneration,
        ).not.toHaveBeenCalled();
        const ledger = JSON.parse(
          fs.readFileSync(
            `${fixture.descriptor.descriptorPath}.ownership-ledger.json`,
            "utf8",
          ),
        );
        expect(ledger.identityOnlyProcesses).toHaveLength(
          expectedIdentityCount,
        );
        if (markGone) {
          expect(() =>
            readOwnedProcessLedgerForRetirement(fixture.descriptor)
          ).not.toThrow();
        } else {
          expect(() =>
            readOwnedProcessLedgerForRetirement(fixture.descriptor)
          ).toThrow("identity-only ownership requires exact recovery");
        }
      } finally {
        await fixture.dispose();
      }
    },
  );

  test("resumes the frozen lead and waits for nonleaders before killing it", async () => {
    const leader = {
      groupId: 41_001,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:41001",
      parentPid: 40_001,
      pid: 41_001,
      sessionId: 41_001,
      startMarker: "ps-lstart-v1:leader",
    };
    const detached = {
      groupId: 42_001,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:42001",
      parentPid: leader.pid,
      pid: 42_001,
      sessionId: 42_001,
      startMarker: "ps-lstart-v1:detached",
    };
    const events = [];
    let detachedKilled = false;
    let detachedGone = false;
    let leadStopped = true;
    const processController = {
      generationState(expected) {
        if (expected.pid === detached.pid) {
          if (!detachedKilled) return "quiescent";
          if (!detachedGone) events.push("detached-gone");
          detachedGone = true;
          return "gone";
        }
        return leadStopped ? "quiescent" : "running";
      },
      signalGeneration(expected, signal) {
        events.push(`${expected.pid}:${signal}`);
        if (expected.pid === leader.pid && signal === "SIGSTOP") {
          leadStopped = true;
        }
        if (expected.pid === leader.pid && signal === "SIGCONT") {
          leadStopped = false;
        }
        if (expected.pid === detached.pid && signal === "SIGKILL") {
          detachedKilled = true;
        }
        return true;
      },
    };

    await terminateSealedCleanupHandoff(
      {
        descriptorPath: "/tmp/dure-sealed-order.json",
        groupId: leader.groupId,
        leaderKernelStartMarker: leader.kernelStartMarker,
        leaderPid: leader.pid,
        leaderStartMarker: leader.startMarker,
        terminateDetachedOwnedGenerations: true,
      },
      { processes: [leader, detached] },
      processController,
      {
        DURE_QA_PROCESS_KILL_GRACE_MS: "1000",
        DURE_QA_PROCESS_TERM_GRACE_MS: "1000",
      },
      { waitForLeaderExit: false },
    );

    expect(events).toEqual([
      `${leader.pid}:SIGCONT`,
      `${detached.pid}:SIGKILL`,
      "detached-gone",
      `${leader.pid}:SIGKILL`,
    ]);
  });

  test("continues exact cleanup when the lead exits during resume", async () => {
    const leader = {
      groupId: 43_001,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:43001",
      parentPid: 40_001,
      pid: 43_001,
      sessionId: 43_001,
      startMarker: "ps-lstart-v1:leader",
    };
    const child = {
      groupId: leader.groupId,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:43002",
      parentPid: leader.pid,
      pid: 43_002,
      sessionId: leader.sessionId,
      startMarker: "ps-lstart-v1:child",
    };
    const events = [];
    let childLive = true;
    let leaderObserved = false;
    const processController = {
      generationState(expected) {
        if (expected.pid === leader.pid) {
          if (!leaderObserved) {
            leaderObserved = true;
            return "quiescent";
          }
          return "gone";
        }
        return childLive ? "quiescent" : "gone";
      },
      signalGeneration(expected, signal) {
        events.push(`${expected.pid}:${signal}`);
        if (expected.pid === child.pid) childLive = false;
        return true;
      },
    };

    await terminateSealedCleanupHandoff(
      {
        descriptorPath: "/tmp/dure-sealed-gone-during-resume.json",
        groupId: leader.groupId,
        leaderKernelStartMarker: leader.kernelStartMarker,
        leaderPid: leader.pid,
        leaderStartMarker: leader.startMarker,
        terminateDetachedOwnedGenerations: false,
      },
      { processes: [leader, child] },
      processController,
      {
        DURE_QA_PROCESS_KILL_GRACE_MS: "1000",
        DURE_QA_PROCESS_TERM_GRACE_MS: "1000",
      },
      { waitForLeaderExit: false },
    );

    expect(events).toEqual([
      `${leader.pid}:SIGCONT`,
      `${child.pid}:SIGKILL`,
    ]);
  });

  test("classifies absent legacy nonleaders before resuming the exact lead", async () => {
    const leader = {
      groupId: 44_001,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:44001",
      parentPid: 40_001,
      pid: 44_001,
      sessionId: 44_001,
      startMarker: "ps-lstart-v1:leader",
    };
    const legacy = {
      groupId: leader.groupId,
      kernelStartMarker: "kernel-start-v1:linux:999",
      parentPid: leader.pid,
      pid: 44_002,
      sessionId: leader.sessionId,
      startMarker: "ps-lstart-v1:legacy-child",
    };
    const events = [];
    let leaderRunning = false;
    const processController = {
      generationState(expected) {
        if (expected.pid === legacy.pid) return "gone";
        return leaderRunning ? "running" : "quiescent";
      },
      signalGeneration(expected, signal) {
        events.push(`${expected.pid}:${signal}`);
        if (expected.pid === legacy.pid) {
          throw new Error("legacy absence was reopened");
        }
        if (signal === "SIGCONT") leaderRunning = true;
        return true;
      },
    };

    await terminateSealedCleanupHandoff(
      {
        descriptorPath: "/tmp/dure-sealed-legacy-absent.json",
        groupId: leader.groupId,
        leaderKernelStartMarker: leader.kernelStartMarker,
        leaderPid: leader.pid,
        leaderStartMarker: leader.startMarker,
        terminateDetachedOwnedGenerations: false,
      },
      { processes: [leader, legacy] },
      processController,
      process.env,
      { waitForLeaderExit: false },
    );

    expect(events).toEqual([
      `${leader.pid}:SIGCONT`,
      `${leader.pid}:SIGKILL`,
    ]);
  });

  test("rejects a running sealed nonleader before resuming the lead", async () => {
    const leader = {
      groupId: 45_001,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:45001",
      parentPid: 40_001,
      pid: 45_001,
      sessionId: 45_001,
      startMarker: "ps-lstart-v1:leader",
    };
    const running = {
      ...leader,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:45002",
      parentPid: leader.pid,
      pid: 45_002,
      startMarker: "ps-lstart-v1:running-child",
    };
    const signalGeneration = vi.fn();

    await expect(
      terminateSealedCleanupHandoff(
        {
          descriptorPath: "/tmp/dure-sealed-running-child.json",
          groupId: leader.groupId,
          leaderKernelStartMarker: leader.kernelStartMarker,
          leaderPid: leader.pid,
          leaderStartMarker: leader.startMarker,
          terminateDetachedOwnedGenerations: false,
        },
        { processes: [leader, running] },
        {
          generationState(expected) {
            return expected.pid === running.pid ? "running" : "quiescent";
          },
          signalGeneration,
        },
      ),
    ).rejects.toThrow("sealed cleanup generation is no longer quiescent");
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("keeps retirement blocked until every sealed generation is gone", async () => {
    const kernelMarker = (id) =>
      process.platform === "darwin"
        ? `kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:${id}`
        : `kernel-start-v2:linux:test-boot:${id}`;
    const leader = {
      kernelStartMarker: kernelMarker(41_001),
      pid: 41_001,
    };
    const survivor = {
      kernelStartMarker: kernelMarker(41_002),
      pid: 41_002,
    };
    const live = new Set([survivor.pid]);
    const processController = {
      generationState: ({ pid }) => live.has(pid) ? "running" : "gone",
    };
    const frozen = { processes: [leader, survivor] };

    await expect(
      verifySealedCleanupHandoffExited(frozen, processController, 0),
    ).rejects.toThrow("sealed cleanup generations remain live: 41002");

    live.clear();
    await expect(
      verifySealedCleanupHandoffExited(frozen, processController, 0),
    ).resolves.toBeUndefined();
  });

  test.each(["promoted", "gone"])(
    "waits for delayed identity-only ownership to become %s in one handoff",
    async (settlement) => {
      const fixture = await createIdentityOnlySealFixture();
      let settlementTimer;

      try {
        const publishFrozen = vi.fn();
        let barriersBeforeSettlement = 0;
        settlementTimer = setTimeout(() => {
          barriersBeforeSettlement = fixture.barrier.mock.calls.length;
          if (settlement === "promoted") fixture.promote();
          else fixture.markGone();
        }, 60);
        const handoff = await fixture.monitor.sealCleanupHandoff(publishFrozen);

        expect(barriersBeforeSettlement).toBeGreaterThan(0);
        expect(fixture.barrier.mock.calls.length).toBeGreaterThan(
          barriersBeforeSettlement,
        );
        if (settlement === "promoted") {
          expect(
            fixture.processController.signalGeneration,
          ).toHaveBeenCalledWith(fixture.child, "SIGSTOP");
        } else {
          expect(
            fixture.processController.signalGeneration,
          ).not.toHaveBeenCalled();
        }
        expect(handoff.kind).toBe("sealed-cleanup-handoff");
        expect(handoff.frozen.processes.map(({ pid }) => pid)).toEqual(
          settlement === "promoted"
            ? [fixture.leader.pid, fixture.child.pid]
            : [fixture.leader.pid],
        );
        expect(publishFrozen).toHaveBeenCalledOnce();
        expect(publishFrozen).toHaveBeenCalledWith(handoff.frozen);
      } finally {
        clearTimeout(settlementTimer);
        await fixture.dispose();
      }
    },
  );

  test("observes identity-only promotion during the final deadline sleep", async () => {
    vi.useFakeTimers();
    let fixture;
    let settlementTimer;
    try {
      fixture = await createIdentityOnlySealFixture();
      const publishFrozen = vi.fn();
      // The one-second identity deadline's final pacing sleep begins at 980ms.
      settlementTimer = setTimeout(fixture.promote, 999);
      const handoffPromise = fixture.monitor.sealCleanupHandoff(publishFrozen);

      await vi.advanceTimersByTimeAsync(1_000);
      const handoff = await handoffPromise;

      expect(handoff.frozen.processes.map(({ pid }) => pid)).toEqual([
        fixture.leader.pid,
        fixture.child.pid,
      ]);
      expect(publishFrozen).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(settlementTimer);
      if (fixture) await fixture.dispose();
      vi.useRealTimers();
    }
  });

  test("fails closed after an unresolved identity-only settlement deadline", async () => {
    vi.useFakeTimers();
    let fixture;
    try {
      fixture = await createIdentityOnlySealFixture();
      const publishFrozen = vi.fn();
      const rejected = expect(
        fixture.monitor.sealCleanupHandoff(publishFrozen),
      ).rejects.toThrow(
        "live identity-only ownership remained unresolved while sealing cleanup handoff",
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;

      expect(publishFrozen).not.toHaveBeenCalled();
    } finally {
      if (fixture) await fixture.dispose();
      vi.useRealTimers();
    }
  });

  test("seal prevents later observer writers and stop census checkpoints", async () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-owned-sealed-ledger-"),
    );
    const descriptorPath = path.join(fixtureRoot, "group.json");
    const kernelMarker = (id) =>
      process.platform === "darwin"
        ? `kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:${id}`
        : `kernel-start-v2:linux:test-boot:${id}`;
    const kernelStartMarker = kernelMarker(41_001);
    const leader = {
      groupId: 41_001,
      kernelStartMarker,
      parentPid: 40_001,
      pid: 41_001,
      sessionId: 41_001,
      startMarker: "ps-lstart-v1:leader",
    };
    const descriptor = {
      descriptorPath,
      groupId: leader.groupId,
      leaderKernelStartMarker: leader.kernelStartMarker,
      leaderPid: leader.pid,
      leaderStartMarker: leader.startMarker,
      livenessWitnessVersion: "inherited-fd-v1",
      supervisorKernelStartMarker: kernelMarker(40_001),
      supervisorPid: leader.parentPid,
      supervisorStartMarker: "ps-lstart-v1:supervisor",
      terminateDetachedOwnedGenerations: false,
    };
    const readMembers = () => [
      {
        groupId: leader.groupId,
        parentPid: leader.parentPid,
        pid: leader.pid,
        processIdentity: exactOwnedProcessIdentity(leader).processIdentity,
        sessionId: leader.sessionId,
        startedAtUnixSeconds: 1_700_000_000,
        state: "live",
      },
    ];
    const observeMembers = vi.fn(observeMembersFrom(readMembers));
    const processController = { generationState: () => "running" };
    let observerCallbacks;
    const startNativeObserver = vi.fn((_descriptor, _known, callbacks) => {
      observerCallbacks = callbacks;
      return {
        barrier: vi.fn(async () => {}),
        ready: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
    });

    try {
      const monitor = await startOwnershipLedgerSampler(
        descriptor,
        [leader],
        true,
        { observeMembers, processController, startNativeObserver },
      );
      const handoff = await monitor.sealCleanupHandoff(() => {});
      expect(handoff.kind).toBe("sealed-cleanup-handoff");
      const censusCount = observeMembers.mock.calls.length;
      const ledger = `${descriptorPath}.ownership-ledger.json`;
      const sealedLedger = fs.readFileSync(ledger, "utf8");
      const sealedLedgerStat = fs.lstatSync(ledger);

      observerCallbacks.admit({
        ...leader,
        kernelStartMarker: kernelMarker(41_002),
        parentPid: leader.pid,
        pid: 41_002,
        startMarker: "ps-lstart-v1:late",
      });
      observerCallbacks.fail(new Error("late observer failure"));
      await monitor.stop();

      expect(observeMembers).toHaveBeenCalledTimes(censusCount);
      expect(fs.readFileSync(ledger, "utf8")).toBe(sealedLedger);
      const ledgerStat = fs.lstatSync(ledger);
      expect([ledgerStat.dev, ledgerStat.ino]).toEqual([
        sealedLedgerStat.dev,
        sealedLedgerStat.ino,
      ]);
      expect(
        fs.existsSync(`${descriptorPath}.ownership-ledger-deltas-v1`),
      ).toBe(false);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("does not overwrite an invalidated ledger when an in-flight sample completes", async () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-owned-sample-race-"),
    );
    const descriptorPath = path.join(fixtureRoot, "group.json");
    const kernelMarker = (id) =>
      process.platform === "darwin"
        ? `kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:${id}`
        : `kernel-start-v2:linux:test-boot:${id}`;
    const leader = {
      groupId: 51_001,
      kernelStartMarker: kernelMarker(51_001),
      parentPid: 50_001,
      pid: 51_001,
      sessionId: 51_001,
      startMarker: "ps-lstart-v1:leader",
    };
    const commandGate = {
      groupId: leader.groupId,
      kernelStartMarker: kernelMarker(51_002),
      parentPid: leader.pid,
      pid: 51_002,
      sessionId: leader.sessionId,
      startMarker: "ps-lstart-v1:command-gate",
    };
    const descriptor = {
      descriptorPath,
      groupId: leader.groupId,
      leaderKernelStartMarker: leader.kernelStartMarker,
      leaderPid: leader.pid,
      leaderStartMarker: leader.startMarker,
      livenessWitnessVersion: "inherited-fd-v1",
      supervisorKernelStartMarker: kernelMarker(leader.parentPid),
      supervisorPid: leader.parentPid,
      supervisorStartMarker: "ps-lstart-v1:supervisor",
      terminateDetachedOwnedGenerations: false,
    };
    const members = [leader, commandGate].map((owned) => ({
      groupId: owned.groupId,
      parentPid: owned.parentPid,
      pid: owned.pid,
      processIdentity: exactOwnedProcessIdentity(owned).processIdentity,
      sessionId: owned.sessionId,
      startedAtUnixSeconds: 1_700_000_000,
      state: "live",
    }));
    const completeObservation = observeMembersFrom(() => members);
    let observationCount = 0;
    let releaseObservation;
    let reportBlocked;
    const observationBlocked = new Promise((resolve) => {
      reportBlocked = resolve;
    });
    const observationReleased = new Promise((resolve) => {
      releaseObservation = resolve;
    });
    const observeMembers = vi.fn(async (request) => {
      observationCount += 1;
      if (observationCount === 4) {
        reportBlocked();
        await observationReleased;
      }
      return completeObservation(request);
    });
    const failure = new Error("injected in-flight sampler invalidation");
    let monitor;

    try {
      monitor = await startOwnershipLedgerSampler(
        descriptor,
        [leader, commandGate],
        true,
        {
          observeMembers,
          processController: {},
          startNativeObserver: null,
        },
      );
      await observationBlocked;
      monitor.invalidate(failure);
      const ledgerPath = `${descriptorPath}.ownership-ledger.json`;
      const invalidatedLedger = fs.readFileSync(ledgerPath, "utf8");
      expect(JSON.parse(invalidatedLedger)).toMatchObject({
        failureReason: failure.message,
        healthy: false,
      });
      expect(() => monitor.assertHealthy()).toThrow(failure.message);

      releaseObservation();
      await expect(
        monitor.admitCommandGate(commandGate),
      ).rejects.toThrow(failure.message);
      expect(() => monitor.assertHealthy()).toThrow(failure.message);
      expect(fs.readFileSync(ledgerPath, "utf8")).toBe(invalidatedLedger);
    } finally {
      releaseObservation?.();
      if (monitor) await monitor.stop().catch(() => {});
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("keeps a stopped ownership monitor immutable", async () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-owned-stopped-ledger-"),
    );
    const descriptorPath = path.join(fixtureRoot, "group.json");
    const kernelMarker = process.platform === "darwin"
      ? "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:61001"
      : "kernel-start-v2:linux:test-boot:61001";
    const leader = {
      groupId: 61_001,
      kernelStartMarker: kernelMarker,
      parentPid: 60_001,
      pid: 61_001,
      sessionId: 61_001,
      startMarker: "ps-lstart-v1:leader",
    };
    const descriptor = {
      descriptorPath,
      groupId: leader.groupId,
      leaderKernelStartMarker: leader.kernelStartMarker,
      leaderPid: leader.pid,
      leaderStartMarker: leader.startMarker,
      livenessWitnessVersion: "inherited-fd-v1",
      supervisorKernelStartMarker: process.platform === "darwin"
        ? "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:60001"
        : "kernel-start-v2:linux:test-boot:60001",
      supervisorPid: leader.parentPid,
      supervisorStartMarker: "ps-lstart-v1:supervisor",
      terminateDetachedOwnedGenerations: false,
    };
    const member = {
      groupId: leader.groupId,
      parentPid: leader.parentPid,
      pid: leader.pid,
      processIdentity: exactOwnedProcessIdentity(leader).processIdentity,
      sessionId: leader.sessionId,
      startedAtUnixSeconds: 1_700_000_000,
      state: "live",
    };

    try {
      const monitor = await startOwnershipLedgerSampler(
        descriptor,
        [leader],
        false,
        {
          observeMembers: observeMembersFrom(() => [member]),
          processController: {},
        },
      );
      await monitor.stop();
      const ledgerPath = `${descriptorPath}.ownership-ledger.json`;
      const stoppedLedger = fs.readFileSync(ledgerPath, "utf8");

      monitor.invalidate(new Error("late invalidation"));

      expect(() => monitor.assertHealthy()).not.toThrow();
      expect(fs.readFileSync(ledgerPath, "utf8")).toBe(stoppedLedger);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("seal rollback resumes its journaled stops without reopening state", async () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-owned-seal-rollback-"),
    );
    const descriptorPath = path.join(fixtureRoot, "group.json");
    const marker = (id) =>
      `kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:${id}`;
    const leader = {
      groupId: 62_001,
      kernelStartMarker: marker(62_001),
      parentPid: 60_001,
      pid: 62_001,
      sessionId: 62_001,
      startMarker: "ps-lstart-v1:leader",
    };
    const child = {
      ...leader,
      kernelStartMarker: marker(62_002),
      parentPid: leader.pid,
      pid: 62_002,
      startMarker: "ps-lstart-v1:child",
    };
    const descriptor = {
      descriptorPath,
      groupId: leader.groupId,
      leaderKernelStartMarker: leader.kernelStartMarker,
      leaderPid: leader.pid,
      leaderStartMarker: leader.startMarker,
      livenessWitnessVersion: "inherited-fd-v1",
      supervisorKernelStartMarker: marker(leader.parentPid),
      supervisorPid: leader.parentPid,
      supervisorStartMarker: "ps-lstart-v1:supervisor",
      terminateDetachedOwnedGenerations: false,
    };
    const states = new Map([
      [leader.pid, "running"],
      [child.pid, "running"],
    ]);
    const members = [leader, child].map((owned) => ({
      groupId: owned.groupId,
      parentPid: owned.parentPid,
      pid: owned.pid,
      processIdentity: exactOwnedProcessIdentity(owned).processIdentity,
      sessionId: owned.sessionId,
      startedAtUnixSeconds: 1_700_000_000,
      state: "live",
    }));
    const signals = [];
    let stateUnavailable = false;
    let monitor;

    try {
      monitor = await startOwnershipLedgerSampler(
        descriptor,
        [leader, child],
        false,
        {
          observeMembers: observeMembersFrom(() => members),
          processController: {
            generationState(expected) {
              if (stateUnavailable) {
                throw new Error("injected seal state outage");
              }
              return states.get(expected.pid);
            },
            signalGeneration(expected, signal) {
              signals.push([expected.pid, signal]);
              states.set(
                expected.pid,
                signal === "SIGSTOP" ? "quiescent" : "running",
              );
              return true;
            },
          },
        },
      );

      await expect(
        monitor.sealCleanupHandoff(() => {
          stateUnavailable = true;
          throw new Error("injected seal publication failure");
        }),
      ).rejects.toThrow("injected seal publication failure");

      expect(signals).toEqual([
        [child.pid, "SIGSTOP"],
        [child.pid, "SIGCONT"],
      ]);
      expect(states.get(child.pid)).toBe("running");
    } finally {
      stateUnavailable = false;
      if (monitor) await monitor.stop().catch(() => {});
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("transfers cleanup without poisoning a sealed ownership monitor", async () => {
    const cleanupFailure = new Error("injected cleanup failure");
    const ownershipMonitor = {
      invalidate: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const handoff = await stopOwnershipMonitorThenHandoffOnTerminationFailure(
      ownershipMonitor,
      async () => {
        throw cleanupFailure;
      },
      { frozen: {}, kind: "sealed-cleanup-handoff" },
    );

    expect(handoff).toBeInstanceOf(OwnedProcessCleanupHandoffError);
    expect(handoff).toMatchObject({
      cause: cleanupFailure,
      kind: "owned-process-cleanup-handoff",
      name: "OwnedProcessCleanupHandoffError",
    });
    expect(ownershipMonitor.stop).toHaveBeenCalledOnce();
    expect(ownershipMonitor.invalidate).not.toHaveBeenCalled();
  });

  test("keeps overlapping monitor and termination failures guardian-owned without a sealed snapshot", async () => {
    const monitorFailure = new Error("injected monitor failure");
    const terminationFailure = new Error("injected termination failure");
    const failure = await stopOwnershipMonitorThenHandoffOnTerminationFailure(
      {
        stop: vi.fn(async () => {
          throw monitorFailure;
        }),
      },
      async () => {
        throw terminationFailure;
      },
    ).catch((error) => error);

    expect(failure).not.toBeInstanceOf(OwnedProcessCleanupHandoffError);
    expect(failure).toMatchObject({
      errors: [monitorFailure, terminationFailure],
      message: expect.stringContaining(
        "ownership monitor and termination both failed",
      ),
    });
  });

  test("keeps monitor failure guardian-owned after exact termination succeeds", async () => {
    const monitorFailure = new Error("injected monitor failure");
    const ownershipMonitor = {
      stop: vi.fn(async () => {
        throw monitorFailure;
      }),
    };
    const terminate = vi.fn(async () => {});
    await expect(
      stopOwnershipMonitorThenHandoffOnTerminationFailure(
        ownershipMonitor,
        terminate,
      ),
    ).rejects.toBe(monitorFailure);
    expect(terminate).toHaveBeenCalledWith(monitorFailure);
  });

  test("disconnects and unreferences the exact lead after supervisor uncertainty", () => {
    const channel = { unref: vi.fn() };
    const witness = { unref: vi.fn() };
    const child = {
      channel,
      connected: true,
      disconnect: vi.fn(),
      stdio: [undefined, undefined, undefined, witness],
      unref: vi.fn(),
    };

    releaseLeadForCleanupHandoff(child);

    expect(channel.unref).toHaveBeenCalledOnce();
    expect(witness.unref).toHaveBeenCalledOnce();
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  test("still unreferences a lead whose IPC already closed", () => {
    const child = {
      connected: false,
      disconnect: vi.fn(),
      unref: vi.fn(),
    };

    releaseLeadForCleanupHandoff(child);

    expect(child.disconnect).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  test.runIf(["darwin", "linux"].includes(process.platform)).each([
    [
      "owner-loss sealing leaves a detached generation runnable after authority refusal",
      "run",
    ],
    ...(process.platform === "linux"
      ? [
          [
            "Linux owner-loss sealing leaves detached generations runnable without hard containment",
            "run-observed",
          ],
        ]
      : []),
  ])("%s", async (_name, operation) => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-owned-detached-seal-"),
      );
      const descriptorPath = path.join(fixtureRoot, "group.json");
      const commandCapture = path.join(fixtureRoot, "command.json");
      const supervisorCapture = path.join(fixtureRoot, "supervisor.pid");
      const commandSource = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        "const capture = process.argv[1];",
        'const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 300000)"], { detached: true, stdio: "ignore" });',
        "detached.unref();",
        "fs.writeFileSync(capture, JSON.stringify({ commandPid: process.pid, detachedPid: detached.pid }));",
        "setInterval(() => {}, 300000);",
      ].join("\n");
      const ownerSource = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        "const [runner, operation, descriptor, commandSource, commandCapture, supervisorCapture] = process.argv.slice(1);",
        'const supervisor = spawn(process.execPath, [runner, operation, descriptor, "--", process.execPath, "-e", commandSource, commandCapture], { env: process.env, stdio: ["ignore", "ignore", "inherit"] });',
        "fs.writeFileSync(supervisorCapture, String(supervisor.pid));",
        "setInterval(() => {}, 300000);",
      ].join("\n");
      let stderr = "";
      const owner = spawn(
        process.execPath,
        [
          "-e",
          ownerSource,
          OWNED_PROCESS_GROUP_MODULE,
          operation,
          descriptorPath,
          commandSource,
          commandCapture,
          supervisorCapture,
        ],
        {
          env: {
            ...process.env,
            DURE_QA_TEST_OWNER_LOSS_TERMINATION_FAILURE: "1",
            NODE_ENV: "test",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      owner.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });
      const ownerClosed = new Promise((resolve) => owner.once("close", resolve));
      let detachedGeneration;
      try {
        await waitForCondition(
          () =>
            fs.existsSync(descriptorPath) &&
            fs.existsSync(commandCapture) &&
            fs.existsSync(supervisorCapture),
        );
        const descriptor = readOwnedProcessGroup(descriptorPath);
        const capture = JSON.parse(fs.readFileSync(commandCapture, "utf8"));
        let owned = [];
        await waitForCondition(() => {
          owned = readOwnedProcessLedgerForCleanup(descriptor);
          return owned.some(({ pid }) => pid === capture.detachedPid);
        });
        const commandGeneration = owned.find(
          ({ pid }) => pid === capture.commandPid,
        );
        detachedGeneration = owned.find(
          ({ pid }) => pid === capture.detachedPid,
        );
        expect(commandGeneration).toBeDefined();
        expect(detachedGeneration).toBeDefined();
        expect(detachedGeneration.groupId).not.toBe(descriptor.groupId);

        owner.kill("SIGKILL");
        await waitForCondition(() => owner.signalCode === "SIGKILL");
        await waitForCondition(() =>
          stderr.includes(
            "termination failed before cleanup handoff could be sealed",
          ),
        );

        const commandIdentity = exactOwnedProcessIdentity(commandGeneration);
        const detachedIdentity = exactOwnedProcessIdentity(detachedGeneration);
        const observation = processMemberSnapshots([
          commandIdentity.pid,
          detachedIdentity.pid,
        ]);
        const command = processMemberFromObservation(
          commandIdentity.pid,
          observation,
        );
        const detached = processMemberFromObservation(
          detachedIdentity.pid,
          observation,
        );
        if (descriptor.terminateDetachedOwnedGenerations) {
          expect(command.status, stderr).toBe("present");
          expect(command.member?.state, stderr).toBe("live");
          expect(
            processLivenessFromObservation(commandIdentity, observation),
          ).toBe("active");
        }
        expect(detached.status, stderr).toBe("present");
        expect(detached.member?.state, stderr).toBe("live");
        expect(
          processLivenessFromObservation(detachedIdentity, observation),
        ).toBe("active");
        expect(
          fs.existsSync(`${descriptorPath}.cleanup-handoff-frozen-v1.json`),
        ).toBe(false);
        expect(stderr).not.toContain(
          "exact successor completed cleanup after supervisor uncertainty",
        );
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) {
          owner.kill("SIGKILL");
        }
        if (detachedGeneration) {
          signalProcessGenerationSync(
            exactOwnedProcessIdentity(detachedGeneration),
            "SIGKILL",
          );
        }
        if (fs.existsSync(descriptorPath)) {
          const descriptor = readOwnedProcessGroup(descriptorPath);
          const cleanup = spawnSync(
            process.execPath,
            [
              OWNED_PROCESS_GROUP_MODULE,
              descriptor.terminateDetachedOwnedGenerations
                ? "terminate"
                : "complete",
              descriptorPath,
              String(descriptor.supervisorPid),
            ],
            { encoding: "utf8", timeout: 15_000 },
          );
          if (cleanup.status !== 0 || cleanup.signal !== null) {
            throw new Error(
              `detached seal fixture cleanup failed: ${cleanup.stderr}`,
            );
          }
        }
        await ownerClosed;
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
  }, 30_000);
});

describe("Dure QA environment migration", () => {
  test("prefers Dure values and treats an empty canonical value as unset", () => {
    expect(
      qaEnvironmentValue(
        {
          DURE_QA_SAMPLE: "canonical",
          HEBBIAN_QA_SAMPLE: "legacy",
        },
        "SAMPLE",
      ),
    ).toBe("canonical");
    expect(
      qaEnvironmentValue(
        { DURE_QA_SAMPLE: "", HEBBIAN_QA_SAMPLE: "legacy" },
        "SAMPLE",
      ),
    ).toBe("legacy");
  });
});

test.runIf(process.platform === "darwin" || process.platform === "linux")(
  "converts owned records into canonical identity observations",
  async () => {
    const generation = await observeExactProcessGeneration(process.pid);
    expect(generation).toBeDefined();
    if (process.platform === "linux") {
      expect(generation.kernelStartMarker).toMatch(
        /^kernel-start-v2:linux:[^:\s]+:\d+$/u,
      );
    }
    const identity = exactOwnedProcessIdentity(generation);
    const observation = processMemberSnapshots([identity.pid]);
    expect(processLivenessFromObservation(identity, observation)).toBe(
      "active",
    );
    const staleIdentity = identity.processIdentity.replace(
      /(\d+)$/u,
      (_value, number) => String(BigInt(number) + 1n),
    );
    expect(
      processLivenessFromObservation(
        { ...identity, processIdentity: staleIdentity },
        observation,
      ),
    ).toBe("stale");
  },
);

describe("owned process startup handshake", () => {
  const message = {
    groupId: 41_001,
    kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9007199254740993",
    kind: "leader-identity",
    parentPid: 40_000,
    pid: 41_001,
    schema: "owned-process-startup-v1",
    sessionId: 0,
    startMarker: "ps-lstart-v1:Tue Nov 14 22:13:20 2023",
  };

  test("accepts an exact self-grouped leader identity", () => {
    expect(startupLeaderFromMessage(message, 41_001)).toEqual({
      groupId: 41_001,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9007199254740993",
      parentPid: 40_000,
      pid: 41_001,
      sessionId: 0,
      startMarker: "ps-lstart-v1:Tue Nov 14 22:13:20 2023",
    });
  });

  test("rejects a stale or non-leader startup identity", () => {
    expect(() =>
      startupLeaderFromMessage(message, 41_002),
    ).toThrow("invalid startup leader handshake");
    expect(() =>
      startupLeaderFromMessage(
        { ...message, groupId: 50_000 },
        41_001,
      ),
    ).toThrow("startup leader is not its process-group leader");
  });

  test("rejects a bootless generation at the startup boundary", () => {
    expect(() =>
      startupLeaderFromMessage(
        {
          ...message,
          kernelStartMarker: "kernel-start-v1:linux:101",
        },
        message.pid,
      ),
    ).toThrow(
      "legacy Linux process generation cannot authorize startup identity",
    );
  });
});

describe("owned process generation signaling", () => {
  test("does not signal a replacement that copies the same second-resolution marker", () => {
    const signalGeneration = vi.fn();
    const expected = {
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9007199254740993",
      pid: 41001,
      startMarker: "ps-lstart-v1:Tue Nov 14 22:13:20 2023",
    };

    expect(() =>
      signalExactProcess(expected, "SIGSTOP", {
        member: {
          groupId: 41001,
          parentPid: 1,
          pid: 41001,
          processIdentity:
            "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9007199254740994",
          sessionId: 41001,
          startedAtUnixSeconds: 1_700_000_000,
          state: "live",
        },
        signalGeneration,
      }),
    ).toThrow("refusing to signal a reused process generation");
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("rejects an invalid legacy macOS marker", () => {
    expect(() =>
      signalExactProcess(
        {
          kernelStartMarker: "kernel-start-v2:macos:100",
          pid: 41001,
          startMarker: "ps-lstart-v1:Tue Nov 14 22:13:20 2023",
        },
        "SIGSTOP",
        {
          member: null,
          signalGeneration: vi.fn(),
        },
      ),
    ).toThrow("invalid kernel process start marker");
  });

  test("does not turn a bootless Linux marker into destructive authority", () => {
    const signalGeneration = vi.fn();
    const expected = {
      kernelStartMarker: "kernel-start-v1:linux:101",
      pid: 41001,
      startMarker: "ps-lstart-v1:Tue Nov 14 22:13:20 2023",
    };

    expect(() =>
      signalExactProcess(expected, "SIGSTOP", {
        member: null,
        signalGeneration,
      }),
    ).toThrow("legacy Linux process generation cannot authorize a signal");
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("lets a reused PID depart a bootless persisted generation", () => {
    const persisted = {
      groupId: 41_001,
      kernelStartMarker: "kernel-start-v1:linux:101",
      parentPid: 1,
      pid: 41_001,
      sessionId: 41_001,
      startMarker: "ps-lstart-v1:legacy",
    };
    const member = {
      groupId: persisted.groupId,
      parentPid: persisted.parentPid,
      pid: persisted.pid,
      processIdentity: "linux:current-boot:102",
      sessionId: persisted.sessionId,
      startedAtUnixSeconds: 1_700_000_000,
      state: "live",
    };

    expect(
      ownedProcessClosure(
        persisted.groupId,
        [member],
        [persisted],
        { seedProcessGroup: false },
      ),
    ).toEqual([]);
    expect(() =>
      ownedProcessClosure(
        persisted.groupId,
        [{ ...member, processIdentity: "linux:current-boot:101" }],
        [persisted],
        { seedProcessGroup: false },
      ),
    ).toThrow(
      "legacy Linux process generation cannot authorize ownership discovery",
    );
  });

  test("does not signal the same Linux pid and ticks from another boot", () => {
    const signalGeneration = vi.fn();
    const expected = {
      kernelStartMarker: "kernel-start-v2:linux:boot-a:101",
      pid: 41001,
      startMarker: "ps-lstart-v1:Tue Nov 14 22:13:20 2023",
    };

    expect(() =>
      signalExactProcess(expected, "SIGSTOP", {
        member: {
          groupId: expected.pid,
          parentPid: 1,
          pid: expected.pid,
          processIdentity: "linux:boot-b:101",
          sessionId: expected.pid,
          startedAtUnixSeconds: 1_700_000_000,
          state: "live",
        },
        signalGeneration,
      }),
    ).toThrow("refusing to signal a reused process generation");
    expect(signalGeneration).not.toHaveBeenCalled();
  });
});

describe("frozen process command delivery", () => {
  async function command(root, operation, supervisorPid, snapshotPath, preload) {
    const child = spawn(process.execPath, [
      ...(preload ? ["--import", preload] : []),
      OWNED_PROCESS_GROUP_MODULE, operation, path.join(root, "group.json"),
      String(supervisorPid), ...(snapshotPath ? [snapshotPath] : []),
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH, HOME: root, DURE_HOME: path.join(root, ".dure"),
        HMUX_DISCOVERY_ROOT: path.join(root, "hmux-discovery"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return { ...outcome, output };
  }

  test.runIf(process.platform === "darwin").each([
    "second census unavailable", "duplicate delivery", "lost response",
    "malformed request", "conflicting request", "unknown point observation",
    "temporary publication collision",
  ])("preserves exact cleanup authority with %s", async (scenario) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dure-frozen-command-"));
    fs.mkdirSync(path.join(root, "hmux-discovery"));
    fs.writeFileSync(path.join(root, "worker.mjs"), [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const root = process.env.DURE_QA_STATE_ROOT;',
      'if (process.argv[2] === "detached") {',
      '  fs.writeFileSync(path.join(root, "detached.pid"), String(process.pid));',
      '} else {',
      '  spawn(process.execPath, [process.argv[1], "detached"], { detached: true, stdio: ["ignore", "ignore", "inherit", Number(process.env.DURE_QA_LIVENESS_WITNESS_FD ?? process.env.HEBBIAN_QA_LIVENESS_WITNESS_FD)] }).unref();',
      '}',
      'setInterval(() => {}, 300000);',
    ].join("\n"));
    const supervisor = spawn(process.execPath, [
      "--experimental-test-module-mocks",
      fileURLToPath(new URL("./owned-process-frozen-command-fixture.mjs", import.meta.url)),
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        HOME: root, DURE_HOME: path.join(root, ".dure"),
        HMUX_DISCOVERY_ROOT: path.join(root, "hmux-discovery"),
        DURE_QA_STATE_ROOT: root,
        DURE_QA_FROZEN_POINT_FAILURE: scenario === "unknown point observation" ? "1" : "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let supervisorOutput = "";
    let outcome;
    supervisor.stderr.on("data", (data) => { supervisorOutput = `${supervisorOutput}${data}`.slice(-32000); });
    supervisor.once("exit", (code, signal) => { outcome = { code, signal }; });
    const descriptorPath = path.join(root, "group.json");
    const snapshotPath = path.join(root, "frozen.json");
    const requestPath = `${descriptorPath}.termination-frozen-v1.json`;
    let descriptor;
    let frozen;
    let injectedRequest = false;
    let requests;
    let originalExitProof;
    try {
      await waitForCondition(() => {
        if (outcome) throw new Error(`supervisor exited before readiness: ${JSON.stringify(outcome)} ${supervisorOutput}`);
        if (!fs.existsSync(descriptorPath) || !fs.existsSync(path.join(root, "detached.pid"))) return false;
        descriptor = readOwnedProcessGroup(descriptorPath, supervisor.pid);
        const detachedPid = Number(fs.readFileSync(path.join(root, "detached.pid"), "utf8"));
        return readOwnedProcessLedger(descriptor).some(({ pid }) => pid === detachedPid);
      });
      frozen = await command(root, "freeze", supervisor.pid, snapshotPath);
      expect(frozen.code, frozen.output).toBe(0);
      fs.writeFileSync(path.join(root, "refuse-observation"), "refuse\n");
      if (scenario === "temporary publication collision") {
        const preload = path.join(root, "publication-collision.mjs");
        fs.writeFileSync(preload, [
          'import fs from "node:fs";',
          `const temporary = ${JSON.stringify(requestPath)} + "." + process.pid + ".tmp";`,
          'fs.writeFileSync(temporary, "existing publication", { flag: "wx", mode: 0o600 });',
          `fs.writeFileSync(${JSON.stringify(path.join(root, "colliding-publication.path"))}, temporary);`,
        ].join("\n"));
        requests = [await command(root, "terminate-frozen", supervisor.pid, snapshotPath, preload)];
        expect(requests[0].code).not.toBe(0);
        const temporary = fs.readFileSync(path.join(root, "colliding-publication.path"), "utf8");
        expect(fs.existsSync(temporary)).toBe(true);
        expect(fs.readFileSync(temporary, "utf8")).toBe("existing publication");
        expect(outcome).toBeUndefined();
      } else if (scenario === "malformed request" || scenario === "conflicting request") {
        const request = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        if (scenario === "malformed request") request.supervisorKernelStartMarker = descriptor.leaderKernelStartMarker;
        else request.processes.pop();
        fs.writeFileSync(requestPath, JSON.stringify(request), { flag: "wx", mode: 0o600 });
        injectedRequest = true;
        const before = fs.readFileSync(requestPath, "utf8");
        requests = [await command(root, "terminate-frozen", supervisor.pid, snapshotPath)];
        expect(requests[0].code).not.toBe(0);
        expect(requests[0].output).toContain(scenario === "malformed request" ? "invalid frozen process tree" : "conflicting frozen termination request");
        expect(fs.readFileSync(requestPath, "utf8")).toBe(before);
        expect(outcome).toBeUndefined();
      } else {
        const request = () => command(root, "terminate-frozen", supervisor.pid, snapshotPath);
        if (scenario === "duplicate delivery") requests = await Promise.all([request(), request()]);
        else if (scenario === "lost response") {
          // Lose the first completed client's response, not its operation identity.
          await request();
          requests = [await request()];
        } else requests = [await request()];
        await waitForCondition(() => outcome !== undefined);
        originalExitProof = await command(root, "verify-exited", supervisor.pid);
        if (scenario === "unknown point observation") {
          expect(outcome.code).toBe(97);
          expect(originalExitProof.code).not.toBe(0);
          expect(supervisorOutput).toContain("injected frozen point refusal");
        } else {
          expect(requests.every(({ code }) => code === 0), JSON.stringify(requests)).toBe(true);
          expect(outcome.code, supervisorOutput).toBe(143);
          expect(originalExitProof.code, originalExitProof.output).toBe(0);
        }
        expect(fs.existsSync(path.join(root, "refused-censuses.log"))).toBe(false);
      }
    } finally {
      fs.writeFileSync(path.join(root, "behavior.json"), JSON.stringify({ scenario, requests, outcome, originalExitProof, supervisorOutput }, null, 2));
      if (descriptor) {
        const expected = readOwnedProcessLedgerForCleanup(descriptor).map(exactOwnedProcessIdentity);
        const observation = processMemberSnapshots([descriptor.supervisorPid, ...expected.map(({ pid }) => pid)]);
        fs.writeFileSync(path.join(root, "cleanup-observation.json"), JSON.stringify({ descriptor, expected, observation, cwd: root, executable: process.execPath }, null, 2));
        if (injectedRequest) fs.renameSync(requestPath, path.join(root, "rejected-request.json"));
        const retired = await command(root, frozen?.code === 0 ? "terminate-frozen" : "terminate", supervisor.pid, frozen?.code === 0 ? snapshotPath : undefined);
        const exitProof = await command(root, "verify-exited", supervisor.pid);
        fs.writeFileSync(path.join(root, "cleanup-result.json"), JSON.stringify({ retired, exitProof }, null, 2));
        expect(retired.code, retired.output).toBe(0);
        expect(exitProof.code, exitProof.output).toBe(0);
      }
      console.info(`Retained frozen command evidence: ${root}`);
    }
  });
});

describe("owned process tree teardown", () => {
  const groupId = 41_001;
  const descriptor = {
    descriptorPath: "/tmp/owned-group.json",
    groupId,
    leaderKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:101",
    leaderPid: groupId,
    leaderStartMarker: "ps-lstart-v1:leader",
    livenessWitnessVersion: "inherited-fd-v1",
    supervisorKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:100",
    supervisorPid: 40_001,
    supervisorStartMarker: "ps-lstart-v1:supervisor",
  };
  const leader = {
    groupId,
    kernelStartMarker: descriptor.leaderKernelStartMarker,
    parentPid: 40_001,
    pid: groupId,
    sessionId: groupId,
    startMarker: descriptor.leaderStartMarker,
  };
  const child = {
    groupId,
    kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:102",
    parentPid: 1,
    pid: 41_002,
    sessionId: groupId,
    startMarker: "ps-lstart-v1:child",
  };
  const processMember = (process, state = "stopped") => ({
    groupId: process.groupId,
    parentPid: process.parentPid,
    pid: process.pid,
    processIdentity: exactOwnedProcessIdentity(process).processIdentity,
    sessionId: process.sessionId,
    startedAtUnixSeconds: 1_700_000_000,
    state,
  });

  function writeFrozenCapacityFixture(processCount) {
    const fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-frozen-capacity-"),
    );
    const snapshotPath = path.join(fixtureRoot, "frozen.json");
    const processes = Array.from({ length: processCount }, (_, index) => ({
      groupId,
      kernelStartMarker: `kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:${100_000 + index}`,
      parentPid: groupId,
      pid: 1_000_000 + index,
      sessionId: groupId,
      startMarker: `ps-lstart-v1:cold-build-${index}`,
    }));
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify({
        groupId,
        leaderKernelStartMarker: descriptor.leaderKernelStartMarker,
        leaderPid: descriptor.leaderPid,
        leaderStartMarker: descriptor.leaderStartMarker,
        livenessWitnessVersion: descriptor.livenessWitnessVersion,
        processes,
        schemaVersion: 1,
        supervisorKernelStartMarker:
          descriptor.supervisorKernelStartMarker,
        supervisorPid: descriptor.supervisorPid,
        supervisorStartMarker: descriptor.supervisorStartMarker,
        terminateDetachedOwnedGenerations: false,
      }),
    );
    return { fixtureRoot, snapshotPath };
  }

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "refuses the caller process group from the canonical self observation",
    async () => {
      const caller = observeExactProcessGeneration(process.pid);
      expect(caller).toBeDefined();

      await expect(
        freezeOwnedProcessTree({
          descriptorPath: "/tmp/dure-caller-process-group.json",
          groupId: caller.groupId,
          leaderKernelStartMarker: caller.kernelStartMarker,
          leaderPid: caller.pid,
          leaderStartMarker: caller.startMarker,
          supervisorStartMarker: caller.startMarker,
          terminateDetachedOwnedGenerations: false,
        }),
      ).rejects.toThrow("refusing to signal the caller process group");
    },
  );

  test("accepts the 7,959-generation frozen ledger from the cold-build incident", () => {
    const fixture = writeFrozenCapacityFixture(7_959);
    try {
      expect(
        readFrozenProcessTree(fixture.snapshotPath, descriptor).processes,
      ).toHaveLength(7_959);
    } finally {
      fs.rmSync(fixture.fixtureRoot, { force: true, recursive: true });
    }
  });

  test("rejects a frozen ledger above the exact-generation capacity", () => {
    const fixture = writeFrozenCapacityFixture(
      OWNED_PROCESS_GENERATION_LIMIT + 1,
    );
    try {
      expect(() =>
        readFrozenProcessTree(fixture.snapshotPath, descriptor),
      ).toThrow(
        `count=${OWNED_PROCESS_GENERATION_LIMIT + 1}; ` +
          `limit=${OWNED_PROCESS_GENERATION_LIMIT}`,
      );
    } finally {
      fs.rmSync(fixture.fixtureRoot, { force: true, recursive: true });
    }
  });

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "freezes and terminates an exact native generation through the canonical boundary",
    async () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-native-owned-freeze-"),
      );
      const descriptorPath = path.join(fixtureRoot, "group.json");
      const owned = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 300000)"],
        { detached: true, stdio: "ignore" },
      );
      let closed = false;
      const ownedClosed = new Promise((resolve) => {
        owned.once("close", () => {
          closed = true;
          resolve();
        });
      });

      try {
        await new Promise((resolve, reject) => {
          owned.once("spawn", resolve);
          owned.once("error", reject);
        });
        let generation;
        let supervisor;
        await waitForCondition(() => {
          generation = observeExactProcessGeneration(owned.pid);
          supervisor = observeExactProcessGeneration(process.pid);
          return generation !== undefined && supervisor !== undefined;
        });
        const nativeDescriptor = {
          descriptorPath,
          groupId: generation.groupId,
          leaderKernelStartMarker: generation.kernelStartMarker,
          leaderPid: generation.pid,
          leaderStartMarker: generation.startMarker,
          livenessWitnessVersion: "inherited-fd-v1",
          supervisorKernelStartMarker: supervisor.kernelStartMarker,
          supervisorPid: supervisor.pid,
          supervisorStartMarker: supervisor.startMarker,
          terminateDetachedOwnedGenerations: false,
        };
        const frozen = await freezeOwnedProcessTree(nativeDescriptor, {
          readLedger: () => [generation],
        });
        expect(frozen.processes.map(({ pid }) => pid)).toEqual([owned.pid]);
        expect(
          processMemberFromObservation(
            owned.pid,
            processMemberSnapshots([owned.pid]),
          ),
        ).toMatchObject({ member: { state: "stopped" }, status: "present" });

        await terminateFrozenOwnedProcessTree(nativeDescriptor, frozen);
        await ownedClosed;
        expect(owned.signalCode).toBe("SIGKILL");
        await waitForCondition(
          () =>
            processMemberFromObservation(
              owned.pid,
              processMemberSnapshots([owned.pid]),
            ).status === "departed",
        );
      } finally {
        if (!closed) {
          owned.kill("SIGKILL");
          await ownedClosed;
        }
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
    30_000,
  );

  test("retains the native cause when historical observation prevents cleanup", async () => {
    const signalGeneration = vi.fn();
    const publishFrozen = vi.fn();
    const diagnostic =
      "native process observation failed (status=15, stderr=proc_bsdinfo pid=41002 errno=1)";
    const observeCurrent = observeMembersFrom(() => []);
    await expect(
      freezeOwnedProcessTree(descriptor, {
        observeMembers: async (request) => request.kind === "point"
          ? {
            status: "incomplete",
            scope: { kind: "point", requestedPids: request.pids },
            reason: "process_member_observation_failed",
            diagnostic,
          }
          : observeCurrent(request),
        processController: { signalGeneration },
        publishFrozen,
        readLedger: () => [child],
      }),
    ).rejects.toThrow(
      `historical process observation is incomplete: process_member_observation_failed (${diagnostic})`,
    );
    expect(signalGeneration).not.toHaveBeenCalled();
    expect(publishFrozen).not.toHaveBeenCalled();
  });

  test.each(["omitted", "wrong pid", "wrong generation"])(
    "refuses a census with an %s leader precondition before any signal",
    async (mismatch) => {
      const signalGeneration = vi.fn();
      const publishFrozen = vi.fn();
      const observeCurrent = observeMembersFrom(() => [processMember(leader)]);
      const observeMembers = vi.fn(async (request) => {
        const observation = await observeCurrent(request);
        if (request.kind === "user_census") {
          const expectedProcess = { ...request.expectedProcess };
          if (mismatch === "wrong pid") expectedProcess.pid += 1;
          if (mismatch === "wrong generation") expectedProcess.processIdentity += "1";
          observation.scope.expectedProcess = mismatch === "omitted"
            ? undefined
            : expectedProcess;
        }
        return observation;
      });

      await expect(freezeOwnedProcessTree(descriptor, {
        observeMembers,
        processController: { signalGeneration },
        publishFrozen,
        readLedger: () => [leader],
      })).rejects.toThrow("current-user process census is incomplete");
      expect(observeMembers).toHaveBeenCalledOnce();
      expect(signalGeneration).not.toHaveBeenCalled();
      expect(publishFrozen).not.toHaveBeenCalled();
    },
  );

  test("still rejects leader reuse after the census precondition succeeded", async () => {
    const signalGeneration = vi.fn();
    const publishFrozen = vi.fn();
    const observeCurrent = observeMembersFrom(() => [processMember(leader)]);
    let pointReads = 0;
    const observeMembers = async (request) => {
      const observation = await observeCurrent(request);
      if (request.kind === "point") {
        pointReads += 1;
        observation.members = [{
          ...processMember(leader),
          processIdentity: `${leader.kernelStartMarker}1`,
        }];
      }
      return observation;
    };

    await expect(freezeOwnedProcessTree(descriptor, {
      observeMembers,
      processController: { signalGeneration },
      publishFrozen,
      readLedger: () => [leader],
    })).rejects.toThrow("process group leader generation changed");
    expect(pointReads).toBe(1);
    expect(signalGeneration).not.toHaveBeenCalled();
    expect(publishFrozen).not.toHaveBeenCalled();
  });

  test("atomically freezes and terminates exact children after leader exit", async () => {
    let alive = true;
    let state = "live";
    const signals = [];
    const readMembers = () =>
      alive ? [processMember(child, state)] : [];
    const observeMembers = observeMembersFrom(readMembers);
    const processController = {
      signalGeneration(expected, signal) {
        signals.push([expected.pid, signal]);
        if (signal === "SIGSTOP") state = "stopped";
        if (signal === "SIGKILL") alive = false;
        return true;
      },
    };

    const frozen = await freezeOwnedProcessTree(descriptor, {
      observeMembers,
      processController,
      readLedger: () => [child],
      wait: async () => {},
    });
    await terminateFrozenOwnedProcessTree(
      descriptor,
      frozen,
      process.env,
      {
        observeMembers,
        processController,
        waitForExit: async () => (alive ? [child] : []),
      },
    );

    expect(signals).toEqual([
      [child.pid, "SIGSTOP"],
      [child.pid, "SIGKILL"],
    ]);
  });

  test("freezes past an exact zombie child without treating it as a reused generation", async () => {
    const signalGeneration = vi.fn();
    const frozen = await freezeOwnedProcessTree(descriptor, {
      observeMembers: observeMembersFrom(() => [
        processMember(leader),
        processMember(child, "zombie"),
      ]),
      processController: { signalGeneration },
      readLedger: () => [leader, child],
      wait: async () => {},
    });

    expect(frozen.processes).toEqual([leader, child]);
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("group-only freeze leaves a contained detached generation available for Hmux reap", async () => {
    const detached = { ...child, groupId: 49_001, sessionId: 49_001 };
    const signalGeneration = vi.fn();
    const frozen = await freezeOwnedProcessTree(
      { ...descriptor, terminateDetachedOwnedGenerations: true },
      {
        includeDetachedOwnedGenerations: false,
        observeMembers: observeMembersFrom(() => [
          processMember(detached, "live"),
        ]),
        processController: {
          signalGeneration,
        },
        readLedger: () => [detached],
        wait: async () => {},
      },
    );

    expect(signalGeneration).not.toHaveBeenCalled();
    expect(frozen.processes).toEqual([]);
  });

  test.each([
    ["ledger", false],
    ["observation", false],
    ["ledger", true],
    ["observation", true],
  ])(
    "converges during detached births from %s with full-tree scope=%s",
    async (discoverySource, includeDetachedOwnedGenerations) => {
      const detached = {
        ...child,
        groupId: 49_001,
        parentPid: leader.pid,
        sessionId: 49_001,
      };
      const members = [leader, detached];
      const states = new Map([
        [leader.pid, "stopped"],
        [detached.pid, "live"],
      ]);
      const signalGeneration = vi.fn((expected, signal) => {
        expect(signal).toBe("SIGSTOP");
        states.set(expected.pid, "stopped");
        return true;
      });
      const readLedger = () => {
        if (states.get(detached.pid) === "live") {
          const pid = 50_000 + members.length;
          const newborn = {
            ...detached,
            kernelStartMarker:
              `kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:${pid}`,
            parentPid: detached.pid,
            pid,
            startMarker: `ps-lstart-v1:detached-child-${pid}`,
          };
          members.push(newborn);
          states.set(pid, "live");
        }
        return discoverySource === "ledger"
          ? [...members]
          : [leader, detached];
      };

      const frozen = await freezeOwnedProcessTree(
        { ...descriptor, terminateDetachedOwnedGenerations: true },
        {
          includeDetachedOwnedGenerations,
          observeMembers: observeMembersFrom(() =>
            members.map((member) =>
              processMember(member, states.get(member.pid)),
            ),
          ),
          processController: { signalGeneration },
          readLedger,
          wait: async () => {},
        },
      );

      expect(members.length).toBeGreaterThan(2);
      if (includeDetachedOwnedGenerations) {
        expect(frozen.processes.map(({ pid }) => pid).sort()).toEqual(
          members.map(({ pid }) => pid).sort(),
        );
        expect(
          signalGeneration.mock.calls.map(([expected]) => expected.pid).sort(),
        ).toEqual(members.slice(1).map(({ pid }) => pid).sort());
        expect(
          [...states.values()].every((state) => state === "stopped"),
        ).toBe(true);
      } else {
        expect(frozen.processes).toEqual([leader]);
        expect(signalGeneration).not.toHaveBeenCalled();
        expect(
          members.slice(1).every(({ pid }) => states.get(pid) === "live"),
        ).toBe(true);
      }
    },
  );

  test("group-only freeze still rejects a reused detached ledger generation", async () => {
    const detached = { ...child, groupId: 49_001, sessionId: 49_001 };
    const replacement = {
      ...detached,
      kernelStartMarker:
        "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:103",
      startMarker: "ps-lstart-v1:reused-detached",
    };
    let reads = 0;
    const signalGeneration = vi.fn();
    const publishFrozen = vi.fn();

    await expect(
      freezeOwnedProcessTree(
        { ...descriptor, terminateDetachedOwnedGenerations: true },
        {
          includeDetachedOwnedGenerations: false,
          observeMembers: observeMembersFrom(() => [
            processMember(leader),
            processMember(detached, "live"),
          ]),
          processController: { signalGeneration },
          publishFrozen,
          readLedger: () => [leader, ++reads === 1 ? detached : replacement],
          wait: async () => {},
        },
      ),
    ).rejects.toThrow("ownership ledger reused a process id");
    expect(signalGeneration).not.toHaveBeenCalled();
    expect(publishFrozen).not.toHaveBeenCalled();
  });

  test("does not admit a target-group child omitted by the later closed census", async () => {
    const racedChild = {
      ...child,
      kernelStartMarker:
        "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:104",
      parentPid: leader.pid,
      pid: 41_004,
      startMarker: "ps-lstart-v1:raced-child",
    };
    const leaderMember = processMember(leader);
    const racedChildMember = processMember(racedChild, "live");
    const pointRequests = [];
    const observeMembers = vi.fn(async (request) => {
      if (request.kind === "user_census") {
        return {
          status: "complete",
          scope: {
            effectiveUid: process.geteuid(),
            evidence: "closed_enumeration",
            kind: "user_census",
            ...(request.expectedProcess ? { expectedProcess: request.expectedProcess } : {}),
          },
          members: [leaderMember, racedChildMember],
        };
      }
      if (request.kind === "group_census") {
        return {
          status: "complete",
          scope: { groupId, kind: "group_census" },
          members: [leaderMember],
        };
      }
      pointRequests.push([...request.pids]);
      return {
        status: "complete",
        scope: { kind: "point", requestedPids: [...request.pids] },
        members: [leaderMember],
      };
    });
    const signalGeneration = vi.fn();

    const frozen = await freezeOwnedProcessTree(descriptor, {
      observeMembers,
      processController: { signalGeneration },
      readLedger: () => [leader],
      wait: async () => {},
    });

    expect(pointRequests.length).toBeGreaterThan(0);
    expect(pointRequests).toEqual(
      pointRequests.map(() => [leader.pid]),
    );
    expect(frozen.processes.map(({ pid }) => pid)).toEqual([leader.pid]);
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("does not retain a historical parent omitted by the newer point observation", async () => {
    const detachedParent = {
      ...child,
      groupId: 49_001,
      kernelStartMarker:
        "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:105",
      parentPid: leader.pid,
      pid: 49_001,
      sessionId: 49_001,
      startMarker: "ps-lstart-v1:detached-parent",
    };
    const detachedChild = {
      ...detachedParent,
      kernelStartMarker:
        "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:106",
      parentPid: detachedParent.pid,
      pid: 49_002,
      startMarker: "ps-lstart-v1:detached-child",
    };
    const leaderMember = processMember(leader);
    const staleParent = processMember(detachedParent, "live");
    const staleChild = processMember(detachedChild, "live");
    const observeMembers = vi.fn(async (request) => {
      if (request.kind === "user_census") {
        return {
          status: "complete",
          scope: {
            effectiveUid: process.geteuid(),
            evidence: "closed_enumeration",
            kind: "user_census",
            ...(request.expectedProcess ? { expectedProcess: request.expectedProcess } : {}),
          },
          members: [leaderMember, staleParent, staleChild],
        };
      }
      if (request.kind === "group_census") {
        return {
          status: "complete",
          scope: { groupId, kind: "group_census" },
          members: [leaderMember],
        };
      }
      return {
        status: "complete",
        scope: {
          kind: "point",
          requestedPids: [...request.pids],
        },
        members: request.pids.includes(leader.pid) ? [leaderMember] : [],
      };
    });
    const signalGeneration = vi.fn(() => {
      throw new Error("stale topology reached destructive authority");
    });

    const frozen = await freezeOwnedProcessTree(
      { ...descriptor, terminateDetachedOwnedGenerations: true },
      {
        observeMembers,
        processController: { signalGeneration },
        readLedger: () => [leader, detachedParent],
        wait: async () => {},
      },
    );

    expect(frozen.processes.map(({ pid }) => pid)).not.toContain(
      detachedChild.pid,
    );
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("does not seed an untracked group after its exact leader exits", async () => {
    const signalGeneration = vi.fn();

    const frozen = await freezeOwnedProcessTree(descriptor, {
      observeMembers: observeMembersFrom(() => [
        processMember(child, "live"),
      ]),
      processController: { signalGeneration },
      readLedger: () => [],
      wait: async () => {},
    });

    expect(frozen.processes).toEqual([]);
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("fails when a leader stopped by this freeze loses its exact anchor", async () => {
    let leaderPresent = true;
    const signals = [];
    const observeMembers = observeMembersFrom(() => [
      ...(leaderPresent ? [processMember(leader, "live")] : []),
      processMember(child, "live"),
    ]);

    await expect(
      freezeOwnedProcessTree(descriptor, {
        observeMembers,
        processController: {
          signalGeneration(expected, signal) {
            signals.push([expected.pid, signal]);
            if (expected.pid === leader.pid && signal === "SIGSTOP") {
              leaderPresent = false;
              return true;
            }
            return false;
          },
        },
        readLedger: () => [leader],
        wait: async () => {},
      }),
    ).rejects.toThrow("process group lost its exact leader anchor");

    expect(signals).toEqual([
      [leader.pid, "SIGSTOP"],
      [leader.pid, "SIGCONT"],
    ]);
  });

  test("excludes an exact process that escapes its group before the signal", async () => {
    let reads = 0;
    const signalGeneration = vi.fn();

    const frozen = await freezeOwnedProcessTree(descriptor, {
      observeMembers: observeMembersFrom(() => {
        reads += 1;
        return [
          {
            ...processMember(child, "live"),
            groupId: reads >= 3 ? 99_001 : groupId,
          },
        ];
      }),
      processController: {
        signalGeneration,
      },
      readLedger: () => [child],
      wait: async () => {},
    });

    expect(frozen.processes).toEqual([]);
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("resumes an exact process that escapes its group during SIGSTOP", async () => {
    let currentGroup = groupId;
    let state = "live";
    const signals = [];
    const readMembers = () => [
      {
        ...processMember(child, state),
        groupId: currentGroup,
      },
    ];

    await expect(
      freezeOwnedProcessTree(descriptor, {
        observeMembers: observeMembersFrom(readMembers),
        processController: {
          signalGeneration(expected, signal) {
            signals.push([expected.pid, signal]);
            if (signal === "SIGSTOP") {
              currentGroup = 99_001;
              state = "stopped";
            } else if (signal === "SIGCONT") {
              state = "live";
            }
            return true;
          },
        },
        readLedger: () => [child],
        wait: async () => {},
      }),
    ).rejects.toThrow(
      "exact process escaped its group while stopping",
    );

    expect(signals).toEqual([
      [child.pid, "SIGSTOP"],
      [child.pid, "SIGCONT"],
    ]);
    expect(state).toBe("live");
  });

  test("rolls back every exact generation stopped by a failed freeze", async () => {
    const sibling = {
      ...child,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:103",
      pid: 41_003,
      startMarker: "ps-lstart-v1:sibling",
    };
    const processes = [leader, child, sibling];
    const groups = new Map(
      processes.map((process) => [process.pid, groupId]),
    );
    const states = new Map(
      processes.map((process) => [process.pid, "live"]),
    );
    const signals = [];
    const readMembers = () =>
      processes.map((process) => ({
        ...processMember(process, states.get(process.pid)),
        groupId: groups.get(process.pid),
      }));

    await expect(
      freezeOwnedProcessTree(descriptor, {
        observeMembers: observeMembersFrom(readMembers),
        processController: {
          signalGeneration(expected, signal) {
            signals.push([expected.pid, signal]);
            if (signal === "SIGSTOP") {
              if (expected.pid === child.pid) {
                groups.set(expected.pid, 99_001);
              }
              states.set(expected.pid, "stopped");
            } else if (signal === "SIGCONT") {
              states.set(expected.pid, "live");
            }
            return true;
          },
        },
        readLedger: () => processes,
        wait: async () => {},
      }),
    ).rejects.toThrow("exact process escaped its group while stopping");

    expect(
      signals.filter(([, signal]) => signal === "SIGCONT"),
    ).toEqual([
      [child.pid, "SIGCONT"],
      [sibling.pid, "SIGCONT"],
      [leader.pid, "SIGCONT"],
    ]);
    expect([...states.values()]).toEqual(["live", "live", "live"]);
  });

  test("resumes stopped generations when the topology deadline expires", async () => {
    let observationCount = 0;
    let state = "live";
    const signals = [];
    const observeCurrent = observeMembersFrom(() => [
      processMember(child, state),
    ]);

    await expect(
      freezeOwnedProcessTree(descriptor, {
        observeMembers: async (request) => {
          observationCount += 1;
          if (observationCount > 6) {
            throw new Error("injected process topology observation timeout");
          }
          return observeCurrent(request);
        },
        processController: {
          signalGeneration(expected, signal) {
            signals.push([expected.pid, signal]);
            state = signal === "SIGSTOP" ? "stopped" : "live";
            return true;
          },
        },
        readLedger: () => [child],
        wait: async () => {},
      }),
    ).rejects.toThrow("injected process topology observation timeout");

    expect(signals).toEqual([
      [child.pid, "SIGSTOP"],
      [child.pid, "SIGCONT"],
    ]);
    expect(state).toBe("live");
  });

  test("rolls back newly stopped generations when snapshot publication fails", async () => {
    const preStopped = {
      ...child,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:103",
      pid: 41_003,
      startMarker: "ps-lstart-v1:pre-stopped",
    };
    const processes = [leader, child, preStopped];
    const states = new Map([
      [leader.pid, "live"],
      [child.pid, "live"],
      [preStopped.pid, "stopped"],
    ]);
    const signals = [];
    const readMembers = () =>
      processes.map((process) =>
        processMember(process, states.get(process.pid)),
      );

    await expect(
      freezeOwnedProcessTree(descriptor, {
        observeMembers: observeMembersFrom(readMembers),
        processController: {
          signalGeneration(expected, signal) {
            signals.push([expected.pid, signal]);
            states.set(
              expected.pid,
              signal === "SIGSTOP" ? "stopped" : "live",
            );
            return true;
          },
        },
        publishFrozen() {
          throw new Error("injected snapshot publication failure");
        },
        readLedger: () => processes,
        wait: async () => {},
      }),
    ).rejects.toThrow("injected snapshot publication failure");

    expect(states.get(leader.pid)).toBe("live");
    expect(states.get(child.pid)).toBe("live");
    expect(states.get(preStopped.pid)).toBe("stopped");
    expect(
      signals.filter(([, signal]) => signal === "SIGCONT"),
    ).toEqual([
      [child.pid, "SIGCONT"],
      [leader.pid, "SIGCONT"],
    ]);
  });

  test("continues freeze rollback after one exact resume fails", async () => {
    const sibling = {
      ...child,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:103",
      pid: 41_003,
      startMarker: "ps-lstart-v1:sibling",
    };
    const processes = [leader, child, sibling];
    const groups = new Map(
      processes.map((process) => [process.pid, groupId]),
    );
    const states = new Map(
      processes.map((process) => [process.pid, "live"]),
    );
    const resumed = [];
    const readMembers = () =>
      processes.map((process) => ({
        ...processMember(process, states.get(process.pid)),
        groupId: groups.get(process.pid),
      }));
    let failure;

    try {
      await freezeOwnedProcessTree(descriptor, {
        observeMembers: observeMembersFrom(readMembers),
        processController: {
          signalGeneration(expected, signal) {
            if (signal === "SIGSTOP") {
              if (expected.pid === child.pid) {
                groups.set(expected.pid, 99_001);
              }
              states.set(expected.pid, "stopped");
              return true;
            }
            resumed.push(expected.pid);
            if (expected.pid === child.pid) {
              throw new Error("injected resume failure");
            }
            states.set(expected.pid, "live");
            return true;
          },
        },
        readLedger: () => processes,
        wait: async () => {},
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain(
      `freeze rollback failed for exact processes: ${child.pid}`,
    );
    expect(failure.errors[0].message).toContain(
      "exact process escaped its group while stopping",
    );
    expect(resumed).toEqual([child.pid, sibling.pid, leader.pid]);
    expect(states.get(child.pid)).toBe("stopped");
    expect(states.get(sibling.pid)).toBe("live");
    expect(states.get(leader.pid)).toBe("live");
  });

  test.each([
    {
      label: "first replacement identity",
      processIdentity:
        "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:998",
    },
    {
      label: "later replacement identity",
      processIdentity:
        "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:999",
    },
  ])("does not signal a reused frozen pid with a $label", async ({
    processIdentity,
  }) => {
    const signalGeneration = vi.fn();
    const waitForExit = vi.fn();
    const replacement = {
      ...processMember(child),
      processIdentity,
    };

    await expect(
      terminateFrozenOwnedProcessTree(
        descriptor,
        { processes: [child] },
        process.env,
        {
          observeMembers: observeMembersFrom(() => [replacement]),
          processController: {
            signalGeneration,
          },
          waitForExit,
        },
      ),
    ).resolves.toBeUndefined();
    expect(signalGeneration).not.toHaveBeenCalled();
    expect(waitForExit).not.toHaveBeenCalled();
  });

  test.each(["foreign detached target", "omitted live owned target"])(
    "refuses a frozen command with %s before signaling",
    async (kind) => {
      const foreign = {
        ...child,
        groupId: 49_001,
        pid: 49_001,
        sessionId: 49_001,
        kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:901",
      };
      const processes = kind === "foreign detached target"
        ? [leader, child, foreign]
        : [leader];
      const signalGeneration = vi.fn(() => true);
      await expect(terminateFrozenOwnedProcessTree(
        { ...descriptor, terminateDetachedOwnedGenerations: true },
        { processes },
        process.env,
        {
          ownedProcesses: [leader, child],
          observeMembers: observeMembersFrom(() =>
            [leader, child, foreign].map((entry) => processMember(entry)),
          ),
          processController: { signalGeneration },
          waitForExit: async () => [],
        },
      )).rejects.toThrow("frozen command does not match current owned targets");
      expect(signalGeneration).not.toHaveBeenCalled();
    },
  );

  test.each(["ledgered reparented child", "new attached descendant"])(
    "accepts a frozen command containing a %s without a whole-user census",
    async (kind) => {
      const descendant = {
        ...child,
        groupId: 49_001,
        sessionId: 49_001,
        parentPid: kind === "new attached descendant" ? leader.pid : 1,
      };
      const processes = [leader, descendant];
      const signalGeneration = vi.fn(() => true);
      const observeMembers = vi.fn(observeMembersFrom(() =>
        processes.map((entry) => processMember(entry)),
      ));
      await terminateFrozenOwnedProcessTree(
        { ...descriptor, terminateDetachedOwnedGenerations: true },
        { processes },
        process.env,
        {
          ownedProcesses: kind === "new attached descendant" ? [leader] : processes,
          observeMembers,
          processController: { signalGeneration },
          waitForExit: async () => [],
        },
      );
      expect(signalGeneration.mock.calls.map(([entry]) => entry.pid))
        .toEqual([descendant.pid, leader.pid]);
      expect(observeMembers.mock.calls.map(([request]) => request.kind))
        .toEqual(["point"]);
    },
  );

  test("signals exact children before the exact leader", async () => {
    const youngerChild = {
      ...child,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:103",
      pid: 41_003,
      startMarker: "ps-lstart-v1:younger-child",
    };
    const processes = [leader, youngerChild, child];
    const signaled = [];

    await terminateFrozenOwnedProcessTree(
      descriptor,
      { processes },
      process.env,
      {
        observeMembers: observeMembersFrom(() =>
          processes.map((process) => processMember(process)),
        ),
        processController: {
          signalGeneration(expected) {
            signaled.push(expected.pid);
            return true;
          },
        },
        waitForExit: async () => [],
      },
    );

    expect(signaled).toEqual([child.pid, youngerChild.pid, leader.pid]);
    expect(
      exactTerminationOrder(processes, descriptor.leaderPid).map(
        ({ pid }) => pid,
      ),
    ).toEqual(signaled);
  });

  test("does not reopen an absent bootless generation after signaling exact peers", async () => {
    const bootless = {
      ...child,
      kernelStartMarker: "kernel-start-v1:linux:999",
      pid: 49_999,
    };
    let exactLive = true;
    const signals = [];

    await terminateFrozenOwnedProcessTree(
      descriptor,
      { processes: [bootless, child] },
      process.env,
      {
        observeMembers: observeMembersFrom(() =>
          exactLive ? [processMember(child)] : [],
        ),
        processController: {
          generationState(expected) {
            if (expected.pid === bootless.pid) {
              throw new Error("legacy absence was reopened");
            }
            return exactLive ? "quiescent" : "gone";
          },
          signalGeneration(expected, signal) {
            signals.push([expected.pid, signal]);
            exactLive = false;
            return true;
          },
        },
      },
    );

    expect(signals).toEqual([[child.pid, "SIGKILL"]]);
  });

  test("propagates an exact child signal failure before touching the leader", async () => {
    const processes = [leader, child];
    const signaled = [];
    const waitForExit = vi.fn();

    await expect(
      terminateFrozenOwnedProcessTree(
        descriptor,
        { processes },
        process.env,
        {
          observeMembers: observeMembersFrom(() =>
            processes.map((process) => processMember(process)),
          ),
          processController: {
            signalGeneration(expected) {
              signaled.push(expected.pid);
              throw new Error("injected exact signal failure");
            },
          },
          waitForExit,
        },
      ),
    ).rejects.toThrow("injected exact signal failure");

    expect(signaled).toEqual([child.pid]);
    expect(waitForExit).not.toHaveBeenCalled();
  });

  test("fails closed when an exact generation survives SIGKILL", async () => {
    await expect(
      terminateFrozenOwnedProcessTree(
        descriptor,
        { processes: [child] },
        process.env,
        {
          observeMembers: observeMembersFrom(() => [
            processMember(child),
          ]),
          processController: {
            signalGeneration: () => true,
          },
          waitForExit: async () => [child],
        },
      ),
    ).rejects.toThrow(
      `exact owned processes survived SIGKILL: ${child.pid}`,
    );
  });

  test("refuses a group-escaped exact process without signaling it", async () => {
    const signalGeneration = vi.fn();

    await expect(
      terminateFrozenOwnedProcessTree(
        descriptor,
        { processes: [child] },
        process.env,
        {
          observeMembers: observeMembersFrom(() => [
            { ...processMember(child), groupId: 99_001 },
          ]),
          processController: {
            signalGeneration,
          },
        },
      ),
    ).rejects.toThrow("refusing exact KILL for detached owned processes");
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("refuses an atomic signal when the kernel generation changes after the frozen census", async () => {
    const signalGeneration = vi.fn(() => {
      throw new Error("refusing to signal a reused process generation");
    });

    await expect(
      terminateFrozenOwnedProcessTree(
        descriptor,
        { processes: [child] },
        process.env,
        {
          observeMembers: observeMembersFrom(() => [
            processMember(child),
          ]),
          processController: {
            signalGeneration,
          },
        },
      ),
    ).rejects.toThrow("refusing to signal a reused process generation");
    expect(signalGeneration).toHaveBeenCalledOnce();
  });
});

describe("owned process sampling", () => {
  const first = {
    groupId: 41001,
    parentPid: 40000,
    pid: 41001,
    processIdentity:
      "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9007199254740994",
    sessionId: 40000,
    startedAtUnixSeconds: 1_700_000_000,
    state: "live",
  };

  test("does not admit a reused historical pid without current ownership", () => {
    const historical = {
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9007199254740993",
      pid: first.pid,
      startMarker: "ps-lstart-v1:Tue Nov 14 22:13:20 2023",
    };
    const replacement = {
      ...first,
      groupId: 99000,
      parentPid: 1,
    };

    expect(
      ownedProcessClosure(41001, [replacement], [historical], {
        seedProcessGroup: false,
      }),
    ).toEqual([]);
  });

  test("admits a replacement only when the live leader group owns it again", () => {
    const historical = {
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9007199254740993",
      pid: first.pid,
      startMarker: "ps-lstart-v1:Tue Nov 14 22:13:20 2023",
    };
    const replacement = { ...first };

    expect(ownedProcessClosure(41001, [replacement], [historical])).toEqual([
      replacement,
    ]);
  });
});
