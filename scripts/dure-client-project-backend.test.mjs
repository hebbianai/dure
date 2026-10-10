import { describe, expect, it, vi } from "vitest";
import { clientProjectBackendGuidance, formatClientProjectBackendGuidance } from "../cli/lib/client-project-backend.mjs";

const registration = { hostId: "local", project: { id: "proj-AppID", path: "/work/operations", kind: "local" } };
const local = { id: "local", transport: { kind: "local" } };
const loadProfiles = () => ({ profiles: [local, { id: "remote", default: true, transport: { kind: "ssh" } }] });

describe("client project backend guidance", () => {
  it("returns the canonical backend identity without selecting the environment's remote default", async () => {
    const requestBackend = vi.fn(async () => ({ result: { schemaVersion: 1, project: { id: "operations" }, root: "/work/operations" } }));
    const result = await clientProjectBackendGuidance(registration, { environment: { DURE_BACKEND_PROFILE: "remote" }, loadProfiles, requestBackend });
    expect(result).toEqual({ state: "registered", backendProfileId: "local", executionHost: "local", projectId: "operations", root: "/work/operations", scheduleArguments: ["--project", "operations", "--backend", "local"] });
    expect(requestBackend).toHaveBeenCalledExactlyOnceWith(local, { operation: "projects.resolve", requiredCapabilities: ["projects.resolve"], body: { schemaVersion: 1, path: registration.project.path } }, { deadlineMs: 2500, maxResponseBytes: 16384 });
    expect(formatClientProjectBackendGuidance(result)).toContain("--project operations --backend local");
  });

  it("returns a shell-quoted registration command for an unregistered folder", async () => {
    const result = await clientProjectBackendGuidance({ ...registration, project: { ...registration.project, path: "/work/O'Brien $(touch bad)" } }, {
      loadProfiles, requestBackend: async () => ({ result: { schemaVersion: 1, project: null, root: null } }),
    });
    expect(result.state).toBe("unregistered");
    expect(result.registerCommand).toMatch(/^dure projects register project-[a-f0-9]{12} --path /);
    expect(result.registerCommand).toContain("'/work/O'\\''Brien $(touch bad)' --backend local");
    expect(result.registerCommand).not.toContain("proj-AppID");
  });

  it("keeps app success and honest guidance when a backend is unavailable or old", async () => {
    const result = await clientProjectBackendGuidance(registration, { loadProfiles, requestBackend: async () => { throw Object.assign(new Error(), { code: "backend_transport_capability_missing" }); } });
    expect(result).toMatchObject({ state: "unavailable", reason: "backend_transport_capability_missing" });
    expect(formatClientProjectBackendGuidance(result)).toContain("could not be checked");
    expect(result.registerCommand).toContain("--backend local");
  });

  it("does not mistake an app SSH host ID for a backend profile or query the local folder", async () => {
    const requestBackend = vi.fn();
    const result = await clientProjectBackendGuidance({ ...registration, hostId: "ssh-AppID", project: { ...registration.project, kind: "ssh" } }, { loadProfiles, requestBackend });
    expect(requestBackend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ executionHost: "ssh-AppID", reason: "run_registration_on_owning_ssh_host" });
    expect(formatClientProjectBackendGuidance(result)).toContain("On SSH host ssh-AppID");
    expect(result.registerCommand).not.toContain("ssh-AppID");
  });
});
