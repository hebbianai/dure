import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  demotionWarnings,
  foregroundPriorityAdapter,
  parseProcessCensus,
  priorityTimelineRows,
  processTree,
  renderPriorityTimeline,
  sampleForegroundPriority,
  startForegroundPriorityGuard,
} from "./foreground-priority-guard.mjs";

const member = (pid, ppid, { nice = 0, priority = 31, command = `/bin/p${pid}` } = {}) => ({
  pid, ppid, nice, priority, command,
});

function fakeAdapter(census) {
  const cleared = [];
  return {
    cleared,
    census: vi.fn(async () => (typeof census === "function" ? census() : census)),
    isBackground: (entry) => entry.priority <= 4,
    clearBackground: vi.fn(async (pid) => {
      cleared.push(pid);
    }),
  };
}

const sample = (atMs, overrides = {}) => ({
  atMs,
  processes: 3,
  highestNice: 0,
  background: { count: 0, commands: [] },
  raisedNice: { count: 0, commands: [] },
  cleared: 0,
  ...overrides,
});

describe("process census", () => {
  it("parses ps rows, keeps command paths with spaces and skips the rest", () => {
    expect(parseProcessCensus([
      "    1     0  0  37 /sbin/launchd",
      "  812   1 -20   4 /Applications/Some App.app/Contents/MacOS/helper ",
      "garbage",
      "",
    ].join("\n"))).toEqual([
      member(1, 0, { priority: 37, command: "/sbin/launchd" }),
      member(812, 1, { nice: -20, priority: 4, command: "/Applications/Some App.app/Contents/MacOS/helper" }),
    ]);
  });

  it("selects the root and all of its descendants from one snapshot", () => {
    const census = [member(0, 0), member(1, 0), member(10, 1), member(11, 10), member(12, 11), member(13, 10), member(20, 1)];
    expect(processTree(census, 10).map((entry) => entry.pid)).toEqual([10, 11, 13, 12]);
    expect(processTree(census, 99)).toEqual([]);
  });

  it("is Darwin-only", () => {
    expect(foregroundPriorityAdapter("darwin")).not.toBeNull();
    for (const platform of ["linux", "win32", "freebsd"]) expect(foregroundPriorityAdapter(platform)).toBeNull();
  });
});

describe("one sample", () => {
  it("lifts every background member of the tree and records raised nice", async () => {
    const adapter = fakeAdapter([
      member(1, 0),
      member(10, 1),
      member(11, 10, { priority: 4, nice: 15, command: "/toolchain/bin/rustc" }),
      member(12, 10, { priority: 4, command: "/usr/local/bin/node" }),
      member(13, 12, { nice: 5, command: "/usr/local/bin/node" }),
      member(30, 1, { priority: 4, nice: 19, command: "/bin/unrelated" }),
    ]);
    const result = await sampleForegroundPriority({ adapter, rootPid: 10, baselineNice: 0, atMs: 500 });
    expect(adapter.cleared).toEqual([11, 12]);
    expect(result).toEqual({
      atMs: 500,
      processes: 4,
      highestNice: 15,
      background: { count: 2, commands: ["rustc", "node"] },
      raisedNice: { count: 2, commands: ["rustc", "node"] },
      cleared: 2,
    });
  });

  it("counts only the lifts that succeeded", async () => {
    const adapter = fakeAdapter([member(10, 1, { priority: 4 }), member(11, 10, { priority: 4 })]);
    adapter.clearBackground.mockImplementation(async (pid) => {
      if (pid === 11) throw new Error("no such process");
    });
    expect((await sampleForegroundPriority({ adapter, rootPid: 10, baselineNice: 0, atMs: 0 })).cleared).toBe(1);
  });

  it("reports an unobservable tree and skips a tree that has already exited", async () => {
    const failing = fakeAdapter(() => {
      throw new Error("spawn /bin/ps ENOENT\nmore detail");
    });
    expect(await sampleForegroundPriority({ adapter: failing, rootPid: 10, baselineNice: 0, atMs: 7 }))
      .toEqual({ atMs: 7, error: "spawn /bin/ps ENOENT" });
    expect(await sampleForegroundPriority({ adapter: fakeAdapter([member(1, 0)]), rootPid: 10, baselineNice: 0, atMs: 7 }))
      .toBeNull();
  });
});

describe("warnings", () => {
  const options = { label: "release build", baselineNice: 0 };
  const demoted = sample(30_000, {
    highestNice: 15,
    background: { count: 5, commands: ["rustc", "node", "cargo", "sh"] },
    raisedNice: { count: 1, commands: ["rustc"] },
    cleared: 5,
  });

  it("warns once when a demotion episode starts, not on every sample", () => {
    expect(demotionWarnings(sample(0), demoted, options)).toEqual([
      "Background QoS demoted 5 process(es) of the release build (rustc, node, cargo, sh, …); lifted 5 with taskpolicy -B. The step summary has the timeline.",
      "nice 15 (started at 0) on 1 process(es) of the release build (rustc); an unprivileged runner cannot lower it, so the build may run slower. The step summary has the timeline.",
    ]);
    expect(demotionWarnings(demoted, { ...demoted, atMs: 60_000 }, options)).toEqual([]);
    expect(demotionWarnings(sample(0), sample(30_000), options)).toEqual([]);
    expect(demotionWarnings(sample(90_000), demoted, options)).toHaveLength(2);
  });

  it("warns once while the tree cannot be observed", () => {
    const failed = { atMs: 0, error: "spawn /bin/ps ENOENT" };
    expect(demotionWarnings(null, failed, options)).toEqual([
      "Could not observe the release build process tree, so a background demotion would go unnoticed: spawn /bin/ps ENOENT",
    ]);
    expect(demotionWarnings(failed, failed, options)).toEqual([]);
  });
});

describe("timeline", () => {
  it("collapses consecutive samples in one state into a row", () => {
    const samples = [
      sample(0, { processes: 2 }),
      sample(30_000, { processes: 9 }),
      sample(60_000, { processes: 14, highestNice: 15, background: { count: 3, commands: ["rustc"] }, cleared: 3 }),
      sample(90_000, { processes: 12, highestNice: 15, background: { count: 1, commands: ["node"] }, cleared: 1 }),
      { atMs: 120_000, error: "ps | timed out" },
      sample(150_000),
    ];
    expect(priorityTimelineRows(samples)).toEqual([
      { time: "0:00–0:30", processes: "2–9", highestNice: 0, background: "0", cleared: 0 },
      { time: "1:00–1:30", processes: "12–14", highestNice: 15, background: "1–3 (rustc, node)", cleared: 4 },
      { time: "2:00", error: "ps | timed out" },
      { time: "2:30", processes: "3", highestNice: 0, background: "0", cleared: 0 },
    ]);
    const markdown = renderPriorityTimeline({
      label: "release build", intervalMs: 30_000, baselineNice: 0, durationMs: 1_084_000, samples,
    });
    expect(markdown).toContain("### Scheduling priority: release build");
    expect(markdown).toContain("Sampled every 30 s for 18 min 4 s, starting at nice 0. Background QoS was seen and lifted 4 time(s).");
    expect(markdown).toContain("| 1:00–1:30 | 12–14 | 15 | 1–3 (rustc, node) | 4 |");
    expect(markdown).toContain("| 2:00 | not observed: ps \\| timed out | | | |");
  });

  it("says plainly when nothing was demoted", () => {
    expect(renderPriorityTimeline({
      label: "release build", intervalMs: 30_000, baselineNice: 0, durationMs: 45_000, samples: [sample(0), sample(30_000)],
    })).toContain("Sampled every 30 s for 45 s, starting at nice 0. No background QoS or raised nice was seen.");
  });
});

describe("guard", () => {
  it("samples at once and every interval until stopped, warning once per episode", async () => {
    let demote = false;
    const adapter = fakeAdapter(() => [member(10, 1), member(11, 10, { priority: demote ? 4 : 31 })]);
    const warn = vi.fn();
    const guard = startForegroundPriorityGuard({ rootPid: 10, label: "build", adapter, intervalMs: 5, baselineNice: 0, warn });
    await vi.waitFor(() => expect(adapter.census.mock.calls.length).toBeGreaterThanOrEqual(2));
    demote = true;
    await vi.waitFor(() => expect(adapter.cleared.length).toBeGreaterThanOrEqual(2));
    const timeline = await guard.stop();
    const calls = adapter.census.mock.calls.length;
    await delay(20);
    expect(adapter.census.mock.calls.length).toBe(calls);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^Background QoS demoted 1 process\(es\) of the build \(p11\)/);
    expect(timeline).toMatchObject({ label: "build", intervalMs: 5, baselineNice: 0 });
    expect(timeline.samples[0].background.count).toBe(0);
    expect(timeline.samples.at(-1).background.count).toBe(1);
  });

  it("does nothing without a platform adapter", async () => {
    const guard = startForegroundPriorityGuard({ rootPid: process.pid, label: "build", adapter: null });
    expect(await guard.stop()).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")(
    "lifts an external background demotion anywhere in the tree (native Darwin)",
    async () => {
      const priorityOf = (pid) => Number(execFileSync("/bin/ps", ["-o", "pri=", "-p", String(pid)], { encoding: "utf8" }).trim());
      const demote = (pid) => execFileSync("/usr/sbin/taskpolicy", ["-b", "-p", String(pid)]);
      const parent = spawn("/bin/sh", ["-c", "/usr/bin/perl -e 'select(undef,undef,undef,0.05) while 1' & echo $!; wait"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let child = null;
      try {
        const [line] = await once(parent.stdout, "data");
        child = Number(String(line).trim());
        demote(parent.pid);
        await vi.waitFor(() => expect(priorityOf(parent.pid)).toBe(4));
        const warn = vi.fn();
        const guard = startForegroundPriorityGuard({ rootPid: parent.pid, label: "fixture", intervalMs: 100, warn });
        await vi.waitFor(() => expect(priorityOf(parent.pid)).toBeGreaterThan(4), { timeout: 5_000 });
        demote(child);
        await vi.waitFor(() => expect(priorityOf(child)).toBeGreaterThan(4), { timeout: 5_000 });
        const timeline = await guard.stop();
        // A second warning needs a clean sample between the two demotions.
        expect(warn).toHaveBeenCalled();
        expect(warn.mock.calls.every(([message]) => message.startsWith("Background QoS demoted 1 process(es) of the fixture"))).toBe(true);
        expect(timeline.samples.every((entry) => entry.processes === 2)).toBe(true);
        expect(timeline.samples.reduce((total, entry) => total + entry.cleared, 0)).toBe(2);
      } finally {
        if (child) process.kill(child, "SIGKILL");
        parent.kill("SIGKILL");
      }
    },
  );
});
