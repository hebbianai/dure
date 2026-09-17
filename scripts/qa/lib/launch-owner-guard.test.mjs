import { describe, expect, test, vi } from "vitest";
import { guardLaunchOwner } from "./launch-owner-guard.mjs";

const descriptorPath = "/fixture/runner-owner.json";
const stopPath = "/fixture/runner-owner.stop";
const runner = {
  groupId: 41,
  parentPid: 31,
  pid: 41,
  processIdentity:
    "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:4100",
  state: "live",
};
const launchOwner = {
  groupId: 31,
  parentPid: 21,
  pid: 31,
  processIdentity:
    "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:3100",
  state: "live",
};
const guard = {
  groupId: 41,
  parentPid: 41,
  pid: 51,
  processIdentity:
    "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:5100",
  state: "live",
};

function observationSequence(...records) {
  const remaining = [...records];
  return vi.fn(async () => remaining.shift());
}

function pointObservation(requestedPids, members) {
  const requested = [...new Set(requestedPids)].sort(
    (left, right) => left - right,
  );
  return {
    members: members
      .filter(({ pid }) => requested.includes(pid))
      .sort((left, right) => left.pid - right.pid),
    scope: { kind: "point", requestedPids: requested },
    status: "complete",
  };
}

function refuseLegacyAuthority() {
  throw new Error("legacy launch-owner authority was used");
}

const legacyAuthoritySentinels = {
  generationIsLive: refuseLegacyAuthority,
  observeGeneration: refuseLegacyAuthority,
};

function generation(member) {
  return {
    groupId: member.groupId,
    parentPid: member.parentPid,
    pid: member.pid,
    processIdentity: member.processIdentity,
  };
}

function stableStartupObservations() {
  return [
    pointObservation([runner.pid], [runner]),
    pointObservation(
      [runner.pid, launchOwner.pid, guard.pid],
      [runner, launchOwner, guard],
    ),
    pointObservation(
      [runner.pid, launchOwner.pid],
      [runner, launchOwner],
    ),
  ];
}

describe("Tauri QA launch-owner guard", () => {
  test("rejects an invalid deadline before publishing readiness", async () => {
    const observeMembers = vi.fn();
    const publishDescriptor = vi.fn();

    await expect(
      guardLaunchOwner(
        descriptorPath,
        runner.pid,
        stopPath,
        { DURE_QA_LAUNCH_OWNER_CLEANUP_GRACE_MS: "unbounded" },
        {
          currentParentPid: () => runner.pid,
          currentPid: () => guard.pid,
          observeMembers,
          publishDescriptor,
        },
      ),
    ).rejects.toThrow("DURE_QA_LAUNCH_OWNER_CLEANUP_GRACE_MS");
    expect(observeMembers).not.toHaveBeenCalled();
    expect(publishDescriptor).not.toHaveBeenCalled();
  });

  test("publishes all exact generations before accepting normal shutdown", async () => {
    const publishDescriptor = vi.fn();
    const signalGeneration = vi.fn();

    await guardLaunchOwner(
      descriptorPath,
      runner.pid,
      stopPath,
      {},
      {
        currentParentPid: () => runner.pid,
        currentPid: () => guard.pid,
        fileExists: (file) => file === stopPath,
        ...legacyAuthoritySentinels,
        observeMembers: observationSequence(...stableStartupObservations()),
        publishDescriptor,
        signalGeneration,
      },
    );

    expect(publishDescriptor).toHaveBeenCalledWith(
      descriptorPath,
      expect.objectContaining({
        guard: generation(guard),
        launchOwner: generation(launchOwner),
        runner: generation(runner),
        schemaVersion: 2,
      }),
    );
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test("turns a parent cancellation marker into one exact runner HUP", async () => {
    const cancelPath = "/fixture/runner.cancel";
    const publishTimeoutCancellation = vi.fn();
    const signalGeneration = vi.fn(() => true);

    await guardLaunchOwner(
      descriptorPath,
      runner.pid,
      stopPath,
      {
        DURE_QA_RUNNER_CANCEL_FILE: cancelPath,
        DURE_QA_RUNNER_TIMEOUT_SECONDS: "10",
      },
      {
        currentParentPid: () => runner.pid,
        currentPid: () => guard.pid,
        fileExists: (file) => file === cancelPath,
        ...legacyAuthoritySentinels,
        observeMembers: observationSequence(
          ...stableStartupObservations(),
          pointObservation([runner.pid, launchOwner.pid], [runner, launchOwner]),
          pointObservation([runner.pid, launchOwner.pid], [launchOwner]),
        ),
        publishDescriptor: vi.fn(),
        publishTimeoutCancellation,
        signalGeneration,
      },
    );

    expect(signalGeneration).toHaveBeenCalledOnce();
    expect(signalGeneration).toHaveBeenCalledWith(
      generation(runner),
      "SIGHUP",
    );
    expect(publishTimeoutCancellation).not.toHaveBeenCalled();
  });

  test("publishes timeout before cancelling the exact runner", async () => {
    const cancelPath = "/fixture/runner.cancel";
    let clock = 0;
    let runnerLive = true;
    let timeoutPublished = false;
    const publishTimeoutCancellation = vi.fn((destination) => {
      expect(destination).toBe(cancelPath);
      timeoutPublished = true;
      return true;
    });
    const signalGeneration = vi.fn((expected, signal) => {
      expect(expected).toEqual(generation(runner));
      expect(signal).toBe("SIGHUP");
      expect(timeoutPublished).toBe(true);
      runnerLive = false;
      return true;
    });
    let observationCalls = 0;
    const observeMembers = vi.fn(async ({ pids }) => {
      observationCalls += 1;
      if (observationCalls === 1) return pointObservation(pids, [runner]);
      if (observationCalls === 2) {
        return pointObservation(pids, [runner, launchOwner, guard]);
      }
      if (observationCalls === 3) {
        return pointObservation(pids, [runner, launchOwner]);
      }
      return pointObservation(
        pids,
        runnerLive ? [runner, launchOwner] : [launchOwner],
      );
    });

    await guardLaunchOwner(
      descriptorPath,
      runner.pid,
      stopPath,
      {
        DURE_QA_LAUNCH_OWNER_POLL_MS: "10",
        DURE_QA_RUNNER_CANCEL_FILE: cancelPath,
        DURE_QA_RUNNER_TIMEOUT_SECONDS: "0.05",
      },
      {
        currentParentPid: () => runner.pid,
        currentPid: () => guard.pid,
        fileExists: () => false,
        ...legacyAuthoritySentinels,
        now: () => clock,
        observeMembers,
        publishDescriptor: vi.fn(),
        publishTimeoutCancellation,
        signalGeneration,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    );

    expect(publishTimeoutCancellation).toHaveBeenCalledOnce();
    expect(clock).toBe(50);
    expect(signalGeneration).toHaveBeenCalledOnce();
    expect(publishTimeoutCancellation.mock.invocationCallOrder[0]).toBeLessThan(
      signalGeneration.mock.invocationCallOrder[0],
    );
  });

  test("counts guard startup against the runner deadline", async () => {
    const cancelPath = "/fixture/runner.cancel";
    let clock = 0;
    let runnerLive = true;
    let observationCalls = 0;
    const wait = vi.fn(async (milliseconds) => {
      clock += milliseconds;
    });
    const observeMembers = vi.fn(async ({ pids }) => {
      clock += 20;
      observationCalls += 1;
      if (observationCalls === 1) return pointObservation(pids, [runner]);
      if (observationCalls === 2) {
        return pointObservation(pids, [runner, launchOwner, guard]);
      }
      if (observationCalls === 3) {
        return pointObservation(pids, [runner, launchOwner]);
      }
      return pointObservation(
        pids,
        runnerLive ? [runner, launchOwner] : [launchOwner],
      );
    });
    const signalGeneration = vi.fn(() => {
      runnerLive = false;
      return true;
    });

    await guardLaunchOwner(
      descriptorPath,
      runner.pid,
      stopPath,
      {
        DURE_QA_RUNNER_CANCEL_FILE: cancelPath,
        DURE_QA_RUNNER_TIMEOUT_SECONDS: "0.05",
      },
      {
        currentParentPid: () => runner.pid,
        currentPid: () => guard.pid,
        fileExists: () => false,
        now: () => clock,
        observeMembers,
        publishDescriptor: vi.fn(),
        publishTimeoutCancellation: vi.fn(() => true),
        signalGeneration,
        wait,
      },
    );

    expect(wait).not.toHaveBeenCalled();
    expect(signalGeneration).toHaveBeenCalledWith(
      generation(runner),
      "SIGHUP",
    );
  });

  test("rejects a runner timeout without a cancellation receipt path", async () => {
    const observeMembers = vi.fn();

    await expect(
      guardLaunchOwner(
        descriptorPath,
        runner.pid,
        stopPath,
        { DURE_QA_RUNNER_TIMEOUT_SECONDS: "1" },
        { observeMembers },
      ),
    ).rejects.toThrow("runner timeout requires DURE_QA_RUNNER_CANCEL_FILE");
    expect(observeMembers).not.toHaveBeenCalled();
  });

  test("bounds HUP cleanup and kills only the published runner generation", async () => {
    let clock = 0;
    let ownerChecks = 0;
    let runnerLive = true;
    const signalGeneration = vi.fn((expected, signal) => {
      expect(expected).toEqual(generation(runner));
      if (signal === "SIGKILL") runnerLive = false;
      return true;
    });
    let observationCalls = 0;
    const observeMembers = vi.fn(async ({ pids }) => {
      observationCalls += 1;
      if (observationCalls === 1) {
        return pointObservation(pids, [runner]);
      }
      if (observationCalls === 2) {
        return pointObservation(pids, [runner, launchOwner, guard]);
      }
      if (observationCalls === 3) {
        return pointObservation(pids, [runner, launchOwner]);
      }
      const members = runnerLive ? [runner] : [];
      if (ownerChecks === 0) members.push(launchOwner);
      ownerChecks += 1;
      return pointObservation(pids, members);
    });

    await guardLaunchOwner(
      descriptorPath,
      runner.pid,
      stopPath,
      {
        DURE_QA_LAUNCH_OWNER_CLEANUP_GRACE_MS: "100",
        DURE_QA_LAUNCH_OWNER_KILL_GRACE_MS: "100",
        DURE_QA_LAUNCH_OWNER_POLL_MS: "50",
      },
      {
        currentParentPid: () => runner.pid,
        currentPid: () => guard.pid,
        fileExists: () => false,
        ...legacyAuthoritySentinels,
        now: () => clock,
        observeMembers,
        publishDescriptor: vi.fn(),
        signalGeneration,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    );

    expect(signalGeneration.mock.calls).toEqual([
      [generation(runner), "SIGHUP"],
      [generation(runner), "SIGKILL"],
    ]);
  });

  test("cancels the published runner when liveness observation fails", async () => {
    const signalGeneration = vi.fn();

    await expect(
      guardLaunchOwner(
        descriptorPath,
        runner.pid,
        stopPath,
        {},
        {
          currentParentPid: () => runner.pid,
          currentPid: () => guard.pid,
          fileExists: () => false,
          observeMembers: observationSequence(
            ...stableStartupObservations(),
            { reason: "fixture", status: "incomplete" },
          ),
          publishDescriptor: vi.fn(),
          signalGeneration,
        },
      ),
    ).rejects.toThrow("process identity observation is incomplete");
    expect(signalGeneration).toHaveBeenCalledOnce();
    expect(signalGeneration).toHaveBeenCalledWith(
      generation(runner),
      "SIGHUP",
    );
  });

  test("converges without signaling when the runner pid is reused", async () => {
    const signalGeneration = vi.fn();
    const reusedRunner = {
      ...runner,
      processIdentity:
        "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:4199",
    };

    const descriptor = await guardLaunchOwner(
      descriptorPath,
      runner.pid,
      stopPath,
      {},
      {
        currentParentPid: () => runner.pid,
        currentPid: () => guard.pid,
        fileExists: () => false,
        observeMembers: observationSequence(
          ...stableStartupObservations(),
          pointObservation(
            [runner.pid, launchOwner.pid],
            [reusedRunner, launchOwner],
          ),
        ),
        publishDescriptor: vi.fn(),
        signalGeneration,
      },
    );

    expect(descriptor.schemaVersion).toBe(2);
    expect(signalGeneration).not.toHaveBeenCalled();
  });

  test.each([
    ["runner", { ...runner, parentPid: 99 }, launchOwner],
    [
      "launch owner",
      runner,
      {
        ...launchOwner,
        processIdentity:
          "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:3199",
      },
    ],
  ])(
    "fails before publication when the %s generation changes",
    async (_label, confirmedRunner, confirmedLaunchOwner) => {
      const publishDescriptor = vi.fn();

      await expect(
        guardLaunchOwner(
          descriptorPath,
          runner.pid,
          stopPath,
          {},
          {
            currentParentPid: () => runner.pid,
            currentPid: () => guard.pid,
            ...legacyAuthoritySentinels,
            observeMembers: observationSequence(
              pointObservation([runner.pid], [runner]),
              pointObservation(
                [runner.pid, launchOwner.pid, guard.pid],
                [runner, launchOwner, guard],
              ),
              pointObservation(
                [runner.pid, launchOwner.pid],
                [confirmedRunner, confirmedLaunchOwner],
              ),
            ),
            publishDescriptor,
          },
        ),
      ).rejects.toThrow("launch ownership changed before publication");
      expect(publishDescriptor).not.toHaveBeenCalled();
    },
  );
});
