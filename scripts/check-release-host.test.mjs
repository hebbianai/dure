import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runReleaseHostCheck } from "./check-release-host.mjs";
import {
  RELEASE_HOST_MAX_LOAD_PER_CORE,
  RELEASE_HOST_WAIT_MINUTES,
  assessReleaseHost,
  releaseHostResourcePolicy,
} from "./lib/release-host-admission.mjs";

const observation = (patch = {}) => ({
  observedAt: new Date().toISOString(),
  oneMinuteLoad: 155.2,
  logicalCores: 16,
  loadPerCore: 155.2 / 16,
  memoryPressure: "normal",
  ...patch,
});

describe("release host admission", () => {
  it("admits the load the v0.2.56 build succeeded at and refuses the loads it failed at", () => {
    expect(RELEASE_HOST_MAX_LOAD_PER_CORE).toBe(16);
    expect(assessReleaseHost(observation())).toMatchObject({ ok: true, code: null, maxLoadPerCore: 16 });
    for (const load of [400, 935]) {
      const verdict = assessReleaseHost(observation({ oneMinuteLoad: load, loadPerCore: load / 16 }));
      expect(verdict).toMatchObject({ ok: false, code: "release_host_overloaded", oneMinuteLoad: load, logicalCores: 16 });
      expect(verdict.message).toMatch(
        new RegExp(`^release_host_overloaded: one-minute load average ${load}\\.0 is \\d+\\.\\d per logical core on 16 cores; release work admits at most 16 per core`),
      );
    }
    expect(assessReleaseHost(observation({ oneMinuteLoad: 256, loadPerCore: 16 })).ok).toBe(true);
    expect(assessReleaseHost(observation({ oneMinuteLoad: 257.6, loadPerCore: 16.1 })).ok).toBe(false);
    expect(assessReleaseHost(observation({ oneMinuteLoad: 1, loadPerCore: 0.5 }), { maxLoadPerCore: 0.25 }).code).toBe("release_host_overloaded");
  });

  it("never admits an unobservable or memory-critical host", () => {
    expect(assessReleaseHost(observation({ oneMinuteLoad: null, loadPerCore: null })).code).toBe("release_host_load_unavailable");
    expect(assessReleaseHost(observation({ loadPerCore: -1 })).code).toBe("release_host_load_unavailable");
    expect(assessReleaseHost(undefined).code).toBe("release_host_load_unavailable");
    expect(assessReleaseHost(observation({ memoryPressure: "critical" })).code).toBe("release_host_memory_critical");
    expect(assessReleaseHost(observation({ memoryPressure: "warning" })).ok).toBe(true);
    expect(assessReleaseHost(observation({ memoryPressure: "unknown" })).ok).toBe(true);
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assessReleaseHost(observation(), { maxLoadPerCore: limit })).toThrow("release_host_load_limit_invalid");
    }
  });

  it("exposes the verdict through the CLI with the configured limit", async () => {
    const observe = async () => observation({ oneMinuteLoad: 480, loadPerCore: 30 });
    await expect(runReleaseHostCheck([], { observe })).resolves.toMatchObject({ ok: false, code: "release_host_overloaded", maxLoadPerCore: 16 });
    await expect(runReleaseHostCheck(["--max-load-per-core", "40"], { observe })).resolves.toMatchObject({ ok: true, maxLoadPerCore: 40 });
    await expect(runReleaseHostCheck(["--max-load-per-core", "abc"], { observe })).rejects.toThrow("release_host_load_limit_invalid");
    await expect(runReleaseHostCheck(["--bogus"], { observe })).rejects.toThrow();
    await expect(runReleaseHostCheck(["status"], { observe })).rejects.toThrow();
    expect((await runReleaseHostCheck(["--help"])).help).toContain("release_host_overloaded");
  });

  it("waits for the release limit first, then gives the same point-in-time verdict", async () => {
    const waitForHost = vi.fn(async ({ report }) => {
      report({ state: "waiting", observation: { loadPerCore: 30, memoryPressure: "normal" }, reasonCodes: ["host_load_above_limit"] });
      report({ state: "ready", observation: { loadPerCore: 9.7, memoryPressure: "warning" }, reasonCodes: [] });
      return { state: "ready" };
    });
    const log = vi.fn();
    const observe = vi.fn(async () => observation());
    await expect(runReleaseHostCheck(["--wait-minutes", String(RELEASE_HOST_WAIT_MINUTES)], { observe, waitForHost, log }))
      .resolves.toMatchObject({ ok: true, maxLoadPerCore: 16 });
    expect(waitForHost).toHaveBeenCalledOnce();
    const [{ readPolicy, maxWaitMs, label }] = waitForHost.mock.calls[0];
    expect({ maxWaitMs, label }).toEqual({ maxWaitMs: 25 * 60_000, label: "release host admission" });
    expect(readPolicy()).toEqual(releaseHostResourcePolicy(16));
    expect(readPolicy()).toMatchObject({ enabled: true, maxLoadPerCore: 16, memoryPressureCeiling: "warning" });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "host waiting: one-minute load per core 30.0 (limit 16), memory pressure normal [host_load_above_limit]",
      "host ready: one-minute load per core 9.7 (limit 16), memory pressure warning",
    ]);
    expect(observe).toHaveBeenCalledOnce();
  });

  it("still refuses a host that stays busy for the whole wait", async () => {
    const waitForHost = vi.fn(async () => {
      throw new Error("Host resource wait timed out; command was not started");
    });
    const log = vi.fn();
    const observe = async () => observation({ oneMinuteLoad: 480, loadPerCore: 30 });
    await expect(runReleaseHostCheck(["--wait-minutes", "25"], { observe, waitForHost, log }))
      .resolves.toMatchObject({ ok: false, code: "release_host_overloaded" });
    expect(log).toHaveBeenCalledWith("host still busy after 1500s (Host resource wait timed out; command was not started)");
  });

  it("waits only when asked, and never on an invalid request", async () => {
    const waitForHost = vi.fn(async () => ({ state: "ready" }));
    const observe = async () => observation();
    await runReleaseHostCheck([], { observe, waitForHost });
    await runReleaseHostCheck(["--wait-minutes", "0"], { observe, waitForHost });
    for (const minutes of ["-1", "1.5", "abc", "", "1e3"]) {
      await expect(runReleaseHostCheck([`--wait-minutes=${minutes}`], { observe, waitForHost })).rejects.toThrow("release_host_wait_invalid");
    }
    await expect(runReleaseHostCheck(["--wait-minutes", "5", "--max-load-per-core", "0"], { observe, waitForHost }))
      .rejects.toThrow("release_host_load_limit_invalid");
    expect(waitForHost).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("reports the real host from the command line", () => {
    const script = path.resolve("scripts/check-release-host.mjs");
    const admitted = spawnSync(process.execPath, [script, "--max-load-per-core", "1000000"], { encoding: "utf8" });
    expect(admitted.status, admitted.stderr).toBe(0);
    expect(JSON.parse(admitted.stdout.split("\n")[0])).toMatchObject({ ok: true, maxLoadPerCore: 1000000 });
    expect(admitted.stdout).toContain("release host admitted");
    expect(admitted.stdout).not.toContain('"message"');
    const refused = spawnSync(process.execPath, [script, "--max-load-per-core", "0"], { encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("release_host_load_limit_invalid");
  });
});
