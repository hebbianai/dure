import { backendTransportErrorReport } from "./backend-transport.mjs";

// Only derive guidance from known codes. Backend messages may contain private
// paths or provider output and must not be copied into CLI/MCP responses.
export function orchestrationFailureDetail(error) {
  const detail = backendTransportErrorReport(error).error;
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
