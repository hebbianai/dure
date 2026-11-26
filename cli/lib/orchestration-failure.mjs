import { backendTransportErrorReport } from "./backend-transport.mjs";

// Only derive guidance from known codes. Backend messages may contain private
// paths or provider output and must not be copied into CLI/MCP responses.
// A goal continues a structured conversation. Neither refusal below changes by
// resending the same request, so the hint is terminal even when an older
// backend still reports retry_same.
const GOAL_REFUSALS = Object.freeze({
  agent_goal_interaction_profile_unsupported:
    "This agent runs a native CLI (for example a provider terminal started by dure run or a pane), and Dure goals continue only a structured conversation such as the app's chat. Goals are unavailable for this agent: tell the user, keep the work in this conversation, and do not resend agent_goal_put; retrying cannot succeed.",
  agent_goal_conversation_not_found:
    "The backend has no conversation for this agentId, so it cannot store a goal for it. Use the agent ID from the Dure conversation context or run receipt; retrying the same request cannot succeed.",
});

// orchestration_generation_conflict reasons that say why the exact Session
// generation cannot use orchestration, and what changes that.
const GENERATION_CONFLICTS = Object.freeze({
  hmux_session_exited:
    "This managed Session generation has exited, so it no longer owns an orchestration inbox. " +
    "If it is this process's own Session, this process outlived a restart or account switch " +
    "(for example a background fork): stop acting from it and continue in the Agent's current " +
    "Session, which `dure runs show <agent>` names; its tools resolve the moved inbox automatically. " +
    "If it is a destination Session, resolve that Agent's current Session before sending. " +
    "Retrying from this generation cannot succeed.",
  session_agent_binding_missing:
    "This managed Session is live, but no Dure Agent binds it as its current Session, so it " +
    "cannot report through orchestration. If the Agent was just restarted or switched accounts, " +
    "that restart has not published its binding: `dure runs resume <agent>` shows it and prints " +
    "the command that finishes it. Otherwise the provider was started outside a Dure Agent; " +
    "`dure runs show <agent>` names the Agent's current Session. Retrying the same lookup " +
    "cannot succeed until that binding changes; do not create another Run.",
  session_dispatch_unassigned:
    "This managed Session is live, but it has not opened its durable inbox: no orchestration " +
    "Dispatch names it yet. A Session opens its own inbox when its provider resolves its " +
    "orchestration context, at session start through the dure-orchestration integration or at " +
    "its first orchestration tool call; no other Session can open it. In that Session, " +
    "`dure orchestration tool orchestration_context_get_current` opens it, and " +
    "`dure orchestration status` shows whether the integration is installed. Retrying before " +
    "then cannot succeed.",
});

function sessionUnavailableMessage(reasonCode) {
  switch (reasonCode) {
    case "hmux_runtime_identity_changed":
      return "The backend's Hmux runtime changed after startup. Restart the Dure app that owns this backend, reconnect the orchestration tools, then retry the same context lookup.";
    case "hmux_descriptor_timeout":
    case "hmux_descriptor_unavailable":
      return "The backend could not observe the managed session. Retry the same context lookup after connectivity recovers; do not reset the Dispatch or create another Run.";
    default:
      return "The backend could not validate the session observation. Run dure diagnostics --json and include this reason code in feedback if it persists; do not reset the Dispatch or create another Run.";
  }
}

/** What a typed backend refusal means and what to do next, or null when its
 * codes carry no guidance. `detail` is a backend transport error report. */
export function orchestrationFailureGuidance(detail) {
  const { remoteCode, reasonCode } = detail;
  if (Object.hasOwn(GOAL_REFUSALS, remoteCode)) {
    return { disposition: "terminal", message: GOAL_REFUSALS[remoteCode] };
  }
  if (remoteCode === "orchestration_request_invalid") {
    return { disposition: "terminal", message:
      "The request body is invalid. Correct it using the tool's input schema or the dure-orchestration skill before resubmitting; retrying the unchanged body cannot succeed." };
  }
  if (remoteCode === "orchestration_method_unsupported") {
    return { message:
      "The backend does not accept this orchestration method. Methods are dotted names such as " +
      "interaction.get or events.read (see dure orchestration --help); MCP tool names run with " +
      "dure orchestration tool. A backend older than this client may not offer the method yet; " +
      "retrying the same method cannot succeed." };
  }
  if (remoteCode === "orchestration_generation_conflict" &&
      Object.hasOwn(GENERATION_CONFLICTS, reasonCode)) {
    return { message: GENERATION_CONFLICTS[reasonCode] };
  }
  if (remoteCode === "orchestration_session_unavailable") {
    return { message: sessionUnavailableMessage(reasonCode) };
  }
  return null;
}

export function orchestrationFailureDetail(error) {
  const detail = backendTransportErrorReport(error).error;
  const guidance = orchestrationFailureGuidance(detail);
  return guidance ? { ...detail, ...guidance } : detail;
}
