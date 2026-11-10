// Reads the per-run records `dure-control-plane serve` keeps under
// <DURE_HOME>/backend/hub-runs/ so `dure diagnostics` can say how long the
// current hub has been up and how the previous one ended.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const HUB_LAUNCH_REASON_ENVIRONMENT = "DURE_HUB_LAUNCH_REASON";
const HUB_RUNS_DIRECTORY = "hub-runs";

const RECORD_SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_RECORDS = 64;
const RECORD_NAME = /^run-\d{13}-\d{1,10}\.json$/;
const EXIT_CAUSES = new Set(["shutdown", "error", "signal", "panic", "unrecorded"]);
const LAUNCH_REASONS = new Set([
  "first_start",
  "restart_unreachable",
  "replacement",
  "activation_recovery",
  "unspecified",
]);

function readOwnerJson(pathname) {
  try {
    const stat = lstatSync(pathname);
    if (
      !stat.isFile() ||
      stat.size > MAX_RECORD_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      return null;
    }
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

function text(value, maximum = 512) {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maximum).replace(/[\u0000-\u001f\u007f]/g, " ")
    : null;
}

function time(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function processId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizePanic(value) {
  if (!value || typeof value !== "object") return null;
  const atMs = time(value.atMs);
  const message = text(value.message);
  if (atMs === null || !message) return null;
  return { atMs, message, location: text(value.location) };
}

function normalizeExit(value) {
  if (!value || typeof value !== "object" || !EXIT_CAUSES.has(value.cause)) {
    return null;
  }
  const recordedAtMs = time(value.recordedAtMs);
  const uptimeMs = time(value.uptimeMs);
  if (recordedAtMs === null || uptimeMs === null) return null;
  return {
    cause: value.cause,
    recordedAtMs,
    uptimeMs,
    signal: text(value.signal, 32),
    error: text(value.error),
    recordedByProcessId: processId(value.recordedByProcessId),
  };
}

export function normalizeHubRunRecord(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== RECORD_SCHEMA_VERSION) {
    return null;
  }
  const record = {
    processId: processId(value.processId),
    generation: text(value.generation, 128),
    buildId: text(value.buildId, 256),
    startedAtMs: time(value.startedAtMs),
    lastAliveAtMs: time(value.lastAliveAtMs),
    launch: {
      reason: LAUNCH_REASONS.has(value.launch?.reason) ? value.launch.reason : "unspecified",
      launcherProcessId: processId(value.launch?.launcherProcessId),
    },
    lastPanic: normalizePanic(value.lastPanic),
    exit: value.exit === undefined || value.exit === null ? null : normalizeExit(value.exit),
  };
  if (
    record.processId === null ||
    !record.generation ||
    record.startedAtMs === null ||
    record.lastAliveAtMs === null ||
    (value.exit !== undefined && value.exit !== null && record.exit === null)
  ) {
    return null;
  }
  return record;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readRecords(directory) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => RECORD_NAME.test(name));
  } catch {
    return [];
  }
  return names
    .sort()
    .slice(-MAX_RECORDS)
    .map((name) => normalizeHubRunRecord(readOwnerJson(join(directory, name))))
    .filter(Boolean);
}

function currentDescriptor(backendRoot) {
  const descriptor = readOwnerJson(join(backendRoot, "control-plane.json"));
  const pid = processId(descriptor?.processId);
  const generation = text(descriptor?.generation, 128);
  return pid !== null && generation ? { processId: pid, generation } : null;
}

/**
 * Describes the current hub run and the most recent hub ending.
 * A run without an ending whose process is gone ended without a record; the
 * next hub to start writes that down too, so both views agree.
 */
export function inspectHubRuns({ backendRoot, now = Date.now(), isAlive = processExists }) {
  const recordsDirectory = join(backendRoot, HUB_RUNS_DIRECTORY);
  const records = readRecords(recordsDirectory);
  const descriptor = currentDescriptor(backendRoot);
  const descriptorAlive = descriptor !== null && isAlive(descriptor.processId);
  const current = descriptorAlive
    ? records.findLast(
        (record) =>
          record.exit === null &&
          record.processId === descriptor.processId &&
          record.generation === descriptor.generation,
      ) ?? null
    : null;
  const ended = records.filter(
    (record) => record !== current && (record.exit !== null || !isAlive(record.processId)),
  );
  const last = ended.reduce(
    (latest, record) =>
      latest === null || record.lastAliveAtMs >= latest.lastAliveAtMs ? record : latest,
    null,
  );
  return {
    state: current ? "running" : descriptorAlive ? "running_without_record" : "not_running",
    recordsDirectory,
    current: current && {
      processId: current.processId,
      generation: current.generation,
      buildId: current.buildId,
      startedAtMs: current.startedAtMs,
      uptimeMs: Math.max(0, now - current.startedAtMs),
      lastAliveAtMs: current.lastAliveAtMs,
      launch: current.launch,
      lastPanic: current.lastPanic,
    },
    lastExit: last && {
      processId: last.processId,
      generation: last.generation,
      buildId: last.buildId,
      startedAtMs: last.startedAtMs,
      lastAliveAtMs: last.lastAliveAtMs,
      launch: last.launch,
      lastPanic: last.lastPanic,
      cause: last.exit?.cause ?? "unrecorded",
      recordedAtMs: last.exit?.recordedAtMs ?? null,
      uptimeMs: last.exit?.uptimeMs ?? Math.max(0, last.lastAliveAtMs - last.startedAtMs),
      signal: last.exit?.signal ?? null,
      error: last.exit?.error ?? null,
      recordedByProcessId: last.exit?.recordedByProcessId ?? null,
    },
  };
}

export function formatDuration(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function describeExit(exit) {
  const after = `after ${formatDuration(exit.uptimeMs)} (pid ${exit.processId})`;
  switch (exit.cause) {
    case "shutdown":
      return `shut down at ${iso(exit.recordedAtMs)} ${after}`;
    case "signal":
      return `ended by ${exit.signal ?? "a signal"} at ${iso(exit.recordedAtMs)} ${after}`;
    case "error":
      return `stopped on error at ${iso(exit.recordedAtMs)} ${after}: ${exit.error ?? "unknown error"}`;
    case "panic":
      return `stopped on a panic at ${iso(exit.recordedAtMs)} ${after}`;
    default:
      return [
        "ended without an exit record (it had no chance to write one: SIGKILL, memory pressure or power loss)",
        `last alive ${iso(exit.lastAliveAtMs)}`,
        ...(exit.recordedAtMs === null ? [] : [`noticed ${iso(exit.recordedAtMs)}`]),
        `uptime at least ${formatDuration(exit.uptimeMs)} (pid ${exit.processId})`,
      ].join("; ");
  }
}

function describePanic(panic) {
  return `${iso(panic.atMs)} ${panic.message}${panic.location ? ` (${panic.location})` : ""}`;
}

export function formatHubRunLines(hub) {
  if (!hub) return [];
  if (hub.state === "unavailable") return ["hub:", "  state: unavailable"];
  const lines = ["hub:", `  state: ${hub.state}`];
  if (hub.current) {
    const { current } = hub;
    lines.push(
      `  process_id: ${current.processId}`,
      `  generation: ${current.generation}`,
      `  started_at: ${iso(current.startedAtMs)}`,
      `  uptime: ${formatDuration(current.uptimeMs)}`,
      `  launch_reason: ${current.launch.reason}${
        current.launch.launcherProcessId ? ` (launcher pid ${current.launch.launcherProcessId})` : ""
      }`,
    );
    if (current.lastPanic) lines.push(`  last_panic: ${describePanic(current.lastPanic)}`);
  }
  lines.push(`  last_exit: ${hub.lastExit ? describeExit(hub.lastExit) : "none recorded"}`);
  if (hub.lastExit?.lastPanic) {
    lines.push(`  last_exit_panic: ${describePanic(hub.lastExit.lastPanic)}`);
  }
  lines.push(`  records: ${hub.recordsDirectory}`);
  return lines;
}
