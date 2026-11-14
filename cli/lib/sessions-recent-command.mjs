import { requestAppControl } from "./app-control-client.mjs";

const SESSIONS_RECENT_ERROR_KIND = "dure.sessions.recent.error";

/** Provider history (Claude, Codex, ...) as the connected app reads it. This
 * is not the Hmux census: it says nothing about which sessions are alive. */
export async function collectRecentSessions({ descriptor, fetchImpl }) {
  const payload = await requestAppControl({
    descriptor,
    path: "/sessions/recent",
    fetchImpl,
  });
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

/** The app answers every frontend route timeout with pane wording; name what
 * this command was actually waiting for. Reading history is read-only, so a
 * retry is always safe. */
function frontendTimeout(deliveryState) {
  return deliveryState === "claimed"
    ? {
        message:
          "The Dure app accepted the request but did not finish reading provider history in time.",
        nextAction:
          "Retry dure sessions recent. To find live sessions, use dure ls --alive --json; this failure does not mean any session exited.",
      }
    : {
        message: "No Dure window picked up the recent sessions request in time.",
        nextAction:
          "Check the selected app with dure diagnostics --json, then retry. To find live sessions, use dure ls --alive --json.",
      };
}

export function recentSessionsErrorReport(error) {
  const code = typeof error?.code === "string" ? error.code : "sessions_recent_failed";
  const deliveryState =
    error?.deliveryState === "claimed" || error?.deliveryState === "unclaimed"
      ? error.deliveryState
      : undefined;
  const timeout =
    code === "frontend_timeout" && deliveryState
      ? frontendTimeout(deliveryState)
      : undefined;
  const message =
    timeout?.message ?? (error instanceof Error ? error.message : String(error));
  const nextAction =
    timeout?.nextAction ??
    (typeof error?.nextAction === "string" ? error.nextAction : undefined);
  return {
    schemaVersion: 1,
    kind: SESSIONS_RECENT_ERROR_KIND,
    error: {
      code,
      ...(deliveryState ? { deliveryState } : {}),
      message,
      ...(timeout
        ? { retryable: true }
        : typeof error?.retryable === "boolean"
          ? { retryable: error.retryable }
          : {}),
      ...(nextAction ? { nextAction } : {}),
    },
  };
}

export function formatRecentSessionsError(report, { color = false } = {}) {
  const { message, nextAction } = report.error;
  const line = color ? `\x1b[31m${message}\x1b[0m` : message;
  return nextAction ? `${line}\n  → ${nextAction}` : line;
}
