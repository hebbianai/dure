import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { validProjectId, validProjectPath } from "./project-contract.mjs";

export const PROJECT_CLIENT_SCHEMA_VERSION = 1;
export const DEFAULT_PROJECT_COMMAND_DEADLINE_MS = 2_500;
export const MAX_PROJECT_COMMAND_DEADLINE_MS = 10_000;
export const MAX_PROJECT_COMMAND_ITEMS = 128;
export const MAX_PROJECT_COMMAND_OUTPUT_BYTES = 256 * 1024;

const ROOT_IDENTITY = /^root_[a-f0-9]{32}$/;
const REPOSITORY_IDENTITY = /^repo_[a-f0-9]{32}$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, keys) {
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function boundedText(value, maximumBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function project(value) {
  if (
    !onlyKeys(value, ["id", "displayName", "rootId", "repositoryId"]) ||
    !validProjectId(value.id) ||
    !boundedText(value.displayName, 256) ||
    !ROOT_IDENTITY.test(value.rootId) ||
    !REPOSITORY_IDENTITY.test(value.repositoryId)
  ) {
    return null;
  }
  return {
    id: value.id,
    displayName: value.displayName,
    rootId: value.rootId,
    repositoryId: value.repositoryId,
  };
}

function backendPayload(value, action, projectId) {
  if (!record(value) || value.schemaVersion !== PROJECT_CLIENT_SCHEMA_VERSION) {
    return { error: "backend_projects_payload_invalid" };
  }
  if (action === "list") {
    if (
      !onlyKeys(value, ["schemaVersion", "complete", "projects"]) ||
      value.complete !== true ||
      !Array.isArray(value.projects) ||
      value.projects.length > MAX_PROJECT_COMMAND_ITEMS
    ) {
      return { error: "backend_projects_payload_invalid" };
    }
    const projects = value.projects.map(project);
    if (
      projects.some((item) => item === null) ||
      projects.some((item, index) => index > 0 && projects[index - 1].id >= item.id)
    ) {
      return { error: "backend_projects_payload_invalid" };
    }
    return { projects };
  }
  if (!onlyKeys(value, ["schemaVersion", "project"])) {
    return { error: "backend_projects_payload_invalid" };
  }
  const selected = project(value.project);
  if (!selected || selected.id !== projectId) {
    return { error: "backend_project_identity_mismatch" };
  }
  return { projects: [selected] };
}

function errorReport(action, code, observedAtMs, durationMs, details = {}) {
  const { deadlineMs = DEFAULT_PROJECT_COMMAND_DEADLINE_MS, ...error } = details;
  return {
    schemaVersion: PROJECT_CLIENT_SCHEMA_VERSION,
    apiVersion: "dure.projects/v1",
    kind: "dure.projects.error",
    action,
    complete: false,
    observedAtMs,
    durationMs,
    source: { kind: "backend_profile", appDaemonRequired: false },
    limits: {
      deadlineMs,
      maxItems: MAX_PROJECT_COMMAND_ITEMS,
      maxOutputBytes: MAX_PROJECT_COMMAND_OUTPUT_BYTES,
    },
    error: { code, ...error },
  };
}

function backendErrorReport(action, error, profile, startedAt, deadlineMs) {
  const observedAtMs = Date.now();
  const { code, ...detail } = backendRequestFailure(error, profile);
  return errorReport(
    action,
    code,
    observedAtMs,
    Math.max(0, observedAtMs - startedAt),
    {
      deadlineMs,
      ...(profile ? { profileId: profile.id } : {}),
      ...detail,
    },
  );
}

export async function collectProjectCommand({
  action,
  projectId,
  projectPath,
  displayName,
  backend,
  deadlineMs = DEFAULT_PROJECT_COMMAND_DEADLINE_MS,
  requestBackend = performBackendProfileRequest,
} = {}) {
  const startedAt = Date.now();
  const invalid =
    !["list", "register", "show"].includes(action) ||
    (["register", "show"].includes(action) && !validProjectId(projectId)) ||
    (action === "register" &&
      (!validProjectPath(projectPath) || !boundedText(displayName, 256))) ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_PROJECT_COMMAND_DEADLINE_MS;
  if (invalid) {
    return errorReport(
      action,
      "backend_projects_request_invalid",
      Date.now(),
      0,
      { deadlineMs: DEFAULT_PROJECT_COMMAND_DEADLINE_MS },
    );
  }
  const profile = backend?.profile;
  if (backend?.error || !profile) {
    return backendErrorReport(
      action,
      backend?.error,
      profile,
      startedAt,
      deadlineMs,
    );
  }
  let response;
  try {
    response = await requestBackend(
      profile,
      {
        body:
          action === "list"
            ? {
                schemaVersion: PROJECT_CLIENT_SCHEMA_VERSION,
                maxItems: MAX_PROJECT_COMMAND_ITEMS,
              }
            : action === "register"
              ? {
                  schemaVersion: PROJECT_CLIENT_SCHEMA_VERSION,
                  projectId,
                  displayName,
                  root: projectPath,
                }
              : {
                  schemaVersion: PROJECT_CLIENT_SCHEMA_VERSION,
                  projectId,
                },
        operation: `projects.${action}`,
        requiredCapabilities: [`projects.${action}`],
      },
      {
        ...backend.transportOptions,
        deadlineMs,
        maxResponseBytes: MAX_PROJECT_COMMAND_OUTPUT_BYTES,
      },
    );
  } catch (error) {
    return backendErrorReport(action, error, profile, startedAt, deadlineMs);
  }
  const parsed = backendPayload(response.result, action, projectId);
  const observedAtMs = Date.now();
  const durationMs = Math.max(0, observedAtMs - startedAt);
  if (parsed.error) {
    return errorReport(action, parsed.error, observedAtMs, durationMs, {
      deadlineMs,
      profileId: profile.id,
    });
  }
  const source = {
    kind: "backend_profile",
    appDaemonRequired: false,
    profileId: profile.id,
    transport: profile.transport.kind,
    backend: response.backend,
  };
  const base = {
    schemaVersion: PROJECT_CLIENT_SCHEMA_VERSION,
    apiVersion: "dure.projects/v1",
    kind: `dure.projects.${action}`,
    complete: true,
    observedAtMs,
    durationMs,
    source,
    limits: {
      deadlineMs,
      maxItems: MAX_PROJECT_COMMAND_ITEMS,
      maxOutputBytes: MAX_PROJECT_COMMAND_OUTPUT_BYTES,
    },
  };
  const report =
    action === "list"
      ? { ...base, projects: parsed.projects }
      : { ...base, project: parsed.projects[0] };
  if (
    Buffer.byteLength(JSON.stringify(report), "utf8") >
    MAX_PROJECT_COMMAND_OUTPUT_BYTES
  ) {
    return errorReport(
      action,
      "backend_projects_output_limit",
      observedAtMs,
      durationMs,
      { deadlineMs, profileId: profile.id },
    );
  }
  return report;
}

export function projectCommandExitCode(report) {
  return report.kind === "dure.projects.error" ? 2 : 0;
}

export function formatProjectCommand(report) {
  if (report.kind === "dure.projects.error") {
    return `Dure projects unavailable: ${report.error.remoteCode ?? report.error.code}`;
  }
  const projects =
    report.kind === "dure.projects.list" ? report.projects : [report.project];
  if (projects.length === 0) return "No Dure projects.";
  return [
    "PROJECT\tNAME\tROOT ID\tREPOSITORY ID",
    ...projects.map((item) =>
      [item.id, item.displayName, item.rootId, item.repositoryId].join("\t"),
    ),
  ].join("\n");
}
