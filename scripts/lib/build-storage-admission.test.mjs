import { describe, expect, it, vi } from "vitest";
import {
  assertHeadroom,
  ensureHeadroom,
} from "./build-storage-admission.mjs";
import { GIB } from "./disk-space.mjs";

describe("build storage admission", () => {
  it("reuses one injected safe reclaimer for the legacy floor path", () => {
    const reclaimOutputs = vi.fn(() => ({
      availableAfter: 120,
      removed: [{ path: "/generated/target" }],
      removedBytes: 70,
    }));
    const result = ensureHeadroom({
      cwd: process.cwd(),
      floorBytes: 100,
      goalBytes: 200,
      label: "fixture",
      log: () => {},
      observeAvailableBytes: () => 50,
      reclaimOutputs,
    });

    expect(result).toMatchObject({ ok: true, availableBytes: 120 });
    expect(reclaimOutputs).toHaveBeenCalledWith({
      cwd: process.cwd(),
      apply: true,
      floorBytes: 100,
      goalBytes: 200,
    });
  });

  it("fails a budgeted build closed without authoritative physical capacity", () => {
    const reclaimOutputs = vi.fn();
    const result = ensureHeadroom({
      cwd: process.cwd(),
      environment: {},
      label: "fixture build",
      observeAvailableBytes: () => null,
      reclaimOutputs,
      requestedBytes: 10,
      reserve: () => ({
        ok: false,
        reason: "available_space_unknown",
        reservation: null,
        reservedBytes: null,
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("was not started");
    expect(reclaimOutputs).not.toHaveBeenCalled();
  });

  it("states the total free space a refused build needs, not only the floor", () => {
    // The refusal used to print the floor beside physical free space. Whenever
    // the request and peer reservations were what pushed unreserved capacity
    // under the floor — the common case — it read as a contradiction: "below
    // the 60.0 GiB floor (physical 103.8 GiB)". Name the sum it is compared to.
    const messages = [];
    const result = ensureHeadroom({
      cwd: process.cwd(),
      environment: {},
      floorBytes: 60 * GIB,
      label: "fixture build",
      log: (line) => messages.push(line),
      observeAvailableBytes: () => 70 * GIB,
      reclaimOutputs: () => ({
        availableAfter: 70 * GIB,
        removed: [],
        removedBytes: 0,
      }),
      requestedBytes: 20 * GIB,
      reserve: () => ({
        ok: false,
        reason: "insufficient_unreserved_space",
        reservation: null,
        reservedBytes: 5 * GIB,
      }),
    });

    expect(result.ok).toBe(false);
    // 60 floor + 20 request + 5 held by peers = 85, against 70.0 GiB free.
    expect(result.message).toContain("needs 85.0 GiB of free space");
    expect(result.message).toContain("this volume has 70.0 GiB");
    expect(result.message).toContain(
      "60.0 GiB floor + 20.0 GiB for this build + 5.0 GiB reserved",
    );
    expect(messages.join("\n")).toContain("needs 85.0 GiB free");
  });

  it("turns the shared result into one throwing launch boundary", () => {
    expect(() =>
      assertHeadroom({}, () => ({ ok: false, message: "fixture refusal" })),
    ).toThrow("fixture refusal");
  });

  it("uses the no-op GC's physical observation, not its cache total or success flag", () => {
    const reserve = vi.fn(() => ({
      ok: false,
      reason: "insufficient_unreserved_space",
      reservation: null,
      reservedBytes: 0,
    }));
    const result = ensureHeadroom({
      cwd: process.cwd(),
      environment: {},
      floorBytes: 60,
      goalBytes: 120,
      requestedBytes: 20,
      log: () => {},
      observeAvailableBytes: () => 200,
      reserve,
      reclaimOutputs: () => ({
        availableAfter: 70,
        totalCacheAfter: 0,
        removed: [],
        removedBytes: 0,
        satisfied: true,
      }),
    });

    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls.map(([request]) => request.availableBytes)).toEqual([200, 70]);
    expect(result.ok).toBe(false);
    expect(result.availableBytes).toBe(70);
  });
});
