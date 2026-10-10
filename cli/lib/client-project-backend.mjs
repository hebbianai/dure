import { createHash } from "node:crypto";
import { loadBackendProfiles, selectBackendProfile } from "./backend-profiles.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { validProjectId, validProjectPath } from "./project-contract.mjs";

function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Read-only backend discovery after the app's registration owner succeeds.
 * Never activate/replace a backend or interpret app IDs as backend IDs. SSH
 * host IDs are also not backend profile IDs: give a command for the owning host.
 */
export async function clientProjectBackendGuidance(registration, {
  environment = process.env,
  requestBackend = performBackendProfileRequest,
  loadProfiles = loadBackendProfiles,
} = {}) {
  const { project, hostId } = registration;
  if (!validProjectPath(project?.path)) return { state: "unavailable", reason: "project_path_invalid" };
  const suggestedId = `project-${createHash("sha256").update(project.path).digest("hex").slice(0, 12)}`;
  const registerCommand = `dure projects register ${suggestedId} --path ${shellWord(project.path)} --backend local`;
  const guidance = {
    state: "unavailable", backendProfileId: "local", registerCommand,
    executionHost: hostId === "local" ? "local" : hostId,
  };
  if (hostId !== "local") return { ...guidance, reason: "run_registration_on_owning_ssh_host" };
  try {
    const { profile } = selectBackendProfile(loadProfiles({ environment }), { explicitId: "local", environment });
    if (profile.transport.kind !== "local") return { ...guidance, reason: "local_profile_target_mismatch" };
    const response = await requestBackend(profile, {
      operation: "projects.resolve", requiredCapabilities: ["projects.resolve"],
      body: { schemaVersion: 1, path: project.path },
    }, { deadlineMs: 2500, maxResponseBytes: 16 * 1024 });
    const result = response.result;
    if (result?.schemaVersion !== 1 ||
        !(result.project === null && result.root === null || validProjectId(result.project?.id) && validProjectPath(result.root))) {
      return { ...guidance, reason: "backend_projects_payload_invalid" };
    }
    if (result.project === null) return { ...guidance, state: "unregistered" };
    return {
      state: "registered", backendProfileId: "local", executionHost: "local",
      projectId: result.project.id, root: result.root,
      scheduleArguments: ["--project", result.project.id, "--backend", "local"],
    };
  } catch (error) {
    return { ...guidance, reason: typeof error?.code === "string" ? error.code : "backend_unavailable" };
  }
}

export function formatClientProjectBackendGuidance(backend) {
  if (!backend) return "";
  if (backend.state === "registered") return `\nBackend project: ${backend.projectId} (root: ${backend.root})\nFor schedules: --project ${backend.projectId} --backend local`;
  if (!backend.registerCommand) return "\nBackend project could not be resolved; inspect dure projects list --backend local.";
  const location = backend.executionHost === "local" ? "On this host" : `On SSH host ${backend.executionHost}`;
  const status = backend.state === "unregistered" ? "Backend project is not registered." : "Backend registration could not be checked; inspect dure projects list --backend local on the owning host first.";
  return `\n${status}\n${location}, register the folder for schedules:\n  ${backend.registerCommand}\nUse the returned backend project ID with dure schedule create --project ID --backend local on that host.`;
}
