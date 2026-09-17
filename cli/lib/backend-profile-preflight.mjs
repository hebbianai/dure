import { projectBackendProfile } from "./backend-profiles.mjs";
import { resolveBackendSshReferencesFromEnvironment } from "./backend-ssh-references.mjs";
import {
  BackendTransportError,
  backendTransportErrorReport,
  performBackendProfileRequest,
} from "./backend-transport.mjs";

const API_VERSION = "dure.backend-profiles/v1";

function validPingResult(result) {
  return (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Object.keys(result).length === 2 &&
    result.schemaVersion === 1 &&
    result.status === "ready"
  );
}

export async function testBackendProfile(
  selection,
  {
    deadlineMs,
    environment = process.env,
    requestBackend = performBackendProfileRequest,
    resolveSshReferences = resolveBackendSshReferencesFromEnvironment,
  } = {},
) {
  const response = await requestBackend(
    selection.profile,
    {
      body: { schemaVersion: 1 },
      operation: "backend.ping",
    },
    {
      deadlineMs,
      resolveSshReferences: (references) =>
        resolveSshReferences(references, environment),
    },
  );
  if (!validPingResult(response.result)) {
    throw new BackendTransportError("backend_transport_malformed_response");
  }
  return {
    schemaVersion: 1,
    apiVersion: API_VERSION,
    kind: "dure.backend_profiles.test",
    status: "ready",
    selection: { source: selection.source, id: selection.profile.id },
    profile: projectBackendProfile(selection.profile),
    backend: response.backend,
  };
}

export function backendProfileTestErrorReport(error, profile) {
  const transport = backendTransportErrorReport(error, profile);
  return {
    schemaVersion: 1,
    apiVersion: API_VERSION,
    kind: "dure.backend_profiles.test_error",
    status: "failed",
    profile: transport.profile,
    error: transport.error,
  };
}

export function formatBackendProfileTestReport(report) {
  return [
    `Dure backend profile test: ${report.profile.id}`,
    `  status: ${report.status}`,
    `  selected by: ${report.selection.source}`,
    `  transport: ${report.profile.transport.kind}`,
    `  backend: ${report.backend.id}@${report.backend.generation}`,
    `  protocol: ${report.backend.protocol.major}.${report.backend.protocol.minor}`,
    `  capabilities: ${report.backend.capabilities.length}`,
  ].join("\n");
}
