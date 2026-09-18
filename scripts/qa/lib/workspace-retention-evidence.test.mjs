import { describe, expect, it } from "vitest";
import { retentionAppFamily, retentionFootprints, retentionProfile, validateRetentionEvidence } from "./workspace-retention-evidence.mjs";

describe("native retention evidence", () => {
  it("attributes only the isolated app family and rejects ambiguous labels", () => {
    const source = ["Dure Live", "Dure QA abc", "Dure QA abc Web Content", "Dure QA abc Graphics and Media", "Dure QA abc Networking"]
      .map((label, i) => `${i}) "${label}" ASN:0x0:\n    pid = ${i + 10}`).join("\n");
    expect(retentionAppFamily(source, 11).map(({ pid }) => pid)).toEqual([11, 12, 13, 14]);
    expect(() => retentionAppFamily(`${source}\n5) "Dure QA abc Web Content" ASN:0x0:\n    pid = 15`, 11)).toThrow("ambiguous");
    expect(() => retentionAppFamily(source, 999)).toThrow("absent");
  });
  it("never substitutes missing native footprint with zero", () => {
    expect(retentionFootprints("WebKit [42]:\n phys_footprint: 1234 B\n phys_footprint_peak: 9000 B").get(42)).toBe(1234);
    expect(retentionFootprints("WebKit [42]:\n measurement failed").has(42)).toBe(false);
  });
  it("keeps the originally attributed family when another same-named QA app starts", () => {
    const source = ["dure", "dure Web Content", "dure Graphics and Media", "dure Networking"]
      .map((label, i) => `${i}) "${label}" ASN:0x0:\n    pid = ${i + 10}`).join("\n");
    const original = retentionAppFamily(source, 10);
    const concurrent = `${source}\n4) "dure" ASN:0x0:\n    pid = 20\n5) "dure Web Content" ASN:0x0:\n    pid = 21`;
    expect(retentionAppFamily(concurrent, 10, original)).toEqual(original);
    expect(() => retentionAppFamily(concurrent.replace("pid = 11", "pid = 99"), 10, original)).toThrow();
  });
  const evidence = (profile = "short") => {
    const plan = retentionProfile(profile);
    const samples = Array.from({ length: plan.returnSamples + plan.idleSamples }, (_, ordinal) => ({
      ordinal, phase: ordinal < plan.returnSamples ? "cycling" : "idle",
      atMs: ordinal < plan.returnSamples ? ordinal * 10_000
        : plan.returnSamples * 10_000 + (ordinal - plan.returnSamples) * plan.idleIntervalMs,
      activeSpaceId: "a", contentHashes: { pane: "hash" }, totals: { terminalSurfaces: 12, hmuxObservers: 12 },
    }));
    return {
    profile,
    terminalCount: 15,
    status: { state: "complete", retention: { workload: "managed-shell-fake-tui", profile, expectedSamples: samples.length,
      samples,
      released: { terminalSurfaces: 0, hmuxObservers: 0, webglContexts: 0 } } },
    points: samples.map(({ ordinal, atMs }) => ({ ordinal, atMs: atMs + 1, bytes: 1000 + ordinal * 100,
      members: [{ role: "webcontent", pid: 42, processIdentity: "generation-a" }] })),
  }; };
  it("reports growth without falsely declaring memory stable", () => {
    expect(validateRetentionEvidence(evidence())).toMatchObject({ deltaBytes: 800, firstBytes: 1000, lastBytes: 1800, idle: null });
  });
  it("separates cycling growth from five-minute idle recovery", () => {
    const value = evidence("extended");
    for (const point of value.points.slice(61)) point.bytes = 7000 - (point.ordinal - 61) * 500;
    expect(validateRetentionEvidence(value)).toMatchObject({ cycling: { deltaBytes: 6000 },
      idle: { deltaBytes: -2500, elapsedMs: 300_000 } });
  });
  it.each([
    ["shortened idle", (v) => { v.status.retention.samples[62].atMs -= 1; }],
    ["wrong idle phase", (v) => { v.status.retention.samples[61].phase = "cycling"; }],
    ["profile mismatch", (v) => { v.status.retention.profile = "short"; }],
    ["missed sample window", (v) => { v.points[61].atMs += 5000; }],
  ])("rejects extended evidence with %s", (_name, mutate) => {
    const value = evidence("extended");
    mutate(value);
    expect(() => validateRetentionEvidence(value)).toThrow();
  });
  it("rejects unknown profiles instead of silently running the short workload", () => {
    expect(() => retentionProfile("typo")).toThrow("unknown retention profile");
  });
  it.each([
    ["missing footprint", (v) => v.points.pop()],
    ["process replacement", (v) => { v.points[1].members[0].processIdentity = "generation-b"; }],
    ["changed content", (v) => { v.status.retention.samples[1].contentHashes.pane = "changed"; }],
    ["duplicate surfaces", (v) => { v.status.retention.samples[1].totals.terminalSurfaces = 16; }],
    ["missing observers", (v) => { v.status.retention.samples[1].totals.hmuxObservers = 11; }],
    ["retained observers", (v) => { v.status.retention.released.hmuxObservers = 1; }],
    ["unfinished workload", (v) => { v.status.state = "running"; }],
  ])("rejects %s", (_name, mutate) => {
    const value = evidence();
    mutate(value);
    expect(() => validateRetentionEvidence(value)).toThrow();
  });
});
