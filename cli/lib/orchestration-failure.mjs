import { backendTransportErrorReport } from "./backend-transport.mjs";

// Only derive guidance from known codes. Backend messages may contain private
// paths or provider output and must not be copied into CLI/MCP responses.
export function orchestrationFailureDetail(error) {
  const detail = backendTransportErrorReport(error).error;
  if (detail.remoteCode === "orchestration_request_invalid") {
    return { ...detail, disposition: "terminal", message:
      "The request body is invalid. Correct it using the tool's input schema or the dure-orchestration skill before resubmitting; retrying the unchanged body cannot succeed." };
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
