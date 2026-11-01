import { describe, expect, it, vi } from "vitest";
import { clientProjectBackendGuidance, formatClientProjectBackendGuidance } from "../cli/lib/client-project-backend.mjs";

const registration = { hostId: "local", project: { id: "proj-AppID", path: "/work/operations", kind: "local" } };
const local = { id: "local", transport: { kind: "local" } };
const loadProfiles = () => ({ profiles: [local, { id: "remote", default: true, transport: { kind: "ssh" } }] });

describe("client project backend guidance", () => {
  it("returns the canonical backend identity without selecting the environment's remote default", async () => {
    const requestBackend = vi.fn(async () => ({ result: { schemaVersion: 1, project: { id: "operations" }, root: "/work/operations" } }));
    const result = await clientProjectBackendGuidance(registration, { environment: { DURE_BACKEND_PROFILE: "remote" }, loadProfiles, requestBackend });
    expect(result).toEqual({ state: "registered", backendProfileId: "local", executionHost: "local", projectId: "operations", root: "/work/operations", registration: "existing", scheduleArguments: ["--project", "operations", "--backend", "local"] });
    expect(requestBackend).toHaveBeenCalledExactlyOnceWith(local, { operation: "projects.resolve", requiredCapabilities: ["projects.resolve"], body: { schemaVersion: 1, path: registration.project.path } }, { deadlineMs: 2500, maxResponseBytes: 16384 });
    expect(formatClientProjectBackendGuidance(result)).toContain("--project operations --backend local");
  });

  it("returns a shell-quoted registration command for an unregistered folder", async () => {
    const result = await clientProjectBackendGuidance({ ...registration, project: { ...registration.project, path: "/work/O'Brien $(touch bad)" } }, {
      loadProfiles, requestBackend: async () => ({ result: { schemaVersion: 1, project: null, root: null } }),
    });
    expect(result.state).toBe("unregistered");
    expect(result.registration).toBe("not_requested");
    expect(formatClientProjectBackendGuidance(result)).toContain("--register-backend");
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

  describe("--register-backend", () => {
    const unregistered = { result: { schemaVersion: 1, project: null, root: null } };
    const suggestedId = /^project-[a-f0-9]{12}$/;

    it("registers an unregistered local folder on the local backend under the path-derived ID, then re-reads it", async () => {
      const requests = [];
      const requestBackend = vi.fn(async (_profile, request) => {
        requests.push(request);
        if (request.operation === "projects.register") {
          return { result: { schemaVersion: 1, project: { id: request.body.projectId, displayName: request.body.displayName, rootId: `root_${"0".repeat(32)}`, repositoryId: `repo_${"0".repeat(32)}` } } };
        }
        return requests.some(({ operation }) => operation === "projects.register")
          ? { result: { schemaVersion: 1, project: { id: requests[1].body.projectId }, root: "/work/operations-canonical" } }
          : unregistered;
      });
      const result = await clientProjectBackendGuidance(registration, { loadProfiles, requestBackend, registerBackend: true, environment: { DURE_BACKEND_PROFILE: "remote" } });
      expect(requests.map(({ operation }) => operation)).toEqual(["projects.resolve", "projects.register", "projects.resolve"]);
      expect(requests[1]).toEqual({
        operation: "projects.register", requiredCapabilities: ["projects.register"],
        body: { schemaVersion: 1, projectId: expect.stringMatching(suggestedId), displayName: "operations", root: "/work/operations" },
      });
      expect(requestBackend.mock.calls.every(([profile]) => profile === local)).toBe(true);
      expect(result).toEqual({
        state: "registered", backendProfileId: "local", executionHost: "local",
        projectId: requests[1].body.projectId, root: "/work/operations-canonical", registration: "created",
        scheduleArguments: ["--project", requests[1].body.projectId, "--backend", "local"],
      });
      expect(formatClientProjectBackendGuidance(result)).toContain(`Backend project registered: ${requests[1].body.projectId}`);
      expect(formatClientProjectBackendGuidance(result)).toContain("dure run and schedules");
    });

    it("prefers the app's project name, falling back to the folder name for a registrable display name", async () => {
      const seen = [];
      const requestBackend = async (_profile, request) => {
        if (request.operation === "projects.register") {
          seen.push(request.body.displayName);
          return { result: { schemaVersion: 1, project: { id: request.body.projectId } } };
        }
        return unregistered;
      };
      await clientProjectBackendGuidance({ ...registration, project: { ...registration.project, name: "  Operations Desk  " } }, { loadProfiles, requestBackend, registerBackend: true });
      await clientProjectBackendGuidance({ ...registration, project: { ...registration.project, name: "bad\u0007name" } }, { loadProfiles, requestBackend, registerBackend: true });
      await clientProjectBackendGuidance({ ...registration, project: { id: "proj-AppID", path: "/work/operations", kind: "local" } }, { loadProfiles, requestBackend, registerBackend: true });
      expect(seen).toEqual(["Operations Desk", "operations", "operations"]);
    });

    it("writes nothing and reports existing when the folder is already registered", async () => {
      const requestBackend = vi.fn(async () => ({ result: { schemaVersion: 1, project: { id: "operations" }, root: "/work/operations" } }));
      const result = await clientProjectBackendGuidance(registration, { loadProfiles, requestBackend, registerBackend: true });
      expect(requestBackend).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ state: "registered", projectId: "operations", registration: "existing" });
    });

    it("keeps the app registration honest when the requested backend registration is refused", async () => {
      const requestBackend = async (_profile, request) => {
        if (request.operation === "projects.register") throw Object.assign(new Error(), { code: "backend_transport_capability_missing" });
        return unregistered;
      };
      const result = await clientProjectBackendGuidance(registration, { loadProfiles, requestBackend, registerBackend: true });
      expect(result).toMatchObject({ state: "unregistered", registration: "failed", reason: "backend_transport_capability_missing" });
      expect(result.registerCommand).toContain("--backend local");
      expect(formatClientProjectBackendGuidance(result)).toContain("requested but not performed (backend_transport_capability_missing)");
    });

    it("still falls back to the sent values when the confirming re-read fails after a successful registration", async () => {
      let registered = false;
      const requestBackend = async (_profile, request) => {
        if (request.operation === "projects.register") { registered = true; return { result: { schemaVersion: 1, project: { id: request.body.projectId } } }; }
        if (registered) throw Object.assign(new Error(), { code: "backend_transport_timeout" });
        return unregistered;
      };
      const result = await clientProjectBackendGuidance(registration, { loadProfiles, requestBackend, registerBackend: true });
      expect(result).toMatchObject({ state: "registered", root: "/work/operations", registration: "created" });
      expect(result.projectId).toMatch(suggestedId);
    });

    it("does not register when there is no usable local backend or the project lives on an SSH host", async () => {
      const requestBackend = vi.fn();
      const ssh = await clientProjectBackendGuidance({ ...registration, hostId: "ssh-AppID" }, { loadProfiles, requestBackend, registerBackend: true });
      expect(requestBackend).not.toHaveBeenCalled();
      expect(ssh).toMatchObject({ state: "unavailable", registration: "failed", reason: "run_registration_on_owning_ssh_host", executionHost: "ssh-AppID" });
      const noProfile = await clientProjectBackendGuidance(registration, {
        loadProfiles: () => { throw Object.assign(new Error(), { code: "backend_profiles_config_unavailable" }); }, requestBackend, registerBackend: true,
      });
      expect(noProfile).toMatchObject({ state: "unavailable", registration: "failed", reason: "backend_profiles_config_unavailable" });
      expect(requestBackend).not.toHaveBeenCalled();
    });
  });
});
