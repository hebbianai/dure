import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hmuxManagedBinding,
  hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import { resolvePaneSplitTarget } from "@/lib/workspace/pane/paneSplitTarget";

const mocks = vi.hoisted(() => ({
  resolvePaneReference: vi.fn(),
  knownHostTrust: vi.fn(),
  createStandalone: vi.fn(),
  departController: vi.fn(),
  commitMutation: vi.fn(),
  getState: vi.fn(),
  sshConfigHosts: vi.fn(),
  registerHost: vi.fn(),
  flush: vi.fn(async () => {}),
  durablePreparation: vi.fn(async () => true),
}));

vi.mock("@/lib/workspace/dock", () => ({
  resolvePaneReference: mocks.resolvePaneReference,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

vi.mock("@/lib/ipc", () => ({
  remoteHmuxKnownHostTrust: mocks.knownHostTrust,
  remoteHmuxStandaloneCreate: mocks.createStandalone,
  remoteHmuxDepartGracefully: mocks.departController,
  sshConfigHosts: mocks.sshConfigHosts,
}));

vi.mock("@/lib/ssh/sshCredentialLifecycle", () => ({
  registerSshLoginHostDurably: mocks.registerHost,
}));

vi.mock("@/lib/hmux/remote/remoteHmuxShellPreparation", () => ({
  hasDurableRemoteHmuxShellPreparation: mocks.durablePreparation,
}));

vi.mock("@/lib/workspace/dock/explicitDockviewCommit", () => ({
  commitExplicitDockviewMutation: mocks.commitMutation,
}));

vi.mock("@/store", () => ({
  useStore: { getState: mocks.getState },
  durableAppStorage: { flush: mocks.flush },
}));

import { handleRemoteHmuxShellHandoff } from "@/lib/hmux/remote/remoteHmuxShellHandoff";

const host = {
  id: "host-rts",
  name: "RTS 개발 서버",
  host: "211.181.122.124",
  port: 22,
  user: "rts",
  auth: "auto" as const,
};
const source = hmuxStandaloneBinding("standalone-source", "workspace-source");
const managedSource = hmuxManagedBinding(
  "managed-source",
  "workspace-source",
  undefined,
  undefined,
  {
    runnerPrincipal: "local",
    runnerInstance: "runner-local",
    channelEpoch: "3",
    hostInstanceId: "host-local",
    terminalEpoch: "terminal-local",
  },
);
const request = {
  sourceSessionId: source.sessionId,
  sourceWorkspaceId: source.workspaceId,
  argv: ["rts@211.181.122.124"],
  destination: { host: "211.181.122.124", user: "rts" },
  initialColumns: 132,
  initialRows: 43,
};

function remoteSession(sessionId = "standalone-target") {
  return {
    sessionId,
    sessionName: "remote-rts",
    workspaceId: "workspace-target",
    sessionClass: "standalone" as const,
    lifecycle: "ready" as const,
    providerId: "shell",
    runnerPrincipal: "rts",
    runnerInstance: "runner-1",
    channelEpoch: "1",
    hostInstanceId: "host-1",
    terminalEpoch: "terminal-1",
    supportedProtocol: {
      minimum: { major: 1, minor: 0 },
      maximum: { major: 1, minor: 0 },
    },
    capabilities: ["screen_snapshot"],
  };
}

function unknownSource() {
  const state = { ...mocks.getState(), sshHosts: [] as typeof host[] };
  mocks.getState.mockReturnValue(state);
  mocks.sshConfigHosts.mockResolvedValue({ files: [], defaultUser: "unused", aliasInspection: { kind: "complete", aliases: [] } });
  const panel = {
    id: `term:${source.sessionId}`,
    params: { sessionId: source.sessionId, binding: source },
    api: { component: "terminal", updateParameters: vi.fn(), setActive: vi.fn() },
  };
  mocks.resolvePaneReference.mockResolvedValue({
    desktopId: "desktop-1", panelId: panel.id,
    api: { getPanel: () => panel, toJSON: () => ({}) },
  });
  return {
    state, panel,
    request: { ...request, argv: ["-p22", ...request.argv], destination: { ...request.destination, port: 22 } },
  };
}

describe("remote Hmux shell handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const saveLayout = vi.fn();
    const state = {
      sshHosts: [host],
      agents: [],
      projects: [],
      saveLayout,
    };
    mocks.getState.mockReturnValue(state);
    mocks.knownHostTrust.mockResolvedValue({
      schemaVersion: 1,
      hostId: host.id,
      hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
    });
    mocks.createStandalone.mockImplementation(async (input) => ({
      requestId: input.requestId,
      bridgeNonce: input.bridgeNonce,
      session: remoteSession(input.targetSessionId),
    }));
    mocks.departController.mockResolvedValue({
      state: "retirement_armed",
    });
    mocks.commitMutation.mockImplementation(({ desktopId, api, mutate }) => {
      const result = mutate();
      mocks.getState().saveLayout(desktopId, api.toJSON());
      return result;
    });
  });

  it.each([`term:${source.sessionId}`, "pane-opaque", "agent:previous"])("creates one exact remote shell and CAS-retargets the same %s pane", async (panelId) => {
    const updateParameters = vi.fn();
    const setActive = vi.fn();
    const panel = {
      id: panelId,
      params: { sessionId: source.sessionId, binding: source },
      api: { component: "terminal", updateParameters, setActive },
    };
    const api = {
      getPanel: vi.fn(() => panel),
      toJSON: vi.fn(() => ({ panels: [panel.params] })),
    };
    mocks.resolvePaneReference.mockResolvedValue({
      desktopId: "desktop-1",
      api,
      panelId: panel.id,
    });
    const claim = vi.fn(async () => true);

    const decide = vi.fn(async () => true);
    const result = await handleRemoteHmuxShellHandoff(request, claim, decide);

    expect(result.ok).toBe(true);
    expect(decide).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(mocks.createStandalone).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ hostId: host.id }),
        initialColumns: 132,
        initialRows: 43,
        sessionName: expect.stringMatching(/^remote-standalone_[A-Za-z0-9_-]+$/),
        commandIntercepts: [
          { command: "claude", providerId: "claude" },
          { command: "codex", providerId: "codex" },
        ],
      }),
      `window:main:desktop:desktop-1:pane:${panelId}`,
    );
    expect(updateParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.stringMatching(/^standalone_/),
        binding: expect.objectContaining({
          runtime: "hmux_standalone_v1",
          source: "ssh",
          hostId: host.id,
        }),
        remoteHmuxTransition: expect.objectContaining({ phase: "attached" }),
      }),
    );
    expect(JSON.stringify(updateParameters.mock.calls)).not.toMatch(
      /password|token|secret|private.?key/i,
    );
    expect(mocks.getState().saveLayout).toHaveBeenCalledWith(
      "desktop-1",
      expect.anything(),
    );
    expect(setActive).toHaveBeenCalled();
  });

  it("offers an unknown explicit destination before registration and same-pane handoff", async () => {
    const state = { ...mocks.getState(), sshHosts: [] as typeof host[] };
    mocks.getState.mockReturnValue(state);
    mocks.sshConfigHosts.mockResolvedValue({ files: [], defaultUser: "unused", aliasInspection: { kind: "complete", aliases: [] } });
    mocks.registerHost.mockImplementation(async () => {
      state.sshHosts = [host];
      return { host, created: true };
    });
    const panel = {
      id: `term:${source.sessionId}`,
      params: { sessionId: source.sessionId, binding: source },
      api: { component: "terminal", updateParameters: vi.fn(), setActive: vi.fn() },
    };
    mocks.resolvePaneReference.mockResolvedValue({
      desktopId: "desktop-1",
      api: { getPanel: () => panel, toJSON: () => ({}) },
      panelId: panel.id,
    });
    const decide = vi.fn(async () => {
      expect(mocks.registerHost).not.toHaveBeenCalled();
      expect(mocks.knownHostTrust).not.toHaveBeenCalled();
      return true;
    });
    const result = await handleRemoteHmuxShellHandoff({
      ...request,
      argv: ["-p22", ...request.argv],
      destination: { ...request.destination, port: 22 },
    }, async () => true, decide);

    expect(decide).toHaveBeenCalledOnce();
    expect(mocks.registerHost).toHaveBeenCalledWith({
      name: "rts@211.181.122.124:22", host: host.host,
      user: host.user, port: 22, auth: "auto",
    });
    expect(result.ok).toBe(true);
    expect(panel.api.updateParameters).toHaveBeenCalledTimes(2);
    expect(panel.api.updateParameters.mock.calls[0]?.[0]).toMatchObject({
      binding: source, remoteHmuxTransition: { phase: "preparing" },
    });
  });

  it.each([false, null])("does not save or create after decision result %j", async (answer) => {
    const fixture = unknownSource();
    const claim = vi.fn(async () => true);
    const result = await handleRemoteHmuxShellHandoff(fixture.request, claim, async () => answer);
    expect(result).toEqual(answer === null ? { ok: false, unavailable: true } : { ok: false, fallback: true });
    expect(claim).not.toHaveBeenCalled();
    expect(mocks.registerHost).not.toHaveBeenCalled();
    expect(mocks.knownHostTrust).not.toHaveBeenCalled();
    expect(mocks.createStandalone).not.toHaveBeenCalled();
    expect(fixture.panel.api.updateParameters).not.toHaveBeenCalled();
  });

  it("does not save after native admission expires while the user decides", async () => {
    const fixture = unknownSource();
    await expect(handleRemoteHmuxShellHandoff(fixture.request, async () => false, async () => true)).resolves.toEqual({ ok: false, fallback: true });
    expect(mocks.registerHost).not.toHaveBeenCalled();
    expect(mocks.knownHostTrust).not.toHaveBeenCalled();
    expect(mocks.createStandalone).not.toHaveBeenCalled();
  });

  it("does not save when the source pane changes while the user decides", async () => {
    const fixture = unknownSource();
    const claim = vi.fn(async () => true);
    await expect(handleRemoteHmuxShellHandoff(fixture.request, claim, async () => {
      fixture.panel.params.binding = hmuxStandaloneBinding("replacement", "other-workspace");
      return true;
    })).resolves.toEqual({ ok: false, fallback: true });
    expect(claim).not.toHaveBeenCalled();
    expect(mocks.registerHost).not.toHaveBeenCalled();
    expect(mocks.createStandalone).not.toHaveBeenCalled();
  });

  it("does not offer a registration after SSH config inspection fails", async () => {
    const fixture = unknownSource();
    mocks.sshConfigHosts.mockRejectedValueOnce(new Error("config unavailable"));
    const decide = vi.fn(async () => true);
    await expect(handleRemoteHmuxShellHandoff(fixture.request, async () => true, decide)).resolves.toEqual({ ok: false, fallback: true });
    expect(decide).not.toHaveBeenCalled();
    expect(mocks.registerHost).not.toHaveBeenCalled();
  });

  it("hands a managed local shell to remote Hmux without falling back to system ssh", async () => {
    const managedRequest = {
      ...request,
      sourceSessionId: managedSource.sessionId,
      sourceWorkspaceId: managedSource.workspaceId,
    };
    const updateParameters = vi.fn();
    const panel = {
      id: `term:${managedSource.sessionId}`,
      params: { sessionId: managedSource.sessionId, binding: managedSource },
      api: { component: "terminal", updateParameters, setActive: vi.fn() },
    };
    const api = {
      getPanel: vi.fn(() => panel),
      toJSON: vi.fn(() => ({ panels: [panel.params] })),
    };
    mocks.resolvePaneReference.mockResolvedValue({
      desktopId: "desktop-1",
      api,
      panelId: panel.id,
    });

    const result = await handleRemoteHmuxShellHandoff(
      managedRequest,
      async () => true,
    );

    expect(result.ok).toBe(true);
    expect(mocks.createStandalone).toHaveBeenCalledTimes(1);
    expect(updateParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          runtime: "hmux_standalone_v1",
          source: "ssh",
          hostId: host.id,
        }),
        remoteHmuxTransition: expect.objectContaining({
          phase: "attached",
          sourceBinding: managedSource,
        }),
      }),
    );
    const updated = updateParameters.mock.lastCall?.[0];
    expect(
      resolvePaneSplitTarget({
        binding: updated?.binding,
        liveCwd: "/home/gate1/projects/quant/gate_hft",
      }),
    ).toEqual({
      kind: "ssh",
      hostId: host.id,
      cwd: "/home/gate1/projects/quant/gate_hft",
    });
  });

  it("does not retarget a replacement generation of the managed source", async () => {
    const managedRequest = {
      ...request,
      sourceSessionId: managedSource.sessionId,
      sourceWorkspaceId: managedSource.workspaceId,
    };
    const initialPanel = {
      id: `term:${managedSource.sessionId}`,
      params: { sessionId: managedSource.sessionId, binding: managedSource },
      api: { component: "terminal", updateParameters: vi.fn(), setActive: vi.fn() },
    };
    const replacementPanel = {
      ...initialPanel,
      params: {
        ...initialPanel.params,
        binding: {
          ...managedSource,
          stopFence: {
            ...managedSource.stopFence,
            terminalEpoch: "replacement-terminal",
          },
        },
      },
    };
    const api = {
      getPanel: vi
        .fn()
        .mockReturnValueOnce(initialPanel)
        .mockReturnValueOnce(initialPanel)
        .mockReturnValueOnce(initialPanel)
        .mockReturnValueOnce(replacementPanel),
      toJSON: vi.fn(),
    };
    mocks.resolvePaneReference.mockResolvedValue({
      desktopId: "desktop-1",
      api,
      panelId: initialPanel.id,
    });

    await expect(
      handleRemoteHmuxShellHandoff(managedRequest, async () => true),
    ).rejects.toThrow("source pane changed");
    expect(mocks.departController).toHaveBeenCalledTimes(1);
    expect(initialPanel.api.updateParameters).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ binding: managedSource, remoteHmuxTransition: expect.objectContaining({ phase: "preparing" }) }),
    );
  });

  it("falls back unchanged before claiming when no registered host matches", async () => {
    mocks.getState.mockReturnValue({
      ...mocks.getState(),
      sshHosts: [],
    });
    const claim = vi.fn(async () => true);
    await expect(handleRemoteHmuxShellHandoff(request, claim)).resolves.toEqual(
      { ok: false, fallback: true },
    );
    expect(claim).not.toHaveBeenCalled();
    expect(mocks.createStandalone).not.toHaveBeenCalled();
  });

  it.each([
    ["-L", "8080:localhost:80", "rts@211.181.122.124"],
    ["rts@other.example"],
    ["other@211.181.122.124"],
    ["-p2222", "rts@211.181.122.124"],
  ])("refuses inconsistent or unsupported requests before native work: %j", async (...argv) => {
    const panel = {
      id: `term:${source.sessionId}`,
      params: { sessionId: source.sessionId, binding: source },
      api: { component: "terminal", updateParameters: vi.fn(), setActive: vi.fn() },
    };
    mocks.resolvePaneReference.mockResolvedValue({
      desktopId: "desktop-1",
      api: { getPanel: () => panel, toJSON: () => ({}) },
      panelId: panel.id,
    });
    const claim = vi.fn(async () => true);

    await expect(
      handleRemoteHmuxShellHandoff({ ...request, argv }, claim),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(mocks.resolvePaneReference).not.toHaveBeenCalled();
    expect(mocks.knownHostTrust).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(mocks.createStandalone).not.toHaveBeenCalled();
    expect(panel.api.updateParameters).not.toHaveBeenCalled();
  });

  it.each(["binding", "content"])("refuses to retarget if the source pane %s changes after remote creation", async (changed) => {
    const updateParameters = vi.fn();
    const initialPanel = {
      id: `term:${source.sessionId}`,
      params: { sessionId: source.sessionId, binding: source },
      api: { component: "terminal", updateParameters, setActive: vi.fn() },
    };
    const changedPanel = {
      ...initialPanel,
      api: { ...initialPanel.api, component: changed === "content" ? "pane-launcher" : "terminal" },
      params: changed === "content" ? initialPanel.params : {
        sessionId: "other-source",
        binding: hmuxStandaloneBinding("other-source", "workspace-other"),
      },
    };
    const api = {
      getPanel: vi
        .fn()
        .mockReturnValueOnce(initialPanel)
        .mockReturnValueOnce(initialPanel)
        .mockReturnValueOnce(initialPanel)
        .mockReturnValueOnce(changedPanel),
      toJSON: vi.fn(),
    };
    mocks.resolvePaneReference.mockResolvedValue({
      desktopId: "desktop-1",
      api,
      panelId: initialPanel.id,
    });

    await expect(
      handleRemoteHmuxShellHandoff(request, async () => true),
    ).rejects.toThrow("source pane changed");
    expect(mocks.createStandalone).toHaveBeenCalledTimes(1);
    expect(mocks.departController).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: host.id }),
      expect.objectContaining({
        sessionId: expect.stringMatching(/^standalone_/),
        workspaceId: "workspace-target",
      }),
      "window:main:desktop:desktop-1:pane:term:standalone-source",
    );
    expect(updateParameters).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ binding: source, remoteHmuxTransition: expect.objectContaining({ phase: "preparing" }) }),
    );
  });

  it("abandons native pending creation when durable retarget commit fails", async () => {
    const panel = {
      id: `term:${source.sessionId}`,
      params: { sessionId: source.sessionId, binding: source },
      api: { component: "terminal", updateParameters: vi.fn(), setActive: vi.fn() },
    };
    const api = {
      getPanel: vi.fn(() => panel),
      toJSON: vi.fn(() => ({ panels: [panel.params] })),
    };
    mocks.resolvePaneReference.mockResolvedValue({
      desktopId: "desktop-1",
      api,
      panelId: panel.id,
    });
    mocks.commitMutation
      .mockImplementationOnce(({ mutate }) => mutate())
      .mockImplementationOnce(() => { throw new Error("layout commit failed"); });

    await expect(
      handleRemoteHmuxShellHandoff(request, async () => true),
    ).rejects.toThrow("layout commit failed");

    expect(mocks.departController).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: host.id }),
      expect.objectContaining({
        sessionId: expect.stringMatching(/^standalone_/),
      }),
      "window:main:desktop:desktop-1:pane:term:standalone-source",
    );
  });
  it.each(["write-failure", "lost-cas"])("does not create remotely after preparation %s", async (failure) => {
    const fixture = unknownSource();
    fixture.state.sshHosts = [host];
    if (failure === "write-failure") mocks.flush.mockRejectedValueOnce(new Error("fixture storage full"));
    else mocks.durablePreparation.mockResolvedValueOnce(false);
    await expect(handleRemoteHmuxShellHandoff(request, async () => true)).rejects.toThrow();
    expect(mocks.createStandalone).not.toHaveBeenCalled();
    expect(mocks.departController).not.toHaveBeenCalled();
  });

  it("retries an unknown remote create without reserving a second target", async () => {
    const panel = {
      id: `term:${source.sessionId}`,
      params: { sessionId: source.sessionId, binding: source },
      api: { component: "terminal", updateParameters: vi.fn(), setActive: vi.fn() },
    };
    mocks.resolvePaneReference.mockResolvedValue({
      desktopId: "desktop-1",
      panelId: panel.id,
      api: { getPanel: () => panel, toJSON: () => ({ panels: [panel.params] }) },
    });
    panel.api.updateParameters.mockImplementation((params) => { panel.params = params; });
    const createdTargets = new Set<string>();
    let loseResponse = true;
    mocks.createStandalone.mockImplementation(async (input) => {
      createdTargets.add(input.targetSessionId);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("fixture: response lost after remote creation");
      }
      return {
        requestId: input.requestId,
        bridgeNonce: input.bridgeNonce,
        session: remoteSession(input.targetSessionId),
      };
    });
    await expect(
      handleRemoteHmuxShellHandoff(request, async () => true),
    ).rejects.toThrow("response lost after remote creation");
    expect(panel.params.binding).toEqual(source);
    expect(createdTargets.size).toBe(1);
    const repeated = await handleRemoteHmuxShellHandoff(request, async () => true);
    expect(repeated.ok).toBe(true);
    expect(createdTargets.size).toBe(1);
  });

});
