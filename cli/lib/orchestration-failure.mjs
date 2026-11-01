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

export function orchestrationFailureDetail(error) {
  const detail = backendTransportErrorReport(error).error;
  if (Object.hasOwn(GOAL_REFUSALS, detail.remoteCode)) {
    return { ...detail, disposition: "terminal", message: GOAL_REFUSALS[detail.remoteCode] };
  }
  if (detail.remoteCode === "orchestration_request_invalid") {
    return { ...detail, disposition: "terminal", message:
      "The request body is invalid. Correct it using the tool's input schema or the dure-orchestration skill before resubmitting; retrying the unchanged body cannot succeed." };
  }
  if (detail.remoteCode === "orchestration_method_unsupported") {
    return { ...detail, message:
      "The backend does not accept this orchestration method. Methods are dotted names such as " +
      "interaction.get or events.read (see dure orchestration --help); MCP tool names run with " +
      "dure orchestration tool. A backend older than this client may not offer the method yet; " +
      "retrying the same method cannot succeed." };
  }
  if (detail.remoteCode === "orchestration_generation_conflict" &&
      detail.reasonCode === "hmux_session_exited") {
    return { ...detail, message:
      "This managed Session generation has exited, so it no longer owns an orchestration inbox. " +
      "If it is this process's own Session, this process outlived a restart or account switch " +
      "(for example a background fork): stop acting from it and continue in the Agent's current " +
      "Session, which `dure runs show <agent>` names; its tools resolve the moved inbox automatically. " +
      "If it is a destination Session, resolve that Agent's current Session before sending. " +
      "Retrying from this generation cannot succeed." };
  }
  if (detail.remoteCode !== "orchestration_session_unavailable") return detail;
  let message;
  switch (detail.reasonCode) {
    case "hmux_runtime_identity_changed":
      message = "The backend's Hmux runtime changed after startup. Restart the Dure app that owns this backend, reconnect the orchestration tools, then retry the same context lookup.";
      break;
    case "hmux_descriptor_timeout":
    case "hmux_descriptor_unavailable":
      message = "The backend could not observe the managed session. Retry the same context lookup after connectivity recovers; do not reset the Dispatch or create another Run.";
      break;
    default:
      message = "The backend could not validate the session observation. Run dure diagnostics --json and include this reason code in feedback if it persists; do not reset the Dispatch or create another Run.";
  }
  return { ...detail, message };
}
