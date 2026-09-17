import {
  BackendProfileError,
  backendProfilesErrorReport,
} from "./backend-profiles.mjs";
import { backendTransportErrorReport } from "./backend-transport.mjs";
import {
  LocalBackendError,
  localBackendErrorReport,
} from "./local-backend.mjs";

function projectLocalBackendReceipt(report) {
  return {
    ...report.error,
    ...(report.status === undefined
      ? {}
      : { status: report.status, retryable: report.retryable }),
    ...(report.action === undefined ? {} : { action: { ...report.action } }),
  };
}

export function backendRequestFailure(error, profile) {
  if (error instanceof LocalBackendError) {
    return projectLocalBackendReceipt(localBackendErrorReport(error));
  }
  if (error instanceof BackendProfileError) {
    return backendProfilesErrorReport(error).error;
  }
  return backendTransportErrorReport(error, profile).error;
}
