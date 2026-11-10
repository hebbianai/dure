// What a running OpenCode process is doing, folded from its plugin events.
// Kept apart from the plugin file because OpenCode calls every function that
// file exports as a plugin.
const fenceKeys = ["workspace_id", "session_id", "runner_principal", "runner_instance",
  "channel_epoch", "host_instance_id", "terminal_epoch"];
const ownerVariable = "DURE_OPENCODE_REPORTER_PID";

/** The exact Host fence this process inherited, or nothing if incomplete. */
export function managedFence(environment) {
  const fence = Object.fromEntries(fenceKeys.map((key) => [key, environment[`HMUX_${key.toUpperCase()}`]]));
  return fenceKeys.every((key) => typeof fence[key] === "string" && fence[key]) ? fence : undefined;
}

/**
 * Whether this process is the one that reports for its terminal. The launch
 * configuration is inherited by everything OpenCode starts, so an OpenCode run
 * from one of its tools would otherwise move the state of the pane it runs in.
 */
export function claimOpenCodeReporter(environment, pid) {
  const owner = environment[ownerVariable];
  if (owner && owner !== String(pid)) return false;
  environment[ownerVariable] = String(pid);
  return true;
}

export function createOpenCodeActivity() {
  return { busy: new Set(), children: new Set(), pending: new Map(), failed: false, aborted: false, reported: undefined };
}

/** Folds one event. Returns whether it finished the agent's last open turn. */
export function applyOpenCodeEvent(state, event) {
  const properties = event?.properties ?? {};
  const sessionId = properties.sessionID ?? properties.info?.id;
  const child = state.children.has(sessionId);
  switch (event?.type) {
    case "session.created":
    case "session.updated":
      if (properties.info?.parentID) state.children.add(properties.info.id);
      return false;
    case "session.deleted":
      state.busy.delete(sessionId);
      state.children.delete(sessionId);
      for (const [id, request] of state.pending) if (request.sessionId === sessionId) state.pending.delete(id);
      return false;
    case "session.status": {
      // A subagent runs inside its parent's turn, which stays busy for it.
      if (child || !sessionId) return false;
      if (properties.status?.type !== "idle") {
        state.busy.add(sessionId);
        state.failed = false;
        state.aborted = false;
        return false;
      }
      // OpenCode repeats idle; only the transition ends a turn.
      if (!state.busy.delete(sessionId) || state.busy.size > 0) return false;
      const completed = !state.failed && !state.aborted;
      state.aborted = false;
      return completed;
    }
    case "session.error":
      if (child || !state.busy.has(sessionId)) return false;
      if (properties.error?.name === "MessageAbortedError") state.aborted = true;
      else state.failed = true;
      return false;
    // A subagent's prompt still needs the person, so these count for any session.
    case "permission.asked":
      state.pending.set(properties.id, { sessionId, attention: "approval_required" });
      return false;
    case "question.asked":
      state.pending.set(properties.id, { sessionId, attention: "input_required" });
      return false;
    case "permission.replied":
    case "question.replied":
    case "question.rejected":
      state.pending.delete(properties.requestID);
      return false;
    default:
      return false;
  }
}

function currentAttention(state) {
  const waitingFor = new Set([...state.pending.values()].map((request) => request.attention));
  if (waitingFor.has("approval_required")) return "approval_required";
  if (waitingFor.has("input_required")) return "input_required";
  return state.failed ? "error" : "none";
}

/** The fenced report for the current state, or nothing if the Host has it. */
export function nextOpenCodeReport(state, fence, completed, requestId) {
  const attention = currentAttention(state);
  const activity = attention === "none" && state.busy.size > 0 ? "working" : "waiting";
  const key = `${activity}/${attention}`;
  const turnCompleted = completed && activity === "waiting" && attention === "none";
  if (key === state.reported && !turnCompleted) return undefined;
  state.reported = key;
  return {
    schema: "hmux-managed-agent-state-report-v1", schemaVersion: 1, expectedFence: fence,
    report: {
      request_id: requestId, identity_only: false, activity, attention, turn_completed: turnCompleted,
      // The process owns this lease: its exit ends the session's state.
      ...(activity === "working" ? { working_ttl_ms: "86400000" } : {}),
    },
  };
}
