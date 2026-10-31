/** Guidance for an `agent_runtime_source_busy` refusal. The backend sends only
 * a typed `reasonCode` naming its Host evidence; this CLI owns the copy.
 * The refusal happens before admission, so nothing was stopped or switched
 * and the same exact command can be retried once the session is idle. */
const REASONS = {
  agent_working: "The session reports work in progress: a running turn, or background shells, subagents or scheduled wakeups still running after the turn ended.",
  agent_background_work: "The session's turn ended, but background work it started (shells, subagents or scheduled wakeups) is still running.",
  agent_attention_required: "The session is waiting for an approval or an answer.",
  agent_starting: "The session is still starting.",
  agent_state_unavailable: "The session has not reported that it is idle.",
  controller_input_pending: "The session has typed input that was not submitted.",
  agent_observation_changed: "The session changed after it was observed idle.",
};

const BACKGROUND_REASONS = new Set(["agent_working", "agent_background_work"]);

/** An error code for text output, with its typed reason when one was sent. */
export function refusalLabel(error) {
  const code = error.remoteCode ?? error.code;
  return error.reasonCode ? `${code} (${error.reasonCode})` : code;
}

export function isSourceBusyRefusal(error) {
  return (error?.remoteCode ?? error?.code) === "agent_runtime_source_busy";
}

/** Replace the transport's generic text on a busy refusal; other errors pass. */
export function withSourceBusyGuidance(error, providerId) {
  return isSourceBusyRefusal(error)
    ? { ...error, message: sourceBusyMessage({ reasonCode: error.reasonCode, providerId }) }
    : error;
}

export function sourceBusyMessage({ reasonCode, providerId } = {}) {
  return [
    REASONS[reasonCode] ?? "The session is busy or has unsent input.",
    "Nothing was stopped or switched.",
    "Wait for that work to finish, or finish, answer or stop it inside the session, then run the same command again.",
    ...(providerId === "claude" && BACKGROUND_REASONS.has(reasonCode) ? [
      "In Claude Code, exiting stops its background tasks, and \"Move to background and exit\" keeps the conversation running without a pane on the current account.",
    ] : []),
  ].join(" ");
}
