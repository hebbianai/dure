import type { DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import * as standaloneRollout from "@/lib/hmux/standalone/hmuxStandaloneRollout";
import { t } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import { type HmuxSessionSummary, hmux } from "@/lib/ipc";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import * as toast from "@/lib/toast";
import { createLocalTerminalOn, openAgentPanel, openLocalTerminalOn } from "@/lib/workspace/dock";
import { registerDockview, unregisterDockview } from "@/lib/workspace/dock/dockRegistry";
import { createHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { closePanelById } from "@/lib/workspace/pane/paneCloseCoordinator";
import { paneCloseIntentStorageKey } from "@/lib/workspace/pane/paneCloseIntent";
import { useStore } from "@/store";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

const created: HmuxSessionSummary = {
  sessionId: "standalone-created",
  workspaceId: "workspace-created",
  sessionClass: "standalone",
  lifecycle: "ready",
  manifestLifecycle: "ready",
  health: "current_healthy",
  inputAllowed: true,
  terminalEpoch: "epoch-created",
  outputSeq: "0",
  capabilities: ["ansi_redraw_v1"],
};

const placementPanel = (
  id: string,
  width: number,
  groupId = id,
  visible = true,
  location = "grid",
) => ({
  id,
  params: id.startsWith("agent:") ? { agentRef: { agentId: id.slice(6) } } : {},
  api: { component: id.startsWith("agent:") ? "agent" : "terminal", getParameters: () => ({}) },
  group: {
    id: groupId,
    api: { width, isVisible: visible, location: { type: location } },
  },
});

const openAgentColumns = () => [
  placementPanel("agent:a", 240, "column-a"),
  placementPanel("agent:b", 360, "column-b"),
  placementPanel("agent:b-tab", 360, "column-b"),
  placementPanel("term:wide", 720),
  placementPanel("agent:hidden", 900, "hidden", false),
  placementPanel("agent:floating", 800, "floating", true, "floating"),
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useStore.setState({ hmuxSessionMetadata: {}, layouts: {} });
});

describe("openAgentPanel", () => {
  it("atomically publishes a CLI-created pane into the durable desktop layout", () => {
    const panels = new Map<string, { id: string; params?: unknown }>();
    const layout = () => ({
      panels: Object.fromEntries([...panels].map(([id, panel]) => [id, panel])),
    });
    const api = {
      panels: [],
      groups: [],
      getPanel: (id: string) => panels.get(id),
      addPanel: ({ id, params }: { id: string; params?: unknown }) => {
        const panel = { id, params };
        panels.set(id, panel);
        return panel;
      },
      toJSON: layout,
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    const agent = {
      id: "agent-cli-created",
      name: "cli-created",
      provider: "codex" as const,
      projectId: "project-1",
      worktreePath: "/repo",
      branch: "main",
      sessionId: "session-cli-created",
      sessionKind: "pty" as const,
      runtimeBinding: {
        schemaVersion: 1 as const,
        runtime: "hmux_managed_v1" as const,
        source: "local" as const,
        hostId: "local" as const,
        sessionId: "session-cli-created",
        workspaceId: "workspace-cli-created",
        backendProfileId: "local",
      },
    };
    registerDockview("desktop-cli", api);
    useStore.setState({ layouts: { "desktop-cli": { panels: {} } } });

    const panelId = openAgentPanel("desktop-cli", agent);
    expect(panelId).not.toBe(false);
    expect(panelId).not.toMatch(/^(agent|term|terminal|launcher):/);
    expect(useStore.getState().layouts["desktop-cli"]).toEqual(layout());
		expect(panels.get(String(panelId))?.params).toEqual({ agentRef: { agentId: "agent-cli-created" } });

    unregisterDockview("desktop-cli", api);
  });

  it("opens a new agent as a right rail matching the post-add agent mean", () => {
    const addPanel = vi.fn(({ id }: { id: string }) => ({ id }));
    const api = {
      width: 1_320,
      panels: openAgentColumns(),
      groups: [],
      getPanel: () => undefined,
      addPanel,
      toJSON: () => ({ panels: {} }),
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    const agent = {
      id: "new-agent",
      name: "new-agent",
      provider: "codex" as const,
      projectId: "project-1",
      worktreePath: "/repo",
      branch: "main",
      sessionId: "session-new-agent",
      sessionKind: "pty" as const,
    };
    registerDockview("desktop-agent-rail", api);

    try {
      const panelId = openAgentPanel("desktop-agent-rail", agent);
      expect(panelId).not.toBe(false);
      expect(panelId).not.toMatch(/^(agent|term|terminal|launcher):/);
      expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({
        id: panelId,
        component: "agent",
        initialWidth: 244,
        position: { direction: "right" },
      }));
    } finally {
      unregisterDockview("desktop-agent-rail", api);
    }
  });
});

describe("openLocalTerminalOn", () => {
  it("keeps launcher completion pending until the actual terminal is presented", async () => {
    standaloneRollout.resetStandaloneCreateTracking();
    vi.spyOn(standaloneRollout, "hmuxManagedShellReady").mockResolvedValue(false);
    vi.spyOn(standaloneRollout, "hmuxStandaloneReady").mockResolvedValue(true);
    let finish!: (value: HmuxSessionSummary) => void;
    vi.spyOn(hmux, "createStandalone").mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const addPanel = vi.fn(({ id }: { id: string }) => ({ id }));
    const api = { panels: [], groups: [], getPanel: () => undefined, addPanel } as unknown as DockviewApi;
    const settled = vi.fn();
    try {
      const creating = createLocalTerminalOn(api, "/repo", undefined, "pending-launcher");
      void creating.then(settled);
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(settled).not.toHaveBeenCalled();
      expect(addPanel).not.toHaveBeenCalled();
      finish(created);
      await creating;
      expect(addPanel).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      standaloneRollout.resetStandaloneCreateTracking();
    }
  });
  it.each([
    { managed: true, standalone: false, detail: "unknown repository extension: relativeworktrees" },
    { managed: false, standalone: true, detail: "shell executable was not found" },
  ])("shows the actual terminal creation failure once: $detail", async ({ managed, standalone, detail }) => {
    standaloneRollout.resetStandaloneCreateTracking();
    vi.spyOn(standaloneRollout, "hmuxManagedShellReady").mockResolvedValue(managed);
    vi.spyOn(standaloneRollout, "hmuxStandaloneReady").mockResolvedValue(standalone);
    vi.spyOn(hmux, "createManagedShell").mockRejectedValue(new Error(detail));
    vi.spyOn(hmux, "createStandalone").mockRejectedValue(new Error(detail));
    const showError = vi.spyOn(toast, "showErrorToast").mockReturnValue(1);
    const api = { panels: [], groups: [], getPanel: () => undefined } as unknown as DockviewApi;
    const operationId = `failed-terminal-${managed}`;
    try {
      openLocalTerminalOn(api, "/repo", undefined, operationId);
      openLocalTerminalOn(api, "/repo", undefined, operationId);
      const pending = standaloneRollout.createStandaloneOnce(operationId, () => {
        throw new Error("the original create must own the in-flight request");
      });
      await pending.catch(() => undefined);
      expect(showError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(detail));
      await expect(pending).rejects.toThrow(detail);
      const retry = vi.fn().mockResolvedValue(undefined);
      await standaloneRollout.createStandaloneOnce(operationId, retry);
      expect(retry).toHaveBeenCalledOnce();
    } finally {
      standaloneRollout.resetStandaloneCreateTracking();
    }
  });

  it.each(["readiness", "both creations", "unsupported"])(
    "reports a terminal failure at $0 without dropping the first cause",
    async (failure) => {
      standaloneRollout.resetStandaloneCreateTracking();
      const managed = vi.spyOn(standaloneRollout, "hmuxManagedShellReady");
      if (failure === "readiness") managed.mockRejectedValue(new Error("backend connection refused"));
      else managed.mockResolvedValue(failure === "both creations");
      vi.spyOn(standaloneRollout, "hmuxStandaloneReady").mockResolvedValue(failure !== "unsupported");
      vi.spyOn(hmux, "createManagedShell").mockRejectedValue(new Error("working folder could not be read"));
      vi.spyOn(hmux, "createStandalone").mockRejectedValue(new Error("shell executable was not found"));
      const showError = vi.spyOn(toast, "showErrorToast").mockReturnValue(1);
      const api = { panels: [], groups: [], getPanel: () => undefined } as unknown as DockviewApi;
      const operationId = `terminal-failure-${failure}`;
      try {
        openLocalTerminalOn(api, "/repo", undefined, operationId);
        await standaloneRollout.createStandaloneOnce(operationId, () => {
          throw new Error("the original create must own the in-flight request");
        }).catch(() => undefined);
        expect(showError).toHaveBeenCalledOnce();
        const message = showError.mock.calls[0]?.[0];
        if (failure === "readiness") expect(message).toContain("backend connection refused");
        else if (failure === "both creations") {
          expect(message).toContain("working folder could not be read");
          expect(message).toContain("shell executable was not found");
        } else expect(message).toContain(t("terminal.failure.unavailable"));
      } finally {
        standaloneRollout.resetStandaloneCreateTracking();
      }
    },
  );

  it("does not show an error when the existing standalone fallback opens the terminal", async () => {
    standaloneRollout.resetStandaloneCreateTracking();
    vi.spyOn(standaloneRollout, "hmuxManagedShellReady").mockResolvedValue(true);
    vi.spyOn(standaloneRollout, "hmuxStandaloneReady").mockResolvedValue(true);
    vi.spyOn(hmux, "createManagedShell").mockRejectedValue(new Error("managed backend is unavailable"));
    vi.spyOn(hmux, "createStandalone").mockResolvedValue(created);
    const showError = vi.spyOn(toast, "showErrorToast").mockReturnValue(1);
    const addPanel = vi.fn(({ id }: { id: string }) => ({ id }));
    const api = { panels: [], groups: [], getPanel: () => undefined, addPanel } as unknown as DockviewApi;
    const operationId = "terminal-successful-compatibility-fallback";
    try {
      openLocalTerminalOn(api, "/repo", undefined, operationId);
      await standaloneRollout.createStandaloneOnce(operationId, () => {
        throw new Error("the original create must own the in-flight request");
      });
      expect(addPanel).toHaveBeenCalledOnce();
      expect(showError).not.toHaveBeenCalled();
    } finally {
      standaloneRollout.resetStandaloneCreateTracking();
    }
  });

  it("uses the post-add agent mean on standalone fallback", async () => {
    standaloneRollout.resetStandaloneCreateTracking();
    vi.spyOn(standaloneRollout, "hmuxManagedShellReady").mockResolvedValue(false);
    vi.spyOn(standaloneRollout, "hmuxStandaloneReady").mockResolvedValue(true);
    vi.spyOn(hmux, "createStandalone").mockResolvedValue(created);
    const addPanel = vi.fn(({ id }: { id: string }) => ({ id }));
    const api = {
      width: 1_320,
      panels: openAgentColumns(),
      groups: [],
      getPanel: () => undefined,
      addPanel,
    } as unknown as DockviewApi;
    const operationId = "average-agent-column-rail";

    try {
      openLocalTerminalOn(api, "/repo", undefined, operationId);
      await standaloneRollout.createStandaloneOnce(operationId, () => {
        throw new Error("the original create must own the in-flight request");
      });
      expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({
        initialWidth: 244,
        position: { direction: "right" },
      }));
    } finally {
      standaloneRollout.resetStandaloneCreateTracking();
    }
  });

  it("leaves an explicit contextual split unchanged", async () => {
    standaloneRollout.resetStandaloneCreateTracking();
    vi.spyOn(standaloneRollout, "hmuxManagedShellReady").mockResolvedValue(false);
    vi.spyOn(standaloneRollout, "hmuxStandaloneReady").mockResolvedValue(true);
    vi.spyOn(hmux, "createStandalone").mockResolvedValue(created);
    const addPanel = vi.fn(({ id }: { id: string }) => ({ id }));
    const api = {
      width: 1_600,
      panels: [placementPanel("term:existing", 800)],
      groups: [],
      getPanel: () => undefined,
      addPanel,
    } as unknown as DockviewApi;
    const position = { referencePanel: "existing", direction: "below" };
    const operationId = "explicit-split";

    try {
      openLocalTerminalOn(api, "/repo", position, operationId);
      await standaloneRollout.createStandaloneOnce(operationId, () => {
        throw new Error("the original create must own the in-flight request");
      });
      expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({ position }));
      expect(addPanel).toHaveBeenCalledWith(
        expect.not.objectContaining({ initialWidth: expect.anything() }),
      );
    } finally {
      standaloneRollout.resetStandaloneCreateTracking();
    }
  });

  it("carries the reserved request identity into standalone creation", async () => {
    standaloneRollout.resetStandaloneCreateTracking();
    vi.spyOn(standaloneRollout, "hmuxManagedShellReady").mockResolvedValue(false);
    vi.spyOn(standaloneRollout, "hmuxStandaloneReady").mockResolvedValue(true);
    const create = vi.spyOn(hmux, "createStandalone").mockResolvedValue(created);
    const api = {
      panels: [],
      groups: [],
      getPanel: () => undefined,
      addPanel: vi.fn(({ id }: { id: string }) => ({ id })),
    } as unknown as DockviewApi;
    const operationId = "term-reserved-create-intent";

    try {
      expect(openLocalTerminalOn(api, "/repo", undefined, operationId)).toBe(operationId);
      await standaloneRollout.createStandaloneOnce(operationId, () => {
        throw new Error("the original create must own the in-flight request");
      });
      expect(create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ operationId, cwd: "/repo" }),
      );
    } finally {
      standaloneRollout.resetStandaloneCreateTracking();
    }
  });
});

describe("createHmuxStandaloneTerminalOn", () => {
  it("publishes the fenced create receipt before mounting the pane", async () => {
    const addPanel = vi.fn(({ id }: { id: string }) => {
      expect(
        useStore.getState().hmuxSessionMetadata[
          hmuxSessionMetadataKey(created.workspaceId, created.sessionId)
        ],
      ).toMatchObject(created);
      return { id };
    });
    vi.spyOn(hmux, "createStandalone").mockResolvedValue(created);
    const api = {
      panels: [],
      getPanel: () => undefined,
      addPanel,
    } as unknown as DockviewApi;

    await createHmuxStandaloneTerminalOn(api, "/repo");

    expect(addPanel).toHaveBeenCalledOnce();
  });

  it("delivers a one-shot command through exact input on an older backend", async () => {
    vi.stubGlobal("navigator", {
      platform: "Win32",
      userAgent: "Windows",
    });
    vi.spyOn(ipc, "backendSupports").mockResolvedValue(false);
    vi.spyOn(hmux, "createStandalone").mockResolvedValue(created);
    const commandInput = vi.spyOn(hmux, "commandInput").mockResolvedValue({
      terminalEpoch: created.terminalEpoch ?? "epoch-created",
      text: { state: "written_to_pty", recordId: "1" },
      submit: { state: "written_to_pty", recordId: "2" },
    });
    const addPanel = vi.fn(({ id }: { id: string }) => {
      expect(commandInput).toHaveBeenCalledOnce();
      return { id };
    });
    const api = {
      panels: [],
      getPanel: () => undefined,
      addPanel,
    } as unknown as DockviewApi;

    await createHmuxStandaloneTerminalOn(
      api,
      "/repo",
      undefined,
      undefined,
      undefined,
      {
        commandLine:
          'cmd.exe /D /Q /V:ON /C powershell -Command "Write-Output \'installed\'" ^& set "_dure_exit=!errorlevel!" ^& exit /B !_dure_exit!',
        closeOnSuccess: true,
      },
    );

    expect(hmux.createStandalone).toHaveBeenCalledWith(
      expect.not.objectContaining({ commandLine: expect.anything() }),
    );
    const delivered = commandInput.mock.calls[0]?.[0].text ?? "";
    expect(delivered).toMatch(
      /^powershell\.exe -NoProfile -EncodedCommand [A-Za-z0-9+/=]+ & call exit \/B %%errorlevel%%$/,
    );
    const encoded = delivered.split(" ")[3] ?? "";
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toContain(
      `$commandLine = 'cmd.exe /D /Q /V:ON /C powershell -Command "Write-Output ''installed''" ^& set "_dure_exit=!errorlevel!" ^& exit /B !_dure_exit!';`,
    );
    expect(commandInput).toHaveBeenCalledWith({
      sessionId: created.sessionId,
      workspaceId: created.workspaceId,
      text: delivered,
      submit: true,
    });
    expect(addPanel).toHaveBeenCalledOnce();
  });

  it("lets a current backend launch the original command atomically", async () => {
    vi.spyOn(ipc, "backendSupports").mockResolvedValue(true);
    const createStandalone = vi
      .spyOn(hmux, "createStandalone")
      .mockResolvedValue(created);
    const commandInput = vi.spyOn(hmux, "commandInput");
    const api = {
      panels: [],
      getPanel: () => undefined,
      addPanel: vi.fn(({ id }: { id: string }) => ({ id })),
    } as unknown as DockviewApi;
    const commandLine = "pnpm install";

    await createHmuxStandaloneTerminalOn(
      api,
      "/repo",
      undefined,
      undefined,
      undefined,
      { commandLine },
    );

    expect(createStandalone).toHaveBeenCalledWith(
      expect.objectContaining({ commandLine }),
    );
    expect(commandInput).not.toHaveBeenCalled();
  });

  it("abandons an unpresented fallback session when command delivery fails", async () => {
    vi.spyOn(ipc, "backendSupports").mockResolvedValue(false);
    vi.spyOn(hmux, "createStandalone").mockResolvedValue(created);
    vi.spyOn(hmux, "commandInput").mockRejectedValue(
      new Error("command input unavailable"),
    );
    const abandon = vi
      .spyOn(hmux, "abandonUnpresentedCreation")
      .mockResolvedValue({ state: "retirement_armed" });
    const addPanel = vi.fn();
    const api = {
      panels: [],
      getPanel: () => undefined,
      addPanel,
    } as unknown as DockviewApi;

    await expect(
      createHmuxStandaloneTerminalOn(
        api,
        "/repo",
        undefined,
        undefined,
        undefined,
        { commandLine: "pnpm install" },
      ),
    ).rejects.toThrow("command input unavailable");

    expect(abandon).toHaveBeenCalledWith(
      created.sessionId,
      created.workspaceId,
    );
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("commits an in-flight create to the replacement StrictMode dockview", async () => {
    let finishCreate: ((session: HmuxSessionSummary) => void) | undefined;
    vi.spyOn(hmux, "createStandalone").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreate = resolve;
        }),
    );
    const firstAdd = vi.fn();
    const replacementAdd = vi.fn(({ id }: { id: string }) => ({ id }));
    const first = {
      panels: [],
      getPanel: () => undefined,
      addPanel: firstAdd,
    } as unknown as DockviewApi;
    const replacement = {
      panels: [],
      getPanel: () => undefined,
      addPanel: replacementAdd,
      toJSON: vi.fn(() => ({ panels: {} })),
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    registerDockview("desktop-strict", first);
    unregisterDockview("desktop-strict", first);
    const creating = createHmuxStandaloneTerminalOn(
      first,
      "/repo",
      undefined,
      undefined,
      "desktop-strict",
    );
    registerDockview("desktop-strict", replacement);
    finishCreate?.(created);
    await creating;

    expect(firstAdd).not.toHaveBeenCalled();
    expect(replacementAdd).toHaveBeenCalledOnce();
    unregisterDockview("desktop-strict", replacement);
  });

  it("safely abandons a Host when its logical desktop disappeared during create", async () => {
    vi.spyOn(hmux, "createStandalone").mockResolvedValue(created);
    const abandon = vi
      .spyOn(hmux, "abandonUnpresentedCreation")
      .mockResolvedValue({ state: "retirement_armed" });
    const api = {
      panels: [],
      getPanel: () => undefined,
      addPanel: vi.fn(),
    } as unknown as DockviewApi;

    await expect(
      createHmuxStandaloneTerminalOn(
        api,
        "/repo",
        undefined,
        undefined,
        "desktop-removed",
      ),
    ).rejects.toMatchObject({ code: "pane_changed" });

    expect(abandon).toHaveBeenCalledWith(
      created.sessionId,
      created.workspaceId,
    );
  });

  it("receives graceful departure before removing an explicit standalone pane", async () => {
    const events: string[] = [];
    vi.spyOn(hmux, "departPaneGracefully").mockImplementation(async () => {
      events.push("departure");
      return { state: "session_preserved", reason: "other_clients_attached" };
    });
    const panel = {
      id: "term:standalone-created",
      params: {
        sessionId: created.sessionId,
        binding: hmuxStandaloneBinding(created.sessionId, created.workspaceId),
      },
    };
    let removed = false;
    const layout = () => ({
      panels: removed
        ? {}
        : {
            [panel.id]: {
              id: panel.id,
              params: panel.params,
            },
          },
    });
    const api = {
      getPanel: (id: string) => (id === panel.id ? panel : undefined),
      removePanel: () => {
        removed = true;
        events.push("removed");
      },
      toJSON: layout,
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    registerDockview("desktop-1", api);
    useStore.setState({ layouts: { "desktop-1": layout() } });

    await expect(closePanelById(panel.id, "desktop-1")).resolves.toEqual({
      desktopId: "desktop-1",
      mode: "live",
      departure: {
        state: "session_preserved",
        reason: "other_clients_attached",
      },
    });

    expect(events).toEqual(["departure", "removed"]);
    expect(useStore.getState().layouts["desktop-1"]).toEqual({
      panels: {},
    });
    expect(hmux.departPaneGracefully).toHaveBeenCalledWith(
      "window:main:desktop:desktop-1:pane:term:standalone-created",
      created.sessionId,
      created.workspaceId,
    );
    unregisterDockview("desktop-1", api);
  });

  it("closes a stale managed terminal beside noncanonical Agent pane params", async () => {
    const target = {
      id: "term:stale-managed",
      params: {
        sessionId: "stale-managed",
        binding: {
          schemaVersion: 1 as const,
          runtime: "hmux_managed_v1" as const,
          source: "local" as const,
          hostId: "local" as const,
          sessionId: "stale-managed",
          workspaceId: "dure-local-shells-v1",
        },
      },
    };
    const sibling = {
      id: "agent:agent-sibling",
      params: {
        agentId: "agent-sibling",
        binding: {
          schemaVersion: 1,
          runtime: "hmux_managed_v1",
          source: "local",
          hostId: "local",
          sessionId: "agent-sibling",
          workspaceId: "workspace-sibling",
        },
      },
    };
    const panels = new Map<string, { id: string; params: unknown }>([
      [target.id, target],
      [sibling.id, sibling],
    ]);
    const layout = () => ({
      panels: Object.fromEntries(
        [...panels].map(([id, panel]) => [id, { id, contentComponent: panel === sibling ? "agent" : "terminal", params: panel.params }]),
      ),
    });
    const api = {
      getPanel: (id: string) => panels.get(id),
      removePanel: (panel: { id: string }) => panels.delete(panel.id),
      toJSON: layout,
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    registerDockview("desktop-stale-managed", api);
    useStore.setState({
      layouts: { "desktop-stale-managed": layout() },
    });

    await expect(
      closePanelById(target.id, "desktop-stale-managed"),
    ).resolves.toMatchObject({
      desktopId: "desktop-stale-managed",
      mode: "live",
    });

    expect(panels.has(target.id)).toBe(false);
    expect(useStore.getState().layouts["desktop-stale-managed"]).toEqual({
      panels: {
        [sibling.id]: { id: sibling.id, contentComponent: "agent", params: { agentRef: { agentId: "agent-sibling" } } },
      },
    });
    unregisterDockview("desktop-stale-managed", api);
  });

  it("preserves a pane retargeted while graceful departure is pending", async () => {
    let releaseDeparture!: () => void;
    vi.spyOn(hmux, "departPaneGracefully").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDeparture = () =>
            resolve({ state: "session_preserved", reason: "retargeted" });
        }),
    );
    let params = {
      sessionId: "old-session",
      binding: hmuxStandaloneBinding("old-session", "workspace-created"),
    };
    const panel = {
      id: "term:retargeted",
      get params() {
        return params;
      },
    };
    const layout = () => ({
      panels: {
        [panel.id]: { id: panel.id, params },
      },
    });
    const removePanel = vi.fn();
    const api = {
      getPanel: (id: string) => (id === panel.id ? panel : undefined),
      removePanel,
      toJSON: layout,
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    registerDockview("desktop-retarget", api);
    useStore.setState({
      layouts: { "desktop-retarget": layout() },
    });

    const closing = closePanelById(panel.id, "desktop-retarget");
    await vi.waitFor(() => {
      expect(hmux.departPaneGracefully).toHaveBeenCalledOnce();
    });
    params = {
      sessionId: "replacement-session",
      binding: hmuxStandaloneBinding(
        "replacement-session",
        "workspace-created",
      ),
    };
    releaseDeparture();

    await expect(closing).rejects.toMatchObject({ code: "pane_changed" });
    expect(removePanel).not.toHaveBeenCalled();
    expect(useStore.getState().layouts["desktop-retarget"]).toEqual(layout());
    expect(
      localStorage.getItem(
        paneCloseIntentStorageKey("desktop-retarget", panel.id),
      ),
    ).toBeNull();
    unregisterDockview("desktop-retarget", api);
  });

  it("preserves sibling layout changes while removing the crossed pane", async () => {
    let releaseDeparture!: () => void;
    vi.spyOn(hmux, "departPaneGracefully").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDeparture = () => resolve({ state: "retirement_armed" });
        }),
    );
    const closingPanel = {
      id: "term:closing",
      params: {
        sessionId: "closing-session",
        binding: hmuxStandaloneBinding("closing-session", "workspace-created"),
      },
    };
    const sibling = {
      id: "term:new-sibling",
      params: {
        sessionId: "sibling-session",
        binding: hmuxStandaloneBinding("sibling-session", "workspace-created"),
      },
    };
    const panels = new Map([[closingPanel.id, closingPanel]]);
    const layout = () => ({
      panels: Object.fromEntries(
        [...panels].map(([id, panel]) => [id, { id, params: panel.params }]),
      ),
    });
    const api = {
      getPanel: (id: string) => panels.get(id),
      removePanel: (panel: { id: string }) => panels.delete(panel.id),
      toJSON: layout,
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    registerDockview("desktop-sibling-change", api);
    useStore.setState({
      layouts: { "desktop-sibling-change": layout() },
    });

    const closing = closePanelById(closingPanel.id, "desktop-sibling-change");
    await vi.waitFor(() => {
      expect(hmux.departPaneGracefully).toHaveBeenCalledOnce();
    });
    panels.set(sibling.id, sibling);
    useStore.getState().saveLayout("desktop-sibling-change", layout());
    releaseDeparture();

    await expect(closing).resolves.toMatchObject({
      desktopId: "desktop-sibling-change",
      mode: "live",
    });
    expect(useStore.getState().layouts["desktop-sibling-change"]).toEqual({
      panels: {
        [sibling.id]: { id: sibling.id, params: sibling.params },
      },
    });
    expect(
      localStorage.getItem(
        paneCloseIntentStorageKey("desktop-sibling-change", closingPanel.id),
      ),
    ).toBeNull();
    unregisterDockview("desktop-sibling-change", api);
  });

  it("keeps the durable close intent when live removal faults after retirement arms", async () => {
    vi.spyOn(hmux, "departPaneGracefully").mockResolvedValueOnce({
      state: "retirement_armed",
    });
    const panel = {
      id: "term:standalone-close-fault",
      params: {
        sessionId: created.sessionId,
        binding: hmuxStandaloneBinding(created.sessionId, created.workspaceId),
      },
    };
    const before = {
      panels: {
        [panel.id]: {
          id: panel.id,
          params: panel.params,
        },
      },
    };
    const api = {
      getPanel: (id: string) => (id === panel.id ? panel : undefined),
      removePanel: vi.fn(() => {
        throw new Error("fault-injected Dockview removal failure");
      }),
      toJSON: vi.fn(() => before),
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    registerDockview("desktop-close-fault", api);
    useStore.setState({ layouts: { "desktop-close-fault": before } });

    await expect(
      closePanelById(panel.id, "desktop-close-fault"),
    ).rejects.toThrow("fault-injected Dockview removal failure");

    expect(hmux.departPaneGracefully).toHaveBeenCalledOnce();
    expect(
      (
        useStore.getState().layouts["desktop-close-fault"] as {
          panels: Record<string, unknown>;
        }
      ).panels,
    ).not.toHaveProperty(panel.id);
    expect(api.fromJSON).not.toHaveBeenCalled();
    unregisterDockview("desktop-close-fault", api);
  });

  it("closes two panes for one session one owner at a time", async () => {
    vi.spyOn(hmux, "departPaneGracefully")
      .mockResolvedValueOnce({
        state: "session_preserved",
        reason: "other_clients_attached",
      })
      .mockResolvedValueOnce({ state: "retirement_armed" });
    const panel = {
      id: "term:standalone-created",
      params: {
        sessionId: created.sessionId,
        binding: hmuxStandaloneBinding(created.sessionId, created.workspaceId),
      },
    };
    const firstRemove = vi.fn();
    const secondRemove = vi.fn();
    const first = {
      getPanel: (id: string) => (id === panel.id ? panel : undefined),
      removePanel: firstRemove,
      toJSON: vi.fn(() => ({ panels: {} })),
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    const second = {
      getPanel: (id: string) => (id === panel.id ? panel : undefined),
      removePanel: secondRemove,
      toJSON: vi.fn(() => ({ panels: {} })),
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    registerDockview("desktop-a", first);
    registerDockview("desktop-b", second);

    await closePanelById(panel.id, "desktop-a");
    expect(firstRemove).toHaveBeenCalledOnce();
    expect(secondRemove).not.toHaveBeenCalled();

    await closePanelById(panel.id, "desktop-b");
    expect(secondRemove).toHaveBeenCalledOnce();
    expect(hmux.departPaneGracefully).toHaveBeenNthCalledWith(
      1,
      "window:main:desktop:desktop-a:pane:term:standalone-created",
      created.sessionId,
      created.workspaceId,
    );
    expect(hmux.departPaneGracefully).toHaveBeenNthCalledWith(
      2,
      "window:main:desktop:desktop-b:pane:term:standalone-created",
      created.sessionId,
      created.workspaceId,
    );
    unregisterDockview("desktop-a", first);
    unregisterDockview("desktop-b", second);
  });

  it("serializes concurrent pane closes without resurrecting the first pane", async () => {
    let releaseFirst!: () => void;
    vi.spyOn(hmux, "departPaneGracefully")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ state: "session_preserved" });
          }),
      )
      .mockResolvedValueOnce({ state: "retirement_armed" });
    const panels = new Map(
      ["first", "second"].map((name) => {
        const id = `term:${name}`;
        return [
          id,
          {
            id,
            params: {
              sessionId: name,
              binding: hmuxStandaloneBinding(name, "workspace-created"),
            },
          },
        ] as const;
      }),
    );
    const layout = () => ({
      panels: Object.fromEntries(
        [...panels].map(([id, panel]) => [id, { id, params: panel.params }]),
      ),
    });
    const api = {
      getPanel: (id: string) => panels.get(id),
      removePanel: (panel: { id: string }) => {
        panels.delete(panel.id);
      },
      toJSON: layout,
      fromJSON: vi.fn(),
    } as unknown as DockviewApi;
    registerDockview("desktop-concurrent", api);
    useStore.setState({ layouts: { "desktop-concurrent": layout() } });

    const first = closePanelById("term:first", "desktop-concurrent");
    const second = closePanelById("term:second", "desktop-concurrent");
    await vi.waitFor(() => {
      expect(hmux.departPaneGracefully).toHaveBeenCalledTimes(1);
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(hmux.departPaneGracefully).toHaveBeenCalledTimes(2);
    expect(useStore.getState().layouts["desktop-concurrent"]).toEqual({
      panels: {},
    });
    unregisterDockview("desktop-concurrent", api);
  });

  it("removes a persisted-only pane without inventing graceful departure", async () => {
    const panelId = "term:persisted-standalone";
    useStore.setState({
      layouts: {
        "desktop-persisted": {
          grid: {
            root: {
              type: "leaf",
              data: {
                id: "group:persisted-standalone",
                views: [panelId],
                activeView: panelId,
              },
              size: 600,
            },
            width: 800,
            height: 600,
            orientation: "HORIZONTAL",
          },
          panels: {
            [panelId]: {
              id: panelId,
              contentComponent: "terminal",
              title: panelId,
              params: {
                sessionId: created.sessionId,
                binding: hmuxStandaloneBinding(
                  created.sessionId,
                  created.workspaceId,
                ),
              },
            },
          },
          activeGroup: "group:persisted-standalone",
        },
      },
    });
    const departure = vi.spyOn(hmux, "departPaneGracefully");

    await expect(closePanelById(panelId)).resolves.toEqual({
      desktopId: "desktop-persisted",
      mode: "persisted",
    });

    expect(departure).not.toHaveBeenCalled();
    const persisted = useStore.getState().layouts["desktop-persisted"] as {
      panels?: unknown;
    };
    expect(persisted.panels).not.toHaveProperty(panelId);
  });
});
