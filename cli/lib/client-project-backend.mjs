import { createHash } from "node:crypto";
import { basename } from "node:path";
import { backendProfileAddCommand, loadBackendProfiles, selectBackendProfile } from "./backend-profiles.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { validProjectId, validProjectPath } from "./project-contract.mjs";

function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const REQUEST_OPTIONS = Object.freeze({ deadlineMs: 2500, maxResponseBytes: 16 * 1024 });

/** A display name the backend's `projects.register` accepts: non-empty,
 *  at most 256 UTF-8 bytes, no control characters. Anything else is `null`
 *  so the caller can fall back rather than send a rejected registration. */
function registrableDisplayName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > 256 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

async function resolveBackendProject(profile, path, requestBackend) {
  const response = await requestBackend(profile, {
    operation: "projects.resolve", requiredCapabilities: ["projects.resolve"],
    body: { schemaVersion: 1, path },
  }, REQUEST_OPTIONS);
  const result = response.result;
  if (result?.schemaVersion !== 1 ||
      !(result.project === null && result.root === null || validProjectId(result.project?.id) && validProjectPath(result.root))) {
    return { error: "backend_projects_payload_invalid" };
  }
  return result.project === null ? { project: null, root: null } : { project: { id: result.project.id }, root: result.root };
}

function registeredGuidance(projectId, root, registration) {
  return {
    state: "registered", backendProfileId: "local", executionHost: "local",
    projectId, root, registration,
    scheduleArguments: ["--project", projectId, "--backend", "local"],
  };
}

/** Backend discovery after the app's registration owner succeeds, and —
 * only when `registerBackend` is requested — the one write that makes the
 * folder usable by `dure run` and `dure schedule`: `projects.register` on
 * the local backend under a path-derived ID. Without the request this is
 * read-only. It never activates or replaces a backend and never interprets
 * app IDs as backend IDs. SSH host IDs are also not backend profile IDs:
 * for those, give a command for the owning host instead of registering.
 *
 * `registration` says what happened to the backend project:
 * - `existing`: already registered; nothing was written.
 * - `created`: registered by this call (`registerBackend` only).
 * - `not_requested`: unregistered or unchecked, and no write was asked for.
 * - `failed`: `registerBackend` was asked for but not performed; `reason`
 *   names the cause and `registerCommand` remains the manual path.
 */
export async function clientProjectBackendGuidance(registration, {
  environment = process.env,
  requestBackend = performBackendProfileRequest,
  loadProfiles = loadBackendProfiles,
  registerBackend = false,
} = {}) {
  const { project, hostId } = registration;
  const pending = registerBackend ? "failed" : "not_requested";
  if (!validProjectPath(project?.path)) return { state: "unavailable", reason: "project_path_invalid", registration: pending };
  const suggestedId = `project-${createHash("sha256").update(project.path).digest("hex").slice(0, 12)}`;
  const registerCommand = `dure projects register ${suggestedId} --path ${shellWord(project.path)} --backend local`;
  const guidance = {
    state: "unavailable", backendProfileId: "local", registerCommand,
    executionHost: hostId === "local" ? "local" : hostId, registration: pending,
  };
  if (hostId !== "local") {
    const profileAddCommand = backendProfileAddCommand(hostId);
    return {
      ...guidance, reason: "run_registration_on_owning_ssh_host",
      ...(profileAddCommand === undefined ? {} : { profileAddCommand }),
    };
  }
  let state = "unavailable";
  try {
    const { profile } = selectBackendProfile(loadProfiles({ environment }), { explicitId: "local", environment });
    if (profile.transport.kind !== "local") return { ...guidance, reason: "local_profile_target_mismatch" };
    const resolved = await resolveBackendProject(profile, project.path, requestBackend);
    if (resolved.error) return { ...guidance, reason: resolved.error };
    if (resolved.project) return registeredGuidance(resolved.project.id, resolved.root, "existing");
    state = "unregistered";
    if (!registerBackend) return { ...guidance, state };
    const displayName = registrableDisplayName(project.name) ?? registrableDisplayName(basename(project.path)) ?? suggestedId;
    const response = await requestBackend(profile, {
      operation: "projects.register", requiredCapabilities: ["projects.register"],
      body: { schemaVersion: 1, projectId: suggestedId, displayName, root: project.path },
    }, REQUEST_OPTIONS);
    if (response.result?.schemaVersion !== 1 || response.result.project?.id !== suggestedId) {
      return { ...guidance, state, reason: "backend_projects_payload_invalid" };
    }
    // Re-read so `root` is the backend's canonical answer; the registration
    // itself already succeeded, so a failed re-read falls back to what was sent.
    const confirmed = await resolveBackendProject(profile, project.path, requestBackend).catch(() => ({ project: null }));
    return confirmed.project
      ? registeredGuidance(confirmed.project.id, confirmed.root, "created")
      : registeredGuidance(suggestedId, project.path, "created");
  } catch (error) {
    return { ...guidance, state, reason: typeof error?.code === "string" ? error.code : "backend_unavailable" };
  }
}

export function formatClientProjectBackendGuidance(backend) {
  if (!backend) return "";
  if (backend.state === "registered") {
    const heading = backend.registration === "created" ? "Backend project registered" : "Backend project";
    return `\n${heading}: ${backend.projectId} (root: ${backend.root})\nFor dure run and schedules: --project ${backend.projectId} --backend local`;
  }
  if (!backend.registerCommand) return "\nBackend project could not be resolved; inspect dure projects list --backend local.";
  const location = backend.executionHost === "local" ? "On this host" : `On SSH host ${backend.executionHost}`;
  const status = backend.registration === "failed"
    ? `Backend registration was requested but not performed (${backend.reason ?? "unknown"}).`
    : backend.state === "unregistered"
      ? "Backend project is not registered."
      : "Backend registration could not be checked; inspect dure projects list --backend local on the owning host first.";
  const hint = backend.registration === "not_requested" && backend.state === "unregistered"
    ? "\nOr rerun client project add with --register-backend to do both in one step."
    : "";
  const profile = backend.profileAddCommand
    ? `\nTo use this SSH host as a backend from here, create its backend profile:\n  ${backend.profileAddCommand}`
    : "";
  return `\n${status}\n${location}, register the folder for dure run and schedules:\n  ${backend.registerCommand}${hint}\nUse the returned backend project ID with dure run --project ID --backend local or dure schedule create --project ID --backend local on that host.${profile}`;
}
