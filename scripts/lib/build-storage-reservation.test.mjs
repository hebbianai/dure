import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptBuildStorageReservation,
  buildStorageReservationRoot,
  inspectBuildStorageReservations,
  reserveBuildStorage,
  storageVolumeId,
} from "./build-storage-reservation.mjs";

const roots = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-build-storage-test-"));
  roots.push(root);
  return root;
}

function completeProcessObservation(identities) {
  return (pids) => {
    const requestedPids = [...new Set(pids)].sort((left, right) => left - right);
    return {
      status: "complete",
      scope: { kind: "point", requestedPids },
      members: requestedPids.flatMap((pid) => {
        const processIdentity = identities.get(pid);
        return processIdentity
          ? [{ pid, processIdentity, state: "live" }]
          : [];
      }),
    };
  };
}

function reserve({
  cwd,
  reservationRoot,
  pid,
  ownerIdentity,
  identities,
  availableBytes = 100,
  floorBytes = 20,
  requestedBytes = 50,
  nowMs = 1_000,
  ttlMs,
}) {
  return reserveBuildStorage({
    availableBytes,
    cwd,
    floorBytes,
    label: "fixture",
    nowMs,
    observeProcesses: completeProcessObservation(identities),
    ownerIdentity,
    pid,
    requestedBytes,
    reservationRoot,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("build storage reservation", () => {
  it("uses one OS-account ledger independent of product runtime roots", () => {
    expect(buildStorageReservationRoot("/host/account")).toBe(
      join("/host/account", ".dure", "build-storage-reservations-v1"),
    );
  });

  it("never over-approves two concurrently published process leases", async () => {
    const cwd = temporaryRoot();
    const reservationRoot = join(temporaryRoot(), "reservations");
    const worker = new URL(
      "../fixtures/build-storage-reservation-worker.mjs",
      import.meta.url,
    );
    const children = Array.from({ length: 2 }, () =>
      fork(worker, [cwd, reservationRoot], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      }),
    );
    const exits = children.map((child) => once(child, "exit"));
    try {
      await Promise.all(
        children.map(async (child) => {
          const [message] = await once(child, "message");
          expect(message).toEqual({ ready: true });
        }),
      );
      const results = children.map(
        (child) =>
          new Promise((resolve) => {
            child.once("message", resolve);
            child.send({ start: true });
          }),
      );

      const outcomes = await Promise.all(results);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
        expect.objectContaining({ reason: "insufficient_unreserved_space" }),
      ]);
    } finally {
      for (const child of children) {
        if (child.connected) child.send({ release: true });
      }
      await Promise.all(exits);
    }
  });

  it("admits at most the capacity left above the shared floor", () => {
    const cwd = temporaryRoot();
    const reservationRoot = join(temporaryRoot(), "reservations");
    const identities = new Map([
      [41, "fixture:41"],
      [42, "fixture:42"],
    ]);
    const first = reserve({
      cwd,
      reservationRoot,
      pid: 41,
      ownerIdentity: "fixture:41",
      identities,
    });
    const second = reserve({
      cwd,
      reservationRoot,
      pid: 42,
      ownerIdentity: "fixture:42",
      identities,
    });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      reason: "insufficient_unreserved_space",
    });
    expect(first.reservation.release()).toBe(true);
  });

  it("fails closed while a malformed publication is too new to reclaim", () => {
    const cwd = temporaryRoot();
    const reservationRoot = join(temporaryRoot(), "reservations");
    const volumeId = storageVolumeId(cwd);
    const directory = join(reservationRoot, `volume-${volumeId}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, `lease-${"a".repeat(32)}.json`), "{\n", {
      mode: 0o600,
    });

    const result = reserve({
      cwd,
      reservationRoot,
      pid: 41,
      ownerIdentity: "fixture:41",
      identities: new Map([[41, "fixture:41"]]),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "reservation_state_invalid",
    });
  });

  it("reclaims a crashed or PID-reused owner by exact process identity", () => {
    const cwd = temporaryRoot();
    const reservationRoot = join(temporaryRoot(), "reservations");
    const identities = new Map([[41, "generation:old"]]);
    const stale = reserve({
      cwd,
      reservationRoot,
      pid: 41,
      ownerIdentity: "generation:old",
      identities,
      requestedBytes: 60,
    });
    expect(stale.ok).toBe(true);

    identities.set(41, "generation:new");
    const replacement = reserve({
      cwd,
      reservationRoot,
      pid: 41,
      ownerIdentity: "generation:new",
      identities,
      requestedBytes: 60,
    });

    expect(replacement.ok).toBe(true);
    expect(replacement.reclaimed).toHaveLength(1);
    expect(stale.reservation.release()).toBe(false);
    expect(replacement.reservation.release()).toBe(true);
  });

  it("keeps an unknown owner only for its bounded TTL", () => {
    const cwd = temporaryRoot();
    const reservationRoot = join(temporaryRoot(), "reservations");
    const identities = new Map([[41, "fixture:41"]]);
    const lease = reserve({
      cwd,
      reservationRoot,
      pid: 41,
      ownerIdentity: "fixture:41",
      identities,
      ttlMs: 10,
    });
    expect(lease.ok).toBe(true);

    const report = inspectBuildStorageReservations({
      cwd,
      nowMs: 1_011,
      observeProcesses: () => ({
        status: "incomplete",
        reason: "fixture unavailable",
      }),
      reclaimStale: true,
      reservationRoot,
    });
    expect(report.active).toEqual([]);
    expect(report.reclaimed).toHaveLength(1);
    expect(report.reservedBytes).toBe(0);
    expect(lease.reservation.release()).toBe(false);
  });

  it("lets descendants reuse a larger inherited reservation without double booking", () => {
    const cwd = temporaryRoot();
    const reservationRoot = join(temporaryRoot(), "reservations");
    const identities = new Map([[41, "fixture:41"]]);
    const lease = reserve({
      cwd,
      reservationRoot,
      pid: 41,
      ownerIdentity: "fixture:41",
      identities,
    });
    const adopted = adoptBuildStorageReservation({
      capability: lease.reservation.capability,
      cwd,
      observeProcesses: completeProcessObservation(identities),
      ownerIdentity: "fixture:99",
      pid: 99,
      requestedBytes: 10,
      reservationRoot,
    });

    expect(adopted).toMatchObject({ owned: false });
    expect(adopted.release()).toBe(false);
    expect(lease.reservation.release()).toBe(true);
  });

  it("restores exact lease ownership after an in-place process exec", () => {
    const cwd = temporaryRoot();
    const reservationRoot = join(temporaryRoot(), "reservations");
    const identities = new Map([[41, "fixture:41"]]);
    const lease = reserve({
      cwd,
      reservationRoot,
      pid: 41,
      ownerIdentity: "fixture:41",
      identities,
    });
    const resumed = adoptBuildStorageReservation({
      capability: lease.reservation.capability,
      cwd,
      observeProcesses: completeProcessObservation(identities),
      ownerIdentity: "fixture:41",
      pid: 41,
      requestedBytes: 10,
      reservationRoot,
    });

    expect(resumed).toMatchObject({ owned: true });
    expect(resumed.release()).toBe(true);
    expect(lease.reservation.release()).toBe(false);
  });

  it("keeps normal admission below 100ms after process observation is ready", () => {
    const cwd = temporaryRoot();
    const reservationRoot = join(temporaryRoot(), "reservations");
    const identities = new Map([[41, "fixture:41"]]);
    const durations = [];
    for (let index = 0; index < 7; index += 1) {
      const startedAt = performance.now();
      const lease = reserve({
        cwd,
        reservationRoot,
        pid: 41,
        ownerIdentity: "fixture:41",
        identities,
      });
      durations.push(performance.now() - startedAt);
      expect(lease.ok).toBe(true);
      lease.reservation.release();
    }
    durations.sort((left, right) => left - right);
    expect(durations[Math.floor(durations.length / 2)]).toBeLessThan(100);
  });
});
