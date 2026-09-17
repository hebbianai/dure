import { describe, expect, test, vi } from "vitest";
import {
  captureOwnedProcessSnapshot,
  observeOwnedProcessSnapshot,
} from "./owned-process-snapshot.mjs";

const BOOT = "00000000-0000-0000-0000-000000000001";

function owned(pid, uniqueId) {
  return {
    kernelStartMarker: `kernel-start-v3:macos:${BOOT}:${uniqueId}`,
    pid,
  };
}

function identityCensus(relations, effectiveUid = process.geteuid?.()) {
  return {
    relations,
    scope: {
      effectiveUid,
      evidence: "closed_enumeration",
      kind: "user_identity_census",
    },
    status: "complete",
  };
}

describe("owned process snapshot", () => {
  test("freezes the ledger and selects exact current-user generations once", async () => {
    const stale = owned(41_001, 101);
    const live = owned(41_002, 102);
    const observeIdentities = vi.fn(async () =>
      identityCensus([
        {
          parentProcessIdentity: null,
          pid: stale.pid,
          processIdentity: `kernel-start-v3:macos:${BOOT}:999`,
        },
        {
          parentProcessIdentity: null,
          pid: 49_999,
          processIdentity: stale.kernelStartMarker,
        },
        {
          parentProcessIdentity: null,
          pid: live.pid,
          processIdentity: live.kernelStartMarker,
        },
      ])
    );

    const snapshot = await captureOwnedProcessSnapshot([stale, live], {
      observeIdentities,
      platform: "darwin",
    });

    expect(observeIdentities).toHaveBeenCalledOnce();
    expect(snapshot.ledger).toEqual([stale, live]);
    expect(snapshot.ledger[0]).not.toBe(stale);
    expect(Object.isFrozen(snapshot.ledger)).toBe(true);
    expect(Object.isFrozen(snapshot.ledger[0])).toBe(true);
    expect(snapshot.candidates).toEqual([
      {
        exact: {
          pid: live.pid,
          processIdentity: live.kernelStartMarker,
        },
        expected: snapshot.ledger[1],
      },
    ]);
  });

  test("an empty ledger does not start a user identity census", async () => {
    const observeIdentities = vi.fn();

    const snapshot = await captureOwnedProcessSnapshot([], {
      observeIdentities,
      platform: "darwin",
    });

    expect(snapshot).toMatchObject({ candidates: [], ledger: [] });
    expect(observeIdentities).not.toHaveBeenCalled();
  });

  test("rejects a census outside the current user authority", async () => {
    const record = owned(41_001, 101);

    await expect(
      captureOwnedProcessSnapshot([record], {
        observeIdentities: async () => identityCensus([], 999_999),
        platform: "darwin",
      }),
    ).rejects.toThrow("owned_process_identity_snapshot_unavailable");
  });

  test("normalizes a census adapter failure at the snapshot boundary", async () => {
    await expect(
      captureOwnedProcessSnapshot([owned(41_001, 101)], {
        observeIdentities: async () => {
          throw new Error("injected census failure");
        },
        platform: "darwin",
      }),
    ).rejects.toThrow(
      "owned_process_identity_snapshot_unavailable: injected census failure",
    );
  });

  test("rejects detailed metadata outside the captured point scope", async () => {
    const record = owned(41_001, 101);
    const observeIdentities = async () =>
      identityCensus([
        {
          parentProcessIdentity: null,
          pid: record.pid,
          processIdentity: record.kernelStartMarker,
        },
      ]);
    const snapshot = await captureOwnedProcessSnapshot([record], {
      observeIdentities,
      platform: "darwin",
    });

    await expect(
      observeOwnedProcessSnapshot(snapshot, {
        observeIdentities,
        observeMembers: async () => ({
          members: [],
          scope: { kind: "point", requestedPids: [] },
          status: "complete",
        }),
      }),
    ).rejects.toThrow("owned_process_observation_scope_mismatch");
  });

  test("converges when an exact candidate PID is reused after the fresh identity census", async () => {
    const record = owned(41_001, 101);
    const replacement = owned(record.pid, 999);
    const observeIdentities = vi
      .fn()
      .mockResolvedValueOnce(identityCensus([
        {
          parentProcessIdentity: null,
          pid: record.pid,
          processIdentity: record.kernelStartMarker,
        },
      ]))
      .mockResolvedValueOnce(identityCensus([
        {
          parentProcessIdentity: null,
          pid: record.pid,
          processIdentity: record.kernelStartMarker,
        },
      ]))
      .mockResolvedValueOnce(identityCensus([
        {
          parentProcessIdentity: null,
          pid: replacement.pid,
          processIdentity: replacement.kernelStartMarker,
        },
      ]));
    const snapshot = await captureOwnedProcessSnapshot([record], {
      observeIdentities,
      platform: "darwin",
    });
    const observeMembers = vi.fn(async (request) => ({
      reason: "process_member_observation_failed",
      scope: { kind: "point", requestedPids: request.pids },
      status: "incomplete",
    }));

    await expect(
      observeOwnedProcessSnapshot(snapshot, {
        observeIdentities,
        observeMembers,
      }),
    ).resolves.toEqual({
      members: [],
      scope: { kind: "point", requestedPids: [] },
      status: "complete",
    });
    expect(observeIdentities).toHaveBeenCalledTimes(3);
    expect(observeMembers).toHaveBeenCalledOnce();
  });

  test("refreshes captured generations before stale metadata can exhaust the deadline", async () => {
    const stale = owned(41_001, 101);
    const live = owned(41_002, 102);
    const relations = (records) => identityCensus(records.map((record) => ({
      parentProcessIdentity: null,
      pid: record.pid,
      processIdentity: record.kernelStartMarker,
    })));
    const observeIdentities = vi.fn()
      .mockResolvedValueOnce(relations([stale, live]))
      .mockResolvedValue(relations([owned(stale.pid, 999), live]));
    const snapshot = await captureOwnedProcessSnapshot([stale, live], {
      observeIdentities,
      platform: "darwin",
    });
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const observeMembers = vi.fn(async (request, { timeoutMs }) => {
      const scope = { kind: "point", requestedPids: request.pids };
      if (request.pids.includes(stale.pid)) {
        elapsed += timeoutMs;
        return {
          reason: "process_member_observation_timeout",
          scope,
          status: "incomplete",
        };
      }
      return {
        members: [{ pid: live.pid, processIdentity: live.kernelStartMarker }],
        scope,
        status: "complete",
      };
    });
    try {
      await expect(observeOwnedProcessSnapshot(snapshot, {
        observeIdentities,
        observeMembers,
        timeoutMs: 50,
      })).resolves.toMatchObject({
        members: [{ pid: live.pid, processIdentity: live.kernelStartMarker }],
        scope: { kind: "point", requestedPids: [live.pid] },
        status: "complete",
      });
      expect(observeMembers).toHaveBeenCalledExactlyOnceWith(
        { kind: "point", pids: [live.pid] },
        { platform: "darwin", timeoutMs: 50 },
      );
      expect(snapshot.candidates.map(({ expected }) => expected)).toEqual([
        stale,
        live,
      ]);
      expect(snapshot.ledger).toEqual([stale, live]);
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    { reason: "process_identity_census_failed", status: "incomplete" },
    identityCensus([], 999_999),
    { ...identityCensus([]), relations: undefined },
  ])("refuses an unavailable fresh identity census before metadata: %j", async (fresh) => {
    const record = owned(41_001, 101);
    const observeIdentities = vi.fn().mockResolvedValueOnce(identityCensus([{
      parentProcessIdentity: null,
      pid: record.pid,
      processIdentity: record.kernelStartMarker,
    }])).mockResolvedValue(fresh);
    const snapshot = await captureOwnedProcessSnapshot([record], {
      observeIdentities,
      platform: "darwin",
    });
    const observeMembers = vi.fn(async () => ({
      members: [],
      scope: { kind: "point", requestedPids: [record.pid] },
      status: "complete",
    }));

    await expect(observeOwnedProcessSnapshot(snapshot, {
      observeIdentities,
      observeMembers,
    })).rejects.toThrow("owned_process_identity_snapshot_unavailable");
    expect(observeMembers).not.toHaveBeenCalled();
  });

  test("keeps metadata failure unknown when the exact generation survives", async () => {
    const record = owned(41_001, 101);
    const observeIdentities = vi.fn(async () => identityCensus([{
      parentProcessIdentity: null,
      pid: record.pid,
      processIdentity: record.kernelStartMarker,
    }]));
    const snapshot = await captureOwnedProcessSnapshot([record], {
      observeIdentities,
      platform: "darwin",
    });
    const failure = {
      diagnostic: "proc_bsdinfo: permission denied",
      reason: "process_member_observation_failed",
      scope: { kind: "point", requestedPids: [record.pid] },
      status: "incomplete",
    };
    const observeMembers = vi.fn(async () => failure);

    await expect(observeOwnedProcessSnapshot(snapshot, {
      observeIdentities,
      observeMembers,
    })).resolves.toBe(failure);
    expect(observeMembers).toHaveBeenCalledOnce();
  });

  test("charges the fresh census to the shared observation deadline", async () => {
    const record = owned(41_001, 101);
    const census = identityCensus([{
      parentProcessIdentity: null,
      pid: record.pid,
      processIdentity: record.kernelStartMarker,
    }]);
    const snapshot = await captureOwnedProcessSnapshot([record], {
      observeIdentities: async () => census,
      platform: "darwin",
    });
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const observeMembers = vi.fn();
    try {
      await expect(observeOwnedProcessSnapshot(snapshot, {
        observeIdentities: async ({ timeoutMs }) => {
          elapsed += timeoutMs;
          return census;
        },
        observeMembers,
        timeoutMs: 50,
      })).resolves.toMatchObject({
        reason: "process_member_observation_timeout",
        status: "incomplete",
      });
      expect(observeMembers).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("does not observe identities or metadata for an empty captured snapshot", async () => {
    const snapshot = await captureOwnedProcessSnapshot([], {
      platform: "darwin",
    });
    const observeIdentities = vi.fn();
    const observeMembers = vi.fn();

    await expect(observeOwnedProcessSnapshot(snapshot, {
      observeIdentities,
      observeMembers,
    })).resolves.toEqual({
      members: [],
      scope: { kind: "point", requestedPids: [] },
      status: "complete",
    });
    expect(observeIdentities).not.toHaveBeenCalled();
    expect(observeMembers).not.toHaveBeenCalled();
  });

  test("keeps the Linux point observation independent of a user identity census", async () => {
    const record = {
      pid: 41_001,
      kernelStartMarker: `kernel-start-v2:linux:${BOOT}:101`,
    };
    const observeIdentities = vi.fn();
    const snapshot = await captureOwnedProcessSnapshot([record], {
      observeIdentities,
      platform: "linux",
    });
    const observation = {
      members: [],
      scope: { kind: "point", requestedPids: [record.pid] },
      status: "complete",
    };
    const observeMembers = vi.fn(async () => observation);

    await expect(observeOwnedProcessSnapshot(snapshot, {
      observeIdentities,
      observeMembers,
    })).resolves.toBe(observation);
    expect(observeIdentities).not.toHaveBeenCalled();
    expect(observeMembers).toHaveBeenCalledExactlyOnceWith(
      { kind: "point", pids: [record.pid] },
      { platform: "linux" },
    );
  });
});
