import { runBoundedCommand } from "./bounded-command.mjs";
import {
  DEFAULT_SESSION_READ_DEADLINE_MS,
  MAX_SESSION_READ_DEADLINE_MS,
  MAX_SESSION_READ_LINES,
} from "./session-read-limits.mjs";

// Hmux owns the work deadline. This grace only lets its child process start,
// report the native failure, and exit before the last-resort watchdog fires.
const READ_PROCESS_GRACE_MS = 1_000;

export class SessionCaptureError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "SessionCaptureError";
    this.kind = kind;
  }
}

export async function captureLocalScreen({
  command,
  sessionId,
  workspaceId,
  lines,
  json = false,
  deadlineMs = DEFAULT_SESSION_READ_DEADLINE_MS,
  signal,
  inspectCompatibility,
  compatibilityMessage,
}) {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_SESSION_READ_DEADLINE_MS
  ) {
    throw new SessionCaptureError(
      "invalid",
      `--deadline-ms must be an integer from 1 to ${MAX_SESSION_READ_DEADLINE_MS}`,
    );
  }
  const argv = [command, "read", sessionId];
  if (workspaceId) argv.push("--workspace", workspaceId);
  argv.push(
    "--lines", String(Math.min(MAX_SESSION_READ_LINES, Math.max(1, lines || 20))),
    "--deadline-ms", String(deadlineMs),
  );
  if (json) argv.push("--json");
  const result = await runBoundedCommand(argv, {
    signal,
    timeoutMs: deadlineMs + READ_PROCESS_GRACE_MS,
  });
  if (signal?.aborted || result.kind === "aborted") {
    throw new SessionCaptureError("aborted", "Session read interrupted");
  }
  if (result.kind === "success") {
    if (!json) return result.stdout;
    let receipt;
    try { receipt = JSON.parse(result.stdout); } catch { /* Validate below. */ }
    if (receipt?.ok !== true || typeof receipt.sessionName !== "string"
      || typeof receipt.sequenceThrough !== "string" || !/^(0|[1-9][0-9]*)$/.test(receipt.sequenceThrough)
      || !Array.isArray(receipt.lines) || receipt.lines.length > MAX_SESSION_READ_LINES
      || !receipt.lines.every((line) => typeof line === "string")) {
      throw new SessionCaptureError("invalid", "Hmux returned an invalid JSON screen receipt. Update Dure before retrying.");
    }
    return `${JSON.stringify(receipt)}\n`;
  }
  if (result.kind === "timeout") {
    throw new SessionCaptureError(
      "timeout",
      `Session read process timed out: stage=process_watchdog deadlineMs=${deadlineMs} graceMs=${READ_PROCESS_GRACE_MS}; Hmux did not report a native outcome`,
    );
  }
  let message = result.stderr?.trim() || result.message || (
    result.kind === "output_limit"
      ? "Session read output limit exceeded"
      : "Session read failed (the session may have exited)"
  );
  if (/^(?:hmux: error: )?hmux_read_deadline_exceeded:/u.test(message)) {
    throw new SessionCaptureError("timeout", message);
  }
  if (result.kind === "nonzero" || result.kind === "unavailable") {
    const inspection = await inspectCompatibility(signal);
    if (signal?.aborted) {
      throw new SessionCaptureError("aborted", "Session read interrupted");
    }
    if (!inspection.compatible) message += `\n${compatibilityMessage(inspection)}`;
  }
  throw new SessionCaptureError(result.kind, message);
}
