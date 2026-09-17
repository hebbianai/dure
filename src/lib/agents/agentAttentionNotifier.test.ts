import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attentionSubscribe: vi.fn(),
  getCurrentWebviewWindow: vi.fn(() => ({ label: "main" })),
  getDockview: vi.fn(),
  isMainWindow: vi.fn(() => true),
  mountedDockviewEntries: vi.fn(),
  notifyPrefs: vi.fn(),
  pushAgentNotification: vi.fn(),
  systemNotify: vi.fn(),
  storeState: {
    activeSpaceId: "desktop-a",
    agents: [{ id: "agent-a", name: "Codex", projectId: "project-a" }],
    layouts: {},
    projects: [{ id: "project-a", name: "Workspace" }],
  },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: mocks.getCurrentWebviewWindow,
}));
vi.mock("@/lib/agents/agentAttentionStore", () => ({
  useAgentAttention: { subscribe: mocks.attentionSubscribe },
}));
vi.mock("@/lib/agents/agentDisplayName", () => ({
  agentDisplayName: (agent: { name: string }) => agent.name,
}));
vi.mock("@/lib/i18n", () => ({ t: (value: string) => value }));
vi.mock("@/lib/settings/notify", () => ({
  notifyPrefs: mocks.notifyPrefs,
  systemNotify: mocks.systemNotify,
}));
vi.mock("@/lib/ipc/notifications", () => ({
  pushAgentNotification: mocks.pushAgentNotification,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/dock/dockRegistry")>()),
  getDockview: mocks.getDockview,
  mountedDockviewEntries: mocks.mountedDockviewEntries,
}));
vi.mock("@/lib/workspace/window/windows", () => ({
  isMainWindow: mocks.isMainWindow,
}));
vi.mock("@/store", () => ({
  useStore: { getState: () => mocks.storeState },
}));

import {
  diffEpisodeBumps,
  episodeNotificationBody,
  installAgentAttentionNotifier,
  notifyAgentEvent,
} from "@/lib/agents/agentAttentionNotifier";

function mountedPane(panelId: string, component = "agent", params: Record<string, unknown> = { agentRef: { agentId: "agent-a" } }) {
  const panel = { id: panelId, params, api: { component, getParameters: () => params, isActive: true, isVisible: true } };
  return { panels: [panel], getPanel: (id: string) => id === panelId ? panel : undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", { hasFocus: () => true });
  mocks.isMainWindow.mockReturnValue(true);
  const api = mountedPane("agent:agent-a");
  mocks.getDockview.mockReturnValue(api);
  mocks.mountedDockviewEntries.mockReturnValue([["desktop-a", api]]);
  mocks.storeState.layouts = {};
  mocks.storeState.agents = [{ id: "agent-a", name: "Codex", projectId: "project-a" }];
  mocks.notifyPrefs.mockReturnValue({
    enabled: true,
    agentDone: true,
    approvalRequired: true,
    agentExited: true,
    suppressWhenVisible: false,
  });
  mocks.systemNotify.mockResolvedValue({ accepted: true });
  mocks.pushAgentNotification.mockResolvedValue(undefined);
});

describe("phone push delivery", () => {
  it("forwards the Host event while desktop notifications are disabled and no phone is attached", () => {
    mocks.notifyPrefs.mockReturnValue({ enabled: false });
    notifyAgentEvent("agent-a", "approval", "Private terminal content", {
      eventId: "hmux:session-a:terminal-a:approval:4",
    });
    expect(mocks.pushAgentNotification).toHaveBeenCalledWith({
      kind: "approval",
      eventId: "hmux:session-a:terminal-a:approval:4",
    });
    expect(mocks.systemNotify).not.toHaveBeenCalled();
  });

  it("does not suppress the phone's completion because its desktop pane is visible", () => {
    mocks.notifyPrefs.mockReturnValue({ enabled: true, agentDone: true, suppressWhenVisible: true });
    notifyAgentEvent("agent-a", "done", "Private terminal content", {
      eventId: "hmux:session-a:terminal-a:turn:4",
    });
    expect(mocks.pushAgentNotification).toHaveBeenCalledWith({
      kind: "done",
      eventId: "hmux:session-a:terminal-a:turn:4",
    });
    expect(mocks.systemNotify).not.toHaveBeenCalled();
  });

  it("leaves phone delivery to the main window and an exact event identity", () => {
    mocks.isMainWindow.mockReturnValue(false);
    notifyAgentEvent("agent-a", "approval", "Approval", { eventId: "event-a" });
    mocks.isMainWindow.mockReturnValue(true);
    notifyAgentEvent("agent-a", "approval", "Approval");
    expect(mocks.pushAgentNotification).not.toHaveBeenCalled();
  });
});

describe("episodeNotificationBody", () => {
  it("gives approval and done distinct copy", () => {
    expect(episodeNotificationBody("approval")).not.toBe(episodeNotificationBody("done"));
  });
});

describe("diffEpisodeBumps", () => {
  it("returns only agents whose episode increased", () => {
    expect(
      diffEpisodeBumps(
        { a: 1, b: 2 },
        { a: 2, b: 2, c: 1 },
      ),
    ).toEqual(["a", "c"]);
  });

  it("returns nothing when episodes are unchanged", () => {
    expect(diffEpisodeBumps({ a: 3 }, { a: 3 })).toEqual([]);
  });
});

describe("desktop notification policy", () => {
  it("prefers an actual mounted Agent pane over a stale preferred saved Space", () => {
    const api = mountedPane("moved-slot");
    mocks.mountedDockviewEntries.mockReturnValue([["desktop-b", api]]);
    mocks.storeState.layouts = { "desktop-a": { panels: { "moved-slot": { contentComponent: "agent", params: { agentRef: { agentId: "agent-a" } } } } } };
    notifyAgentEvent("agent-a", "approval", "Approval needed", { eventId: "moved-notification" });
    expect(mocks.systemNotify).toHaveBeenCalledWith("Codex · Workspace", "Approval needed", {
      eventId: "moved-notification",
      paneTarget: { desktopId: "desktop-b", panelId: "moved-slot", windowLabel: "main" },
    });
  });

  it.each(["slot", "launcher:old", "term:old", "agent:old"])("routes attention to the current Agent pane %s", (panelId) => {
    const api = mountedPane(panelId);
    mocks.mountedDockviewEntries.mockReturnValue([["desktop-b", api]]);
    notifyAgentEvent("agent-a", "approval", "Approval needed", { eventId: `attention-${panelId}` });
    expect(mocks.systemNotify).toHaveBeenCalledWith("Codex · Workspace", "Approval needed", {
      eventId: `attention-${panelId}`,
      paneTarget: { desktopId: "desktop-b", panelId, windowLabel: "main" },
    });
  });

  it("suppresses attention for a visible Agent in a neutral slot", () => {
    const api = mountedPane("visible-slot");
    mocks.getDockview.mockReturnValue(api);
    mocks.mountedDockviewEntries.mockReturnValue([["desktop-a", api]]);
    mocks.notifyPrefs.mockReturnValue({ enabled: true, approvalRequired: true, suppressWhenVisible: true });
    notifyAgentEvent("agent-a", "approval", "Approval needed", { eventId: "visible-neutral" });
    expect(mocks.systemNotify).not.toHaveBeenCalled();
  });

  it.each(["agent", "terminal", "launcher"])("does not suppress or target attention using changed %s content at an old Agent ID", (component) => {
    const api = mountedPane("agent:agent-a", component, { agentRef: null });
    mocks.getDockview.mockReturnValue(api);
    mocks.mountedDockviewEntries.mockReturnValue([["desktop-a", api]]);
    mocks.storeState.layouts = { "desktop-a": { panels: { "agent:agent-a": { contentComponent: "agent", params: {} } } } };
    mocks.notifyPrefs.mockReturnValue({ enabled: true, approvalRequired: true, suppressWhenVisible: true });
    notifyAgentEvent("agent-a", "approval", "Approval needed", { eventId: `changed-${component}` });
    expect(mocks.systemNotify).toHaveBeenCalledWith("Codex · Workspace", "Approval needed", { eventId: `changed-${component}`, paneTarget: undefined });
  });

  it("delivers one native dispatch for one stable done episode", () => {
    let subscription:
      | ((
          state: {
            episodes: Record<string, number>;
            episodeKinds: Record<string, "done">;
            episodeIds: Record<string, string>;
          },
          previous: {
            episodes: Record<string, number>;
          },
        ) => void)
      | undefined;
    mocks.attentionSubscribe.mockImplementation((callback) => {
      subscription = callback;
      return () => undefined;
    });
    installAgentAttentionNotifier();

    const episodes = { "agent-a": 1 };
    subscription?.(
      {
        episodes,
        episodeKinds: { "agent-a": "done" },
        episodeIds: { "agent-a": "hmux:session-a:terminal-a:turn:1" },
      },
      { episodes: {} },
    );
    subscription?.(
      {
        episodes,
        episodeKinds: { "agent-a": "done" },
        episodeIds: { "agent-a": "hmux:session-a:terminal-a:turn:1" },
      },
      { episodes },
    );

    expect(mocks.systemNotify).toHaveBeenCalledTimes(1);
    expect(mocks.systemNotify).toHaveBeenCalledWith(
      "Codex · Workspace",
      "agents.attention.turnFinished",
      {
        eventId: "hmux:session-a:terminal-a:turn:1",
        paneTarget: {
          desktopId: "desktop-a",
          panelId: "agent:agent-a",
          windowLabel: "main",
        },
      },
    );
  });

  it("suppresses delivery when notifications are disabled", () => {
    mocks.notifyPrefs.mockReturnValue({
      enabled: false,
      agentDone: true,
      approvalRequired: true,
      agentExited: true,
      suppressWhenVisible: false,
    });

    notifyAgentEvent("agent-a", "done", "완료", {
      eventId: "hmux:session-a:terminal-a:turn:2",
    });

    expect(mocks.systemNotify).not.toHaveBeenCalled();
  });

  it("suppresses delivery while the exact pane is visible and focused", () => {
    mocks.notifyPrefs.mockReturnValue({
      enabled: true,
      agentDone: true,
      approvalRequired: true,
      agentExited: true,
      suppressWhenVisible: true,
    });

    notifyAgentEvent("agent-a", "done", "완료", {
      eventId: "hmux:session-a:terminal-a:turn:3",
    });

    expect(mocks.systemNotify).not.toHaveBeenCalled();
  });
});

describe("dispatch-spawned agents suppress only their own done notification", () => {
  // Routed through a const (not an inline literal at the assignment site) so
  // the extra field doesn't trip the mock fixture's excess-property check.
  const workflowDispatchAgent = {
    id: "agent-a",
    name: "Codex",
    projectId: "project-a",
    workflowDispatch: {
      schemaVersion: 1,
      taskId: "task-1",
      dispatchId: "dispatch-1",
      generation: 1,
    },
  };



  it("still delivers the done notification for an agent the user created (no workflowDispatch)", () => {
    // Quick-dispatched or by hand: the user's own pane. Only orchestration
    // workers (workflowDispatch) are quiet — never widen this to a spawn tag.
    mocks.storeState.agents = [{ id: "agent-a", name: "Codex", projectId: "project-a" }];

    notifyAgentEvent("agent-a", "done", "완료", { eventId: "evt-user-1" });
    expect(mocks.systemNotify).toHaveBeenCalledTimes(1);
  });

  it("drops the desktop notification for kind done when the agent carries a workflowDispatch receipt", () => {
    mocks.storeState.agents = [workflowDispatchAgent];

    notifyAgentEvent("agent-a", "done", "완료", {
      eventId: "hmux:session-a:terminal-a:turn:6",
    });

    expect(mocks.systemNotify).not.toHaveBeenCalled();
  });

  it("still delivers an approval notification when the agent carries a workflowDispatch receipt", () => {
    mocks.storeState.agents = [workflowDispatchAgent];

    notifyAgentEvent("agent-a", "approval", "승인 필요", {
      eventId: "hmux:session-a:terminal-a:turn:7",
    });

    expect(mocks.systemNotify).toHaveBeenCalledTimes(1);
  });
});
