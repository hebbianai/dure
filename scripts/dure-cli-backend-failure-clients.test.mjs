import { describe, expect, it } from "vitest";
import { agentSpawnQueryExitCode, collectAgentSpawnQuery, formatAgentSpawnQuery } from "../cli/lib/agent-spawn-query.mjs";
import { BackendProfileError } from "../cli/lib/backend-profiles.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import { LocalBackendError } from "../cli/lib/local-backend.mjs";
import { collectProjectCommand } from "../cli/lib/project-client.mjs";
import { collectProviderLaunchDefaults } from "../cli/lib/provider-launch-defaults.mjs";
import { collectScheduleCommand } from "../cli/lib/schedule-client.mjs";
import { collectSessionRead } from "../cli/lib/session-read.mjs";

function backend() {
  return {
    profile: { id: "remote-a", transport: { kind: "ssh" } },
  };
}

const clients = [
  {
    name: "session read",
    kind: "dure.sessions.error",
    action: "read",
    collect: ({ selectedBackend, requestBackend }) =>
      collectSessionRead({
        backend: selectedBackend,
        requestBackend,
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
  },
  {
    name: "schedule list",
    kind: "dure.schedules.error",
    action: "list",
    collect: ({ selectedBackend, requestBackend }) =>
      collectScheduleCommand({
        action: "list",
        backend: selectedBackend,
        requestBackend,
      }),
  },
  {
    name: "project list",
    kind: "dure.projects.error",
    action: "list",
    collect: ({ selectedBackend, requestBackend }) =>
      collectProjectCommand({
        action: "list",
        backend: selectedBackend,
        requestBackend,
      }),
  },
  {
    name: "agent spawn status",
    kind: "dure.agent_spawn.error",
    action: "status",
    collect: ({ selectedBackend, requestBackend }) =>
      collectAgentSpawnQuery({
        action: "status",
        operationId: "operation-1",
        backend: selectedBackend,
        requestBackend,
      }),
  },
  {
    name: "provider launch defaults",
    kind: "dure.provider_launch_defaults.error",
    action: "get",
    collect: ({ selectedBackend, requestBackend }) =>
      collectProviderLaunchDefaults({
        action: "get",
        backend: selectedBackend,
        requestBackend,
      }),
  },
];

it.each([
  "provider_executable_not_found",
  "provider_executable_not_executable",
  "provider_executable_lookup_failed",
  "provider_executable_path_missing",
  "future_reason",
  "constructor",
])("projects setup evidence %s without copying private backend text", async (reasonCode) => {
  const report = await collectAgentSpawnQuery({
    action: "apply",
    operationId: "operation-1",
    planToken: `sha256:${"a".repeat(64)}`,
    expectedLastSequence: 1,
    backend: backend(),
    requestBackend: async () => {
      throw new BackendTransportError("backend_transport_remote_error", {
        details: {
          code: "agent_spawn_provider_unavailable",
          reasonCode,
          disposition: "retry_same",
          message: "private /Users/someone/provider",
        },
      });
    },
  });
  expect(report.error.reasonCode).toBe(reasonCode);
  expect(report.error.message.includes("Install")).toBe(reasonCode === "provider_executable_not_found");
  expect(formatAgentSpawnQuery(report)).toContain(report.error.message);
  expect(formatAgentSpawnQuery(report)).toContain("agent_spawn_provider_unavailable");
  expect(agentSpawnQueryExitCode(report)).toBe(2);
  expect(JSON.stringify(report)).not.toContain("/Users/someone");
});

describe.each(clients)("$name backend failure projection", ({ action, collect, kind }) => {
  it("preserves the recovering receipt", async () => {
    const report = await collect({
      selectedBackend: { error: new LocalBackendError("recovering") },
    });
    expect(report).toMatchObject({
      kind,
      action,
      error: { code: "recovering", status: "recovering", retryable: true },
    });
    expect(report.error).not.toHaveProperty("profileId");
  });

  it("preserves the CLI update action", async () => {
    const report = await collect({
      selectedBackend: { error: new LocalBackendError("cli_update_required") },
    });
    expect(report).toMatchObject({
      kind,
      action,
      error: {
        code: "cli_update_required",
        status: "cli_update_required",
        retryable: false,
        action: {
          label: "Update Dure App",
          command: "dure install --global",
        },
      },
    });
    expect(report.error).not.toHaveProperty("profileId");
  });

  it("preserves an exact backend profile error", async () => {
    const report = await collect({
      selectedBackend: {
        error: new BackendProfileError("backend_profiles_selection_not_found"),
      },
    });
    expect(report).toMatchObject({
      kind,
      action,
      error: { code: "backend_profiles_selection_not_found" },
    });
    expect(report.error).not.toHaveProperty("profileId");
  });

  it("preserves validated remote transport details", async () => {
    const error = new BackendTransportError("backend_transport_remote_error", {
      details: {
        capability: "sessions.read",
        code: "remote_busy",
        disposition: "retry_same",
      },
    });
    const report = await collect({
      selectedBackend: backend(),
      requestBackend: async () => {
        throw error;
      },
    });
    expect(report).toMatchObject({
      kind,
      action,
      error: {
        code: "backend_transport_remote_error",
        capability: "sessions.read",
        profileId: "remote-a",
        remoteCode: "remote_busy",
        disposition: "retry_same",
      },
    });
  });
});
