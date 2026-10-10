import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runWithBuildStorage } from "../run-with-build-storage.mjs";
import {
  assertHeadroom,
  ensureHeadroom,
} from "./build-storage-admission.mjs";
import { inspectBuildStorageReservations } from "./build-storage-reservation.mjs";
import { GIB } from "./disk-space.mjs";
import { withoutLocalGitOverrides } from "./git-environment.mjs";

describe("build storage admission", () => {
  it("reports the holding worktree and refuses the runner until its real lease is released", () => {
    const root = mkdtempSync(join(tmpdir(), "dure-storage-refusal-"));
    const repository = join(root, "repository");
    const worktree = join(root, "worker");
    const reservationRoot = join(root, "reservations");
    const environment = withoutLocalGitOverrides({
      ...process.env,
      HOME: join(root, "home"),
      DURE_HOME: join(root, "dure-home"),
      HMUX_DISCOVERY_ROOT: join(root, "hmux-discovery"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
    });
    mkdirSync(repository);
    mkdirSync(environment.HOME);
    const git = (...args) => execFileSync("git", args, {
      cwd: repository,
      env: environment,
      stdio: "pipe",
    });
    const observeProcesses = (pids) => ({
      status: "complete",
      scope: { kind: "point", requestedPids: pids },
      members: pids.map((pid) => ({
        pid, processIdentity: `fixture:${pid}`, state: "live",
      })),
    });
    const reclaimOutputs = vi.fn(() => ({
      availableAfter: 77 * GIB, removed: [], removedBytes: 0,
    }));
    let held;
    try {
      git("init", "--quiet");
      git(
        "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "commit", "--allow-empty", "-m", "fixture",
      );
      git("worktree", "add", "-b", "worker", worktree);
      mkdirSync(join(worktree, "target"));
      const canary = join(worktree, "target", "keep-cache");
      writeFileSync(canary, "untouched cache");
      const common = {
        environment: {},
        reservationRoot,
        reclaimOutputs,
        log: () => {},
        observeAvailableBytes: () => 100 * GIB,
      };
      held = ensureHeadroom({
        ...common,
        cwd: worktree,
        label: "custom build",
        buildClass: "dev",
        requestedBytes: 20 * GIB,
        reservationOptions: {
          pid: 41, ownerIdentity: "fixture:41", observeProcesses, nowMs: 1_000,
        },
      });
      expect(held.ok).toBe(true);
      expect(held.reservation.record.cwd).toBe(worktree);
      const run = vi.fn(() => ({ status: 0 }));
      const invoke = () => runWithBuildStorage(
        ["cli", "--", "fixture-command"],
        {
          cwd: repository, environment, run,
          admit: (options) => ensureHeadroom({
            ...common, ...options, observeAvailableBytes: () => 77 * GIB,
            reservationOptions: {
              pid: 42, ownerIdentity: "fixture:42", observeProcesses, nowMs: 121_000,
            },
          }),
        },
      );
      let refusal;
      try {
        invoke();
      } catch (error) {
        refusal = error.message;
      }
      expect(refusal).toContain("needs 84.0 GiB of free space");
      expect(run).not.toHaveBeenCalled();
      expect(reclaimOutputs).toHaveBeenCalledOnce();
      expect(refusal).toContain("pid=41 class=dev reserved=20.0 GiB age=2m");
      expect(refusal).toContain(`worktree=${JSON.stringify(worktree)}`);
      expect(refusal).not.toContain("pid=42");
      expect(refusal).not.toContain(held.reservation.record.token);
      expect(refusal).not.toContain("fixture-command");
      const activeLeases = () => inspectBuildStorageReservations({
        cwd: repository, reservationRoot, observeProcesses,
      }).active;
      expect(activeLeases()).toHaveLength(1);
      expect(held.reservation.release()).toBe(true);
      expect(invoke()).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(activeLeases()).toHaveLength(0);
      expect(readFileSync(canary, "utf8")).toBe("untouched cache");
    } finally {
      held?.reservation?.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a changed authority failure after reclaim without claiming only a space shortage", () => {
    const reserve = vi.fn()
      .mockReturnValueOnce({ ok: false, reason: "insufficient_unreserved_space", reservedBytes: 20 })
      .mockReturnValueOnce({ ok: false, reason: "reservation_state_invalid", reservedBytes: 20 });
    const result = ensureHeadroom({
      environment: {}, requestedBytes: 4, floorBytes: 60, log: () => {}, reserve,
      observeAvailableBytes: () => 77,
      reclaimOutputs: () => ({ availableAfter: 77, removed: [], removedBytes: 0 }),
    });
    expect(result.message).toContain("reservation_state_invalid");
    expect(result.message).not.toContain("it needs");
    expect(reserve).toHaveBeenCalledTimes(2);
  });

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
