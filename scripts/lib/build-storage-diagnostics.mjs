import { BUILD_STORAGE_BUDGETS, formatBytes } from "./disk-space.mjs";

const MAX_HOLDERS = 8;

function boundedContext(value, maximum) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

/** Project the existing authority's observation, never its capabilities or
 * process command lines. Paths are local diagnostics, not a shareable report. */
export function buildStorageReservationDiagnostics(
  report,
  { nowMs = Date.now() } = {},
) {
  const active = [...report.active].sort(
    (left, right) => left.record.acquiredAtUnixMs - right.record.acquiredAtUnixMs,
  );
  return {
    reservedBytes: report.reservedBytes,
    invalidCount: report.invalid.length,
    observationStatus: report.observationStatus,
    activeCount: active.length,
    omittedCount: Math.max(0, active.length - MAX_HOLDERS),
    active: active.slice(0, MAX_HOLDERS).map(({ record, liveness }) => ({
      acquiredAtUnixMs: record.acquiredAtUnixMs,
      ageMs: Math.max(0, nowMs - record.acquiredAtUnixMs),
      cwd: boundedContext(record.cwd, 512),
      label: boundedContext(record.label, 96),
      // Older standard runner leases already carry the class in their label.
      buildClass: record.buildClass ??
        Object.keys(BUILD_STORAGE_BUDGETS).find(
          (kind) => record.label === `${kind} build`,
        ) ?? "unknown",
      liveness,
      pid: record.pid,
      requestedBytes: record.requestedBytes,
    })),
  };
}

function quotedContext(value) {
  // JSON quotes newlines and C0 controls; also escape terminal C1 controls and
  // Unicode direction/line controls so a holder cannot forge diagnostic rows.
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function ageLabel(ageMs) {
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatBuildStorageReservationDiagnostics(diagnostics) {
  if (!diagnostics) return "Reservation holder details unavailable.";
  const lines = [
    `Reservation holders: ${diagnostics.activeCount ?? diagnostics.active.length}, ` +
      `${formatBytes(diagnostics.reservedBytes)} reserved; ` +
      `observation=${diagnostics.observationStatus}, invalid=${diagnostics.invalidCount}.`,
    ...diagnostics.active.map((holder) =>
      `  pid=${holder.pid} class=${holder.buildClass} reserved=${formatBytes(holder.requestedBytes)} ` +
      `age=${ageLabel(holder.ageMs)} liveness=${holder.liveness} ` +
      `label=${quotedContext(holder.label)} worktree=${quotedContext(holder.cwd)}`,
    ),
  ];
  if (diagnostics.omittedCount > 0) {
    lines.push(`  ${diagnostics.omittedCount} more holders omitted (limit ${MAX_HOLDERS}).`);
  }
  if (diagnostics.active.length > 0) {
    lines.push("Age is elapsed time, not a completion estimate. Unknown liveness does not prove exit.");
  }
  return lines.join("\n");
}
