import { expect, test } from "vitest";
import {
  percentile,
  sampleMachineProcessContext,
  sampleProcessTree,
  summarizeProcessSamples,
} from "./process-tree-metrics.mjs";

test("uses native topology as the process relationship authority", () => {
  expect(
    sampleProcessTree(40, {
      processCurrentUserTopology: () => ({
        status: "complete",
        members: [
          { pid: 40, parentPid: 1, state: "live" },
          { pid: 41, parentPid: 40, state: "live" },
          { pid: 42, parentPid: 41, state: "stopped" },
          { pid: 90, parentPid: 1, state: "live" },
        ],
      }),
      readProcessResourceRows: () => [
        { pid: 40, cpuPercent: 1, rssKiB: 1_024 },
        { pid: 41, cpuPercent: 2, rssKiB: 2_048 },
        { pid: 42, cpuPercent: 3, rssKiB: 3_072 },
        { pid: 90, cpuPercent: 100, rssKiB: 100_000 },
      ],
    }),
  ).toEqual({
    processCount: 3,
    cpuPercent: 6,
    rssMiB: 6,
  });
});

test("fails sampling when the relationship topology is incomplete", () => {
  expect(() =>
    sampleProcessTree(40, {
      processCurrentUserTopology: () => ({
        status: "incomplete",
        reason: "process_member_observation_timeout",
      }),
      readProcessResourceRows: () => [],
    })
  ).toThrow(/process topology is unavailable/);
});

test("percentile uses nearest-rank selection without mutating input", () => {
  const values = [40, 10, 30, 20];

  expect(percentile(values, 0.5)).toBe(20);
  expect(percentile(values, 0.95)).toBe(40);
  expect(values).toEqual([40, 10, 30, 20]);
});

test("summarizeProcessSamples reports average and peak resources", () => {
  expect(
    summarizeProcessSamples([
      { processCount: 3, cpuPercent: 12, rssMiB: 400 },
      { processCount: 5, cpuPercent: 28, rssMiB: 550 },
    ]),
  ).toEqual({
      samples: 2,
      averageCpuPercent: 20,
      peakCpuPercent: 28,
      peakRssMiB: 550,
      peakProcessCount: 5,
  });
});

test("empty metric samples fail explicitly", () => {
  expect(() => percentile([], 0.95)).toThrow(/empty sample/);
  expect(() => summarizeProcessSamples([])).toThrow(/no process samples/);
});

test("captures process-tree resources with concurrent machine load", () => {
  expect(
    sampleMachineProcessContext(42, {
      availableParallelism: () => 12,
      loadAverage: () => [3.5, 2.5, 1.5],
      now: () => 1_787_741_000_000,
      sampleProcessTree: (rootPid) => ({
        rootPid,
        processCount: 7,
        cpuPercent: 63,
        rssMiB: 512,
      }),
    }),
  ).toEqual({
    sampledAtMs: 1_787_741_000_000,
    logicalCpuCount: 12,
    loadAverage: {
      oneMinute: 3.5,
      fiveMinutes: 2.5,
      fifteenMinutes: 1.5,
    },
    processTree: {
      rootPid: 42,
      processCount: 7,
      cpuPercent: 63,
      rssMiB: 512,
    },
  });
});
