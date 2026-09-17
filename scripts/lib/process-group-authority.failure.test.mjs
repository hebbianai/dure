import { beforeEach, expect, it, vi } from "vitest";

const nativeBoundary = vi.hoisted(() => ({
  observeProcessMembers: vi.fn(),
  signalProcessGeneration: vi.fn(),
}));

vi.mock("./process-identity.mjs", () => nativeBoundary);

import {
  observeOwnedProcessGroup,
  retireExactLeaderProcessGroup,
  signalOwnedProcessGroup,
} from "./process-group-authority.mjs";

const owner = {
  pid: 41_001,
  processIdentity: "leader-generation",
  processGroup: {
    kind: "posix_process_group_v1",
    id: 41_001,
    witness: {
      pid: 41_004,
      processIdentity: "witness-generation",
    },
  },
};
const child = { pid: 41_002, processIdentity: "child-generation" };
const preStopped = {
  pid: 41_003,
  processIdentity: "pre-stopped-generation",
};
const lateMember = {
  pid: 41_005,
  processIdentity: "late-member-generation",
};

function member(identity, state = "live", groupId = owner.processGroup.id) {
  return { ...identity, groupId, state };
}

function pointObservation() {
  const requestedPids = [
    process.pid,
    owner.pid,
    owner.processGroup.witness.pid,
  ].sort((left, right) => left - right);
  return {
    status: "complete",
    scope: { kind: "point", requestedPids },
    members: [
      member(
        { pid: process.pid, processIdentity: "test-runner-generation" },
        "live",
        91_001,
      ),
      member(owner),
      member(owner.processGroup.witness),
    ].sort((left, right) => left.pid - right.pid),
  };
}

function groupObservation(members) {
  return {
    status: "complete",
    scope: { kind: "group_census", groupId: owner.processGroup.id },
    members,
  };
}

function runningGroup() {
  return groupObservation([
    member(owner),
    member(child),
    member(preStopped, "stopped"),
    member(owner.processGroup.witness),
  ]);
}

function stoppedGroup({ includeWitness = true } = {}) {
  return groupObservation([
    member(owner, "stopped"),
    member(child, "stopped"),
    member(preStopped, "stopped"),
    ...(includeWitness
      ? [member(owner.processGroup.witness, "stopped")]
      : []),
  ]);
}

function exactPointObservation(requestedPids, members) {
  return {
    status: "complete",
    scope: { kind: "point", requestedPids },
    members,
  };
}

function observeScenario(observations, { pointObservations = [] } = {}) {
  let groupRead = 0;
  let pointRead = 0;
  nativeBoundary.observeProcessMembers.mockImplementation(async (request) => {
    if (request.kind === "point") {
      if (request.pids.includes(process.pid)) return pointObservation();
      const configured = pointObservations[pointRead] ?? [];
      pointRead += 1;
      return Array.isArray(configured)
        ? exactPointObservation(request.pids, configured)
        : configured;
    }
    const observation = typeof observations === "function"
      ? observations(groupRead)
      : observations[groupRead];
    groupRead += 1;
    if (!observation) {
      throw new Error("test process observation scenario exhausted");
    }
    return observation;
  });
}

const rollbackMessagePrefix = "injected primary observation failure";
const rollbackMessageTail = "distant primary failure tail";
const rollbackPrimaryFailure = Object.assign(
  new Error(
    `${rollbackMessagePrefix} ${"x".repeat(512)} ${rollbackMessageTail}`,
  ),
  { code: "EIO" },
);

beforeEach(() => {
  nativeBoundary.observeProcessMembers.mockReset();
  nativeBoundary.signalProcessGeneration.mockReset();
  nativeBoundary.signalProcessGeneration.mockResolvedValue(true);
});

it("preserves the reason an exact group could not be observed without signaling", async () => {
  nativeBoundary.observeProcessMembers.mockResolvedValue({
    status: "incomplete",
    reason: "native_observer_timeout",
  });

  await expect(observeOwnedProcessGroup(owner)).resolves.toMatchObject({
    state: "unproven",
    reason: "native_observer_timeout",
  });
  expect(nativeBoundary.signalProcessGeneration).not.toHaveBeenCalled();
});

it("returns a retired receipt when an exact-leader group is absent", async () => {
  observeScenario([groupObservation([]), groupObservation([])]);

  await expect(retireExactLeaderProcessGroup(owner)).resolves.toEqual({
    groupId: owner.pid,
    members: [],
    status: "retired",
  });
  expect(nativeBoundary.observeProcessMembers).toHaveBeenCalledTimes(3);
  expect(nativeBoundary.signalProcessGeneration).not.toHaveBeenCalled();
});

it("returns a retired receipt when an exact-leader group is all zombies", async () => {
  observeScenario([
    groupObservation([
      member(owner, "zombie"),
      member(child, "zombie"),
    ]),
    groupObservation([]),
  ]);

  await expect(retireExactLeaderProcessGroup(owner)).resolves.toEqual({
    groupId: owner.pid,
    members: [],
    status: "retired",
  });
  expect(nativeBoundary.signalProcessGeneration).not.toHaveBeenCalled();
});

it.each([
  {
    failure: "missing leader",
    members: [member(child)],
  },
  {
    failure: "zombie leader",
    members: [member(owner, "zombie"), member(child)],
  },
  {
    failure: "reused leader",
    members: [
      member({ ...owner, processIdentity: "reused-leader-generation" }),
      member(child),
    ],
  },
])("refuses an exact-leader group with a $failure", async ({ members }) => {
  observeScenario([groupObservation(members)]);

  await expect(
    retireExactLeaderProcessGroup(owner),
  ).rejects.toMatchObject({
    code: "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
    message: "exact process group anchor is unavailable",
  });
  expect(nativeBoundary.signalProcessGeneration).not.toHaveBeenCalled();
});

it("refuses an exact leader that escaped an otherwise retired group", async () => {
  observeScenario(
    [groupObservation([])],
    { pointObservations: [[member(owner, "live", 91_002)]] },
  );

  await expect(
    retireExactLeaderProcessGroup(owner),
  ).rejects.toMatchObject({
    code: "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
    message: "exact process group anchor is unavailable",
  });
  expect(nativeBoundary.signalProcessGeneration).not.toHaveBeenCalled();
});

it("refuses an incomplete exact-leader census without signaling", async () => {
  observeScenario([{ status: "incomplete", reason: "fixture" }]);

  await expect(
    retireExactLeaderProcessGroup(owner),
  ).rejects.toMatchObject({
    code: "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
    message: "exact process group census is incomplete",
  });
  expect(nativeBoundary.signalProcessGeneration).not.toHaveBeenCalled();
});

it("refuses an exact group containing the current process", async () => {
  observeScenario([
    groupObservation([
      member(owner),
      member(
        { pid: process.pid, processIdentity: "test-runner-generation" },
      ),
    ]),
  ]);

  await expect(
    retireExactLeaderProcessGroup(owner),
  ).rejects.toMatchObject({
    code: "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
    message: "refusing to signal a process group containing the current process",
  });
  expect(nativeBoundary.signalProcessGeneration).not.toHaveBeenCalled();
});

it("validates retirement options before observing a group", async () => {
  observeScenario([groupObservation([])]);

  await expect(
    retireExactLeaderProcessGroup(owner, { timeoutMs: -1 }),
  ).rejects.toThrow("invalid process group retirement options");
  expect(nativeBoundary.observeProcessMembers).not.toHaveBeenCalled();
  expect(nativeBoundary.signalProcessGeneration).not.toHaveBeenCalled();
});

it("retires an exact-leader process group without inventing a witness", async () => {
  observeScenario([
    groupObservation([member(owner), member(child)]),
    groupObservation([member(owner, "stopped"), member(child, "stopped")]),
    groupObservation([member(owner, "stopped"), member(child, "stopped")]),
    groupObservation([member(owner, "stopped"), member(child, "stopped")]),
    groupObservation([]),
  ]);

  await expect(retireExactLeaderProcessGroup(owner)).resolves.toEqual({
    groupId: owner.pid,
    members: [child, {
      pid: owner.pid,
      processIdentity: owner.processIdentity,
    }],
    status: "retired",
  });
  expect(
    nativeBoundary.signalProcessGeneration.mock.calls.map(
      ([identity, signal]) => `${identity.pid}:${signal}`,
    ),
  ).toEqual([
    `${child.pid}:SIGSTOP`,
    `${owner.pid}:SIGSTOP`,
    `${child.pid}:SIGKILL`,
    `${owner.pid}:SIGKILL`,
  ]);
});

it.each([
  {
    failure: "incomplete retirement observation",
    pointObservation: { status: "incomplete", reason: "fixture" },
    expectedMessage: "exact process group retirement observation is incomplete",
    timeoutMs: 1_000,
  },
  {
    failure: "retirement deadline",
    pointObservation: [member(owner, "live"), member(child, "live")],
    expectedMessage: "exact process group did not retire before the deadline",
    timeoutMs: 0,
    delay: () => new Promise((resolve) => setTimeout(resolve, 5)),
  },
])("fails closed after an $failure", async ({
  delay,
  expectedMessage,
  pointObservation: configuredPointObservation,
  timeoutMs,
}) => {
  observeScenario(
    [
      groupObservation([member(owner), member(child)]),
      groupObservation([member(owner, "stopped"), member(child, "stopped")]),
      groupObservation([member(owner, "stopped"), member(child, "stopped")]),
      groupObservation([member(owner, "stopped"), member(child, "stopped")]),
    ],
    { pointObservations: [configuredPointObservation] },
  );

  await expect(
    retireExactLeaderProcessGroup(owner, { delay, timeoutMs }),
  ).rejects.toMatchObject({
    code: "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
    message: expectedMessage,
  });
});

it("refuses a retired receipt when a process joins after the frozen set", async () => {
  observeScenario([
    groupObservation([member(owner), member(child)]),
    groupObservation([member(owner, "stopped"), member(child, "stopped")]),
    groupObservation([member(owner, "stopped"), member(child, "stopped")]),
    groupObservation([member(owner, "stopped"), member(child, "stopped")]),
    groupObservation([member(lateMember)]),
  ]);

  await expect(
    retireExactLeaderProcessGroup(owner),
  ).rejects.toMatchObject({
    code: "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
    message: "exact process group retained live members after retirement",
  });
});

it("stops multi-batch retirement observation at one operation deadline", async () => {
  const members = [
    owner,
    ...Array.from({ length: 299 }, (_, index) => ({
      pid: 42_000 + index,
      processIdentity: `batch-member-${index}`,
    })),
  ];
  const running = groupObservation(members.map((identity) => member(identity)));
  const stopped = groupObservation(
    members.map((identity) => member(identity, "stopped")),
  );
  const groupObservations = [running, stopped, stopped, stopped];
  let clock = 0;
  let groupRead = 0;
  let retirementPointReads = 0;
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  nativeBoundary.observeProcessMembers.mockImplementation(
    async (request, options) => {
      expect(options.timeoutMs).toBeGreaterThan(0);
      if (request.kind === "group_census") {
        return groupObservations[groupRead++];
      }
      retirementPointReads += 1;
      clock = 2;
      return exactPointObservation(request.pids, []);
    },
  );

  try {
    await expect(
      retireExactLeaderProcessGroup(owner, { timeoutMs: 1 }),
    ).rejects.toMatchObject({
      code: "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
      message: "exact process group did not retire before the deadline",
    });
    expect(retirementPointReads).toBe(1);
    expect(
      nativeBoundary.signalProcessGeneration.mock.calls.every(
        ([, , options]) =>
          options.timeoutMs > 0 && options.timeoutMs <= 1,
      ),
    ).toBe(true);
  } finally {
    clockSpy.mockRestore();
  }
});

it("does not open default-timeout rollback calls after retirement expires", async () => {
  let clock = 0;
  let groupRead = 0;
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  nativeBoundary.observeProcessMembers.mockImplementation(
    async (request, options) => {
      expect(options.timeoutMs).toBeGreaterThan(0);
      if (request.kind !== "group_census") {
        throw new Error("unexpected point observation");
      }
      groupRead += 1;
      if (groupRead === 1) return runningGroup();
      clock = 2;
      return { status: "incomplete", reason: "deadline fixture" };
    },
  );

  try {
    await expect(
      retireExactLeaderProcessGroup(owner, { timeoutMs: 1 }),
    ).rejects.toMatchObject({
      code: "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
      message: expect.stringContaining("exact rollback failed"),
    });
    expect(
      nativeBoundary.signalProcessGeneration.mock.calls.map(
        ([identity, signal, options]) => ({
          options,
          signal: `${identity.pid}:${signal}`,
        }),
      ),
    ).toEqual([
      {
        options: { timeoutMs: 1 },
        signal: `${child.pid}:SIGSTOP`,
      },
      {
        options: { timeoutMs: 1 },
        signal: `${owner.processGroup.witness.pid}:SIGSTOP`,
      },
      {
        options: { timeoutMs: 1 },
        signal: `${owner.pid}:SIGSTOP`,
      },
    ]);
  } finally {
    clockSpy.mockRestore();
  }
});

it("converges when a non-anchor member retires before its exact stop", async () => {
  const withoutRetiredChild = groupObservation([
    member(owner, "stopped"),
    member(preStopped, "stopped"),
    member(owner.processGroup.witness, "stopped"),
  ]);
  observeScenario([
    runningGroup(),
    withoutRetiredChild,
    withoutRetiredChild,
    withoutRetiredChild,
  ]);
  nativeBoundary.signalProcessGeneration.mockImplementation(
    async (identity, signal) =>
      signal === "SIGSTOP" && identity.pid === child.pid ? false : true,
  );

  await expect(signalOwnedProcessGroup(owner, "SIGTERM")).resolves.toBe(true);
  expect(
    nativeBoundary.signalProcessGeneration.mock.calls.map(
      ([identity, signal]) => `${identity.pid}:${signal}`,
    ),
  ).toEqual([
    `${owner.pid}:SIGSTOP`,
    `${child.pid}:SIGSTOP`,
    `${owner.processGroup.witness.pid}:SIGSTOP`,
    `${owner.pid}:SIGTERM`,
    `${preStopped.pid}:SIGTERM`,
    `${owner.processGroup.witness.pid}:SIGTERM`,
    `${owner.pid}:SIGCONT`,
    `${owner.processGroup.witness.pid}:SIGCONT`,
  ]);
});

it("rejects a successfully stopped member missing from a later census", async () => {
  const withoutStoppedChild = groupObservation([
    member(owner, "stopped"),
    member(preStopped, "stopped"),
    member(owner.processGroup.witness, "stopped"),
  ]);
  observeScenario([
    runningGroup(),
    stoppedGroup(),
    withoutStoppedChild,
    withoutStoppedChild,
    withoutStoppedChild,
    withoutStoppedChild,
  ]);

  await expect(signalOwnedProcessGroup(owner, "SIGTERM")).rejects.toMatchObject({
    code: "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
    message: "a stopped exact process group member changed while freezing",
  });
  expect(
    nativeBoundary.signalProcessGeneration.mock.calls.map(
      ([identity, signal]) => `${identity.pid}:${signal}`,
    ),
  ).toEqual([
    `${owner.pid}:SIGSTOP`,
    `${child.pid}:SIGSTOP`,
    `${owner.processGroup.witness.pid}:SIGSTOP`,
    `${owner.pid}:SIGCONT`,
    `${child.pid}:SIGCONT`,
    `${owner.processGroup.witness.pid}:SIGCONT`,
  ]);
});

it.each([
  {
    failure: "an incomplete confirmation",
    observations: [
      runningGroup(),
      { status: "incomplete", reason: "fixture" },
    ],
    expectedMessage: "exact process group confirmation is incomplete",
  },
  {
    failure: "a missing exact anchor",
    observations: [runningGroup(), stoppedGroup({ includeWitness: false })],
    expectedMessage: "exact process group anchor is unavailable",
  },
  {
    failure: "bounded nonconvergence",
    observations: () => runningGroup(),
    expectedMessage: "exact process group did not reach a bounded fixed point",
    stopPasses: 32,
  },
  {
    failure: "a rollback signal failure",
    observations: (groupRead) => {
      if (groupRead === 0) return runningGroup();
      throw rollbackPrimaryFailure;
    },
    expectedCode: "EIO",
    expectedPrimaryFailure: rollbackPrimaryFailure,
    rollbackFailurePid: child.pid,
  },
])("rolls back newly stopped generations after $failure", async ({
  expectedCode = "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
  expectedMessage,
  expectedPrimaryFailure,
  observations,
  rollbackFailurePid,
  stopPasses = 1,
}) => {
  observeScenario(observations);
  if (rollbackFailurePid) {
    nativeBoundary.signalProcessGeneration.mockImplementation(
      async (identity, signal) => {
        if (signal === "SIGCONT" && identity.pid === rollbackFailurePid) {
          throw new Error("injected exact resume failure");
        }
        return true;
      },
    );
  }

  let failure;
  try {
    await signalOwnedProcessGroup(owner, "SIGTERM");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure.code).toBe(expectedCode);
  if (rollbackFailurePid) {
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.cause).toBe(failure.errors[0]);
    expect(failure.errors[0]).toBe(expectedPrimaryFailure);
    expect(failure.errors[1].message).toBe("injected exact resume failure");
    expect(failure.message.startsWith(rollbackMessagePrefix)).toBe(true);
    expect(failure.message).not.toContain(rollbackMessageTail);
    expect(failure.message).toContain("exact rollback failed for 41002");
    expect(failure.message.length).toBeLessThan(512);
  } else {
    expect(failure.message).toBe(expectedMessage);
  }

  const stopTrace = [owner.pid, child.pid, owner.processGroup.witness.pid]
    .map((pid) => `${pid}:SIGSTOP`);
  expect(
    nativeBoundary.signalProcessGeneration.mock.calls.map(
      ([identity, signal]) => `${identity.pid}:${signal}`,
    ),
  ).toEqual([
    ...Array.from({ length: stopPasses }, () => stopTrace).flat(),
    `${owner.pid}:SIGCONT`,
    `${child.pid}:SIGCONT`,
    `${owner.processGroup.witness.pid}:SIGCONT`,
  ]);
});

it.each([
  { outcome: "retired", signal: "SIGTERM" },
  { outcome: "succeeded", signal: "SIGKILL" },
  { outcome: "retired", signal: "SIGKILL" },
  {
    outcome: "failed",
    signal: "SIGTERM",
    expectedFailureMessage: "first exact termination failure",
  },
  {
    outcome: "multiple failures",
    signal: "SIGKILL",
    expectedFailureMessage:
      "multiple exact process group members could not be terminated",
  },
])(
  "continues $signal after an exact frozen member is $outcome",
  async ({ expectedFailureMessage, outcome, signal }) => {
    observeScenario([
      groupObservation([
        member(owner),
        member(preStopped, "stopped"),
        member(owner.processGroup.witness),
      ]),
      groupObservation([
        member(owner, "stopped"),
        member(preStopped, "stopped"),
        member(owner.processGroup.witness, "stopped"),
      ]),
      groupObservation([
        member(owner, "stopped"),
        member(preStopped, "stopped"),
        member(owner.processGroup.witness, "stopped"),
      ]),
      groupObservation([
        member(owner, "stopped"),
        member(preStopped, "stopped"),
        member(owner.processGroup.witness, "stopped"),
      ]),
    ]);
    nativeBoundary.signalProcessGeneration.mockImplementation(
      async (identity, observedSignal) => {
        if (observedSignal !== signal) return true;
        if (identity.pid === owner.pid) {
          if (outcome === "retired") return false;
          if (outcome === "failed" || outcome === "multiple failures") {
            throw new Error("first exact termination failure");
          }
        }
        if (
          outcome === "multiple failures" &&
          identity.pid === preStopped.pid
        ) {
          throw new Error("second exact termination failure");
        }
        return true;
      },
    );

    let failure;
    try {
      await signalOwnedProcessGroup(owner, signal);
    } catch (error) {
      failure = error;
    }
    if (outcome === "retired" || outcome === "succeeded") {
      expect(failure).toBeUndefined();
    } else if (outcome === "failed") {
      expect(failure?.message).toBe(expectedFailureMessage);
    } else {
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.message).toBe(expectedFailureMessage);
      expect(failure.errors.map(({ message }) => message)).toEqual([
        "first exact termination failure",
        "second exact termination failure",
      ]);
    }

    expect(
      nativeBoundary.signalProcessGeneration.mock.calls
        .map(([identity, observedSignal]) =>
          `${identity.pid}:${observedSignal}`
        ),
    ).toEqual([
      `${owner.pid}:SIGSTOP`,
      `${owner.processGroup.witness.pid}:SIGSTOP`,
      `${owner.pid}:${signal}`,
      `${preStopped.pid}:${signal}`,
      ...(signal === "SIGKILL" && outcome === "multiple failures"
        ? []
        : [`${owner.processGroup.witness.pid}:${signal}`]),
      ...(signal === "SIGTERM"
        ? [
            ...(outcome === "retired" ? [] : [`${owner.pid}:SIGCONT`]),
            `${owner.processGroup.witness.pid}:SIGCONT`,
          ]
        : []),
    ]);
  },
);
