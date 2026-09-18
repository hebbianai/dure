import assert from "node:assert/strict";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { observeProcessMembers, processMemberFromObservation } from "../../lib/process-identity.mjs";

const execute = promisify(execFile);
const profiles = JSON.parse(fs.readFileSync(new URL("../../../src/qa/workspacePerformance/retentionProfiles.json", import.meta.url), "utf8"));
export function retentionProfile(name) {
  assert.ok(Object.hasOwn(profiles, name), `unknown retention profile: ${name}`);
  return profiles[name];
}
const roles = new Map([["", "app"], [" Web Content", "webcontent"],
  [" Graphics and Media", "gpu"], [" Networking", "networking"]]);

export function retentionAppFamily(source, appPid, originalFamily) {
  const entries = source.split(/\n(?=\d+\))/u).flatMap((block) => {
    const label = block.match(/^\d+\) "([^"]+)" /u)?.[1];
    const pid = Number(block.match(/\bpid = (\d+)\b/u)?.[1]);
    return label && Number.isSafeInteger(pid) && pid > 0 ? [{ label, pid }] : [];
  });
  const app = entries.find(({ pid }) => pid === appPid);
  assert.ok(app, "isolated QA app is absent from LaunchServices");
  const family = (originalFamily ? originalFamily.map(({ pid, label, role }) => {
    assert.ok(entries.some((entry) => entry.pid === pid && entry.label === label),
      `original QA process disappeared: ${role}`);
    return { pid, label, role };
  }) : entries.flatMap((entry) => {
    const role = roles.get(entry.label.startsWith(app.label) ? entry.label.slice(app.label.length) : null);
    return role ? [{ ...entry, role }] : [];
  })).sort((a, b) => a.pid - b.pid);
  for (const role of roles.values()) {
    assert.equal(family.filter((entry) => entry.role === role).length, 1,
      `missing or ambiguous QA process attribution: ${role}`);
  }
  assert.equal(family.find(({ role }) => role === "app").pid, appPid, "QA app identity changed");
  return family;
}

export function retentionFootprints(source) {
  return new Map(source.split(/(?=^[^\n]+ \[\d+\]:)/mu).flatMap((block) => {
    const pid = Number(block.match(/^.+ \[(\d+)\]:/u)?.[1]);
    const bytes = Number(block.match(/\bphys_footprint: (\d+) B/u)?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(bytes) && bytes >= 0
      ? [[pid, bytes]] : [];
  }));
}

export async function captureRetentionFootprint(appPid, originalFamily) {
  const run = async (command, args) => (await execute(command, args, {
    encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
  const family = retentionAppFamily(await run("/usr/bin/lsappinfo", ["list"]), appPid, originalFamily);
  const pids = family.map(({ pid }) => pid);
  const before = await observeProcessMembers({ kind: "point", pids });
  assert.equal(before.status, "complete");
  const atMs = Date.now();
  const sizes = retentionFootprints(await run("/usr/bin/footprint",
    ["--noCategories", "--swapped", "-f", "bytes", ...pids.flatMap((pid) => ["-p", String(pid)])]));
  const after = await observeProcessMembers({ kind: "point", pids });
  assert.equal(after.status, "complete");
  assert.deepEqual(retentionAppFamily(await run("/usr/bin/lsappinfo", ["list"]), appPid, family), family);
  const members = family.map((entry) => {
    const first = processMemberFromObservation(entry.pid, before);
    const last = processMemberFromObservation(entry.pid, after);
    assert.equal(first.status, "present");
    assert.equal(last.status, "present");
    assert.equal(first.member.processIdentity, last.member.processIdentity);
    if (originalFamily) {
      assert.equal(last.member.processIdentity,
        originalFamily.find(({ pid }) => pid === entry.pid)?.processIdentity,
        "original QA process generation changed");
    }
    assert.ok(sizes.has(entry.pid), `missing footprint for ${entry.role}`);
    return { ...entry, processIdentity: last.member.processIdentity, bytes: sizes.get(entry.pid) };
  });
  return { atMs, members, bytes: members.reduce((total, member) => total + member.bytes, 0) };
}

export function validateRetentionEvidence({ status, points, terminalCount, profile = "short" }) {
  assert.equal(status?.state, "complete", "native workload did not complete");
  assert.equal(status.retention?.workload, "managed-shell-fake-tui", "unknown retention workload");
  const { samples, expectedSamples, released } = status.retention ?? {};
  const plan = retentionProfile(profile);
  assert.equal(status.retention.profile, profile, "retention profile mismatch");
  assert.equal(expectedSamples, plan.returnSamples + plan.idleSamples, "sample contract mismatch");
  assert.equal(samples?.length, expectedSamples, "incomplete native samples");
  assert.equal(points.length, expectedSamples, "missing correlated footprint points");
  const identities = (point) => point.members.map(({ role, pid, processIdentity }) => ({ role, pid, processIdentity }));
  for (const [ordinal, sample] of samples.entries()) {
    assert.equal(sample.ordinal, ordinal);
    assert.equal(points[ordinal].ordinal, ordinal);
    assert.equal(sample.phase, ordinal < plan.returnSamples ? "cycling" : "idle", "retention phase mismatch");
    assert.ok(Number.isFinite(sample.atMs) && Number.isFinite(points[ordinal].atMs), "missing measurement time");
    assert.ok(points[ordinal].atMs >= sample.atMs && points[ordinal].atMs < sample.atMs + plan.sampleWindowMs,
      "footprint outside sample window");
    if (ordinal > plan.returnSamples) {
      assert.ok(sample.atMs - samples[ordinal - 1].atMs >= plan.idleIntervalMs, "idle interval shortened");
    }
    assert.deepEqual(identities(points[ordinal]), identities(points[0]), "QA process generation changed");
    assert.deepEqual(sample.contentHashes, samples[0].contentHashes, "terminal content changed");
    assert.ok(Object.keys(sample.contentHashes).length > 0, "missing content proof");
    assert.equal(sample.activeSpaceId, samples[0].activeSpaceId, "different return Space");
    assert.ok(sample.totals.terminalSurfaces > 0 && sample.totals.terminalSurfaces <= terminalCount,
      "missing or duplicated terminal surfaces");
    assert.equal(sample.totals.hmuxObservers, sample.totals.terminalSurfaces);
    assert.ok(Number.isFinite(points[ordinal].bytes) && points[ordinal].bytes > 0, "missing footprint");
  }
  assert.equal(released?.terminalSurfaces, 0, "terminal surfaces survived removal");
  assert.equal(released?.hmuxObservers, 0, "terminal observers survived removal");
  assert.equal(released?.webglContexts, 0, "terminal graphics survived removal");
  const bytes = points.map((point) => point.bytes);
  const summarize = (phasePoints) => ({ firstBytes: phasePoints[0].bytes, lastBytes: phasePoints.at(-1).bytes,
    deltaBytes: phasePoints.at(-1).bytes - phasePoints[0].bytes,
    elapsedMs: phasePoints.at(-1).atMs - phasePoints[0].atMs });
  return { firstBytes: bytes[0], lastBytes: bytes.at(-1), minimumBytes: Math.min(...bytes),
    maximumBytes: Math.max(...bytes), deltaBytes: bytes.at(-1) - bytes[0],
    cycling: summarize(points.slice(0, plan.returnSamples)),
    idle: plan.idleSamples ? summarize(points.slice(plan.returnSamples)) : null,
    caveat: "Managed-shell synthetic TUI renderer observation, not native provider-driver coverage, a heap-leak verdict or long-term stability proof. Footprint includes compression; model bytes are admission estimates." };
}
