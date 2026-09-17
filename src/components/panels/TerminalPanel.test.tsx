// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createDockview, type IDockviewPanelProps } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  homeDir: vi.fn(async () => "/Users/test"),
  hmuxExitHandler: undefined as
    | ((
        receipt: import("@/lib/terminal/structuredTerminalRecord").HmuxSessionExitReceipt,
      ) => void)
    | undefined,
  providerConversationIdentityHandler: undefined as
    | ((
        identity: import("@/lib/ipc").HmuxProviderConversationIdentity,
        attachedBinding: import("@/lib/terminal/terminalBinding").HmuxPaneBindingV1,
      ) => void)
    | undefined,
  workingDirectoryHandler: undefined as
    | ((
        workingDirectory: import("@/lib/ipc").HmuxWorkingDirectory,
        attachedBinding: import("@/lib/terminal/terminalBinding").HmuxPaneBindingV1,
      ) => void)
    | undefined,
  terminalBindings: [] as Array<
    import("@/lib/terminal/terminalBinding").TerminalPaneBindingV1 | undefined
  >,
  commitLayout: vi.fn(() => true),
  closePanelById: vi.fn(async () => null),
  splitHandler: undefined as ((direction: "right" | "below") => void) | undefined,
  startTerminal: vi.fn(),
  killHandler: undefined as (() => void) | undefined,
  prepareConversion: vi.fn(),
  commitConversion: vi.fn(),
  commitDockviewMutation: vi.fn((input: { mutate: () => unknown }) =>
    input.mutate(),
  ),
}));

vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: (props: {
    binding?: import("@/lib/terminal/terminalBinding").TerminalPaneBindingV1;
    onKill?: () => void;
    onSplit?: (direction: "right" | "below") => void;
    onHmuxSessionExit?: (
      receipt: import("@/lib/terminal/structuredTerminalRecord").HmuxSessionExitReceipt,
    ) => void;
    onProviderConversationIdentity?: (
      identity: import("@/lib/ipc").HmuxProviderConversationIdentity,
      attachedBinding: import("@/lib/terminal/terminalBinding").HmuxPaneBindingV1,
    ) => void;
    onWorkingDirectory?: (
      workingDirectory: import("@/lib/ipc").HmuxWorkingDirectory,
      attachedBinding: import("@/lib/terminal/terminalBinding").HmuxPaneBindingV1,
    ) => void;
  }) => {
    mocks.terminalBindings.push(props.binding);
    mocks.killHandler = props.onKill;
    mocks.splitHandler = props.onSplit;
    mocks.hmuxExitHandler = props.onHmuxSessionExit;
    mocks.providerConversationIdentityHandler =
      props.onProviderConversationIdentity;
    mocks.workingDirectoryHandler = props.onWorkingDirectory;
    return <div data-testid="terminal" />;
  },
}));

vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
  useWorkspaceDurableLayoutCommit: () => mocks.commitLayout,
  useWorkspaceRuntimeActive: () => true,
  useWorkspaceRuntimeDesktopId: () => "desktop-test",
}));

vi.mock("@/lib/ipc", () => ({
  homeDir: mocks.homeDir,
}));

vi.mock("@/lib/workspace/dock/openBrowserPanel", () => ({
  openBrowserPanelOn: vi.fn(),
}));
vi.mock("@/lib/workspace/dock", () => ({
  openLocalTerminalOn: mocks.startTerminal,
  openRemoteSshTerminalOn: mocks.startTerminal,
  retargetHmuxStandaloneTerminalPanel: vi.fn(),
}));
vi.mock("@/lib/workspace/pane/paneCloseCoordinator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/pane/paneCloseCoordinator")>()),
  closePanelById: mocks.closePanelById,
}));
vi.mock("@/lib/files/fileViewerPane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/files/fileViewerPane")>()),
  openFileViewerOn: vi.fn(),
}));

vi.mock("@/lib/hmux/conversion/hmuxSessionConversionWorkflow", () => ({
  prepareHmuxSessionConversion: mocks.prepareConversion,
  commitPreparedHmuxSessionConversion: mocks.commitConversion,
}));

vi.mock("@/lib/workspace/dock/explicitDockviewCommit", () => ({
  commitExplicitDockviewMutation: mocks.commitDockviewMutation,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(async () => true),
  message: vi.fn(),
}));

import {
  TerminalPanel,
  type TerminalPanelParams,
} from "@/components/panels/TerminalPanel";
import { setLang } from "@/lib/i18n";
import {
  hmuxStandaloneBinding,
  remoteHmuxManagedBinding,
  remoteHmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { publishTerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocationStore";
import { useStore } from "@/store";

const legacyLocalBinding = (sessionId: string) =>
  ({
    schemaVersion: 1,
    runtime: "legacy_session_v1",
    source: "local",
    hostId: "local",
    sessionId,
  }) as unknown as TerminalPaneBindingV1;

function panelProps(
  params: TerminalPanelParams,
  updateParameters = vi.fn(),
  panelId = "term:panel-under-test",
): IDockviewPanelProps<TerminalPanelParams> {
  const panelApi = {
    id: panelId,
    component: "terminal",
    setTitle: vi.fn(),
    updateParameters: (next: TerminalPanelParams) => {
      panel.params = next;
      updateParameters(next);
    },
    close: vi.fn(),
  };
  const panel = { params, api: panelApi };
  return {
    params,
    api: panelApi,
    containerApi: {
      getPanel: (panelId: string) =>
        panelId === panelApi.id ? panel : undefined,
      toJSON: vi.fn(() => ({ grid: {} })),
    },
  } as unknown as IDockviewPanelProps<TerminalPanelParams>;
}

beforeEach(() => {
  setLang("en");
  vi.clearAllMocks();
  mocks.killHandler = undefined;
  mocks.splitHandler = undefined;
  mocks.hmuxExitHandler = undefined;
  mocks.providerConversationIdentityHandler = undefined;
  mocks.workingDirectoryHandler = undefined;
  mocks.terminalBindings.length = 0;
  mocks.commitLayout.mockReturnValue(true);
  mocks.prepareConversion.mockReset();
  mocks.commitConversion.mockReset();
  useStore.setState({
    sessionCwd: {},
    hmuxSessionMetadata: {},
    sessionAgent: {},
    sessionAgentPin: {},
    sessionAgentRuntimeState: {},
    sessionTitle: {},
  });
});

afterEach(() => {
  cleanup();
});

describe("TerminalPanel", () => {
  it.each(["right", "below"] as const)(
    "reserves a launcher for body split %s without starting a terminal",
    (direction) => {
      const container = document.createElement("div");
      document.body.append(container);
      const api = createDockview(container, {
        createComponent: () => ({
          element: document.createElement("div"),
          init() {},
        }),
      });
      api.layout(1000, 700);
      const params = {
        sessionId: "split-source",
        cwd: "/initial",
        binding: hmuxStandaloneBinding("split-source", "split-workspace"),
      };
      const props = panelProps(params);
      const source = api.addPanel({
        id: props.api.id,
        component: "terminal",
        params,
      });
      useStore.setState({ sessionCwd: { "split-source": "/current directory" } });
      const view = render(<TerminalPanel {...props} containerApi={api} />);
      try {
        act(() => mocks.splitHandler?.(direction));
        expect(api.panels).toHaveLength(2);
        const launcher = api.panels.find((panel) => panel.id !== source.id)!;
        expect(launcher.toJSON().contentComponent).toBe("launcher");
        expect(launcher.params).toEqual({ cwd: "/current directory" });
        expect(launcher.group).not.toBe(source.group);
        expect(api.getPanel(source.id)).toBe(source);
        expect(mocks.startTerminal).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        api.dispose();
        container.remove();
      }
    },
  );

  it("renders the retirement notice instead of a terminal for a legacy binding", () => {
    const rendered = render(
      <TerminalPanel
        {...panelProps({
          sessionId: "legacy-session",
          cwd: "/repo",
          binding: legacyLocalBinding("legacy-session"),
        })}
      />,
    );

    expect(rendered.queryByTestId("terminal")).toBeNull();
    expect(mocks.terminalBindings).toHaveLength(0);
    expect(rendered.getByTestId("retired-legacy-terminal")).toBeTruthy();
  });

  it("persists the Host conversation identity for the next remote managed attachment", () => {
    const stopFence = {
      runnerPrincipal: "runner-user",
      runnerInstance: "runner-instance",
      channelEpoch: "7",
      hostInstanceId: "host-instance",
      terminalEpoch: "terminal-epoch",
    } as const;
    const binding = remoteHmuxManagedBinding(
      "remote-session",
      "remote-workspace",
      "remote-host",
      "bridge-nonce",
      "create-key",
      stopFence,
      "account-codex",
      ".dure/accounts/account-codex",
    );
    const params = {
      sessionId: binding.sessionId,
      binding,
    } satisfies TerminalPanelParams;
    const updateParameters = vi.fn();
    const view = render(
      <TerminalPanel {...panelProps(params, updateParameters)} />,
    );
    const identity = {
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
      ...stopFence,
      revision: "3",
      observedThroughOutputSeq: "42",
      providerId: "codex",
      conversationId: "conversation-123",
      source: "provider_event",
    } as const;

    expect(mocks.providerConversationIdentityHandler).toBeTypeOf("function");
    act(() => mocks.providerConversationIdentityHandler?.(identity, binding));

    const next = updateParameters.mock.calls[
      updateParameters.mock.calls.length - 1
    ]?.[0] as TerminalPanelParams;
    expect(next.binding).toEqual({
      ...binding,
      conversationIdentity: { schemaVersion: 1, ...identity },
    });
    expect(mocks.commitLayout).toHaveBeenCalledOnce();

    view.rerender(
      <TerminalPanel {...panelProps(next, updateParameters)} />,
    );
    expect(
      mocks.terminalBindings[mocks.terminalBindings.length - 1],
    ).toEqual(next.binding);
  });

  it.each(["term:panel-under-test", "slot", "launcher:previous", "agent:previous"])("persists the Host working directory in terminal content at %s", (panelId) => {
    const sessionId = "standalone-session";
    const binding = hmuxStandaloneBinding(sessionId, "workspace-1");
    const params = {
      sessionId,
      binding,
    } satisfies TerminalPanelParams;
    const updateParameters = vi.fn();
    render(<TerminalPanel {...panelProps(params, updateParameters, panelId)} />);

    expect(mocks.workingDirectoryHandler).toBeTypeOf("function");
    act(() =>
      mocks.workingDirectoryHandler?.(
        {
          terminalEpoch: "terminal-1",
          observedThroughOutputSeq: "42",
          path: "/repo/HebbianIDE/.worktrees/task",
          source: "process_inspection",
        },
        binding,
      ),
    );

    expect(updateParameters).toHaveBeenCalledWith({
      ...params,
      cwd: "/repo/HebbianIDE/.worktrees/task",
    });
    expect(mocks.commitDockviewMutation).toHaveBeenCalledOnce();
  });

  it("ignores a retired attachment cwd after an imperative retarget before rerender", () => {
    const sourceBinding = hmuxStandaloneBinding(
      "standalone-source",
      "workspace-source",
    );
    const sourceParams = {
      sessionId: sourceBinding.sessionId,
      binding: sourceBinding,
    } satisfies TerminalPanelParams;
    const updateParameters = vi.fn();
    const props = panelProps(sourceParams, updateParameters);
    render(<TerminalPanel {...props} />);
    const staleWorkingDirectoryHandler = mocks.workingDirectoryHandler;
    const targetBinding = hmuxStandaloneBinding(
      "standalone-target",
      "workspace-target",
    );
    const targetParams = {
      sessionId: targetBinding.sessionId,
      binding: targetBinding,
    } satisfies TerminalPanelParams;

    act(() => props.api.updateParameters(targetParams));
    updateParameters.mockClear();
    mocks.commitDockviewMutation.mockClear();
    act(() =>
      staleWorkingDirectoryHandler?.(
        {
          terminalEpoch: "terminal-source",
          observedThroughOutputSeq: "43",
          path: "/repo/source",
          source: "process_inspection",
        },
        sourceBinding,
      ),
    );

    expect(props.containerApi.getPanel(props.api.id)?.params).toEqual(
      targetParams,
    );
    expect(updateParameters).not.toHaveBeenCalled();
    expect(mocks.commitDockviewMutation).not.toHaveBeenCalled();
  });

  it.each(["term:panel-under-test", "slot", "launcher:previous", "agent:previous"])("promotes idle terminal content at %s through Agent pane conversion", async (panelId) => {
    const sessionId = "standalone-claude";
    const binding = hmuxStandaloneBinding(sessionId, "workspace-claude");
    const request = {
      sourceSessionId: sessionId,
      sourceWorkspaceId: binding.workspaceId,
      panelId,
      target: "managed" as const,
    };
    const prepared = { request, inspection: { providerId: "claude" } };
    mocks.prepareConversion.mockResolvedValue(prepared);
    mocks.commitConversion.mockResolvedValue({ panelId: "agent:promoted" });
    useStore.setState({
      projects: [
        {
          id: "project-1",
          name: "HebbianIDE",
          path: "/repo",
          kind: "local",
          isRepo: true,
        },
      ],
      sessionCwd: { [sessionId]: "/repo/worktree" },
      sessionAgent: { [sessionId]: "claude" },
      sessionAgentRuntimeState: {
        [sessionId]: {
          terminalEpoch: "terminal-1",
          revision: "4",
          observedThroughOutputSeq: "10",
          lifecycle: "running",
          activity: "waiting",
          attention: "none",
          source: "process_lifecycle",
        },
      },
    });
    publishTerminalExecutionLocation(sessionId, { kind: "local" });

    render(
      <TerminalPanel
        {...panelProps({
          sessionId,
          cwd: "/repo/worktree",
          binding,
        }, undefined, panelId)}
      />,
    );

    await waitFor(() =>
      expect(mocks.prepareConversion).toHaveBeenCalledWith(request),
    );
    await waitFor(() =>
      expect(mocks.commitConversion).toHaveBeenCalledWith(prepared),
    );
  });

  it.each(["working", "replaced", "closed", "retargeted"])("does not commit a late automatic promotion after the source is %s", async (change) => {
    const sessionId = "standalone-codex";
    const binding = hmuxStandaloneBinding(sessionId, "workspace-codex");
    let finishPreparation: ((value: unknown) => void) | undefined;
    mocks.prepareConversion.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
    );
    useStore.setState({
      projects: [
        {
          id: "project-1",
          name: "HebbianIDE",
          path: "/repo",
          kind: "local",
          isRepo: true,
        },
      ],
      sessionCwd: { [sessionId]: "/repo/worktree" },
      sessionAgent: { [sessionId]: "codex" },
      sessionAgentRuntimeState: {
        [sessionId]: {
          terminalEpoch: "terminal-1",
          revision: "1",
          observedThroughOutputSeq: "1",
          lifecycle: "running",
          activity: "waiting",
          attention: "none",
          source: "process_lifecycle",
        },
      },
    });
    publishTerminalExecutionLocation(sessionId, { kind: "local" });

    const props = panelProps({ sessionId, cwd: "/repo/worktree", binding });
    render(<TerminalPanel {...props} />);
    await waitFor(() => expect(mocks.prepareConversion).toHaveBeenCalledOnce());

    await act(async () => {
      if (change === "working") useStore.getState().setSessionAgentRuntimeState(sessionId, {
        terminalEpoch: "terminal-1",
        revision: "2",
        observedThroughOutputSeq: "2",
        lifecycle: "running",
        activity: "working",
        attention: "none",
        source: "process_lifecycle",
      });
      if (change === "closed") vi.spyOn(props.containerApi, "getPanel").mockReturnValue(undefined);
      if (change === "replaced") {
        const previous = props.containerApi.getPanel(props.api.id)!;
        vi.spyOn(props.containerApi, "getPanel").mockReturnValue({ ...previous, api: { ...previous.api, component: "launcher" } } as typeof previous);
      }
      if (change === "retargeted") props.api.updateParameters({ sessionId: "new-target", binding: hmuxStandaloneBinding("new-target", "new-workspace") });
      finishPreparation?.({ inspection: { providerId: "codex" } });
      await Promise.resolve();
    });
    expect(mocks.commitConversion).not.toHaveBeenCalled();
  });

  it("routes explicit Hmux termination through the durable pane close journal", async () => {
    render(
      <TerminalPanel
        {...panelProps({
          sessionId: "standalone-session",
          binding: hmuxStandaloneBinding(
            "standalone-session",
            "workspace-1",
          ),
        })}
      />,
    );

    // onKill은 이제 닫기 가드(closePaneWithPinGuard)를 지나므로 비동기다.
    mocks.killHandler?.();

    await waitFor(() =>
      expect(mocks.closePanelById).toHaveBeenCalledWith(
        "term:panel-under-test",
        "desktop-test",
      ),
    );
  });

  it("closes a one-shot command pane only after a successful exit", () => {
    const successProps = panelProps({
      sessionId: "install-success",
      binding: hmuxStandaloneBinding("install-success", "workspace-success"),
      closeOnSuccess: true,
    });
    render(<TerminalPanel {...successProps} />);

    expect(successProps.api.close).not.toHaveBeenCalled();
    act(() => mocks.hmuxExitHandler?.({ exitCode: 0, reason: "completed" }));

    expect(successProps.api.close).toHaveBeenCalledOnce();
  });

  it.each([
    { exitCode: 1, reason: "failed" },
    { exitCode: 130, reason: "interrupted" },
    { reason: "session_exited" },
  ])("keeps a non-successful command pane open for inspection: %j", (receipt) => {
    const failedProps = panelProps({
      sessionId: "install-failed",
      binding: hmuxStandaloneBinding("install-failed", "workspace-failed"),
      closeOnSuccess: true,
    });
    render(<TerminalPanel {...failedProps} />);

    act(() => mocks.hmuxExitHandler?.(receipt));

    expect(failedProps.api.close).not.toHaveBeenCalled();
  });

  it("keeps an ordinary terminal pane open after successful exit", () => {
    const props = panelProps({
      sessionId: "ordinary-terminal",
      binding: hmuxStandaloneBinding("ordinary-terminal", "workspace"),
    });
    render(<TerminalPanel {...props} />);
    act(() => mocks.hmuxExitHandler?.({ exitCode: 0, reason: "completed" }));
    expect(props.api.close).not.toHaveBeenCalled();
  });

  // A remote standalone shell is bound to its SSH host; its title must name
  // that host, not "local". On 2026-09-02 a shell on the WSL host jay-wsl
  // rendered as "local" in the pane header.
  it("titles a remote standalone shell by its SSH host", () => {
    useStore.setState({
      sshHosts: [
        {
          id: "host-1",
          name: "jay-wsl",
          host: "100.109.95.46",
          port: 2222,
          user: "hongj",
          auth: "auto",
        },
      ],
    });
    const props = panelProps({
      sessionId: "standalone_remote",
      cwd: "/home/hongj",
      binding: remoteHmuxStandaloneBinding(
        "standalone_remote",
        "workspace-remote",
        "host-1",
        "nonce-1",
      ),
    });
    render(<TerminalPanel {...props} />);
    expect(props.api.setTitle).toHaveBeenLastCalledWith("jay-wsl · hongj");
  });

  it("replaces the local cwd title with a nested SSH target", () => {
    const props = panelProps({
      sessionId: "workspace-6-pane-3",
      cwd: "/Users/jwan",
      binding: hmuxStandaloneBinding("workspace-6-pane-3", "workspace-6"),
    });
    const view = render(<TerminalPanel {...props} />);
    expect(props.api.setTitle).toHaveBeenLastCalledWith("local · jwan");

    act(() =>
      publishTerminalExecutionLocation("workspace-6-pane-3", {
        kind: "ssh",
        target: "rts@211.181.122.124",
      }),
    );
    view.rerender(<TerminalPanel {...props} />);
    expect(props.api.setTitle).toHaveBeenLastCalledWith("rts@211.181.122.124");

    act(() =>
      publishTerminalExecutionLocation("workspace-6-pane-3", { kind: "local" }),
    );
  });

  it("uses the live terminal title as the automatic Dockview title", () => {
    useStore.setState({
      sessionTitle: { "workspace-title": "Review authentication flow" },
    });
    const props = panelProps({
      sessionId: "workspace-title",
      cwd: "/Users/jwan/project",
      binding: hmuxStandaloneBinding("workspace-title", "workspace-title"),
    });

    render(<TerminalPanel {...props} />);

    expect(props.api.setTitle).toHaveBeenLastCalledWith(
      "Review authentication flow",
    );
  });
});
