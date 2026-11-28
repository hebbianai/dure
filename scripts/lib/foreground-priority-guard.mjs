import { execFile } from "node:child_process";
import { getPriority } from "node:os";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export const FOREGROUND_GUARD_INTERVAL_MS = 30_000;
const TOOL_TIMEOUT_MS = 10_000;
const NAMED_COMMANDS = 4;

/** Darwin runs every thread of a PRIO_DARWIN_BG process at MAXPRI_THROTTLE,
 * which `ps` reports as PRI 4 (osfmk/kern/sched.h). */
const DARWIN_THROTTLED_PRIORITY = 4;

/** Per-platform census and background-lift primitives. Only Darwin has a
 * background state that the process owner can lift without privileges: an
 * unprivileged owner may raise nice but never lower it, so nice is recorded,
 * not changed. `taskpolicy -B -p` clears the demotion another process applied
 * (`taskpolicy -b -p`, which children started afterwards inherit); a process
 * that put itself in the background keeps that state. */
const ADAPTERS = Object.freeze({
  darwin: Object.freeze({
    async census(execute) {
      const { stdout } = await execute("/bin/ps", ["-ax", "-o", "pid=,ppid=,nice=,pri=,comm="], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: TOOL_TIMEOUT_MS,
      });
      return parseProcessCensus(stdout);
    },
    isBackground: (member) => member.priority <= DARWIN_THROTTLED_PRIORITY,
    async clearBackground(pid, execute) {
      await execute("/usr/sbin/taskpolicy", ["-B", "-p", String(pid)], {
        encoding: "utf8",
        timeout: TOOL_TIMEOUT_MS,
      });
    },
  }),
});

export function foregroundPriorityAdapter(platform = process.platform) {
  return ADAPTERS[platform] ?? null;
}

/** Parse `ps -o pid=,ppid=,nice=,pri=,comm=`; unparseable lines are skipped. */
export function parseProcessCensus(stdout) {
  const members = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(.+?)\s*$/u);
    if (!match) continue;
    members.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      nice: Number(match[3]),
      priority: Number(match[4]),
      command: match[5],
    });
  }
  return members;
}

/** The root and every descendant present in one census snapshot. */
export function processTree(census, rootPid) {
  const children = new Map();
  for (const member of census) {
    if (member.pid === member.ppid) continue;
    if (!children.has(member.ppid)) children.set(member.ppid, []);
    children.get(member.ppid).push(member);
  }
  const root = census.find((member) => member.pid === rootPid);
  if (!root) return [];
  const tree = [root];
  for (let index = 0; index < tree.length; index += 1) {
    tree.push(...(children.get(tree[index].pid) ?? []));
  }
  return tree;
}

function named(members) {
  return {
    count: members.length,
    commands: [...new Set(members.map((member) => basename(member.command)))].slice(0, NAMED_COMMANDS),
  };
}

/** Observe the tree once and lift every background member out of it. */
export async function sampleForegroundPriority({ adapter, execute = executeFile, rootPid, baselineNice, atMs }) {
  let census;
  try {
    census = await adapter.census(execute);
  } catch (error) {
    return { atMs, error: error.message.split("\n")[0] };
  }
  const tree = processTree(census, rootPid);
  if (tree.length === 0) return null;
  const background = tree.filter(adapter.isBackground);
  let cleared = 0;
  for (const member of background) {
    try {
      await adapter.clearBackground(member.pid, execute);
      cleared += 1;
    } catch {
      // The member may have exited since the census; the next sample retries.
    }
  }
  return {
    atMs,
    processes: tree.length,
    highestNice: Math.max(...tree.map((member) => member.nice)),
    background: named(background),
    raisedNice: named(tree.filter((member) => member.nice > baselineNice)),
    cleared,
  };
}

const commandList = (members) =>
  members.commands.length ? ` (${members.commands.join(", ")}${members.count > members.commands.length ? ", …" : ""})` : "";

/** One warning per demotion episode: when a sample starts showing it. */
export function demotionWarnings(previous, sample, { label, baselineNice }) {
  const warnings = [];
  if (sample.error) {
    if (!previous?.error) warnings.push(`Could not observe the ${label} process tree, so a background demotion would go unnoticed: ${sample.error}`);
    return warnings;
  }
  if (sample.background.count && !previous?.background?.count) {
    warnings.push(
      `Background QoS demoted ${sample.background.count} process(es) of the ${label}${commandList(sample.background)}; lifted ${sample.cleared} with taskpolicy -B. The step summary has the timeline.`,
    );
  }
  if (sample.raisedNice.count && !previous?.raisedNice?.count) {
    warnings.push(
      `nice ${sample.highestNice} (started at ${baselineNice}) on ${sample.raisedNice.count} process(es) of the ${label}${commandList(sample.raisedNice)}; an unprivileged runner cannot lower it, so the build may run slower. The step summary has the timeline.`,
    );
  }
  return warnings;
}

/** Sample immediately and then every interval until stopped. */
export function startForegroundPriorityGuard({
  rootPid,
  label,
  adapter = foregroundPriorityAdapter(),
  execute = executeFile,
  intervalMs = FOREGROUND_GUARD_INTERVAL_MS,
  baselineNice = getPriority(),
  clock = () => performance.now(),
  warn = (message) => process.stdout.write(`::warning::${message}\n`),
}) {
  if (!adapter) return { stop: async () => null };
  const started = clock();
  const stopping = new AbortController();
  const samples = [];
  const loop = (async () => {
    let previous = null;
    while (!stopping.signal.aborted) {
      const sample = await sampleForegroundPriority({
        adapter, execute, rootPid, baselineNice, atMs: clock() - started,
      });
      if (sample) {
        for (const message of demotionWarnings(previous, sample, { label, baselineNice })) warn(message);
        samples.push(sample);
        previous = sample;
      }
      await delay(intervalMs, undefined, { signal: stopping.signal }).catch(() => {});
    }
  })();
  return {
    async stop() {
      stopping.abort();
      await loop;
      return { label, intervalMs, baselineNice, durationMs: clock() - started, samples };
    },
  };
}

function clockTime(ms) {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

const range = (low, high) => (low === high ? `${low}` : `${low}–${high}`);

/** Consecutive samples in the same state share one row. */
export function priorityTimelineRows(samples) {
  const rows = [];
  for (const sample of samples) {
    const state = sample.error ?? `${sample.highestNice}:${sample.background.count > 0}`;
    const row = rows.at(-1);
    if (row?.state === state) {
      row.lastAtMs = sample.atMs;
      row.samples.push(sample);
    } else {
      rows.push({ state, firstAtMs: sample.atMs, lastAtMs: sample.atMs, samples: [sample] });
    }
  }
  return rows.map(({ firstAtMs, lastAtMs, samples: group }) => {
    const [first] = group;
    const time = range(clockTime(firstAtMs), clockTime(lastAtMs));
    if (first.error) return { time, error: first.error };
    const processes = group.map((sample) => sample.processes);
    const background = group.map((sample) => sample.background.count);
    const commands = [...new Set(group.flatMap((sample) => sample.background.commands))];
    return {
      time,
      processes: range(Math.min(...processes), Math.max(...processes)),
      highestNice: first.highestNice,
      background: `${range(Math.min(...background), Math.max(...background))}${commands.length ? ` (${commands.slice(0, NAMED_COMMANDS).join(", ")})` : ""}`,
      cleared: group.reduce((total, sample) => total + sample.cleared, 0),
    };
  });
}

/** Markdown for $GITHUB_STEP_SUMMARY. */
export function renderPriorityTimeline({ label, intervalMs, baselineNice, durationMs, samples }) {
  const observed = samples.filter((sample) => !sample.error);
  const demoted = observed.some((sample) => sample.background.count);
  const niced = observed.some((sample) => sample.raisedNice.count);
  const cleared = observed.reduce((total, sample) => total + sample.cleared, 0);
  const verdict = demoted || niced
    ? [
        demoted ? `Background QoS was seen and lifted ${cleared} time(s).` : null,
        niced ? "nice was raised above its starting value; an unprivileged runner cannot lower it." : null,
      ].filter(Boolean).join(" ")
    : "No background QoS or raised nice was seen.";
  const lines = [
    `### Scheduling priority: ${label}`,
    "",
    `Sampled every ${duration(intervalMs)} for ${duration(durationMs)}, starting at nice ${baselineNice}. ${verdict}`,
    "",
    "| Time | Processes | Highest nice | Background QoS | Lifted |",
    "| --- | --- | --- | --- | --- |",
    ...priorityTimelineRows(samples).map((row) =>
      row.error
        ? `| ${row.time} | not observed: ${row.error.replaceAll("|", "\\|")} | | | |`
        : `| ${row.time} | ${row.processes} | ${row.highestNice} | ${row.background} | ${row.cleared} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
