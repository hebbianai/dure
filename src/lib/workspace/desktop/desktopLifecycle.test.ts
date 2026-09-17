import { afterEach, describe, expect, it, vi } from "vitest";
import {
  removeDesktopWithSessions,
} from "@/lib/workspace/desktop/desktopLifecycle";
import { desktopCloseIntentStorageKey } from "@/lib/workspace/desktop/desktopCloseIntent";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { prepareExplicitHmuxPaneClose } from "@/lib/workspace/pane/paneClose";
import {
  hmuxStandaloneBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";

const legacyLocalBinding = (sessionId: string) =>
  ({
    schemaVersion: 1,
    runtime: "legacy_session_v1",
    source: "local",
    hostId: "local",
    sessionId,
  }) as unknown as TerminalPaneBindingV1;

vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	getDockview: vi.fn(),
}));
vi.mock("@/lib/workspace/pane/paneClose", () => ({
  prepareExplicitHmuxPaneClose: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  useStore.setState({ spaces: [], layouts: {} });
  localStorage.removeItem(desktopCloseIntentStorageKey("desktop-1"));
  localStorage.removeItem(desktopCloseIntentStorageKey("desktop-close-fault"));
  localStorage.removeItem(desktopCloseIntentStorageKey("desktop-retarget"));
});

describe("removeDesktopWithSessions", () => {
  it("gracefully departs the exact mounted standalone pane before desktop disposal", async () => {
    const binding = hmuxStandaloneBinding("hmux", "workspace-1");
    const params = { sessionId: "hmux", binding };
    const events: string[] = [];
    vi.mocked(getDockview).mockReturnValue({
      getPanel: (panelId: string) =>
        panelId === "term:hmux" ? { id: panelId, params } : undefined,
    } as ReturnType<typeof getDockview>);
    vi.mocked(prepareExplicitHmuxPaneClose).mockImplementation(async () => {
      events.push("departure");
      return { state: "retirement_armed" };
    });
    const removeSpace = vi.fn(() => events.push("removed"));
    useStore.setState({
      spaces: [{ id: "desktop-1", name: "one" }],
      layouts: {
        "desktop-1": {
          panels: {
            "term:hmux": { id: "term:hmux", contentComponent: "terminal", params },
          },
        },
      },
      removeSpace,
    });

    await removeDesktopWithSessions("desktop-1");

    expect(prepareExplicitHmuxPaneClose).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      panelId: "term:hmux",
      params,
    });
    expect(events).toEqual(["departure", "removed"]);
    expect(
      localStorage.getItem(desktopCloseIntentStorageKey("desktop-1")),
    ).toBeNull();
  });

  it("retains durable desktop close intent when removal faults after Hmux departure", async () => {
    const binding = hmuxStandaloneBinding("hmux", "workspace-1");
    const params = { sessionId: "hmux", binding };
    vi.mocked(getDockview).mockReturnValue({
      getPanel: () => ({ id: "term:hmux", params }),
    } as unknown as ReturnType<typeof getDockview>);
    vi.mocked(prepareExplicitHmuxPaneClose).mockResolvedValueOnce({
      state: "retirement_armed",
    });
    useStore.setState({
      spaces: [{ id: "desktop-close-fault", name: "fault" }],
      layouts: {
        "desktop-close-fault": {
          panels: { "term:hmux": { id: "term:hmux", contentComponent: "terminal", params } },
        },
      },
      removeSpace: vi.fn(() => {
        throw new Error("fault-injected desktop persistence failure");
      }),
    });

    await expect(
      removeDesktopWithSessions("desktop-close-fault"),
    ).rejects.toThrow("fault-injected desktop persistence failure");

    expect(prepareExplicitHmuxPaneClose).toHaveBeenCalledOnce();
    expect(
      localStorage.getItem(
        desktopCloseIntentStorageKey("desktop-close-fault"),
      ),
    ).not.toBeNull();
    expect(
      JSON.parse(
        localStorage.getItem(
          desktopCloseIntentStorageKey("desktop-close-fault"),
        ) ?? "",
      ),
    ).toMatchObject({ phase: "departure_processed" });
  });

  it("removes the exact pane when a started departure returns an error", async () => {
    const binding = hmuxStandaloneBinding("hmux", "workspace-1");
    const params = { sessionId: "hmux", binding };
    let removed = false;
    vi.mocked(getDockview).mockReturnValue({
      getPanel: () =>
        removed ? undefined : { id: "term:hmux", params },
      removePanel: () => {
        removed = true;
      },
      toJSON: () => ({
        panels: removed
          ? {}
          : { "term:hmux": { id: "term:hmux", contentComponent: "terminal", params } },
      }),
    } as unknown as ReturnType<typeof getDockview>);
    vi.mocked(prepareExplicitHmuxPaneClose).mockRejectedValueOnce(
      new Error("fault-injected departure failure"),
    );
    const removeSpace = vi.fn();
    useStore.setState({
      spaces: [{ id: "desktop-close-fault", name: "fault" }],
      layouts: {
        "desktop-close-fault": {
          panels: { "term:hmux": { id: "term:hmux", contentComponent: "terminal", params } },
        },
      },
      removeSpace,
    });

    await expect(
      removeDesktopWithSessions("desktop-close-fault"),
    ).rejects.toThrow("fault-injected departure failure");

    expect(removeSpace).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(
        desktopCloseIntentStorageKey("desktop-close-fault"),
      ),
    ).toBeNull();
    expect(
      useStore.getState().layouts["desktop-close-fault"],
    ).toEqual({ panels: {} });
  });

  it("departs every local and remote Hmux pane while retired-legacy panes need no teardown", async () => {
    const localBinding = hmuxStandaloneBinding("local-shared", "workspace-1");
    const remoteBinding = {
      schemaVersion: 1,
      runtime: "hmux_standalone_v1",
      source: "ssh",
      hostId: "ssh-host-1",
      sessionId: "remote-shared",
      workspaceId: "workspace-1",
      commandBridgeNonce: "bridge-1",
    } as const;
    const paramsByPanel = {
      "term:local-a": { sessionId: "local-shared", binding: localBinding },
      "term:local-b": { sessionId: "local-shared", binding: localBinding },
      "ssh:remote-a": { sessionId: "remote-shared", binding: remoteBinding },
      "ssh:remote-b": { sessionId: "remote-shared", binding: remoteBinding },
      "term:legacy-a": {
        sessionId: "legacy-shared",
        binding: legacyLocalBinding("legacy-shared"),
      },
      "term:legacy-b": {
        sessionId: "legacy-shared",
        binding: legacyLocalBinding("legacy-shared"),
      },
    };
    vi.mocked(getDockview).mockReturnValue({
      getPanel: (panelId: string) => {
        const params = paramsByPanel[panelId as keyof typeof paramsByPanel];
        return params ? { id: panelId, params } : undefined;
      },
    } as ReturnType<typeof getDockview>);
    const removeSpace = vi.fn();
    useStore.setState({
      spaces: [{ id: "desktop-1", name: "one" }],
      layouts: {
        "desktop-1": {
          panels: Object.fromEntries(
            Object.entries(paramsByPanel).map(([id, params]) => [
              id,
              { id, contentComponent: params.binding.source === "ssh" ? "ssh" : "terminal", params },
            ]),
          ),
        },
      },
      removeSpace,
    });

    await removeDesktopWithSessions("desktop-1");

    expect(prepareExplicitHmuxPaneClose).toHaveBeenCalledTimes(4);
    for (const panelId of [
      "term:local-a",
      "term:local-b",
      "ssh:remote-a",
      "ssh:remote-b",
    ]) {
      expect(prepareExplicitHmuxPaneClose).toHaveBeenCalledWith({
        desktopId: "desktop-1",
        panelId,
        params: paramsByPanel[panelId as keyof typeof paramsByPanel],
      });
    }
    expect(removeSpace).toHaveBeenCalledWith("desktop-1");
  });

  it("preserves a desktop retargeted while a pane departure is pending", async () => {
    let releaseDeparture!: () => void;
    vi.mocked(prepareExplicitHmuxPaneClose).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDeparture = () => resolve({ state: "session_preserved" });
        }),
    );
    let params = {
      sessionId: "old",
      binding: hmuxStandaloneBinding("old", "workspace-1"),
    };
    const layout = () => ({
      panels: {
        "term:session": {
          id: "term:session",
          contentComponent: "terminal",
          params,
        },
      },
    });
    const removeSpace = vi.fn();
    vi.mocked(getDockview).mockReturnValue({
      getPanel: () => ({ id: "term:session", params }),
      toJSON: layout,
    } as unknown as ReturnType<typeof getDockview>);
    useStore.setState({
      spaces: [{ id: "desktop-retarget", name: "retarget" }],
      layouts: { "desktop-retarget": layout() },
      removeSpace,
    });

    const removing = removeDesktopWithSessions("desktop-retarget");
    await vi.waitFor(() => {
      expect(prepareExplicitHmuxPaneClose).toHaveBeenCalledOnce();
    });
    params = {
      sessionId: "new",
      binding: hmuxStandaloneBinding("new", "workspace-1"),
    };
    useStore.getState().saveLayout("desktop-retarget", layout());
    releaseDeparture();

    await expect(removing).rejects.toMatchObject({ code: "pane_changed" });
    expect(removeSpace).not.toHaveBeenCalled();
    expect(useStore.getState().layouts["desktop-retarget"]).toEqual(layout());
    expect(
      localStorage.getItem(desktopCloseIntentStorageKey("desktop-retarget")),
    ).toBeNull();
  });

  it("removes an earlier processed pane but preserves a sibling retargeted mid-saga", async () => {
    let releaseSecond!: () => void;
    vi.mocked(prepareExplicitHmuxPaneClose)
      .mockResolvedValueOnce({ state: "session_preserved" })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = () =>
              resolve({ state: "session_preserved" });
          }),
      );
    const firstParams = {
      sessionId: "first",
      binding: hmuxStandaloneBinding("first", "workspace-1"),
    };
    let secondParams = {
      sessionId: "second",
      binding: hmuxStandaloneBinding("second", "workspace-1"),
    };
    let firstRemoved = false;
    const layout = () => ({
      panels: {
        ...(!firstRemoved
          ? {
              "term:first": {
                id: "term:first",
                contentComponent: "terminal",
                params: firstParams,
              },
            }
          : {}),
        "term:second": {
          id: "term:second",
          contentComponent: "terminal",
          params: secondParams,
        },
      },
    });
    const api = {
      getPanel: (panelId: string) => {
        if (panelId === "term:first" && !firstRemoved) {
          return { id: panelId, params: firstParams };
        }
        if (panelId === "term:second") {
          return { id: panelId, params: secondParams };
        }
        return undefined;
      },
      removePanel: (panel: { id: string }) => {
        if (panel.id === "term:first") firstRemoved = true;
      },
      toJSON: layout,
    } as unknown as ReturnType<typeof getDockview>;
    vi.mocked(getDockview).mockReturnValue(api);
    const removeSpace = vi.fn();
    useStore.setState({
      spaces: [{ id: "desktop-retarget", name: "retarget" }],
      layouts: { "desktop-retarget": layout() },
      removeSpace,
    });

    const removing = removeDesktopWithSessions("desktop-retarget");
    await vi.waitFor(() => {
      expect(prepareExplicitHmuxPaneClose).toHaveBeenCalledTimes(2);
    });
    secondParams = {
      sessionId: "replacement",
      binding: hmuxStandaloneBinding("replacement", "workspace-1"),
    };
    useStore.getState().saveLayout("desktop-retarget", layout());
    releaseSecond();

    await expect(removing).rejects.toMatchObject({ code: "pane_changed" });
    const persisted = useStore.getState().layouts["desktop-retarget"] as {
      panels: Record<string, { params: { sessionId: string } }>;
    };
    expect(persisted.panels).not.toHaveProperty("term:first");
    expect(persisted.panels["term:second"]?.params.sessionId).toBe(
      "replacement",
    );
    expect(removeSpace).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(desktopCloseIntentStorageKey("desktop-retarget")),
    ).toBeNull();
  });
});
