import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGuardian } from "../run-hmux-tests.mjs";
import { runHostResourcesCli } from "../host-resources.mjs";
import {
  DEFAULT_HOST_RESOURCE_POLICY,
  hostResourceDecision,
  hostResourcePolicyPath,
  observeHostResources,
  parseHostResourcePolicy,
  parseMacMemoryPressure,
  readHostResourcePolicy,
  waitForHostResources,
  writeHostResourcePolicy,
} from "./host-resource-admission.mjs";

const roots = [];
const enabled = { ...DEFAULT_HOST_RESOURCE_POLICY, enabled: true };
const healthy = () => ({
  observedAt: new Date().toISOString(), durationMs: 1,
  loadPerCore: 0.5, memoryPressure: "normal",
});
function fixturePath() {
  const root = mkdtempSync(join(tmpdir(), "dure-host-resource-policy-test-"));
  roots.push(root);
  return join(root, "policy.json");
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host pressure admission", () => {
  it("waits through load and memory pressure, then admits one command", async () => {
    const command = vi.fn();
    const report = vi.fn();
    const samples = [
      { loadPerCore: 7 }, { memoryPressure: "warning" }, {},
    ];
    const sleep = vi.fn(async () => expect(command).not.toHaveBeenCalled());
    const receipt = await waitForHostResources({
      readPolicy: () => enabled, sleep, report,
      observe: async () => ({ ...healthy(), ...samples.shift() }),
    });
    command();
    expect(receipt.state).toBe("ready");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledOnce();
    expect(report.mock.calls.map(([entry]) => entry.reasonCodes)).toEqual([
      ["host_load_above_limit"], ["host_memory_pressure_above_limit"], [],
    ]);
  });

  it("never treats stale, future, missing or unknown evidence as healthy", () => {
    for (const patch of [
      { observedAt: "invalid" }, { observedAt: new Date(Date.now() - 6_000).toISOString() },
      { observedAt: new Date(Date.now() + 6_000).toISOString() },
      { durationMs: 6_000 }, { durationMs: -1 }, { loadPerCore: null }, { loadPerCore: -1 },
      { memoryPressure: "unknown" }, { memoryPressure: "critical" },
    ]) expect(hostResourceDecision(enabled, { ...healthy(), ...patch }).state).toBe("waiting");
    expect(hostResourceDecision(enabled, { ...healthy(), loadPerCore: 2 }).state).toBe("waiting");
    expect(hostResourceDecision({ ...enabled, memoryPressureCeiling: "warning" }, {
      ...healthy(), memoryPressure: "warning",
    }).state).toBe("ready");
  });

  it("cancels a wait without launching work and removes only its signal handlers", async () => {
    const baseline = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const cancellation = new AbortController();
    const command = vi.fn();
    await expect(waitForHostResources({
      readPolicy: () => enabled,
      observe: async () => ({ ...healthy(), memoryPressure: "critical" }),
      report: () => {}, signal: cancellation.signal,
      sleep: async () => cancellation.abort(new Error("fixture cancellation")),
    }).then(command)).rejects.toThrow("fixture cancellation");
    expect(command).not.toHaveBeenCalled();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(baseline);
  });

  it("honors persistent policy replacement while waiting; disabled policy does not probe", async () => {
    const policyPath = fixturePath();
    writeHostResourcePolicy(enabled, policyPath);
    const observe = vi.fn(async () => ({ ...healthy(), memoryPressure: "critical" }));
    const receipt = await waitForHostResources({
      policyPath, observe, report: () => {},
      sleep: async () => writeHostResourcePolicy(DEFAULT_HOST_RESOURCE_POLICY, policyPath),
    });
    expect(receipt.state).toBe("disabled");
    expect(observe).toHaveBeenCalledOnce();
    await waitForHostResources({ policyPath, observe });
    expect(observe).toHaveBeenCalledOnce();
  });

  it("stops at the wait deadline without starting work", async () => {
    const command = vi.fn();
    await expect(waitForHostResources({
      readPolicy: () => enabled,
      observe: async () => ({ ...healthy(), memoryPressure: "unknown" }),
      report: () => {}, maxWaitMs: 10,
    }).then(command)).rejects.toThrow("timed out");
    expect(command).not.toHaveBeenCalled();
  });

  it("waits before native QA preparation, cleanup or fixture launch", async () => {
    const policyPath = fixturePath();
    const temporaryRoot = join(policyPath, "not-a-directory");
    const superviseCommand = vi.fn();
    const reapState = vi.fn();
    await expect(runGuardian(["fixture"], {
      temporaryRoot, superviseCommand, reapState,
      waitForResources: async () => { throw new Error("pressure wait cancelled"); },
    })).rejects.toThrow("pressure wait cancelled");
    expect(superviseCommand).not.toHaveBeenCalled();
    expect(reapState).not.toHaveBeenCalled();
  });
});

describe("host pressure observations and configuration", () => {
  it("uses dispatch memory flags, not internal XNU ordinal values", () => {
    expect(["1\n", "2\n", "4\n", "0", "3", "", "2junk"].map(parseMacMemoryPressure))
      .toEqual(["normal", "warning", "critical", "unknown", "unknown", "unknown", "unknown"]);
  });

  it("observes bounded macOS pressure independently from load, not swap totals", async () => {
    const execute = vi.fn(async () => ({ stdout: "2\n" }));
    const result = await observeHostResources({
      platform: "darwin", execute, readLoad: () => [48], readCpus: () => Array(16),
    });
    expect(result).toMatchObject({ loadPerCore: 3, memoryPressure: "warning", memoryError: null });
    expect(execute).toHaveBeenCalledWith("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"],
      expect.objectContaining({ timeout: 2_000, maxBuffer: 4_096 }));
  });

  it("reports failed and unsupported memory observations as unknown", async () => {
    const execute = vi.fn(async () => { throw new Error("probe timeout"); });
    expect(await observeHostResources({ platform: "darwin", execute })).toMatchObject({
      memoryPressure: "unknown", memoryError: "pressure_probe_failed",
    });
    execute.mockClear();
    expect(await observeHostResources({ platform: "win32", execute })).toMatchObject({
      loadPerCore: null, memoryPressure: "unknown", memoryError: "unsupported_platform",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("shares account policy across disposable homes, with an explicit fixture override", () => {
    const expected = join(userInfo().homedir, ".dure", "host-resource-policy-v1.json");
    expect(hostResourcePolicyPath({ HOME: "/fixture", DURE_HOME: "/fixture/dure" })).toBe(expected);
    const override = fixturePath();
    expect(hostResourcePolicyPath({ DURE_HOST_RESOURCE_POLICY: override })).toBe(override);
    expect(() => hostResourcePolicyPath({ DURE_HOST_RESOURCE_POLICY: "relative" })).toThrow("absolute");
  });

  it("defaults absent configuration to disabled, but refuses invalid configuration", () => {
    const pathname = fixturePath();
    expect(readHostResourcePolicy(pathname).enabled).toBe(false);
    writeFileSync(pathname, "{bad}");
    expect(() => readHostResourcePolicy(pathname)).toThrow();
    for (const patch of [
      { enabled: "true" }, { maxLoadPerCore: 0 }, { maxLoadPerCore: Infinity },
      { pollIntervalMs: 0 }, { memoryPressureCeiling: "critical" }, { unknown: true },
    ]) expect(() => parseHostResourcePolicy({ ...enabled, ...patch })).toThrow("Invalid");
  });

  it("configures and reads the exact policy through the CLI, rejecting ignored options", async () => {
    const pathname = fixturePath();
    await runHostResourcesCli(["set", "--policy", pathname, "--enabled", "false", "--max-load-per-core", "1.5"]);
    expect(JSON.parse(readFileSync(pathname, "utf8"))).toMatchObject({ enabled: false, maxLoadPerCore: 1.5 });
    expect((await runHostResourcesCli(["wait", "--policy", pathname])).state).toBe("disabled");
    await expect(runHostResourcesCli(["status", "--enabled", "false"])).rejects.toThrow("Usage:");
    await expect(runHostResourcesCli(["wait", "--max-wait-ms", "NaN"])).rejects.toThrow("nonnegative");
  });
});
