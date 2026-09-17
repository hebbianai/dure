// @vitest-environment jsdom
import { Profiler, useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DockviewReact,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";

vi.mock("@/lib/workspace/window/currentWindowFocus", () => ({
  currentWindowIsFocused: () => true,
  currentWindowIsInputReady: () => true,
  subscribeCurrentWindowInputReady: (listener: (ready: boolean) => void) => {
    listener(true);
    return () => {};
  },
}));

vi.mock("@/lib/ipc", () => ({
  querySessionHmux: vi.fn(async () => null),
  hmux: { listSessions: vi.fn(async () => []) },
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const clipboardMocks = vi.hoisted(() => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: clipboardMocks.writeText,
}));
const dialogMocks = vi.hoisted(() => ({ ask: vi.fn(), message: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: dialogMocks.ask,
  message: dialogMocks.message,
}));
const windowMocks = vi.hoisted(() => ({
  openAgentSessionWindow: vi.fn(),
}));
const agentRemovalMocks = vi.hoisted(() => ({
  openAgentRemovalDialog: vi.fn(),
}));
const buildRehostMocks = vi.hoisted(() => ({
  rehostManagedBuild: vi.fn(async (): Promise<void> => undefined),
}));
const refreshMocks = vi.hoisted(() => ({
  resumeExactManagedAgentPane: vi.fn(async (): Promise<void> => undefined),
}));
const permissionModeMocks = vi.hoisted(() => ({
  execute: vi.fn(async () => ({
    receipt: { targetMode: "skip_permissions" },
    presentation: "pending" as const,
  })),
  inspect: vi.fn(),
}));
const paneSignalMocks = vi.hoisted(() => ({
  requestManagedRecovery: vi.fn(),
}));
const workspaceRuntimeMocks = vi.hoisted(() => ({
  desktopId: undefined as string | undefined,
}));
const paneSplitMocks = vi.hoisted(() => ({
  openSplitTerminalPanel: vi.fn(),
  openSplitLauncherPanel: vi.fn(),
}));
vi.mock("@/lib/workspace/window/windows", () => windowMocks);
vi.mock("@/lib/agents/agentRemovalDialog", () => agentRemovalMocks);
vi.mock("@/lib/sessions/managed/managedBuildRehostWorkflow", () =>
  buildRehostMocks,
);
vi.mock("@/lib/sessions/managed/managedExactConversationResume", () => refreshMocks);
vi.mock("@/lib/sessions/managed/managedAgentRehost", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/sessions/managed/managedAgentRehost")
  >()),
  inspectManagedAgentRehost: permissionModeMocks.inspect,
}));
vi.mock(
  "@/lib/sessions/managed/managedAgentPermissionModeRelaunch",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/sessions/managed/managedAgentPermissionModeRelaunch")
    >()),
    executeManagedAgentPermissionModeRelaunch: permissionModeMocks.execute,
  }),
);
vi.mock("@/lib/workspace/pane/paneMenuSignals", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/workspace/pane/paneMenuSignals")
  >()),
  requestManagedRecovery: paneSignalMocks.requestManagedRecovery,
}));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/workspace/WorkspaceRuntimeContext")
  >()),
  useWorkspaceRuntimeDesktopId: () => workspaceRuntimeMocks.desktopId,
}));
vi.mock("@/lib/workspace/pane/paneSplit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/pane/paneSplit")>()),
  openSplitTerminalPanel: paneSplitMocks.openSplitTerminalPanel,
  openSplitLauncherPanel: paneSplitMocks.openSplitLauncherPanel,
}));

import { PaneChrome } from "@/components/workspace/PaneChrome";
import { usePaneInputFocus } from "@/components/workspace/usePaneInputFocus";
import { PaneRehostBoundary } from "@/components/workspace/PaneRehostBoundary";
import { ManagedAgentRecoveryBar } from "@/components/sessions/ManagedAgentRecoveryBar";
import { OVERFLOW_REVEAL_DELAY_MS } from "@/components/ui/overflow-reveal-text";
import { useStructuredTerminalPaneHealth } from "@/components/terminal/structured/useStructuredTerminalPaneHealth";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { installAgentAttentionWatch } from "@/lib/agents/agentAttentionWatch";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { publishConversationTitle } from "@/lib/agents/chat/conversationPresentationState";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { beginManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import {
  clearSpacesPaneHover,
  setSpacesPaneHover,
  spacesPaneHoverKey,
} from "@/lib/spaces/spacesPaneHover";
import { publishTerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocationStore";
import {
  clearHmuxPaneHealth,
  getHmuxPaneHealth,
  publishHmuxPaneHealthObservation,
} from "@/lib/terminal/hmuxPaneHealthStore";
import {
  invokePaneAction,
  paneActionSnapshot,
  registerPaneActions,
} from "@/lib/workspace/pane/paneActionRegistry";
import {
  hmuxLocalBinding,
  hmuxManagedBinding,
  remoteHmuxManagedBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { HmuxPaneHealth } from "@/lib/terminal/terminalHealth";
import { t } from "@/lib/i18n";
import { shareFileAtPointer } from "@/lib/platform/share";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import { useStore } from "@/store";
import { agentFixture, hmuxSessionMetadataFixture, stopFenceFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";
import { hoverHint } from "@/test/tooltip";

vi.mock("@/lib/platform/share", () => ({ shareFileAtPointer: vi.fn() }));

const legacySshBinding = (sessionId: string, hostId: string) =>
  ({
    schemaVersion: 1,
    runtime: "legacy_ssh_session_v1",
    source: "ssh",
    hostId,
    sessionId,
  }) as unknown as TerminalPaneBindingV1;

function paneProps(
  id: string,
  params: Record<string, unknown>,
  component = id.startsWith("agent:") ? "agent" : id.startsWith("ssh:") ? "ssh" : "terminal",
): IDockviewPanelHeaderProps {
  return {
    api: {
      id,
      component,
      title: id,
      isGroupActive: true,
      close: vi.fn(),
      onDidActiveGroupChange: () => ({ dispose() {} }),
      onDidTitleChange: () => ({ dispose() {} }),
    },
    containerApi: {},
    params,
  } as unknown as IDockviewPanelHeaderProps;
}

/** Builds an Agent fixture; unspecified fields follow id-derived defaults. */
function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  const { id } = overrides;
  return agentFixture({
    name: id,
    worktreePath: `/repo/.worktrees/${id}`,
    branch: id,
    sessionId: `${id}-session`,
    ...overrides,
  });
}

/** Local managed Agent shared by the rehost workflow tests. */
function localRehostAgent(
  binding: NonNullable<Agent["runtimeBinding"]> & { sessionId: string },
  overrides: Partial<Agent> = {},
): Agent {
  return makeAgent({
    id: "local-agent",
    worktreePath: "/repo",
    branch: "main",
    sessionId: binding.sessionId,
    conversationId: "conversation-1",
    runtimeBinding: binding,
    ...overrides,
  });
}

/** Remote SSH managed Agent shared by the rehost workflow tests. */
function remoteRehostAgent(
  binding: NonNullable<Agent["runtimeBinding"]> & { sessionId: string },
): Agent {
  return makeAgent({
    id: "remote-agent",
    projectId: "project-remote",
    worktreePath: "/srv/repo",
    branch: "main",
    sessionId: binding.sessionId,
    sessionKind: "ssh",
    conversationId: "conversation-1",
    runtimeBinding: binding,
  });
}

function localProject(id: string, name: string, path: string) {
  return { id, name, path, kind: "local" as const, isRepo: true };
}

/** Minimal legacy standalone binding — intentionally no schemaVersion/source/hostId. */
function bareStandaloneBinding(sessionId: string, workspaceId: string) {
  return { runtime: "hmux_standalone_v1", sessionId, workspaceId };
}

function renderPane(id: string, params: Record<string, unknown>) {
  return render(<><PaneChrome {...paneProps(id, params)} /><PaneRehostBoundary paneId={id}><div data-testid="retained-pane" /></PaneRehostBoundary></>);
}

function renderAgentPane(agent: Agent, params: Record<string, unknown> = {}) {
  return renderPane(`agent:${agent.id}`, { agentRef: { agentId: agent.id }, ...params });
}

const testPaneHealthIds = new Set<string>();

function clearTestPaneHealth(): void {
  for (const paneHealthId of testPaneHealthIds) {
    clearHmuxPaneHealth(paneHealthId);
  }
  testPaneHealthIds.clear();
}

function seedTestPaneHealth(
  paneHealthId: string,
  health: HmuxPaneHealth,
): void {
  clearHmuxPaneHealth(paneHealthId);
  testPaneHealthIds.add(paneHealthId);
  const publish = (
    observation: Parameters<typeof publishHmuxPaneHealthObservation>[1],
  ) =>
    publishHmuxPaneHealthObservation(paneHealthId, observation, health.updatedAt);
  const terminalEpoch =
    health.terminalEpoch ??
    (health.receivedSequence || health.presentedSequence
      ? "test-terminal-epoch"
      : undefined);
  if (terminalEpoch) {
    publish({
      kind: "frame_received",
      terminalEpoch,
      sequence: health.receivedSequence ?? health.presentedSequence ?? "0",
    });
    if (health.presentedSequence) {
      publish({
        kind: "frame_presented",
        terminalEpoch,
        sequence: health.presentedSequence,
      });
    }
  }
  if (
    health.state === "connecting" ||
    health.state === "recovering" ||
    health.state === "error"
  ) {
    publish({
      kind: "connection",
      state: health.state,
      reason: health.reason,
    });
  }
}

/** Opens the pane dropdown menu through its trigger button. */
function openPaneMenu() {
  fireEvent.pointerDown(screen.getByLabelText("Pane 메뉴"), {
    button: 0,
    ctrlKey: false,
  });
}

/** Opens the pane menu and resolves its rehost menu item. */
async function findRehostMenuItem() {
  openPaneMenu();
  return await screen.findByRole("menuitem", { name: "현재 빌드로 재호스트" });
}

beforeEach(() => {
  clearTestPaneHealth();
  // Default to Pro for promotion and other advanced controls.
  useStore.setState((state) => ({
    uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const },
  }));
  workspaceRuntimeMocks.desktopId = undefined;
  paneSplitMocks.openSplitTerminalPanel.mockClear();
  paneSplitMocks.openSplitLauncherPanel.mockClear();
  clipboardMocks.writeText.mockResolvedValue(undefined);
  dialogMocks.ask.mockResolvedValue(true);
  clearSpacesPaneHover();
  useAgentAttention.setState({
    displayStates: {},
    episodes: {},
    acks: {},
  });
  useStore.setState({
    agents: [],
    agentActivity: {},
    hmuxSessionMetadata: {},
    sessionTitle: {},
    sessionCwd: {},
    sessionAgent: {},
    sessionAgentPin: {},
    sessionAgentRuntimeState: {},
    projects: [],
  });
});

afterEach(() => {
  cleanup();
  clearTestPaneHealth();
  clearSpacesPaneHover();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** A running Host snapshot with the given activity, for terminal pane rows. */
const terminalRuntime = (activity: "working" | "waiting") => ({
  terminalEpoch: "epoch-1",
  revision: "1",
  observedThroughOutputSeq: "1",
  lifecycle: "running" as const,
  activity,
  attention: "none" as const,
  source: "process_lifecycle" as const,
});

describe("PaneChrome", () => {
  it("updates file actions when Dockview replaces content in the same historical slot", async () => {
    workspaceRuntimeMocks.desktopId = "file-space";
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    let dock!: DockviewApi;
    try {
      render(<DockviewReact components={{ fileviewer: () => null, terminal: () => null }} defaultTabComponent={PaneChrome} onReady={({ api }) => { dock = api; }} />);
      act(() => {
        dock.layout(900, 600);
        dock.addPanel({ id: "file:historical", component: "fileviewer", params: { path: "/before", source: "local" } });
      });
      openPaneMenu();
      fireEvent.click(await screen.findByRole("menuitem", { name: t("common.share") }));
      expect(shareFileAtPointer).toHaveBeenLastCalledWith("/before");
      act(() => {
        addPanePreservingSizes(dock, { id: "unused-new-id", component: "terminal", params: { path: "/before", source: "local" }, replacement: dock.getPanel("file:historical")!.api });
      });
      openPaneMenu();
      await screen.findByRole("menu");
      expect(screen.queryByRole("menuitem", { name: (name) => name.startsWith(t("workspace.paneMenu.hide")) })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: t("common.share") })).toBeNull();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      act(() => {
        addPanePreservingSizes(dock, { id: "another-unused-id", component: "fileviewer", params: { path: "/after", source: "local" }, replacement: dock.getPanel("file:historical")!.api });
      });
      openPaneMenu();
      fireEvent.click(await screen.findByRole("menuitem", { name: t("common.share") }));
      expect(shareFileAtPointer).toHaveBeenLastCalledWith("/after");
      expect(shareFileAtPointer).toHaveBeenCalledTimes(2);
      expect(dock.panels.map((pane) => pane.id)).toEqual(["file:historical"]);
    } finally {
      platform.mockRestore();
    }
  });

  it.each(["pane-file-view", "agent:previous", "file:historical"])(
    "offers file actions for the current file content in %s",
    async (id) => {
      workspaceRuntimeMocks.desktopId = "file-space";
      const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      try {
        render(<PaneChrome {...paneProps(id, { path: "/repo/current.txt", source: "local" }, "fileviewer")} />);
        openPaneMenu();
        expect(await screen.findByRole("menuitem", { name: (name) => name.startsWith(t("workspace.paneMenu.hide")) })).toBeTruthy();
        fireEvent.click(screen.getByRole("menuitem", { name: t("common.share") }));
        expect(shareFileAtPointer).toHaveBeenCalledExactlyOnceWith("/repo/current.txt");
      } finally {
        platform.mockRestore();
      }
    },
  );

  it.each([
    { component: "terminal", params: { path: "/repo/old.txt", source: "local" } },
    { component: "fileviewer", params: { path: "/repo/old.txt", source: "unknown" } },
    { component: "fileviewer", params: { path: "/repo/old.txt", source: "local", hostId: 7 } },
  ])("does not infer file actions from a historical ID with $component content and $params", async ({ component, params }) => {
    workspaceRuntimeMocks.desktopId = "file-space";
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      render(<PaneChrome {...paneProps("file:historical", params, component)} />);
      openPaneMenu();
      await screen.findByRole("menu");
      expect(screen.queryByRole("menuitem", { name: (name) => name.startsWith(t("workspace.paneMenu.hide")) })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: t("common.share") })).toBeNull();
      expect(shareFileAtPointer).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });

  it.each(["slot", "agent:previous", "launcher:previous"])(
    "follows current Agent content in the same Dockview header %s",
    async (id) => {
      const current = makeAgent({ id: "current", displayName: "Current Agent" });
      const other = makeAgent({ id: "other", displayName: "Other Agent" });
      useStore.setState({ agents: [current, other, makeAgent({ id: "previous", displayName: "Previous Agent" })] });
      let dock!: DockviewApi;
      const view = render(<DockviewReact components={{ agent: () => null }} defaultTabComponent={PaneChrome} onReady={({ api }) => { dock = api; }} />);
      act(() => {
        dock.layout(900, 600);
        dock.addPanel({ id, component: "agent", params: { agentRef: { agentId: current.id } } });
      });
      const panel = dock.getPanel(id)!;
      const title = () => panel.group.element.querySelector("[data-pane-title]")?.textContent;
      await waitFor(() => expect(title()).toBe("Current Agent"));
      act(() => panel.api.updateParameters({ agentRef: { agentId: other.id } }));
      await waitFor(() => expect(title()).toBe("Other Agent"));
      expect(dock.getPanel(id)).toBe(panel);
      act(() => panel.api.updateParameters({ agentRef: null }));
      await waitFor(() => expect(title()).not.toBe("Other Agent"));
      expect(title()).not.toBe("Previous Agent");
      expect(dock.getPanel(id)).toBe(panel);
      view.unmount();
    },
  );
  it("hands a header click to its input without stealing toolbar focus", async () => {
    function Content({ api }: IDockviewPanelProps) {
      const inputRef = useRef<HTMLTextAreaElement>(null);
      usePaneInputFocus({ paneApi: api, inputRef, inputReady: true });
      return <textarea ref={inputRef} aria-label={`${api.id} input`} />;
    }
    let dock!: DockviewApi;
    render(
      <DockviewReact
        components={{ content: Content }}
        defaultTabComponent={PaneChrome}
        onReady={({ api }) => { dock = api; }}
      />,
    );
    act(() => {
      dock.layout(800, 500);
      dock.addPanel({ id: "term:click-left", component: "content" });
      dock.addPanel({
        id: "term:click-right", component: "content",
        position: { referencePanel: "term:click-left", direction: "right" },
      });
    });
    const left = dock.getPanel("term:click-left")!;
    const input = await screen.findByRole("textbox", { name: "term:click-left input" });
    const otherInput = screen.getByRole("textbox", { name: "term:click-right input" });
    const title = left.group.element.querySelector<HTMLElement>("[data-pane-title]")!;
    const tab = title.closest<HTMLElement>("[role='tab']")!;
    otherInput.focus();
    fireEvent.pointerDown(title, { button: 0 });
    // WebKit's native tab press focuses the tab before React receives click.
    tab.focus();
    fireEvent.click(title);
    expect(dock.activePanel?.id).toBe(left.id);
    expect(document.activeElement).toBe(input);

    const toolbarButton = left.group.element.querySelector<HTMLButtonElement>(
      ".pane-chrome button[aria-haspopup='menu']",
    )!;
    expect(toolbarButton).not.toBeNull();
    toolbarButton.focus();
    fireEvent.click(toolbarButton);
    expect(document.activeElement).not.toBe(input);
  });

  it("follows Host agent identity through the canonical pane binding", () => {
    const sessionId = "term-runtime-agent";
    const binding = hmuxManagedBinding(sessionId, "dure-local-shells-v1");
    const { container } = renderPane(`term:${sessionId}`, {
      binding,
      cwd: "/repo/.worktrees/uiux-test-claude",
    });
    const pane = container.querySelector(".pane-chrome");

    act(() => {
      useStore.setState({ sessionAgent: { [sessionId]: "claude" } });
    });
    expect(screen.getByText("Claude Code · uiux-test-claude")).toBeTruthy();
    expect(container.querySelector(".pane-chrome")).toBe(pane);

    act(() => {
      useStore.setState({ sessionAgent: { [sessionId]: null } });
    });
    expect(screen.queryByText("Claude Code · uiux-test-claude")).toBeNull();
    expect(screen.getByText(`term:${sessionId}`)).toBeTruthy();
    expect(container.querySelector(".pane-chrome")).toBe(pane);
  });

  it("keeps responsive action tiers out of the JavaScript resize hot path", () => {
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = observe;
        disconnect() {}
        unobserve() {}
      },
    );

    const { container } = renderPane("term:resize", { sessionId: "resize" });

    expect(observe).not.toHaveBeenCalled();
    expect(container.querySelector(".pane-chrome")?.classList).toContain(
      "@container/pane-chrome",
    );
  });

  it.each(["basic", "pro"] as const)(
    "opens the Hmux agent large-session view in %s mode",
    (interfaceMode) => {
      useStore.setState((state) => ({
        uiPrefs: { ...state.uiPrefs, interfaceMode },
      }));
      const binding = hmuxManagedBinding("session-1", "workspace-1");
      const agent = makeAgent({
        id: "large-session",
        displayName: "UI polish",
        sessionId: "session-1",
        runtimeBinding: binding,
      });
      useStore.setState({ agents: [agent] });
      renderAgentPane(agent, { binding, sessionId: agent.sessionId });

      const expand = screen.getByRole("button", { name: /Codex/ });
      fireEvent.click(expand);
      expect(windowMocks.openAgentSessionWindow).toHaveBeenCalledWith(
        agent.id,
        "UI polish",
        "detached:agent:large-session",
      );
    },
  );

  it.each([false, true])("projects active=%s onto the large-session action", (isGroupActive) => {
    const binding = hmuxManagedBinding("session-hover", "workspace-hover");
    const agent = makeAgent({
      id: "large-session-hover",
      sessionId: "session-hover",
      runtimeBinding: binding,
    });
    useStore.setState({ agents: [agent] });
    const props = paneProps(`agent:${agent.id}`, {
      agentRef: { agentId: agent.id },
      agentId: agent.id,
      binding,
      sessionId: agent.sessionId,
    });
    Object.assign(props.api, { isGroupActive });
    render(<PaneChrome {...props} />);

    const expand = screen.getByRole("button", { name: /Codex/ });
    expect(expand.hasAttribute("data-pane-window-action-active")).toBe(isGroupActive);
  });

  it("prefers the resolved attention state over stale heuristic activity", () => {
    const agent = makeAgent({ id: "pixel", provider: "claude" });
    useStore.setState({
      agents: [agent],
      agentActivity: { [agent.id]: "working" },
    });
    useAgentAttention.setState({
      displayStates: { [agent.id]: "blocked" },
      episodes: { [agent.id]: 1 },
      acks: { [agent.id]: 0 },
    });

    const { container } = renderAgentPane(agent);

    expect(container.querySelector(".bg-status-blocked")).toBeTruthy();
    expect(container.querySelector(".bg-status-run")).toBeNull();
  });

  it("keeps an exact managed Host working state across hydration and a stale exit", () => {
    const sessionId = "managed-live-session";
    const workspaceId = "managed-live-workspace";
    const binding = hmuxManagedBinding(sessionId, workspaceId);
    const agent = makeAgent({
      id: "managed-live-agent",
      branch: "agent/managed-live-agent",
      sessionId,
      runtimeBinding: binding,
    });
    useStore.setState({
      agents: [agent],
      agentActivity: {},
      hmuxSessionMetadata: {
        [hmuxSessionMetadataKey(workspaceId, sessionId)]: {
          sessionId,
          workspaceId,
          sessionClass: "managed",
          lifecycle: "ready",
          manifestLifecycle: "ready",
          health: "current_healthy",
          inputAllowed: true,
          hostProcessAlive: true,
          terminalEpoch: "terminal-live",
          outputSeq: "9",
          capabilities: [],
        },
      },
      sessionAgentRuntimeState: {
        [sessionId]: {
          terminalEpoch: "terminal-live",
          revision: "9",
          observedThroughOutputSeq: "9",
          lifecycle: "running",
          activity: "working",
          attention: "none",
          source: "provider_event",
        },
      },
    });
    const stopWatch = installAgentAttentionWatch();
    try {
      const { container } = renderAgentPane(agent, { binding });

      // Working shows as the loader in the glyph slot, not as a dot after the
      // label (owner decision 2026-09-03) — and the logo yields the slot.
      expect(container.querySelector(".dure-loader")).toBeTruthy();
      expect(container.querySelector(".bg-status-warn")).toBeNull();

      act(() => useStore.getState().setAgentActivity(agent.id, "working"));
      act(() => useStore.getState().setAgentActivity(agent.id, "exited"));
      expect(container.querySelector(".dure-loader")).toBeTruthy();

      act(() =>
        useStore.getState().setSessionAgentRuntimeState(sessionId, {
          terminalEpoch: "terminal-live",
          revision: "10",
          observedThroughOutputSeq: "9",
          lifecycle: "exited",
          activity: "waiting",
          attention: "none",
          source: "process_lifecycle",
        }),
      );
      expect(screen.getAllByLabelText("종료됨")).not.toHaveLength(0);
      expect(container.querySelector(".dure-loader")).toBeNull();
      expect(container.querySelector(".bg-status-warn")).toBeNull();
    } finally {
      stopWatch();
    }
  });

  it("keeps an alive managed Host waiting until semantic activity arrives", () => {
    const sessionId = "managed-live-without-semantic-state";
    const workspaceId = "managed-live-workspace";
    const stopFence = {
      runnerPrincipal: "local-user",
      runnerInstance: "runner-live",
      channelEpoch: "1",
      hostInstanceId: "host-live",
      terminalEpoch: "terminal-live",
    };
    const binding = hmuxManagedBinding(
      sessionId,
      workspaceId,
      undefined,
      undefined,
      stopFence,
    );
    const agent = makeAgent({
      id: "managed-live-without-semantic-state-agent",
      branch: "agent/managed-live-without-semantic-state-agent",
      sessionId,
      runtimeBinding: binding,
    });
    const liveSession: HmuxSessionSummary = {
      sessionId,
      workspaceId,
      sessionClass: "managed",
      lifecycle: "ready",
      manifestLifecycle: "ready",
      health: "current_healthy",
      inputAllowed: true,
      hostProcessAlive: true,
      terminalEpoch: stopFence.terminalEpoch,
      stopFence,
      outputSeq: "0",
      capabilities: [],
    };
    useStore.setState({
      agents: [agent],
      agentActivity: { [agent.id]: "connecting" },
      hmuxSessionMetadata: {
        [hmuxSessionMetadataKey(workspaceId, sessionId)]: liveSession,
      },
      sessionAgentRuntimeState: {},
    });
    const stopWatch = installAgentAttentionWatch();
    try {
      const { container } = renderAgentPane(agent, { binding });

      // No working claim without semantic evidence: no loader in the slot,
      // and waiting is the ordinary resting state, so no badge either
      // (owner decision 2026-09-03).
      expect(container.querySelector(".dure-loader")).toBeNull();
      expect(screen.queryByLabelText("응답 대기")).toBeNull();
      expect(container.querySelector(".bg-status-warn")).toBeNull();

      act(() => useStore.getState().setAgentActivity(agent.id, "exited"));
      expect(container.querySelector(".dure-loader")).toBeNull();
      expect(screen.queryByLabelText("응답 대기")).toBeNull();
      expect(container.querySelector(".bg-status-warn")).toBeNull();

      act(() =>
        useStore.getState().setHmuxSessionMetadata({
          ...liveSession,
          lifecycle: "exited",
          manifestLifecycle: "exited",
          health: "exited",
          hostProcessAlive: false,
        }),
      );
      expect(screen.getAllByLabelText("종료됨")).not.toHaveLength(0);
      expect(container.querySelector(".bg-status-warn")).toBeNull();
    } finally {
      stopWatch();
    }
  });

  it("renders ordinary input_required as blue input waiting, not red blocked", () => {
    const agent = makeAgent({ id: "task-tracking" });
    useStore.setState({
      agents: [agent],
      agentActivity: { [agent.id]: "waiting" },
    });
    useAgentAttention.setState({
      displayStates: { [agent.id]: "input" },
      episodes: { [agent.id]: 1 },
      acks: { [agent.id]: 0 },
    });

    const { container } = renderAgentPane(agent);

    // The state badge on the glyph carries the title once; the former
    // wrapper span that repeated it went with the trailing dot (2026-09-03).
    expect(screen.getAllByLabelText("입력 대기")).toHaveLength(1);
    expect(container.querySelector(".bg-status-done")).toBeTruthy();
    expect(container.querySelector(".bg-status-blocked")).toBeNull();
  });

  it("offers agent deletion from an agent pane menu and opens its confirmation", async () => {
    const agent = makeAgent({ id: "delete-me", sessionId: "delete-session" });
    useStore.setState({
      agents: [agent],
      agentActivity: { [agent.id]: "waiting" },
      projects: [localProject("project-1", "Project", "/repo")],
    });
    renderAgentPane(agent);

    openPaneMenu();
    const remove = await screen.findByRole("menuitem", { name: /에이전트 삭제/ });
    expect(remove.getAttribute("data-variant")).toBe("destructive");
    expect(remove.textContent).toContain("워크트리 삭제 선택 가능");
    fireEvent.click(remove);

    await waitFor(() =>
      expect(agentRemovalMocks.openAgentRemovalDialog).toHaveBeenCalledWith(agent),
    );
  });

  it("does not offer agent deletion from a terminal pane menu", async () => {
    renderPane("term:shell", { sessionId: "shell", cwd: "/repo" });

    openPaneMenu();
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "에이전트 삭제" })).toBeNull();
  });

  it("opens detailed pane information from the pane menu", async () => {
    const binding = hmuxManagedBinding("session-info", "workspace-info");
    const agent = makeAgent({
      id: "pane-info",
      displayName: "Pane diagnostics",
      projectId: "project-info",
      branch: "agent/pane-info",
      sessionId: "session-info",
      runtimeBinding: binding,
      conversationId: "conversation-info",
    });
    useStore.setState({
      agents: [agent],
      projects: [localProject("project-info", "HebbianIDE", "/repo")],
      hmuxSessionMetadata: hmuxSessionMetadataFixture({
        sessionId: "session-info",
        sessionName: "hmux-info",
        workspaceId: "workspace-info",
        hostBuildVersion: "2026.08.09",
        terminalEpoch: "epoch-info",
        outputSeq: "42",
        capabilities: ["terminal_io_v1"],
      }),
    });
    seedTestPaneHealth("detached:agent:pane-info", {
      state: "live",
      terminalEpoch: "epoch-info",
      receivedSequence: "42",
      presentedSequence: "42",
      updatedAt: 1_754_729_600_000,
    });
    renderAgentPane(agent);

    openPaneMenu();
    expect(
      await screen.findByRole("menuitem", { name: "최근 작업" }),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Host ID 복사" }),
    );
    await waitFor(() =>
      expect(clipboardMocks.writeText).toHaveBeenCalledWith("local"),
    );

    openPaneMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Pane 정보…" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Pane 정보" });
    expect(dialog.textContent).toContain("agent:pane-info");
    expect(dialog.textContent).toContain("/repo/.worktrees/pane-info");
    expect(dialog.textContent).toContain("session-info");
    expect(dialog.textContent).toContain("workspace-info");
    expect(dialog.textContent).toContain("Space ID");
    expect(dialog.textContent).not.toContain("Desktop ID");
    expect(dialog.textContent).toContain("현재 · 정상");
    expect(dialog.textContent).toContain("epoch-info");
    expect(
      screen.getByRole("button", { name: "수신 seq 복사" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "표시 seq 복사" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "수신 seq 복사" }));
    await waitFor(() =>
      expect(clipboardMocks.writeText).toHaveBeenLastCalledWith("42"),
    );
    fireEvent.click(screen.getByRole("button", { name: "표시 seq 복사" }));
    await waitFor(() =>
      expect(clipboardMocks.writeText).toHaveBeenLastCalledWith("42"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Host 상태 복사" }));
    await waitFor(() =>
      expect(clipboardMocks.writeText).toHaveBeenCalledWith("현재 · 정상"),
    );
    expect(screen.getByRole("status").textContent).toBe("클립보드에 복사됨");

    clipboardMocks.writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "Workspace ID 복사" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "클립보드에 복사하지 못했습니다",
      ),
    );
    expect(clipboardMocks.writeText).toHaveBeenLastCalledWith("workspace-info");
  });

  it("splits an SSH Agent from the live Agent authority with empty params", () => {
    workspaceRuntimeMocks.desktopId = "space-remote";
    const binding = remoteHmuxManagedBinding(
      "remote-session",
      "remote-workspace",
      "host-current",
      "bridge-current",
    );
    const agent = remoteRehostAgent(binding);
    useStore.setState({
      agents: [agent],
      projects: [
        {
          id: agent.projectId,
          name: "Remote",
          path: "/srv/repo",
          kind: "ssh",
          isRepo: true,
          sshHostId: "host-current",
        },
      ],
      sessionCwd: { [agent.sessionId]: "/srv/repo/live" },
    });
    renderAgentPane(agent);

    fireEvent.click(screen.getByLabelText("오른쪽으로 분할"));

    expect(paneSplitMocks.openSplitLauncherPanel).toHaveBeenCalledWith(
      "space-remote",
      {
        kind: "ssh",
        hostId: "host-current",
        cwd: "/srv/repo/live",
      },
      { referencePanel: `agent:${agent.id}`, direction: "right" },
    );
    expect(paneSplitMocks.openSplitTerminalPanel).not.toHaveBeenCalled();
  });

  it("closes a canonical Agent pane with empty params", async () => {
    const binding = hmuxManagedBinding("close-session", "close-workspace");
    const agent = localRehostAgent(binding);
    useStore.setState({
      agents: [agent],
      projects: [localProject(agent.projectId, "Project", "/repo")],
    });
    const props = paneProps(`agent:${agent.id}`, {});
    render(<PaneChrome {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));

    await waitFor(() => expect(props.api.close).toHaveBeenCalledOnce());
  });

  it("renders one pane action model from the menu button and tab right-click", async () => {
    const { container } = renderPane("term:shared-menu", {
      sessionId: "shared-menu",
      cwd: "/repo",
    });

    openPaneMenu();
    const dropdown = await screen.findByRole("menu");
    const dropdownLabels = Array.from(
      dropdown.querySelectorAll<HTMLElement>("[role='menuitem']"),
      (item) => item.textContent,
    );
    // 정체 관련 순서: 이름 변경 → 정보 → 고정. 이 fixture는 desktop이 없어 분할 섹션이
    // 아예 만들어지지 않으므로 두 표면이 그대로 같다(→ PaneActionMenu.test).
    expect(dropdownLabels).toEqual([
      "Pane 제목 변경…",
      "Pane 정보…",
      "Pane ID 복사",
      "Pane 고정",
      "닫기",
    ]);

    fireEvent.keyDown(dropdown, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    const chrome = container.querySelector<HTMLElement>(".pane-chrome");
    expect(chrome).toBeTruthy();
    fireEvent.contextMenu(chrome as HTMLElement, { clientX: 40, clientY: 20 });
    const contextMenu = await screen.findByRole("menu");
    const contextLabels = Array.from(
      contextMenu.querySelectorAll<HTMLElement>("[role='menuitem']"),
      (item) => item.textContent,
    );
    expect(contextLabels).toEqual(dropdownLabels);
  });

  it("dismisses the pane dropdown after one outside pointer interaction", async () => {
    const outsideAction = vi.fn();
    render(
      <>
        <button type="button" onClick={outsideAction}>
          Outside action
        </button>
        <PaneChrome
          {...paneProps("term:outside-dismiss", {
            sessionId: "outside-dismiss",
            cwd: "/repo",
          })}
        />
      </>,
    );

    openPaneMenu();
    await screen.findByRole("menu");
    expect(document.body.style.pointerEvents).not.toBe("none");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside action" }));
    fireEvent.click(screen.getByRole("button", { name: "Outside action" }));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(outsideAction).toHaveBeenCalledOnce();
  });

  it("copies the host ID and pane ID from the pane menu", async () => {
    renderPane("ssh:copy-pane", {
      binding: legacySshBinding("session-copy-id", "ssh-host-id"),
      cwd: "/repo",
    });

    openPaneMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Host ID 복사" }),
    );
    await waitFor(() =>
      expect(clipboardMocks.writeText).toHaveBeenCalledWith("ssh-host-id"),
    );

    openPaneMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Pane ID 복사" }),
    );
    await waitFor(() =>
      expect(clipboardMocks.writeText).toHaveBeenLastCalledWith("ssh:copy-pane"),
    );
  });

  it("marks only the exact pane published by Spaces hover", () => {
    setSpacesPaneHover(spacesPaneHoverKey("detached", "term:hovered"));
    const { container } = render(
      <>
        <section className="dv-groupview">
          <PaneChrome
            {...paneProps("term:hovered", {
              sessionId: "hovered",
              cwd: "/repo",
            })}
          />
        </section>
        <section className="dv-groupview">
          <PaneChrome
            {...paneProps("term:other", {
              sessionId: "other",
              cwd: "/repo",
            })}
          />
        </section>
      </>,
    );

    const groups = container.querySelectorAll(".dv-groupview");
    expect(groups[0]?.hasAttribute("data-spaces-pane-hovered")).toBe(true);
    expect(groups[1]?.hasAttribute("data-spaces-pane-hovered")).toBe(false);
  });

  it("renders a legacy terminal pane with its session title", () => {
    useStore.setState({
      sessionTitle: { "sess-1": "zsh" },
      sessionCwd: { "sess-1": "/repo" },
    });
    renderPane("term:sess-1", { sessionId: "sess-1", cwd: "/repo" });
    expect(screen.getByText("zsh")).toBeTruthy();
  });

  it("updates a native Agent pane from its live terminal title without remounting", () => {
    const binding = hmuxManagedBinding("session-title", "workspace-title");
    const agent = makeAgent({
      id: "terminal-title-agent",
      sessionId: "session-title",
      runtimeBinding: binding,
    });
    useStore.setState({ agents: [agent] });
    const { container } = renderAgentPane(agent, { binding });
    const pane = container.querySelector(".pane-chrome");

    act(() => {
      useStore.setState({
        sessionTitle: { "session-title": "Review authentication flow" },
      });
    });

    expect(screen.getByText("Review authentication flow")).toBeTruthy();
    expect(container.querySelector(".pane-chrome")).toBe(pane);
  });

  it("uses a structured conversation title as the pane's primary name", () => {
    const agent = makeAgent({
      id: "structured-title-agent",
      interactionProfile: {
        schemaVersion: 1,
        kind: "structured_protocol",
        backendProfileId: "local",
        interactionSessionId: "interaction-title",
      },
    });
    useStore.setState({ agents: [agent] });

    const { container } = renderAgentPane(agent);
    const pane = container.querySelector(".pane-chrome");
    expect(container.querySelector("[data-pane-title]")?.textContent).toBe(
      "structured-title-agent",
    );

    act(() => {
      publishConversationTitle(agent.id, "✻ Review authentication flow");
    });

    expect(container.querySelector("[data-pane-title]")?.textContent).toBe(
      "Review authentication flow",
    );
    expect(container.querySelector("[data-pane-conversation-title]")).toBeNull();
    expect(container.querySelector("[data-pane-agent-identity]")).toBeNull();
    expect(
      container.querySelector("[data-pane-title]")?.getAttribute("title"),
    ).toContain("Review authentication flow");

    act(() => {
      useStore.setState({ agents: [{ ...agent, displayName: "fix-uiux" }] });
    });
    expect(container.querySelector("[data-pane-title]")?.textContent).toBe(
      "fix-uiux",
    );
    expect(container.querySelector(".pane-chrome")).toBe(pane);
  });

  it("uses a native provider conversation title as the pane's primary name", () => {
    const binding = hmuxManagedBinding("session-native-title", "workspace-native-title");
    const agent = makeAgent({
      id: "native-conversation-title-agent",
      name: "codex-10",
      displayName: "codex-10",
      sessionId: "session-native-title",
      conversationId: "thread-native-title",
      runtimeBinding: binding,
    });
    useStore.setState({ agents: [agent] });
    const { container } = renderAgentPane(agent, { binding });

    act(() => {
      publishConversationTitle(agent.id, "clean code");
    });

    expect(container.querySelector("[data-pane-title]")?.textContent).toBe(
      "clean code",
    );
  });

  it("reveals a clipped pane title only after a deliberate hover", () => {
    vi.useFakeTimers();
    try {
      const title = "a deliberately long Agent display name";
      const agent = makeAgent({ id: "long-title-agent", displayName: title });
      useStore.setState({ agents: [agent] });
      const { container } = renderAgentPane(agent);
      const content = screen.getByText(title);
      const viewport = container.querySelector("[data-pane-title]");
      expect(viewport).toBeTruthy();
      Object.defineProperty(viewport, "clientWidth", {
        configurable: true,
        value: 100,
      });
      Object.defineProperty(content, "scrollWidth", {
        configurable: true,
        value: 240,
      });

      fireEvent.pointerEnter(viewport as Element, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(OVERFLOW_REVEAL_DELAY_MS - 1));
      expect(content.style.transform).not.toContain("-140px");

      act(() => vi.advanceTimersByTime(1));
      expect(content.style.transform).toContain("-140px");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("shows a nested SSH target without exposing the local cwd", () => {
    const sessionId = "workspace-6-pane-3";
    useStore.setState({
      sessionTitle: { [sessionId]: "local" },
      sessionCwd: { [sessionId]: "/Users/jwan" },
    });
    act(() =>
      publishTerminalExecutionLocation(sessionId, {
        kind: "ssh",
        target: "rts@211.181.122.124",
      }),
    );

    const { container } = renderPane(`term:${sessionId}`, {
      sessionId,
      cwd: "/Users/jwan",
    });

    expect(screen.getByText("rts@211.181.122.124")).toBeTruthy();
    // 진단 툴팁은 바 전체가 아니라 제목 텍스트에 붙는다 — 바 hover는
    // 버튼이 우선(2026-08-01).
    expect(
      container.querySelector(".pane-chrome span[title]")?.getAttribute("title"),
    ).toBe("rts@211.181.122.124");
    expect(container.textContent).not.toContain("/Users/jwan");
    act(() =>
      publishTerminalExecutionLocation(sessionId, {
        kind: "local",
      }),
    );
  });

  it("shows hmux session name and host build in the badge (다중 빌드 가시화 회귀)", async () => {
    const workspaceId = "ws-1";
    const sessionId = "standalone_abc";
    useStore.setState({
      // 배지는 하드 문제(error/stale)에서만 드러난다 — 진단 내용(빌드 버전 등)은
      // 그때 그대로 보여야 한다.
      hmuxSessionMetadata: {
        [hmuxSessionMetadataKey(workspaceId, sessionId)]: {
          sessionId,
          sessionName: "web-dev",
          workspaceId,
          sessionClass: "standalone",
          lifecycle: "ready",
          hostBuildVersion: "0.1.1+abcdef123456",
          terminalEpoch: "1",
          outputSeq: "0",
          capabilities: [],
        },
      },
    });
    seedTestPaneHealth("detached:term:standalone_abc", {
      state: "error",
      terminalEpoch: "1",
      updatedAt: 1,
    });
    renderPane("term:standalone_abc", {
      sessionId,
      binding: bareStandaloneBinding(sessionId, workspaceId),
    });
    // 본문은 상태 문구뿐 — 세션 이름·빌드 등 진단은 title에만 남는다
    // (Pinpoint 제보: pane에 세션 이름을 보여주지 말 것).
    const badge = screen.getByText("연결 오류");
    expect(screen.queryByText(/web-dev/)).toBeNull();
    const hint = await hoverHint(badge);
    expect(hint).toContain("web-dev");
    expect(hint).toContain("host 0.1.1+abcdef123456");
    expect(hint).toContain("standalone");
  });

  it("keeps the hard-state badge nameless even without metadata", () => {
    const workspaceId = "ws-1";
    const sessionId = "standalone_noname";
    seedTestPaneHealth("detached:term:standalone_noname", {
      state: "error",
      terminalEpoch: "1",
      updatedAt: 1,
    });
    renderPane("term:standalone_noname", {
      sessionId,
      binding: bareStandaloneBinding(sessionId, workspaceId),
    });
    expect(screen.getByText("연결 오류")).toBeTruthy();
    expect(screen.queryByText("HMUX")).toBeNull();
  });

  it("keeps an exact live pane attachment authoritative over a stale catalog probe", () => {
    const workspaceId = "ws-live-pane";
    const sessionId = "managed-live-pane";
    useStore.setState({
      hmuxSessionMetadata: hmuxSessionMetadataFixture({
        sessionId,
        workspaceId,
        lifecycle: "unavailable",
        manifestLifecycle: "ready",
        health: "stale_transport",
        terminalEpoch: "epoch-live",
        outputSeq: "42",
      }),
    });
    seedTestPaneHealth(`detached:term:${sessionId}`, {
      state: "live",
      terminalEpoch: "epoch-live",
      receivedSequence: "42",
      presentedSequence: "42",
      updatedAt: 1,
    });

    renderPane(`term:${sessionId}`, {
      sessionId,
      binding: hmuxManagedBinding(sessionId, workspaceId),
    });

    expect(screen.queryByText("연결 오류")).toBeNull();
    expect(screen.queryByText("응답 지연")).toBeNull();
  });

  it("hides the identity badge while the session is healthy (Pinpoint 제보)", () => {
    // 세션 정보는 라벨과 hover title이 이미 말한다 — 평상시 배지는 소음이다.
    const workspaceId = "ws-1";
    const sessionId = "standalone_quiet";
    renderPane("term:standalone_quiet", {
      sessionId,
      binding: bareStandaloneBinding(sessionId, workspaceId),
    });
    expect(screen.queryByText("HMUX")).toBeNull();
  });

  it("keeps renderer catch-up out of connection-error chrome", () => {
    const workspaceId = "ws-render-backlog";
    const sessionId = "standalone_render_backlog";
    seedTestPaneHealth(`detached:term:${sessionId}`, {
      state: "recovering",
      reason: "render_backlog",
      receivedSequence: "486127",
      presentedSequence: "486063",
      updatedAt: 1,
    });
    renderPane(`term:${sessionId}`, {
      sessionId,
      binding: bareStandaloneBinding(sessionId, workspaceId),
    });

    expect(screen.queryByText("연결 오류")).toBeNull();
    expect(screen.queryByText("응답 지연")).toBeNull();
    expect(screen.queryByRole("button", { name: "화면 새로고침" })).toBeNull();
  });

  it("does not rerender pane chrome for sequence-only Hmux health progress", () => {
    const sessionId = "health-sequence";
    const paneHealthId = `detached:term:${sessionId}`;
    testPaneHealthIds.add(paneHealthId);
    const chromeCommits = vi.fn();
    const { result } = renderHook(() =>
      useStructuredTerminalPaneHealth(paneHealthId),
    );
    act(() => {
      result.current({
        kind: "frame_presented",
        terminalEpoch: "epoch-1",
        sequence: "41",
      });
    });
    render(
      <Profiler id="pane-chrome" onRender={chromeCommits}>
        <PaneChrome
          {...paneProps(`term:${sessionId}`, {
            sessionId,
            binding: bareStandaloneBinding(sessionId, "ws-health-sequence"),
          })}
        />
      </Profiler>,
    );
    const baselineCommits = chromeCommits.mock.calls.length;

    act(() => {
      result.current({
        kind: "frame_received",
        terminalEpoch: "epoch-1",
        sequence: "42",
      });
    });
    act(() => {
      result.current({
        kind: "frame_presented",
        terminalEpoch: "epoch-1",
        sequence: "42",
      });
    });

    expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
      state: "live",
      terminalEpoch: "epoch-1",
      receivedSequence: "42",
      presentedSequence: "42",
    });
    expect(chromeCommits).toHaveBeenCalledTimes(baselineCommits);

    act(() => {
      result.current({
        kind: "connection",
        state: "error",
        reason: "transport_closed",
      });
    });
    expect(chromeCommits.mock.calls.length).toBeGreaterThan(baselineCommits);
    expect(screen.getByText("연결 오류")).toBeTruthy();
  });

  it("does not rerender a closed pane menu for another Agent conversation update", async () => {
    const currentAgent = makeAgent({
      id: "current-agent",
      projectId: "project-1",
    });
    const otherAgent = makeAgent({
      id: "other-agent",
      displayName: "Candidate before",
      projectId: "project-1",
      conversationId: "conversation-before",
    });
    workspaceRuntimeMocks.desktopId = "desktop-1";
    useStore.setState({
      agents: [currentAgent, otherAgent],
      projects: [localProject("project-1", "Project", "/repo")],
    });
    const chromeCommits = vi.fn();
    render(
      <Profiler id="pane-chrome" onRender={chromeCommits}>
        <PaneChrome {...paneProps(`agent:${currentAgent.id}`, { agentRef: { agentId: currentAgent.id } })} />
      </Profiler>,
    );
    const closedBaselineCommits = chromeCommits.mock.calls.length;

    act(() => {
      useStore.setState((state) => ({
        agents: state.agents.map((candidate) =>
          candidate.id === otherAgent.id
            ? { ...candidate, conversationId: "conversation-after" }
            : candidate,
        ),
      }));
    });

    expect(chromeCommits).toHaveBeenCalledTimes(closedBaselineCommits);
    act(() => {
      useStore.setState((state) => ({
        agents: state.agents.map((candidate) =>
          candidate.id === otherAgent.id
            ? { ...candidate, displayName: "Candidate current" }
            : candidate,
        ),
      }));
    });
    expect(chromeCommits).toHaveBeenCalledTimes(closedBaselineCommits);

    openPaneMenu();
    const switchAgent = await screen.findByRole("menuitem", {
      name: "에이전트로 교체",
    });
    switchAgent.focus();
    fireEvent.keyDown(switchAgent, { key: "ArrowRight" });
    expect(
      await screen.findByRole("menuitem", { name: /Candidate current/ }),
    ).toBeTruthy();
    const openBaselineCommits = chromeCommits.mock.calls.length;
    act(() => {
      useStore.setState((state) => ({
        agents: state.agents.map((candidate) =>
          candidate.id === otherAgent.id
            ? { ...candidate, displayName: "Candidate after" }
            : candidate,
        ),
      }));
    });
    expect(chromeCommits.mock.calls.length).toBeGreaterThan(openBaselineCommits);
    expect(
      await screen.findByRole("menuitem", { name: /Candidate after/ }),
    ).toBeTruthy();
  });

  it("keeps Agent switch candidates live in the tab context menu", async () => {
    const currentAgent = makeAgent({
      id: "context-current-agent",
      projectId: "project-1",
    });
    const otherAgent = makeAgent({
      id: "context-other-agent",
      displayName: "Context candidate",
      projectId: "project-1",
    });
    workspaceRuntimeMocks.desktopId = "desktop-1";
    useStore.setState({
      agents: [currentAgent, otherAgent],
      projects: [localProject("project-1", "Project", "/repo")],
    });
    const { container } = renderAgentPane(currentAgent);

    const chrome = container.querySelector<HTMLElement>(".pane-chrome");
    expect(chrome).toBeTruthy();
    fireEvent.contextMenu(chrome as HTMLElement, {
      clientX: 40,
      clientY: 20,
    });
    const switchAgent = await screen.findByRole("menuitem", {
      name: "에이전트로 교체",
    });
    switchAgent.focus();
    fireEvent.keyDown(switchAgent, { key: "ArrowRight" });

    expect(
      await screen.findByRole("menuitem", { name: /Context candidate/ }),
    ).toBeTruthy();
    act(() => {
      useStore.setState((state) => ({
        agents: state.agents.map((candidate) =>
          candidate.id === otherAgent.id
            ? { ...candidate, displayName: "Context candidate after" }
            : candidate,
        ),
      }));
    });
    expect(
      await screen.findByRole("menuitem", { name: /Context candidate after/ }),
    ).toBeTruthy();
  });

  it("shows a direct managed promotion action for an idle standalone Codex pane", () => {
    const workspaceId = "ws-1";
    const sessionId = "standalone-codex";
    useStore.setState({
      projects: [localProject("project-1", "repo", "/repo")],
      sessionAgentPin: { [sessionId]: "codex" },
      sessionAgentRuntimeState: { [sessionId]: terminalRuntime("waiting") },
      sessionCwd: { [sessionId]: "/repo/.worktrees/agent-a" },
    });
    renderPane(`term:${sessionId}`, {
      sessionId,
      cwd: "/repo/.worktrees/agent-a",
      binding: bareStandaloneBinding(sessionId, workspaceId),
    });

    expect(screen.queryByLabelText("관리 세션으로 전환")).toBeNull();
    act(() =>
      publishTerminalExecutionLocation(sessionId, {
        kind: "local",
      }),
    );
    const action = screen.getByLabelText("관리 세션으로 전환");
    expect(action).not.toHaveProperty("disabled", true);
  });

  it("explains why a working standalone Codex pane cannot be promoted yet", () => {
    const workspaceId = "ws-1";
    const sessionId = "standalone-working";
    useStore.setState({
      projects: [localProject("project-1", "repo", "/repo")],
      sessionAgentPin: { [sessionId]: "codex" },
      sessionAgentRuntimeState: { [sessionId]: terminalRuntime("working") },
      sessionCwd: { [sessionId]: "/repo" },
    });
    publishTerminalExecutionLocation(sessionId, { kind: "local" });
    renderPane(`term:${sessionId}`, {
      sessionId,
      cwd: "/repo",
      binding: bareStandaloneBinding(sessionId, workspaceId),
    });

    expect(
      screen.getByLabelText(
        "에이전트가 작업을 마치면 관리 세션으로 전환할 수 있습니다.",
      ),
    ).toHaveProperty("disabled", true);
  });

  function managedMetadata(
    workspaceId: string,
    sessionId: string,
    health: "current_healthy" | "compatible_old_healthy" | "stale_transport",
  ): Record<string, HmuxSessionSummary> {
    return hmuxSessionMetadataFixture({
      sessionId,
      sessionName: "codex-1",
      workspaceId,
      health,
      terminalEpoch: "1",
    });
  }

  it("keeps healthy local Hmux rehost in the pane dropdown", async () => {
    const binding = hmuxManagedBinding("local-current", "ws-local");
    const localAgent = localRehostAgent(binding, { projectId: "project-local" });
    useStore.setState({
      agents: [localAgent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "current_healthy",
      ),
    });
    renderAgentPane(localAgent, { binding, sessionId: binding.sessionId });

    expect(await findRehostMenuItem()).toBeTruthy();
  });

  it.each([
    ["basic", "context"], ["pro", "context"],
    ["basic", "dropdown"], ["pro", "dropdown"],
  ] as const)(
    "refreshes the exact conversation on a new Host from the %s pane %s menu",
    async (interfaceMode, surface) => {
      const agent = localRehostAgent(hmuxManagedBinding("refresh-old", "ws-refresh"));
      useStore.setState((state) => ({
        agents: [agent], uiPrefs: { ...state.uiPrefs, interfaceMode },
      }));
      const { container } = renderAgentPane(agent);
      if (surface === "context") {
        fireEvent.contextMenu(container.querySelector(".pane-chrome") as HTMLElement);
      } else {
        openPaneMenu();
      }
      fireEvent.click(await screen.findByRole("menuitem", { name: /^새로고침/ }));

      await waitFor(() => expect(refreshMocks.resumeExactManagedAgentPane).toHaveBeenCalledWith(
        agent.id, `agent:${agent.id}`, "conversation-1", undefined,
      ));
      expect(buildRehostMocks.rehostManagedBuild).not.toHaveBeenCalled();
    },
  );

  it("keeps Refresh disabled until the current conversation identity arrives", async () => {
    const agent = localRehostAgent(hmuxManagedBinding("refresh-no-id", "ws-refresh"), {
      conversationId: undefined,
    });
    useStore.setState({ agents: [agent] });
    renderAgentPane(agent);
    openPaneMenu();
    const refresh = await screen.findByRole("menuitem", { name: /^새로고침/ });
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(refresh);
    expect(refreshMocks.resumeExactManagedAgentPane).not.toHaveBeenCalled();
    act(() => useStore.setState({ agents: [{ ...agent, conversationId: "observed-conversation" }] }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^새로고침/ }));
    await waitFor(() => expect(refreshMocks.resumeExactManagedAgentPane).toHaveBeenCalledWith(
      agent.id, `agent:${agent.id}`, "observed-conversation", undefined,
    ));
  });

  it("refreshes the Host-projected conversation instead of a stale legacy ID", async () => {
    const binding = hmuxManagedBinding("refresh-projected", "ws-refresh");
    const fence = stopFenceFixture();
    const agent = localRehostAgent({
      ...binding,
      stopFence: fence,
      conversationIdentity: {
        schemaVersion: 1, ...fence,
        sessionId: binding.sessionId, workspaceId: binding.workspaceId,
        providerId: "codex", conversationId: "host-conversation",
        revision: "2", observedThroughOutputSeq: "8", source: "provider_event",
      },
    }, { conversationId: "stale-legacy-conversation" });
    useStore.setState({ agents: [agent] });
    renderAgentPane(agent);
    openPaneMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /^새로고침/ }));
    await waitFor(() => expect(refreshMocks.resumeExactManagedAgentPane).toHaveBeenCalledWith(
      agent.id, `agent:${agent.id}`, "host-conversation", undefined,
    ));
  });

  it.each(["resolve", "reject"] as const)(
    "retains the pane and excludes competing Host actions until Refresh %s settles",
    async (outcome) => {
      const agent = localRehostAgent(hmuxManagedBinding("refresh-pending", "ws-refresh"));
      let settle!: () => void;
      refreshMocks.resumeExactManagedAgentPane.mockImplementationOnce(
        () => new Promise<void>((resolve, reject) => {
          settle = outcome === "resolve" ? resolve : () => reject(new Error("refresh failed"));
        }),
      );
      useStore.setState({ agents: [agent] });
      const { container } = renderAgentPane(agent);
      const retainedPane = screen.getByTestId("retained-pane");
      openPaneMenu();
      fireEvent.click(await screen.findByRole("menuitem", { name: /^새로고침/ }));
      await waitFor(() => expect(refreshMocks.resumeExactManagedAgentPane).toHaveBeenCalledOnce());
      expect(retainedPane.parentElement?.hasAttribute("inert")).toBe(true);
      expect(screen.getByRole("status").textContent).toContain("재호스트 중…");
      fireEvent.contextMenu(container.querySelector(".pane-chrome") as HTMLElement);
      for (const name of [/^새로고침/, /현재 빌드로 재호스트/]) {
        const item = await screen.findByRole("menuitem", { name });
        expect(item.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(item);
      }
      expect(refreshMocks.resumeExactManagedAgentPane).toHaveBeenCalledOnce();
      expect(buildRehostMocks.rehostManagedBuild).not.toHaveBeenCalled();
      await act(async () => settle());
      expect(screen.getByTestId("retained-pane")).toBe(retainedPane);
      expect(retainedPane.parentElement?.hasAttribute("inert")).toBe(false);
      expect(screen.getByRole("menuitem", { name: /^새로고침/ }).getAttribute("aria-disabled")).not.toBe("true");
    },
  );

  it("does not offer local exact Refresh on an SSH Agent pane", async () => {
    const agent = remoteRehostAgent(remoteHmuxManagedBinding("remote", "ws-remote", "host-1", "bridge-1"));
    useStore.setState({ agents: [agent] });
    renderAgentPane(agent);
    openPaneMenu();
    await screen.findByRole("menuitem", { name: "현재 빌드로 재호스트" });
    expect(screen.queryByRole("menuitem", { name: /^새로고침/ })).toBeNull();
  });

  it.each(["local", "ssh"] as const)(
    "shows Rehost progress across the %s pane's temporary disconnect",
    async (source) => {
      const localBinding = hmuxManagedBinding("rehost-progress", "ws-progress");
      const agent = source === "local"
        ? localRehostAgent(localBinding)
        : remoteRehostAgent(remoteHmuxManagedBinding(
            localBinding.sessionId, localBinding.workspaceId, "host-1", "bridge-1",
          ));
      const paneId = `agent:${agent.id}`;
      const healthId = `detached:${paneId}`;
      let finishRehost!: () => void;
      buildRehostMocks.rehostManagedBuild.mockImplementationOnce(
        () => new Promise<void>((resolve) => { finishRehost = resolve; }),
      );
      useStore.setState({ agents: [agent] });
      const { container } = renderAgentPane(agent);
      const header = container.querySelector(".pane-chrome");

      fireEvent.click(await findRehostMenuItem());
      expect(header?.textContent).not.toContain("재호스트 중…");
      expect(screen.getByRole("status").textContent).toContain("재호스트 중…");
      act(() => {
        seedTestPaneHealth(healthId, {
          state: "error", reason: "transport_closed", updatedAt: 1,
        });
      });
      expect(screen.queryByText("연결 오류")).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("재호스트 중…");
      expect(getHmuxPaneHealth(healthId)?.state).toBe("error");

      await act(async () => {
        seedTestPaneHealth(healthId, {
          state: "live", terminalEpoch: "successor", presentedSequence: "1", updatedAt: 2,
        });
        finishRehost();
      });
      expect(screen.queryByText("재호스트 중…")).toBeNull();
      expect(screen.queryByText("연결 오류")).toBeNull();
      expect(container.querySelector(".pane-chrome")).toBe(header);
    },
  );

  it("stops Rehost progress and restores the observed error when the action fails", async () => {
    const agent = localRehostAgent(hmuxManagedBinding("rehost-failure", "ws-progress"));
    let failRehost!: (error: Error) => void;
    buildRehostMocks.rehostManagedBuild.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { failRehost = reject; }),
    );
    useStore.setState({ agents: [agent] });
    renderAgentPane(agent);
    fireEvent.click(await findRehostMenuItem());
    expect(screen.getByRole("status").textContent).toContain("재호스트 중…");
    await act(async () => {
      seedTestPaneHealth(`detached:agent:${agent.id}`, {
        state: "error", reason: "transport_closed", updatedAt: 1,
      });
      failRehost(new Error("rehost failed"));
    });
    expect(screen.queryByText("재호스트 중…")).toBeNull();
    expect(screen.getByText("연결 오류")).toBeTruthy();
  });

  it("does not offer Resume for the source disconnect while Rehost is pending", async () => {
    const binding = hmuxManagedBinding("rehost-recovery", "ws-progress");
    const agent = localRehostAgent(binding);
    let finishRehost!: () => void;
    buildRehostMocks.rehostManagedBuild.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishRehost = resolve; }),
    );
    useStore.setState({ agents: [agent] });
    render(
      <>
        <PaneChrome {...paneProps(`agent:${agent.id}`, { agentRef: { agentId: agent.id } })} />
        <ManagedAgentRecoveryBar agentId={agent.id} panelId={`agent:${agent.id}`}
          binding={binding} onAvailabilityChange={() => {}} />
      </>,
    );
    fireEvent.click(await findRehostMenuItem());
    act(() => {
      useStore.setState({
        hmuxSessionMetadata: managedMetadata(binding.workspaceId, binding.sessionId, "stale_transport"),
      });
    });
    try {
      expect(screen.queryByRole("button", { name: /정확한 대화 재개/ })).toBeNull();
    } finally {
      await act(async () => { finishRehost(); });
    }
    expect(screen.getByRole("button", { name: /정확한 대화 재개/ })).toBeTruthy();
  });

  it("advertises and invokes the visible Rehost control as a named pane action", async () => {
    const binding = hmuxManagedBinding("local-named-action", "ws-local");
    const localAgent = localRehostAgent(binding, { projectId: "project-local" });
    const paneId = `agent:${localAgent.id}`;
    const unregisterStatus = registerPaneActions({ owner: {},
      paneId,
      status: "attached",
      actions: {},
    });
    useStore.setState({
      agents: [localAgent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "current_healthy",
      ),
    });
    try {
      renderAgentPane(localAgent, { binding, sessionId: binding.sessionId });

      await waitFor(() =>
        expect(paneActionSnapshot(paneId)?.actions).toContain("rehost"),
      );
      await expect(invokePaneAction(paneId, "rehost")).resolves.toEqual({
        ok: true,
        paneId,
        action: "rehost",
      });
      expect(buildRehostMocks.rehostManagedBuild).toHaveBeenCalledWith(
        localAgent.id,
        paneId,
      );
    } finally {
      unregisterStatus();
    }
  });

  it("advertises and invokes explicit permission-mode targets as named pane actions", async () => {
    const binding = hmuxManagedBinding("local-permissions", "ws-local");
    const localAgent = localRehostAgent(binding, { projectId: "project-local" });
    const paneId = `agent:${localAgent.id}`;
    const inspection = {
      agentId: localAgent.id,
      agentName: localAgent.name,
      providerId: localAgent.provider,
      permissionMode: "default",
      conversationId: localAgent.conversationId,
      sourceBinding: binding,
    };
    const unregisterStatus = registerPaneActions({ owner: {},
      paneId,
      status: "idle",
      actions: {},
    });
    let completeExecution!: () => void;
    permissionModeMocks.inspect.mockResolvedValueOnce(inspection);
    permissionModeMocks.execute.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        completeExecution = resolve;
      });
      return {
        receipt: { targetMode: "skip_permissions" },
        presentation: "pending" as const,
      };
    });
    useStore.setState({
      agents: [localAgent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "current_healthy",
      ),
    });
    try {
      renderAgentPane(localAgent, { binding, sessionId: binding.sessionId });

      await waitFor(() =>
        expect(paneActionSnapshot(paneId)?.actions).toEqual(
          expect.arrayContaining([
            "permission_mode:default",
            "permission_mode:skip_permissions",
          ]),
        ),
      );
      const firstInvocation = invokePaneAction(
        paneId,
        "permission_mode:skip_permissions",
      );
      await waitFor(() => expect(permissionModeMocks.execute).toHaveBeenCalled());
      await expect(
        invokePaneAction(paneId, "permission_mode:skip_permissions"),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "pane_action_failed", retryable: true },
      });
      completeExecution();
      await expect(firstInvocation).resolves.toEqual({
        ok: true,
        paneId,
        action: "permission_mode:skip_permissions",
      });
      expect(permissionModeMocks.inspect).toHaveBeenCalledWith(
        localAgent.id,
        paneId,
      );
      expect(permissionModeMocks.execute).toHaveBeenCalledWith(
        inspection,
        "skip_permissions",
      );
      expect(permissionModeMocks.execute).toHaveBeenCalledTimes(1);
    } finally {
      unregisterStatus();
    }
  });

  it("does not advertise an unsupported skip-permissions target", async () => {
    const binding = hmuxManagedBinding("local-safe-only", "ws-local");
    const localAgent = localRehostAgent(binding, {
      projectId: "project-local",
      provider: "amp",
    });
    const paneId = `agent:${localAgent.id}`;
    const unregisterStatus = registerPaneActions({ owner: {},
      paneId,
      status: "idle",
      actions: {},
    });
    useStore.setState({ agents: [localAgent] });
    try {
      renderAgentPane(localAgent, { binding, sessionId: binding.sessionId });

      await waitFor(() =>
        expect(paneActionSnapshot(paneId)?.actions).toContain(
          "permission_mode:default",
        ),
      );
      expect(paneActionSnapshot(paneId)?.actions).not.toContain(
        "permission_mode:skip_permissions",
      );
    } finally {
      unregisterStatus();
    }
  });

  it("keeps permission-mode actions off remote managed Agent panes", async () => {
    const binding = remoteHmuxManagedBinding(
      "remote-permissions",
      "ws-remote",
      "host-remote",
      "bridge-remote",
    );
    const remoteAgent = remoteRehostAgent(binding);
    const paneId = `agent:${remoteAgent.id}`;
    const unregisterStatus = registerPaneActions({ owner: {},
      paneId,
      status: "idle",
      actions: {},
    });
    useStore.setState({ agents: [remoteAgent] });
    try {
      renderAgentPane(remoteAgent, { binding, sessionId: binding.sessionId });

      await waitFor(() =>
        expect(paneActionSnapshot(paneId)?.actions).toContain("rehost"),
      );
      expect(
        paneActionSnapshot(paneId)?.actions.some((action) =>
          action.startsWith("permission_mode:"),
        ),
      ).toBe(false);
    } finally {
      unregisterStatus();
    }
  });

  it("reports a named Rehost failure instead of swallowing it as UI feedback", async () => {
    const binding = hmuxManagedBinding("local-named-failure", "ws-local");
    const localAgent = localRehostAgent(binding, { projectId: "project-local" });
    const paneId = `agent:${localAgent.id}`;
    const unregisterStatus = registerPaneActions({ owner: {},
      paneId,
      status: "attached",
      actions: {},
    });
    buildRehostMocks.rehostManagedBuild.mockRejectedValueOnce(
      new Error("rehost failed"),
    );
    useStore.setState({
      agents: [localAgent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "compatible_old_healthy",
      ),
    });
    try {
      renderAgentPane(localAgent, { binding, sessionId: binding.sessionId });
      await waitFor(() =>
        expect(paneActionSnapshot(paneId)?.actions).toContain("rehost"),
      );

      await expect(invokePaneAction(paneId, "rehost")).resolves.toMatchObject({
        ok: false,
        error: { code: "pane_action_failed", message: "rehost failed" },
      });
      expect(paneSignalMocks.requestManagedRecovery).not.toHaveBeenCalled();
    } finally {
      unregisterStatus();
    }
  });

  it("does not advertise Rehost when the pane has no rehost workflow", () => {
    const paneId = "term:plain";
    const unregisterStatus = registerPaneActions({ owner: {},
      paneId,
      status: "attached",
      actions: {},
    });
    try {
      renderPane(paneId, { sessionId: "plain", cwd: "/repo" });
      expect(paneActionSnapshot(paneId)?.actions).not.toContain("rehost");
    } finally {
      unregisterStatus();
    }
  });

  it("runs manual Rehost for a stale backend-owned Native Agent", async () => {
    const binding = hmuxManagedBinding("runtime-native", "ws-local");
    const localAgent = localRehostAgent(binding, {
      projectId: "project-local",
      executionProfile: { kind: "provider_default" },
    });
    useStore.setState({
      agents: [localAgent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "stale_transport",
      ),
    });
    renderAgentPane(localAgent, { binding, sessionId: binding.sessionId });

    const rehost = await findRehostMenuItem();
    expect(buildRehostMocks.rehostManagedBuild).not.toHaveBeenCalled();

    fireEvent.click(rehost);

    await waitFor(() =>
      expect(buildRehostMocks.rehostManagedBuild).toHaveBeenCalledWith(
        localAgent.id,
        `agent:${localAgent.id}`,
      ),
    );
  });

  it("opens exact conversation recovery when local managed rehost fails", async () => {
    const binding = hmuxManagedBinding("local-failed", "ws-local");
    const localAgent = localRehostAgent(binding, {
      projectId: "project-local",
      conversationId: "possibly-wrong-conversation",
    });
    buildRehostMocks.rehostManagedBuild.mockRejectedValueOnce(
      new Error("rehost failed"),
    );
    useStore.setState({
      agents: [localAgent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "compatible_old_healthy",
      ),
    });
    renderAgentPane(localAgent, { binding, sessionId: binding.sessionId });

    fireEvent.click(await findRehostMenuItem());

    await waitFor(() =>
      expect(paneSignalMocks.requestManagedRecovery).toHaveBeenCalledWith(
        `agent:${localAgent.id}`,
      ),
    );
  });

  it("offers managed rehost from the pane binding without an Agent registry entry", async () => {
    const binding = hmuxManagedBinding("legacy-managed", "ws-local");
    useStore.setState({
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "compatible_old_healthy",
      ),
    });
    renderPane(`term:${binding.sessionId}`, {
      binding,
      cwd: "/repo",
      sessionId: binding.sessionId,
    });

    expect(await findRehostMenuItem()).toBeTruthy();
  });

  it("routes an old SSH managed pane through the remote journaled rehost", async () => {
    const binding = {
      schemaVersion: 1 as const,
      runtime: "hmux_managed_v1" as const,
      source: "ssh" as const,
      hostId: "host-1",
      sessionId: "remote-old",
      workspaceId: "ws-remote",
      createIdempotencyKey: "create-old",
      commandBridgeNonce: "bridge-old",
      stopFence: {
        runnerPrincipal: "principal",
        runnerInstance: "instance",
        channelEpoch: "7",
        hostInstanceId: "host-old",
        hostGeneration: "9",
        terminalEpoch: "terminal-old",
      },
    };
    const remoteAgent = remoteRehostAgent(binding);
    useStore.setState({
      agents: [remoteAgent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "compatible_old_healthy",
      ),
    });
    renderAgentPane(remoteAgent, { binding, sessionId: binding.sessionId });

    fireEvent.click(await findRehostMenuItem());
    await waitFor(() =>
      expect(buildRehostMocks.rehostManagedBuild).toHaveBeenCalledWith(
        remoteAgent.id,
        `agent:${remoteAgent.id}`,
      ),
    );
    expect(dialogMocks.ask).not.toHaveBeenCalled();
  });

  it.each([
    ["managed", "current_healthy", undefined],
    ["stale", "stale_transport", undefined],
    ["unknown", undefined, undefined],
    ["error", undefined, "error"],
  ] as const)(
    "keeps SSH Hmux %s rehost in the pane menu until explicit inspection",
    async (_case, metadataHealth, paneHealth) => {
      const binding = remoteHmuxManagedBinding(
        "remote-session",
        "ws-remote",
        "host-1",
        "bridge-1",
      );
      const remoteAgent = remoteRehostAgent(binding);
      useStore.setState({
        agents: [remoteAgent],
        hmuxSessionMetadata: metadataHealth
          ? managedMetadata(
              binding.workspaceId,
              binding.sessionId,
              metadataHealth,
            )
          : {},
      });
      if (paneHealth) {
        seedTestPaneHealth(`detached:agent:${remoteAgent.id}`, {
          state: paneHealth,
          reason: "transport unavailable",
          updatedAt: 1,
        });
      }
      renderAgentPane(remoteAgent, { binding, sessionId: binding.sessionId });

      expect(
        screen.queryByRole("button", { name: "현재 빌드로 재호스트" }),
      ).toBeNull();
      const action = await findRehostMenuItem();
      expect(buildRehostMocks.rehostManagedBuild).not.toHaveBeenCalled();

      fireEvent.click(action);
      await waitFor(() =>
        expect(buildRehostMocks.rehostManagedBuild).toHaveBeenCalledOnce(),
      );
    },
  );

  it("runs the lazy SSH managed rehost from a terminal binding without Agent metadata", async () => {
    const binding = remoteHmuxManagedBinding(
      "remote-terminal",
      "ws-remote",
      "host-1",
      "bridge-1",
    );
    renderPane("term:remote-terminal", {
      binding,
      sessionId: binding.sessionId,
    });

    expect(buildRehostMocks.rehostManagedBuild).not.toHaveBeenCalled();
    const action = await findRehostMenuItem();
    expect(buildRehostMocks.rehostManagedBuild).not.toHaveBeenCalled();

    fireEvent.click(action);

    await waitFor(() =>
      expect(buildRehostMocks.rehostManagedBuild).toHaveBeenCalledWith(
        binding,
        "term:remote-terminal",
      ),
    );
  });

  it("routes completed SSH rehost repair through the shared action", async () => {
    const binding = remoteHmuxManagedBinding(
      "remote-terminal",
      "ws-remote",
      "host-1",
      "bridge-1",
    );
    renderPane("term:remote-terminal", {
      binding,
      sessionId: binding.sessionId,
    });

    fireEvent.click(await findRehostMenuItem());

    await waitFor(() =>
      expect(buildRehostMocks.rehostManagedBuild).toHaveBeenCalledWith(
        binding,
        "term:remote-terminal",
      ),
    );
    expect(dialogMocks.ask).not.toHaveBeenCalled();
  });

  it("uses the canonical workflow for a local managed Agent pane", async () => {
    const binding = hmuxManagedBinding("local-old", "ws-local");
    const localAgent = localRehostAgent(binding);
    useStore.setState({
      agents: [localAgent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "compatible_old_healthy",
      ),
    });
    renderAgentPane(localAgent, { binding, sessionId: binding.sessionId });
    fireEvent.click(await findRehostMenuItem());
    await waitFor(() =>
      expect(buildRehostMocks.rehostManagedBuild).toHaveBeenCalledWith(
        localAgent.id,
        `agent:${localAgent.id}`,
      ),
    );
    expect(dialogMocks.ask).not.toHaveBeenCalled();
  });

  it("keeps local stale-transport rehost available in the pane menu", async () => {
    const binding = hmuxManagedBinding("local-old", "ws-local");
    const localAgent = localRehostAgent(binding);
    const metadata = managedMetadata(
      binding.workspaceId,
      binding.sessionId,
      "stale_transport",
    );
    useStore.setState({ agents: [localAgent], hmuxSessionMetadata: metadata });
    renderAgentPane(localAgent, { binding, sessionId: binding.sessionId });

    expect(await findRehostMenuItem()).toBeTruthy();
  });

  it("keeps an observer-bound standalone rehost only in the pane menu", async () => {
    const binding = hmuxLocalBinding("standalone-observer", "ws-local");
    useStore.setState({
      hmuxSessionMetadata: {
        [hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)]: {
          sessionId: binding.sessionId,
          workspaceId: binding.workspaceId,
          sessionClass: "standalone",
          lifecycle: "ready",
          health: "stale_transport",
          terminalEpoch: "1",
          outputSeq: "0",
          capabilities: [],
        },
      },
    });
    renderPane("term:observer", {
      binding,
      sessionId: binding.sessionId,
    });

    expect(
      screen.queryByRole("button", { name: "현재 빌드로 재호스트" }),
    ).toBeNull();
    expect(await findRehostMenuItem()).toBeTruthy();
  });

  it("hides the hmux badge for a managed pane (인라인 TUI가 곧 managed 표시)", () => {
    const binding = hmuxManagedBinding("agent-xy", "ws-1");
    const agent = makeAgent({
      id: "agent-xy",
      sessionId: binding.sessionId,
      runtimeBinding: binding,
    });
    useStore.setState({
      agents: [agent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "current_healthy",
      ),
    });
    renderAgentPane(agent);
    // 정체성 배지(세션 이름) 없음 — managed pane은 깔끔하게. 닫기 버튼은 유지.
    expect(screen.queryByText("codex-1")).toBeNull();
    expect(screen.getByRole("button", { name: "닫기" })).toBeTruthy();
  });

  it("uses the Agent authority when stale pane runtime parameters report an error", async () => {
    const binding = hmuxManagedBinding("agent-current", "ws-current");
    const agent = makeAgent({
      id: "agent-zz",
      sessionId: binding.sessionId,
      runtimeBinding: binding,
    });
    useStore.setState({
      agents: [agent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "stale_transport",
      ),
    });
    seedTestPaneHealth("detached:agent:agent-zz", {
      state: "error",
      reason: "structured terminal reconnect exhausted",
      updatedAt: 1,
    });
    renderAgentPane(agent, {
		agentId: "stale-agent",
      binding: {
        runtime: "hmux_managed_v1",
        sessionId: "stale-session",
        workspaceId: "stale-workspace",
      },
    });
    // Hard pane failures keep the compact label; session details stay in title.
    const stuck = screen.getByText("연결 오류");
    expect(await hoverHint(stuck)).toContain("codex-1");
  });

  it("presents the credential replacement gap as connecting instead of an error", () => {
    const binding = hmuxManagedBinding("agent-switching", "ws-1");
    const switchingAgent = makeAgent({
      id: "agent-switching",
      name: "switching-agent",
      worktreePath: "/repo/.worktrees/switching-agent",
      branch: "agent/switching-agent",
      sessionId: binding.sessionId,
      runtimeBinding: binding,
    });
    useStore.setState({
      agents: [switchingAgent],
      hmuxSessionMetadata: managedMetadata(
        binding.workspaceId,
        binding.sessionId,
        "stale_transport",
      ),
    });
    const endTransition = beginManagedCredentialSwitchTransition(switchingAgent.id);
    try {
      renderAgentPane(switchingAgent, { binding, sessionId: binding.sessionId });

      expect(screen.queryByText("연결 오류")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "화면 새로고침" }),
      ).toBeNull();
    } finally {
      act(() => endTransition());
    }
  });
});
