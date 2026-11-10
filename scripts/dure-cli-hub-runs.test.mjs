import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatDuration,
  formatHubRunLines,
  inspectHubRuns,
  normalizeHubRunRecord,
} from "../cli/lib/hub-run-records.mjs";
import {
  createDiagnosticReport,
  formatDiagnosticReport,
} from "../cli/lib/runtime-diagnostics.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function backendRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hub-runs-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "hub-runs"), { mode: 0o700 });
  return root;
}

function writeOwner(pathname, value, mode = 0o600) {
  fs.writeFileSync(pathname, `${JSON.stringify(value)}\n`, { mode });
  fs.chmodSync(pathname, mode);
}

function writeRun(root, record, mode) {
  const name = `run-${String(record.startedAtMs).padStart(13, "0")}-${record.processId}.json`;
  writeOwner(path.join(root, "hub-runs", name), { schemaVersion: 1, ...record }, mode);
}

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 1, 15, 59, 0);

function run(processId, startedAtMs, fields = {}) {
  return {
    processId,
    generation: "local-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    buildId: "dure-control-plane/v9-test",
    startedAtMs,
    lastAliveAtMs: startedAtMs,
    launch: { reason: "first_start", launcherProcessId: 700 },
    ...fields,
  };
}

describe("hub run records", () => {
  it("reports the current hub and how the previous hub ended", () => {
    const root = backendRoot();
    writeRun(root, run(100, T0, {
      lastAliveAtMs: T0 + HOUR,
      exit: { cause: "signal", recordedAtMs: T0 + HOUR, uptimeMs: HOUR, signal: "SIGTERM" },
    }));
    writeRun(root, run(200, T0 + 2 * HOUR, {
      lastAliveAtMs: T0 + 2 * HOUR + 60_000,
      launch: { reason: "restart_unreachable", launcherProcessId: 701 },
    }));
    writeOwner(path.join(root, "control-plane.json"), {
      processId: 200,
      generation: "local-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const hub = inspectHubRuns({
      backendRoot: root,
      now: T0 + 3 * HOUR + 2 * 60_000,
      isAlive: (pid) => pid === 200,
    });

    expect(hub).toMatchObject({
      state: "running",
      current: {
        processId: 200,
        uptimeMs: HOUR + 2 * 60_000,
        launch: { reason: "restart_unreachable", launcherProcessId: 701 },
      },
      lastExit: { processId: 100, cause: "signal", signal: "SIGTERM", uptimeMs: HOUR },
    });
    const text = formatHubRunLines(hub).join("\n");
    expect(text).toContain("  state: running");
    expect(text).toContain("  uptime: 1h 2m");
    expect(text).toContain("  launch_reason: restart_unreachable (launcher pid 701)");
    expect(text).toContain(
      "  last_exit: ended by SIGTERM at 2026-11-01T16:59:00.000Z after 1h 0m (pid 100)",
    );
  });

  it("treats a run whose process is gone without an ending as unrecorded, bounded by its heartbeat", () => {
    const root = backendRoot();
    writeRun(root, run(100, T0, {
      lastAliveAtMs: T0 + 95 * 60_000,
      lastPanic: { atMs: T0 + 90 * 60_000, message: "worker failed", location: "src/lib.rs:7" },
    }));
    writeOwner(path.join(root, "control-plane.json"), {
      processId: 100,
      generation: "local-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const hub = inspectHubRuns({ backendRoot: root, now: T0 + 3 * HOUR, isAlive: () => false });

    expect(hub.state).toBe("not_running");
    expect(hub.current).toBeNull();
    expect(hub.lastExit).toMatchObject({
      processId: 100,
      cause: "unrecorded",
      recordedAtMs: null,
      uptimeMs: 95 * 60_000,
      lastAliveAtMs: T0 + 95 * 60_000,
    });
    const text = formatHubRunLines(hub).join("\n");
    expect(text).toContain("ended without an exit record");
    expect(text).toContain("last alive 2026-11-01T17:34:00.000Z");
    expect(text).toContain("uptime at least 1h 35m (pid 100)");
    expect(text).not.toContain("noticed");
    expect(text).toContain("  last_exit_panic: 2026-11-01T17:29:00.000Z worker failed (src/lib.rs:7)");
  });

  it("shows when a successor noticed an unrecorded ending", () => {
    const root = backendRoot();
    writeRun(root, run(100, T0, {
      lastAliveAtMs: T0 + HOUR,
      exit: { cause: "unrecorded", recordedAtMs: T0 + 2 * HOUR, uptimeMs: HOUR, recordedByProcessId: 200 },
    }));

    const hub = inspectHubRuns({ backendRoot: root, now: T0 + 3 * HOUR, isAlive: () => false });

    expect(hub.lastExit).toMatchObject({ cause: "unrecorded", recordedByProcessId: 200 });
    expect(formatHubRunLines(hub).join("\n")).toContain(
      "noticed 2026-11-01T17:59:00.000Z; uptime at least 1h 0m (pid 100)",
    );
  });

  it("distinguishes a live hub from a build without run records", () => {
    const root = backendRoot();
    writeOwner(path.join(root, "control-plane.json"), {
      processId: 300,
      generation: "local-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    const hub = inspectHubRuns({ backendRoot: root, now: T0, isAlive: () => true });

    expect(hub).toMatchObject({ state: "running_without_record", current: null, lastExit: null });
    expect(formatHubRunLines(hub)).toContain("  last_exit: none recorded");
  });

  it("ignores records that are not owner-only or do not match the schema", () => {
    const root = backendRoot();
    writeRun(root, run(100, T0, {
      exit: { cause: "signal", recordedAtMs: T0 + HOUR, uptimeMs: HOUR, signal: "SIGTERM" },
    }), 0o644);
    writeRun(root, run(101, T0 + 1, { exit: { cause: "teleported", recordedAtMs: 1, uptimeMs: 1 } }));
    fs.writeFileSync(path.join(root, "hub-runs", "run-0000000000002-102.json"), "{", { mode: 0o600 });

    const hub = inspectHubRuns({ backendRoot: root, now: T0, isAlive: () => false });

    expect(hub).toMatchObject({ state: "not_running", current: null, lastExit: null });
    expect(normalizeHubRunRecord({ schemaVersion: 2 })).toBeNull();
  });

  it("strips control characters from recorded text", () => {
    const record = normalizeHubRunRecord({
      schemaVersion: 1,
      ...run(100, T0, {
        exit: { cause: "error", recordedAtMs: T0, uptimeMs: 0, error: "bad\u001b[31m\nthing" },
      }),
    });
    expect(record.exit.error).toBe("bad [31m thing");
  });

  it("formats durations compactly", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(5 * 60_000 + 3_000)).toBe("5m 3s");
    expect(formatDuration(26 * HOUR)).toBe("1d 2h");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("adds the hub section to diagnostics without changing the report status", () => {
    const hub = {
      state: "not_running",
      recordsDirectory: "/fixture/backend/hub-runs",
      current: null,
      lastExit: null,
    };
    const report = createDiagnosticReport({
      cli: { pathMatchesCurrent: true },
      app: { state: "running", compatibility: { state: "available", mode: "current" } },
      hmux: { compatible: true },
      hub,
    });
    expect(report).toMatchObject({ status: "ok", issues: [], hub });
    expect(formatDiagnosticReport(report)).toContain(
      "hub:\n  state: not_running\n  last_exit: none recorded\n  records: /fixture/backend/hub-runs",
    );
  });
});
