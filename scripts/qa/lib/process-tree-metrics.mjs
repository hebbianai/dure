import { execFileSync } from "node:child_process";
import os from "node:os";
import { processCurrentUserTopology } from "../../lib/process-identity.mjs";

function readProcessResourceRows() {
  return execFileSync(
    "ps",
    ["-axo", "pid=,%cpu=,rss="],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 3)
    .map(([pid, cpuPercent, rssKiB]) => ({
      pid: Number(pid),
      cpuPercent: Number(cpuPercent),
      rssKiB: Number(rssKiB),
    }));
}

export function sampleProcessTree(
  rootPid,
  dependencies = { processCurrentUserTopology, readProcessResourceRows },
) {
  const observation = dependencies.processCurrentUserTopology();
  if (observation.status !== "complete") {
    throw new Error(
      `QA process topology is unavailable: ${observation.reason}`,
    );
  }
  const members = observation.members.filter(
    (member) => member.state !== "zombie",
  );
  if (!members.some((member) => member.pid === rootPid)) {
    throw new Error(`QA process tree root ${rootPid} is not running`);
  }
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const member of members) {
      if (
        !descendants.has(member.pid) &&
        descendants.has(member.parentPid)
      ) {
        descendants.add(member.pid);
        changed = true;
      }
    }
  }
  const rows = dependencies.readProcessResourceRows();
  const selected = rows.filter((row) => descendants.has(row.pid));
  if (!selected.some((row) => row.pid === rootPid)) {
    throw new Error(`QA process tree root ${rootPid} is not running`);
  }
  return {
    processCount: selected.length,
    cpuPercent: sum(selected.map((row) => row.cpuPercent)),
    rssMiB: sum(selected.map((row) => row.rssKiB)) / 1024,
  };
}

export function summarizeProcessSamples(samples) {
  if (samples.length === 0) throw new Error("no process samples were collected");
  return {
    samples: samples.length,
    averageCpuPercent:
      sum(samples.map((sample) => sample.cpuPercent)) / samples.length,
    peakCpuPercent: Math.max(...samples.map((sample) => sample.cpuPercent)),
    peakRssMiB: Math.max(...samples.map((sample) => sample.rssMiB)),
    peakProcessCount: Math.max(
      ...samples.map((sample) => sample.processCount),
    ),
  };
}

export function sampleMachineProcessContext(
  rootPid,
  dependencies = {
    availableParallelism: () => os.availableParallelism(),
    loadAverage: () => os.loadavg(),
    now: () => Date.now(),
    sampleProcessTree,
  },
) {
  const [oneMinute, fiveMinutes, fifteenMinutes] = dependencies.loadAverage();
  return {
    sampledAtMs: dependencies.now(),
    logicalCpuCount: dependencies.availableParallelism(),
    loadAverage: { oneMinute, fiveMinutes, fifteenMinutes },
    processTree: dependencies.sampleProcessTree(rootPid),
  };
}

export function percentile(values, quantile) {
  if (values.length === 0) throw new Error("cannot measure an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
