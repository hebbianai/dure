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
    agents: [{ id: "agent-a", name: "Codex", projectId: "project-a" }] as Array<
      { id: string; name: string; projectId: string } & Record<string, unknown>
    >,
    layouts: {},
    projects: [{ id: "project-a", name: "Workspace" }],
    sessionAgentRuntimeState: {} as Record<string, unknown>,
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
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";

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
  mocks.storeState.sessionAgentRuntimeState = {};
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
    }, undefined);
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
    }, undefined);
    expect(mocks.systemNotify).not.toHaveBeenCalled();
  });

  it("names the agent by the key the phone lists it under, so a tap opens it", () => {
    mocks.storeState.agents = [
      {
        id: "agent-a",
        name: "Codex",
        projectId: "project-a",
        sessionId: "pane-session-a",
        runtimeBinding: { runtime: "hmux_managed_v1", sessionId: "managed_0123abcd" },
      },
      {
        id: "agent-chat",
        name: "Claude",
        projectId: "project-a",
        provider: "claude",
        sessionId: "pane-session-b",
        interactionProfile: { kind: "structured_protocol", backendProfileId: "local" },
      },
    ];
    notifyAgentEvent("agent-a", "approval", "Approval", { eventId: "event-a" });
    notifyAgentEvent("agent-chat", "approval", "Approval", { eventId: "event-b" });
    expect(mocks.pushAgentNotification.mock.calls).toEqual([
      [{ kind: "approval", eventId: "event-a", sessionId: "managed_0123abcd" }, undefined],
      [{ kind: "approval", eventId: "event-b", sessionId: "agent-chat" }, "claude"],
    ]);
  });

  it("names the pending approval only where the alert's two answers are both offered", () => {
    const runtime = (choices: string[]) => ({
      terminalEpoch: "7",
      lifecycle: "running",
      attention: "approval_required",
      attentionId: "attention-3",
      approvalRequest: { toolName: "Bash", summary: "git push", choices },
    });
    mocks.storeState.agents = [{
      id: "agent-a",
      name: "Codex",
      projectId: "project-a",
      sessionId: "pane-session-a",
      runtimeBinding: { runtime: "hmux_managed_v1", sessionId: "managed_0123abcd" },
    }];
    for (const [choices, kind] of [
      [["approve", "approve_always", "deny"], "approval"],
      [["approve"], "approval"],
      [["approve", "deny"], "done"],
    ] as const) {
      mocks.storeState.sessionAgentRuntimeState = { "pane-session-a": runtime([...choices]) };
      notifyAgentEvent("agent-a", kind, "Body", { eventId: `event-${kind}-${choices.length}` });
    }
    expect(mocks.pushAgentNotification.mock.calls.map(([event]) => event.approval)).toEqual([
      { attentionId: "attention-3", terminalEpoch: "7" },
      undefined,
      undefined,
    ]);
    // Identity only: what the agent asked stays on this computer.
    expect(JSON.stringify(mocks.pushAgentNotification.mock.calls)).not.toContain("git push");
  });

  it("offers a reply on a finished turn only to an idle Hmux agent, with its process and provider", () => {
    const idle = { terminalEpoch: "7", lifecycle: "running", activity: "waiting", attention: "none" };
    mocks.storeState.agents = [
      {
        id: "agent-a",
        name: "Claude",
        projectId: "project-a",
        provider: "claude",
        sessionId: "pane-session-a",
        runtimeBinding: { runtime: "hmux_managed_v1", sessionId: "managed_0123abcd" },
      },
      {
        id: "agent-chat",
        name: "Claude",
        projectId: "project-a",
        provider: "claude",
        sessionId: "pane-session-b",
        interactionProfile: { kind: "structured_protocol", backendProfileId: "local" },
      },
    ];
    for (const [agentId, kind, runtime] of [
      ["agent-a", "done", idle],
      ["agent-a", "done", { ...idle, activity: "working" }],
      ["agent-a", "input", { ...idle, attention: "input_required" }],
      ["agent-chat", "done", idle],
    ] as const) {
      mocks.storeState.sessionAgentRuntimeState = { "pane-session-a": runtime, "pane-session-b": runtime };
      notifyAgentEvent(agentId, kind, "Body", { eventId: `event-${kind}` });
    }
    expect(mocks.pushAgentNotification.mock.calls.map(([event, provider]) => [event.kind, event.reply, provider])).toEqual([
      ["done", { terminalEpoch: "7" }, "claude"],
      ["done", undefined, "claude"],
      ["input", undefined, "claude"],
      ["done", undefined, "claude"],
    ]);
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

  it.each(["done", "approval"] as const)(
    "still delivers %s for the focused pane of a Space the Work view covers",
    (kind) => {
      mocks.notifyPrefs.mockReturnValue({
        enabled: true,
        agentDone: true,
        approvalRequired: true,
        agentExited: true,
        suppressWhenVisible: true,
      });
      useWindowSidebarStore.getState().setTab("work");
      try {
        notifyAgentEvent("agent-a", kind, "Turn finished", {
          eventId: `hmux:session-a:terminal-a:${kind}:4`,
        });
      } finally {
        useWindowSidebarStore.getState().setTab("spaces");
      }
      expect(mocks.systemNotify).toHaveBeenCalledOnce();
    },
  );
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

describe("an agent another agent manages", () => {
  // A Chat coordinator, the worker it started, and the worker's own worker:
  // Run parents are the relation owner's facts (agentRelations.ts).
  const lead = { id: "lead", name: "Lead", projectId: "project-a" };
  const worker = { id: "worker", name: "Worker", projectId: "project-a", runParent: { agentId: "lead" } };
  const subWorker = { id: "sub", name: "Sub", projectId: "project-a", runParent: { agentId: "worker" } };

  beforeEach(() => {
    mocks.storeState.agents = [lead, worker, subWorker];
  });

  it("does not tell the person, on the desktop or the phone, that its turn finished", async () => {
    for (const agentId of ["worker", "sub"]) {
      expect(await notifyAgentEvent(agentId, "done", "Turn finished", { eventId: `turn-${agentId}` }))
        .toMatchObject({
          desktop: { status: "not_sent", reason: "managed_agent" },
          phone: { status: "not_sent", reason: "managed_agent" },
        });
    }
    expect(mocks.systemNotify).not.toHaveBeenCalled();
    expect(mocks.pushAgentNotification).not.toHaveBeenCalled();
  });

  it("still tells the person when only a person can go on, at any depth, and the manager's own turns", async () => {
    mocks.notifyPrefs.mockReturnValue({
      enabled: true,
      agentDone: true,
      approvalRequired: true,
      agentExited: true,
      agentMessage: true,
      suppressWhenVisible: false,
    });
    for (const kind of ["approval", "input", "exited", "message"] as const) {
      expect((await notifyAgentEvent("sub", kind, "Body", { eventId: `sub-${kind}` })).desktop)
        .toEqual({ status: "shown" });
    }
    expect((await notifyAgentEvent("lead", "done", "Turn finished", { eventId: "turn-lead" })))
      .toMatchObject({ desktop: { status: "shown" }, phone: { status: "queued" } });
    expect(mocks.pushAgentNotification.mock.calls.map(([event]) => event.kind))
      .toEqual(["approval", "input", "done"]);
  });

  it("notifies as before when the manager it names is not one of this computer's agents", async () => {
    mocks.storeState.agents = [{ ...worker, runParent: { agentId: "elsewhere" } }];
    expect(await notifyAgentEvent("worker", "done", "Turn finished", { eventId: "turn-worker" }))
      .toMatchObject({ desktop: { status: "shown" }, phone: { status: "queued" } });
  });

  it("notifies as before once the person turns finished turns of managed agents back on", async () => {
    mocks.notifyPrefs.mockReturnValue({
      enabled: true,
      agentDone: true,
      managedAgentDone: true,
      suppressWhenVisible: false,
    });
    expect(await notifyAgentEvent("sub", "done", "Turn finished", { eventId: "turn-sub" }))
      .toMatchObject({ desktop: { status: "shown" }, phone: { status: "queued" } });
  });
});

describe("an agent the person muted", () => {
  const mutedAgent = {
    id: "agent-a",
    name: "Codex",
    projectId: "project-a",
    notificationsMuted: true,
  };

  it("sends no desktop notification and no phone push for any kind", () => {
    mocks.storeState.agents = [mutedAgent];
    for (const kind of ["approval", "done", "input", "exited", "message"] as const) {
      notifyAgentEvent("agent-a", kind, "Body", { eventId: `event-${kind}` });
      notifyAgentEvent("agent-a", kind, "Body");
    }
    expect(mocks.systemNotify).not.toHaveBeenCalled();
    expect(mocks.pushAgentNotification).not.toHaveBeenCalled();
  });

  it("notifies again once unmuted, and other agents stay audible", () => {
    mocks.storeState.agents = [
      mutedAgent,
      { id: "agent-b", name: "Claude", projectId: "project-a" },
    ];
    notifyAgentEvent("agent-b", "approval", "Approval", { eventId: "event-b" });
    expect(mocks.systemNotify).toHaveBeenCalledTimes(1);
    expect(mocks.pushAgentNotification).toHaveBeenCalledTimes(1);

    mocks.storeState.agents = [{ id: "agent-a", name: "Codex", projectId: "project-a" }];
    notifyAgentEvent("agent-a", "approval", "Approval", { eventId: "event-a" });
    expect(mocks.systemNotify).toHaveBeenCalledTimes(2);
    expect(mocks.pushAgentNotification).toHaveBeenCalledTimes(2);
  });
});

describe("agent messages (dure notify)", () => {
  it("shows the message beside the agent's visible pane, with its pane target and no phone push", async () => {
    mocks.notifyPrefs.mockReturnValue({ enabled: true, agentMessage: true, suppressWhenVisible: true });
    const receipt = await notifyAgentEvent("agent-a", "message", "Build is green", { eventId: "notify:n.1" });
    expect(mocks.systemNotify).toHaveBeenCalledWith("Codex · Workspace", "Build is green", {
      eventId: "notify:n.1",
      paneTarget: { desktopId: "desktop-a", panelId: "agent:agent-a", windowLabel: "main" },
    });
    expect(mocks.pushAgentNotification).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      agent: { id: "agent-a", name: "Codex", project: "Workspace" },
      desktop: { status: "shown" },
      phone: { status: "not_sent", reason: "unsupported" },
    });
  });

  it("lets a dispatched worker's explicit message through", async () => {
    mocks.storeState.agents = [{
      id: "agent-a",
      name: "Codex",
      projectId: "project-a",
      workflowDispatch: { schemaVersion: 1, taskId: "task-1", dispatchId: "dispatch-1", generation: 1 },
    }];
    mocks.notifyPrefs.mockReturnValue({ enabled: true, agentMessage: true });
    expect((await notifyAgentEvent("agent-a", "message", "Done", { eventId: "notify:n.2" })).desktop)
      .toEqual({ status: "shown" });
  });

  it("tells the sender that the person muted this agent", async () => {
    mocks.storeState.agents = [{ id: "agent-a", name: "Codex", projectId: "project-a", notificationsMuted: true }];
    mocks.notifyPrefs.mockReturnValue({ enabled: true, agentMessage: true });
    expect(await notifyAgentEvent("agent-a", "message", "Hi", { eventId: "notify:n.6" })).toEqual({
      agent: { id: "agent-a", name: "Codex", project: "Workspace" },
      desktop: { status: "not_sent", reason: "muted" },
      phone: { status: "not_sent", reason: "muted" },
    });
    expect(mocks.systemNotify).not.toHaveBeenCalled();
  });

  it("titles a message from outside any agent without naming an agent or a pane", async () => {
    mocks.notifyPrefs.mockReturnValue({ enabled: true, agentMessage: true, suppressWhenVisible: true });
    const receipt = await notifyAgentEvent(null, "message", "Backup finished", { eventId: "notify:n.3" });
    expect(mocks.systemNotify).toHaveBeenCalledWith(
      "notifications.agentMessage.personTitle",
      "Backup finished",
      { eventId: "notify:n.3", paneTarget: undefined },
    );
    expect(receipt).toEqual({
      agent: null,
      desktop: { status: "shown" },
      phone: { status: "not_sent", reason: "no_agent" },
    });
  });

  it.each([
    { enabled: false, agentMessage: true },
    { enabled: true, agentMessage: false },
  ])("reports a disabled desktop for %o", async (prefs) => {
    mocks.notifyPrefs.mockReturnValue(prefs);
    const receipt = await notifyAgentEvent("agent-a", "message", "Hi", { eventId: "notify:n.4" });
    expect(mocks.systemNotify).not.toHaveBeenCalled();
    expect(receipt.desktop).toEqual({ status: "disabled" });
  });

  it.each([
    [{ accepted: false, reason: "permission-denied" }, { status: "permission_denied", reason: "permission-denied" }],
    [{ accepted: false, reason: "permission-not-requested" }, { status: "permission_denied", reason: "permission-not-requested" }],
    [{ accepted: false, reason: "dispatch-failed" }, { status: "failed", reason: "dispatch-failed" }],
    [{ accepted: false, reason: "backend-error" }, { status: "failed", reason: "backend-error" }],
  ])("reports the native adapter's refusal %o", async (native, desktop) => {
    mocks.notifyPrefs.mockReturnValue({ enabled: true, agentMessage: true });
    mocks.systemNotify.mockResolvedValue(native);
    expect((await notifyAgentEvent("agent-a", "message", "Hi", { eventId: "notify:n.5" })).desktop)
      .toEqual(desktop);
  });

  it("reports what the existing kinds did through the same table", async () => {
    mocks.notifyPrefs.mockReturnValue({ enabled: true, approvalRequired: true, agentExited: true, suppressWhenVisible: false });
    expect(await notifyAgentEvent("agent-a", "approval", "Approval", { eventId: "event-a" })).toMatchObject({
      desktop: { status: "shown" },
      phone: { status: "queued" },
    });
    expect((await notifyAgentEvent("agent-a", "exited", "Exited")).phone)
      .toEqual({ status: "not_sent", reason: "unsupported" });
    expect((await notifyAgentEvent("missing", "approval", "Approval", { eventId: "event-b" })).desktop)
      .toEqual({ status: "not_sent", reason: "no_agent" });
  });
});
