import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
const backend = vi.hoisted(() => ({ supports: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauri.listen,
}));

vi.mock("@/lib/ipc/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ipc/core")>();
  return { ...original, backendSupports: backend.supports };
});

import {
  cliRequestClaim,
  cliRequestComplete,
  credentialSessionBindings,
  hmux,
  hubDeviceRevoke,
  providerPreflight,
  remoteHmuxAbandonUnpresented,
  remoteHmuxProvision,
} from "@/lib/ipc";

describe("hmux IPC", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    backend.supports.mockReset().mockResolvedValue(true);
  });

  it("keeps CLI broker correlation arguments flat", async () => {
    tauri.invoke.mockResolvedValue(undefined);

    await cliRequestClaim("request-1");
    await cliRequestComplete("request-1", { ok: true });

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "cli_request_claim", {
      reqId: "request-1",
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "cli_request_complete", {
      reqId: "request-1",
      result: { ok: true },
    });
  });

  it("preserves terminal colors in the native session conversion request", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const request = {
      conversionId: "conversion-colors",
      sourceSessionId: "source-session",
      sourceWorkspaceId: "workspace",
      target: "managed" as const,
      providerId: "codex" as const,
      cwd: "/repo",
      confirmed: true,
      permissionMode: "default" as const,
      rows: 24,
      columns: 80,
      terminalEnvironment: {},
      terminalDefaultColors: { foregroundRgb: 0x123456, backgroundRgb: 0x654321 },
    };

    await hmux.convertSession(request);

    expect(tauri.invoke).toHaveBeenCalledWith("hmux_convert_session", {
      request: {
        ...request,
        expectedSourceFence: null,
        expectedConversationId: null,
        credentialId: null,
        credentialDirectory: null,
        credentialGeneration: null,
      },
    });
  });

  it("resolves an exact Hmux name without requiring discovery identities", async () => {
    tauri.invoke.mockResolvedValue(undefined);

    await hmux.resolveNamedSession("hmux-spawn-reliability");

    expect(tauri.invoke).toHaveBeenCalledWith("hmux_resolve_named_session", {
      name: "hmux-spawn-reliability",
    });
  });

  it("reads credential-session bindings by provider without credential material", async () => {
    tauri.invoke.mockResolvedValue([]);

    await credentialSessionBindings("codex");

    expect(tauri.invoke).toHaveBeenCalledWith("credential_session_bindings", {
      providerId: "codex",
    });
  });

  it("stops a managed provider only through exact identity", async () => {
    tauri.invoke.mockResolvedValue(undefined);

    const expectedFence = {
      runnerPrincipal: "principal-1",
      runnerInstance: "runner-1",
      channelEpoch: "7",
      hostInstanceId: "host-1",
      terminalEpoch: "terminal-1",
    };
    await hmux.stopManaged("stop-1", "session-1", "workspace-1", expectedFence);

    expect(tauri.invoke).toHaveBeenCalledWith("hmux_managed_stop", {
      stopId: "stop-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      expectedFence,
    });
  });

  it("terminates an external catalog session through its exact terminal generation", async () => {
    const receipt = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      terminalEpoch: "terminal-1",
      sessionClass: "standalone",
      outcome: "terminated",
    };
    tauri.invoke.mockResolvedValue(receipt);

    await expect(
      hmux.terminateExact(
        "session-1",
        "workspace-1",
        "terminal-1",
        "standalone",
      ),
    ).resolves.toEqual(receipt);

    expect(tauri.invoke).toHaveBeenCalledWith("hmux_session_terminate_exact", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      terminalEpoch: "terminal-1",
      sessionClass: "standalone",
    });
  });

  it("rejects an uncorrelated exact termination receipt at the IPC boundary", async () => {
    tauri.invoke.mockResolvedValue({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      terminalEpoch: "replacement",
      sessionClass: "standalone",
      outcome: "terminated",
    });

    await expect(
      hmux.terminateExact(
        "session-1",
        "workspace-1",
        "terminal-1",
        "standalone",
      ),
    ).rejects.toThrow("hmux_exact_termination_receipt_mismatch");
  });

  it("sends pane-scoped graceful departure without a termination fallback", async () => {
    tauri.invoke.mockResolvedValue({ state: "retirement_armed" });

    await hmux.departPaneGracefully("owner-1", "session-1", "workspace-1");

    expect(tauri.invoke).toHaveBeenCalledWith("hmux_pane_depart_gracefully", {
      ownerId: "owner-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
  });

  it("abandons only the exact unpresented standalone creation", async () => {
    tauri.invoke.mockResolvedValue({ state: "retirement_armed" });

    await hmux.abandonUnpresentedCreation("session-1", "workspace-1");

    expect(tauri.invoke).toHaveBeenCalledWith(
      "hmux_standalone_abandon_unpresented",
      {
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    );
  });

  it("keeps remote unpresented-create authority inside its exact SSH request", async () => {
    tauri.invoke.mockResolvedValue({ state: "session_preserved" });

    await remoteHmuxAbandonUnpresented({
      target: {
        schemaVersion: 1,
        hostId: "host-1",
        host: "example.test",
        port: 22,
        user: "dev",
        auth: "auto",
        hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
      },
      requestId: "abandon-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      launchOwnerProof: "launch-proof-1",
    });

    expect(tauri.invoke).toHaveBeenCalledWith(
      "remote_hmux_standalone_abandon_unpresented",
      {
        request: {
          target: {
            hostId: "host-1",
            host: "example.test",
            port: 22,
            user: "dev",
            auth: "auto",
            hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
          },
          requestId: "abandon-1",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          launchOwnerProof: "launch-proof-1",
        },
      },
    );
  });

  it("sends the exact SSH target and nothing else when matching a computer's hmux", async () => {
    tauri.invoke.mockResolvedValue({
      schemaVersion: 1,
      hostId: "host-1",
      buildId: "0.1.4+abc.x86_64-unknown-linux-musl.release",
      targetTriple: "x86_64-unknown-linux-musl",
      outcome: "alreadyCurrent",
    });

    const receipt = await remoteHmuxProvision({
      schemaVersion: 1,
      hostId: "host-1",
      host: "example.test",
      port: 22,
      user: "dev",
      auth: "auto",
      hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
    });

    // `schemaVersion` is this side's own framing; the command takes the target.
    expect(tauri.invoke).toHaveBeenCalledWith("remote_hmux_provision", {
      request: {
        hostId: "host-1",
        host: "example.test",
        port: 22,
        user: "dev",
        auth: "auto",
        hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
      },
    });
    // A box that needed nothing still answers, and the answer is a success.
    expect(receipt.outcome).toBe("alreadyCurrent");
  });

  it("queries native pane attachment by the exact departure identity", async () => {
    tauri.invoke.mockResolvedValue({ state: "attached" });

    await hmux.paneAttachmentStatus("owner-1", "session-1", "workspace-1");

    expect(tauri.invoke).toHaveBeenCalledWith("hmux_pane_attachment_status", {
      ownerId: "owner-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
  });

  it("forwards explicit terminal overrides to Hmux creation", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const terminalEnv = { NO_COLOR: "1", COLORTERM: null };
    const terminalDefaultColors = {
      foregroundRgb: 0x123456,
      backgroundRgb: 0x654321,
    };

    await hmux.createStandalone({
      operationId: "terminal-override-create",
      cwd: "/workspace",
      columns: 120,
      rows: 30,
      terminalEnv,
      terminalDefaultColors,
    });

    expect(tauri.invoke).toHaveBeenCalledWith("hmux_standalone_create", {
      request: {
        operationId: "terminal-override-create",
        cwd: "/workspace",
        columns: 120,
        rows: 30,
        terminalEnv,
        commandLine: null,
        terminalDefaultColors,
      },
    });
  });

  it("forwards terminal defaults through every local Hmux create boundary", async () => {
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "hmux_managed_create_advance_v1"
        ? {
            state: "current",
            receipt: {
              idempotencyKey: "create-1",
              outcome: "created",
              session: {
                sessionId: "session-1",
                workspaceId: "workspace-1",
                sessionClass: "managed",
                lifecycle: "ready",
                manifestLifecycle: "ready",
                health: "current_healthy",
                hostBuildVersion: "0.1.4+test",
                clientSelection: "direct_rust",
                inputAllowed: true,
                detachOnly: false,
                terminalEpoch: "terminal-1",
                stopFence: {
                  runnerPrincipal: "principal-1",
                  runnerInstance: "runner-1",
                  channelEpoch: "1",
                  hostInstanceId: "host-1",
                  terminalEpoch: "terminal-1",
                },
                outputSeq: "0",
                capabilities: [],
              },
            },
          }
        : undefined,
    );
    const terminalDefaultColors = {
      foregroundRgb: 0x123456,
      backgroundRgb: 0x654321,
    };

    await hmux.createStandalone({
      operationId: "terminal-default-create",
      cwd: "/workspace",
      columns: 120,
      rows: 30,
      terminalDefaultColors,
    });
    await hmux.advanceManagedCreate({
      idempotencyKey: "create-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      providerId: "codex",
      permissionMode: "default",
      cwd: "/workspace",
      command: "codex",
      columns: 120,
      rows: 30,
      terminalDefaultColors,
    });
    await hmux.createManagedShell({
      idempotencyKey: "shell-1",
      sessionId: "session-2",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      columns: 120,
      rows: 30,
      terminalDefaultColors,
    });

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "hmux_standalone_create", {
      request: {
        operationId: "terminal-default-create",
        cwd: "/workspace",
        columns: 120,
        rows: 30,
        terminalEnv: null,
        commandLine: null,
        terminalDefaultColors,
      },
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "hmux_managed_create_advance_v1", {
      request: {
        idempotencyKey: "create-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        providerId: "codex",
        conversationId: null,
        permissionMode: "default",
        credentialId: null,
        credentialDirectory: null,
        credentialGeneration: null,
        cwd: "/workspace",
        command: "codex",
        columns: 120,
        rows: 30,
        terminalEnv: null,
        terminalDefaultColors,
      },
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(3, "hmux_managed_shell_create", {
      idempotencyKey: "shell-1",
      sessionId: "session-2",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      columns: 120,
      rows: 30,
      terminalEnv: null,
      terminalDefaultColors,
    });
  });

  it("rejects legacy normalization states on the explicit advance boundary", async () => {
    const existing = {
      idempotencyKey: "create-credential",
      outcome: "created",
      session: {
        sessionId: "session-credential",
        workspaceId: "workspace-credential",
        sessionClass: "managed",
        lifecycle: "exited",
        manifestLifecycle: "exited",
        health: "exited",
        hostBuildVersion: "0.1.4+test",
        clientSelection: "direct_rust",
        inputAllowed: false,
        detachOnly: true,
        terminalEpoch: "terminal-1",
        stopFence: {
          runnerPrincipal: "principal-1",
          runnerInstance: "runner-1",
          channelEpoch: "1",
          hostInstanceId: "host-1",
          terminalEpoch: "terminal-1",
        },
        outputSeq: "1",
        capabilities: [],
      },
    };
    const request = {
      idempotencyKey: "create-credential",
      sessionId: "session-credential",
      workspaceId: "workspace-credential",
      providerId: "codex" as const,
      permissionMode: "default" as const,
      credentialId: "credential-requested",
      credentialDirectory: "/profiles/requested",
      credentialGeneration: 7,
      cwd: "/workspace",
      command: "codex",
      columns: 120,
      rows: 30,
      terminalDefaultColors: { foregroundRgb: 0, backgroundRgb: 0 },
    };
    tauri.invoke.mockResolvedValue({
      state: "normalize_existing",
      existing,
    });

    await expect(hmux.advanceManagedCreate(request)).rejects.toThrow(
      "hmux_managed_create_resolution_invalid",
    );
  });

  it("preflights the provider in the requested terminal environment", async () => {
    tauri.invoke.mockResolvedValue({ ready: true });

    await providerPreflight({
      provider: "claude",
      command: "claude",
      cwd: "/workspace",
      terminalEnv: { NO_COLOR: null },
    });

    expect(tauri.invoke).toHaveBeenCalledWith("provider_preflight", {
      provider: "claude",
      command: "claude",
      cwd: "/workspace",
      terminalEnv: { NO_COLOR: null },
      includeVersion: true,
    });
  });

  it("forwards executable-only preflight without silently enabling diagnostics", async () => {
    tauri.invoke.mockResolvedValue({ executable: true });
    await providerPreflight({
      provider: "codex",
      command: "codex",
      cwd: "/workspace",
      includeVersion: false,
    });
    expect(tauri.invoke).toHaveBeenCalledWith("provider_preflight", {
      provider: "codex",
      command: "codex",
      cwd: "/workspace",
      terminalEnv: null,
      includeVersion: false,
    });
  });

  it("requires an explicit flag before forgetting an unreachable revoke record", async () => {
    tauri.invoke.mockResolvedValue({ revoked: false, failures: [] });

    await hubDeviceRevoke("phone-1");
    await hubDeviceRevoke("phone-1", true);

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "hub_device_revoke", {
      deviceId: "phone-1",
      forgetUnreachable: false,
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "hub_device_revoke", {
      deviceId: "phone-1",
      forgetUnreachable: true,
    });
  });
});
