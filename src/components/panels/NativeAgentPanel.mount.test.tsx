// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createDockview } from "dockview-react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import { NativeAgentPanel as NativeAgentPanelImpl } from "@/components/panels/NativeAgentPanel";
import { StructuredTerminalRecoveryStatus } from "@/components/terminal/structured/StructuredTerminalRecoveryStatus";
import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { dispatchCliPaneActionRequest } from "@/lib/cli/cliPaneActions";
import { t } from "@/lib/i18n";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import type { TerminalAttachRecovery } from "@/lib/terminal/terminalAttachRecovery";
import { invokePaneAction, paneActionSnapshot, registerPaneActions } from "@/lib/workspace/pane/paneActionRegistry";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent, SshHostConfig } from "@/types";
import { publishConversationTitle } from "@/lib/agents/chat/conversationPresentationState";

const mocks = vi.hoisted(() => ({
	inspectExact: vi.fn(),
	splitHandler: undefined as ((direction: "right" | "below") => void) | undefined,
	startTerminal: vi.fn(),
	ensureLocal: vi.fn(),
	ensureRemote: vi.fn(),
	workflowInspect: vi.fn(),
	workflowRebind: vi.fn(),
	providerInputInspect: vi.fn(),
	terminalEnsures: [] as Array<unknown>,
	terminalProviderHints: [] as Array<"codex" | "claude" | undefined>,
	terminalInputDisabled: [] as boolean[],
	terminalRecoveryVisible: false,
	terminalError: undefined as string | undefined,
	terminalRecoveryPresentationChange: undefined as
		| ((visible: boolean) => void)
		| undefined,
	terminalAttachRecovery: undefined as TerminalAttachRecovery | undefined,
	terminalFallbackDisabled: [] as boolean[],
	exitedResuming: [] as boolean[],
	exitedProps: undefined as Record<string, unknown> | undefined,
	historyProps: undefined as Record<string, unknown> | undefined,
	credentialSwitcherProps: undefined as Record<string, unknown> | undefined,
	accounts: [] as Array<{
		id: string;
		provider: "codex" | "claude";
		name: string;
		dir: string;
	}>,
	activeAccounts: {} as Partial<Record<"codex" | "claude", string>>,
	listConversations: vi.fn(),
	recoverExitedConversation: vi.fn(),
	resumeExactConversation: vi.fn(),
	openRemoteLogin: vi.fn(),
	sshHosts: [] as SshHostConfig[],
	activity: "running" as "running" | "exited",
	terminalTitle: undefined as string | undefined,
	automaticPaneTitle: vi.fn(),
	projectOverride: null as
		| null
		| undefined
		| {
				id: string | undefined;
				name: string;
				path: string;
				kind: "local" | "ssh";
				sshHostId?: string;
				isRepo: boolean;
		  },
}));

vi.mock("@/lib/workspace/dock", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock")>()),
	openLocalTerminalOn: mocks.startTerminal,
	openRemoteSshTerminalOn: mocks.startTerminal,
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionExact: mocks.inspectExact,
}));
vi.mock("@/lib/sessions/managed/managedAgentRuntime", () => ({
	ensureManagedAgentRuntime: mocks.ensureLocal,
}));
vi.mock("@/lib/sessions/launch/remoteManagedAgentRuntime", () => ({
	ensureRemoteManagedAgentRuntime: mocks.ensureRemote,
}));
vi.mock("@/lib/ipc/dureWorkflow", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/ipc/dureWorkflow")>();
	return {
		...original,
		createDureWorkflowTransport: () => ({
			...original.createDureWorkflowTransport(),
			inspectDispatchSession: mocks.workflowInspect,
			rebindDispatchSession: mocks.workflowRebind,
		}),
	};
});
vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeDesktopId: () => undefined,
}));
vi.mock(
	"@/lib/agents/providerConversationInputAuthority",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/agents/providerConversationInputAuthority")
		>()),
		inspectProviderConversationInputAuthority: mocks.providerInputInspect,
	}),
);
vi.mock("@/components/agents/useManagedAgentTerminalFallback", () => ({
	useManagedAgentTerminalFallback: ({ disabled }: { disabled?: boolean }) => {
		mocks.terminalFallbackDisabled.push(disabled ?? false);
		return {
		authoritativeExit: false,
		openingShell: false,
		onHmuxSessionExit: vi.fn(),
		onOpenShell: undefined,
		onTerminalKeyDown: vi.fn(),
		};
	},
}));
vi.mock("@/components/agents/useAgentPaneAttentionAck", () => ({
	useAgentPaneAttentionAck: vi.fn(),
}));
vi.mock("@/components/panels/useRemoteAgentCredentialActions", () => ({
	useRemoteAgentCredentialActions: () => ({
		busy: false,
		openRemoteLogin: mocks.openRemoteLogin,
		copyAccountToHost: vi.fn(),
	}),
}));
vi.mock("@/components/panels/useAgentPanelState", () => ({
	useNativeAgentPanelState: (agent: Agent) => ({
		agentCwd: agent.worktreePath,
		terminalTitle: mocks.terminalTitle,
		activity: mocks.activity,
		agentRuntimeState: undefined,
		sshError: undefined,
		setAgentActivity: vi.fn(),
		accounts: mocks.accounts,
		activeAccounts: mocks.activeAccounts,
		sshHosts: mocks.sshHosts,
		project:
			mocks.projectOverride === null
				? {
						id: agent.projectId,
						name: "Project",
						path: "/repo",
						kind: "local",
						isRepo: true,
					}
				: mocks.projectOverride,
		restartReq: 0,
		getActiveSpaceId: () => undefined,
		getAgentById: () => agent,
		getProjectSshHost: () => undefined,
		getProjectSshHostId: () => undefined,
	}),
}));
vi.mock("@/lib/workspace/performance/workspacePerformance", () => ({
	workspacePerformance: {
		beginPaneOpen: vi.fn(),
		cancelPaneOpen: vi.fn(),
		markPaneReady: vi.fn(),
	},
}));
vi.mock("@/lib/workspace/pane/paneTitleOverrideStore", () => ({
	applyAutomaticPaneTitle: mocks.automaticPaneTitle,
}));
vi.mock("@/lib/sessions/managed/managedConversationLaunch", () => ({
	recoverExitedManagedConversationPane: mocks.recoverExitedConversation,
}));
vi.mock("@/lib/sessions/managed/managedExactConversationResume", () => ({
	resumeExactManagedAgentPane: mocks.resumeExactConversation,
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	homeDir: () => new Promise<string>(() => {}),
	listConversations: mocks.listConversations,
}));

vi.mock("@/components/terminal/TerminalView", () => ({
	TerminalView: (props: {
		paneApi?: { id: string };
		onSplit?: (direction: "right" | "below") => void;
		attachRecovery?: TerminalAttachRecovery;
		ensure?: unknown;
		inputDisabled?: boolean;
		onAttachRecoveryPresentationChange?: (visible: boolean) => void;
		providerHint?: "codex" | "claude";
	}) => {
		mocks.splitHandler = props.onSplit;
		mocks.terminalEnsures.push(props.ensure);
		mocks.terminalProviderHints.push(props.providerHint);
		mocks.terminalInputDisabled.push(props.inputDisabled ?? false);
		mocks.terminalRecoveryPresentationChange =
			props.onAttachRecoveryPresentationChange;
		mocks.terminalAttachRecovery = props.attachRecovery;
		if (typeof props.ensure === "function") {
			void props.ensure(80, 24);
		}
		return (
			<div data-testid="terminal-view">
				{mocks.terminalError && (
					<StructuredTerminalRecoveryStatus
						paneId={props.paneApi?.id}
						error={mocks.terminalError}
						attachRecovery={props.attachRecovery}
					/>
				)}
				{mocks.terminalRecoveryVisible && (
					<div data-testid="structured-attach-recovery" />
				)}
			</div>
		);
	},
}));
vi.mock("@/components/panels/AgentPanelToolbarFrame", () => ({
	AgentPanelToolbarFrame: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/agents/AgentRuntimeProfileSwitch", () => ({
	AgentRuntimeProfileSwitch: ({
		onSwitch,
		disabled,
	}: {
		onSwitch(): Promise<void>;
		disabled?: boolean;
	}) => (
		<button type="button" disabled={disabled} onClick={() => void onSwitch()}>
			profile switch
		</button>
	),
}));
vi.mock("@/components/agents/AgentCredentialSwitcher", () => ({
	AgentCredentialSwitcher: (props: {
		disabled?: boolean;
		failure?: string;
		onSwitch(accountId: string | null): void;
		currentAccount?: { id: string };
		followsGlobal?: boolean;
	}) => {
		mocks.credentialSwitcherProps = props;
		return (
		<button
			type="button"
			disabled={props.disabled}
			data-testid="credential-switch"
			data-failure={props.failure ?? ""}
			onClick={() => props.onSwitch(null)}
		>
			credential switch
		</button>
		);
	},
}));
vi.mock("@/components/agents/AgentConversationHistoryControl", () => ({
	AgentConversationHistoryControl: (props: Record<string, unknown>) => {
		mocks.historyProps = props;
		return null;
	},
}));
vi.mock("@/components/agents/AgentExitedSessionSurface", () => ({
	AgentExitedSessionSurface: (props: Record<string, unknown>) => {
		mocks.exitedProps = props;
		mocks.exitedResuming.push(Boolean(props.resuming));
		return props.structuredAttachRecoveryVisible ? null : (
			<div data-testid="agent-exited-recovery" />
		);
	},
}));
vi.mock("@/components/panels/AgentPanelWindowActions", () => ({
	AgentPanelWindowActions: () => null,
}));
vi.mock("@/components/plugins/AgentPluginClaimStatus", () => ({
	AgentPluginClaimStatus: () => null,
}));
vi.mock("@/components/agents/DelegateTaskControl", () => ({
	DelegateTaskControl: () => null,
}));

function panelProps(agentId: string): AgentPanelDockProps {
	return {
		api: {
			id: `agent:${agentId}`,
			isVisible: true,
			title: agentId,
			close: vi.fn(),
		},
		containerApi: {},
		params: { agentRef: { agentId } },
	} as unknown as AgentPanelDockProps;
}

function launchSelection(): AgentRuntimeLaunchSelectionView {
	return {
		ownerKey: "fixture-runtime",
		loaded: false,
		hydrationError: false,
		model: null,
		effort: null,
		permissionMode: "default",
		switching: false,
		error: null,
		switchSelection: vi.fn(),
		retryHydration: vi.fn(),
		dismissError: vi.fn(),
	};
}

const historyActionLease = {
	busy: false,
	async run(action: () => Promise<void>) {
		await action();
		return true;
	},
};

function NativeAgentPanel(
	props: Omit<
		ComponentProps<typeof NativeAgentPanelImpl>,
		"historyActionLease"
	>,
) {
	return (
		<NativeAgentPanelImpl
			{...props}
			historyActionLease={historyActionLease}
		/>
	);
}

function mountedAgent(index: number): Agent {
	const id = `agent-${index}`;
	const sessionId = `session-${index}`;
	const workspaceId = `workspace-${index}`;
	return agentFixture({
		id,
		name: id,
		sessionId,
		started: true,
		runtimeBinding:
			index % 2 === 0
				? managedBindingFixture({ sessionId, workspaceId })
				: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source: "ssh",
						hostId: "host-1",
						sessionId,
						workspaceId,
						createIdempotencyKey: `create-${index}`,
						commandBridgeNonce: `bridge-${index}`,
					},
	});
}

describe("NativeAgentPanel mount", () => {
	it.each([
		["right", 0],
		["below", 0],
		["right", 1],
		["below", 1],
	] as const)(
		"reserves a launcher for body split %s from agent %i",
		(direction, index) => {
			const previous = useStore.getState();
			const agent = mountedAgent(index);
			useStore.setState({
				agents: [agent],
				sessionCwd: { [agent.sessionId!]: "/current directory" },
			});
			const container = document.createElement("div");
			document.body.append(container);
			const api = createDockview(container, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
			api.layout(1000, 700);
			const props = panelProps(agent.id);
			const source = api.addPanel({ id: props.api.id, component: "agent" });
			const view = render(
				<NativeAgentPanel
					agent={agent}
					backendManaged
					panelProps={{ ...props, api: source.api, containerApi: api }}
					launchSelection={launchSelection()}
					switchCredential={vi.fn()}
					switchToStructuredChat={vi.fn()}
				/>,
			);
			try {
				act(() => mocks.splitHandler?.(direction));
				expect(api.panels).toHaveLength(2);
				const launcher = api.panels.find((panel) => panel.id !== source.id)!;
				expect(launcher.toJSON().contentComponent).toBe("launcher");
				expect(launcher.params).toEqual({
					cwd: "/current directory",
					...(index === 1 ? { hostId: "host-1" } : {}),
				});
				expect(launcher.group).not.toBe(source.group);
				expect(api.getPanel(source.id)).toBe(source);
				expect(mocks.startTerminal).not.toHaveBeenCalled();
			} finally {
				view.unmount();
				api.dispose();
				container.remove();
				useStore.setState(previous);
			}
		},
	);

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.splitHandler = undefined;
		// Most mounted toolbar flows exercise Pro launch pills. Credential
		// switching is also exercised explicitly in Basic below.
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const },
		}));
		mocks.terminalEnsures.length = 0;
		mocks.terminalProviderHints.length = 0;
		mocks.terminalInputDisabled.length = 0;
		mocks.terminalRecoveryVisible = false;
		mocks.terminalError = undefined;
		mocks.terminalRecoveryPresentationChange = undefined;
		mocks.terminalAttachRecovery = undefined;
		mocks.terminalFallbackDisabled.length = 0;
		mocks.exitedResuming.length = 0;
		mocks.exitedProps = undefined;
		mocks.historyProps = undefined;
		mocks.credentialSwitcherProps = undefined;
		mocks.accounts = [];
		mocks.activeAccounts = {};
		mocks.listConversations.mockReset().mockResolvedValue([]);
		mocks.recoverExitedConversation
			.mockReset()
			.mockResolvedValue("conversation-recovered");
		mocks.resumeExactConversation.mockReset().mockResolvedValue({});
		mocks.openRemoteLogin.mockReset().mockResolvedValue(undefined);
		mocks.sshHosts = [];
		mocks.activity = "running";
		mocks.terminalTitle = undefined;
		mocks.projectOverride = null;
		mocks.ensureLocal.mockResolvedValue(undefined);
		mocks.ensureRemote.mockResolvedValue(false);
		mocks.workflowInspect.mockResolvedValue(undefined);
		mocks.workflowRebind.mockResolvedValue(undefined);
		mocks.inspectExact.mockImplementation(
			async (target: { sessionId: string; workspaceId: string }) => ({
				...target,
				sessionName: target.sessionId,
				sessionClass: "managed",
				lifecycle: "ready",
				health: "current_healthy",
				terminalEpoch: "terminal-1",
				outputSeq: "0",
				capabilities: [],
			}),
		);
	});

	it("keeps a launch replacement's exited source out of recovery until settlement", () => {
		mocks.terminalError = "session_exited";
		const agent = { ...mountedAgent(0), conversationId: "conversation-exact" };
		const props = {
			agent,
			backendManaged: true,
			panelProps: panelProps(agent.id),
			switchCredential: vi.fn(),
			switchToStructuredChat: vi.fn(),
		};
		const view = render(
			<NativeAgentPanel
				{...props}
				launchSelection={{ ...launchSelection(), switching: true }}
			/>,
		);
		const terminal = screen.getByTestId("terminal-view");
		expect(screen.queryByText(t("terminal.recovery.title"))).toBeNull();
		expect(paneActionSnapshot(`agent:${agent.id}`)?.actions).not.toContain(
			"resume",
		);
		view.rerender(
			<NativeAgentPanel {...props} launchSelection={launchSelection()} />,
		);
		expect(screen.getByTestId("terminal-view")).toBe(terminal);
		expect(paneActionSnapshot(`agent:${agent.id}`)?.actions).toContain(
			"resume",
		);
	});

	it("keeps the terminal mounted through credential replacement and restores a settled failure", async () => {
		useStore.setState((state) => ({
			accounts: [],
			uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" },
		}));
		let reject!: (error: Error) => void;
		const switchCredential = vi.fn(
			() =>
				new Promise<AgentCredentialTransitionResult>((_resolve, fail) => {
					reject = fail;
				}),
		);
		const agent = { ...mountedAgent(0), conversationId: "conversation-exact" };
		const props = {
			agent,
			backendManaged: true,
			panelProps: panelProps(agent.id),
			switchCredential,
			switchToStructuredChat: vi.fn(),
			launchSelection: launchSelection(),
		};
		const view = render(<NativeAgentPanel {...props} />);
		const terminal = screen.getByTestId("terminal-view");
		fireEvent.click(screen.getByTestId("credential-switch"));
		mocks.terminalError = "session_exited";
		view.rerender(<NativeAgentPanel {...props} />);
		expect(switchCredential).toHaveBeenCalledOnce();
		expect(paneActionSnapshot(`agent:${agent.id}`)?.actions).not.toContain(
			"resume",
		);
		expect(screen.getByTestId("terminal-view")).toBe(terminal);
		await act(async () => reject(new Error("replacement failed")));
		expect(paneActionSnapshot(`agent:${agent.id}`)?.actions).toContain(
			"resume",
		);
		expect(
			screen.getByTestId("credential-switch").getAttribute("data-failure"),
		).toBe("replacement failed");
	});

	it("disables terminal input on exit and restores it with the live lifecycle", () => {
		const agent = mountedAgent(0);
		const props = {
			agent,
			backendManaged: true,
			panelProps: panelProps(agent.id),
			launchSelection: launchSelection(),
			switchCredential: vi.fn(),
			switchToStructuredChat: vi.fn(),
		};
		const view = render(<NativeAgentPanel {...props} />);
		expect(mocks.terminalInputDisabled[mocks.terminalInputDisabled.length - 1]).toBe(false);
		mocks.activity = "exited";
		view.rerender(<NativeAgentPanel {...props} />);
		expect(mocks.terminalInputDisabled[mocks.terminalInputDisabled.length - 1]).toBe(true);
		mocks.activity = "running";
		view.rerender(<NativeAgentPanel {...props} />);
		expect(mocks.terminalInputDisabled[mocks.terminalInputDisabled.length - 1]).toBe(false);
	});

	it("renders one canonical recovery surface for an exited dead attach", () => {
		mocks.activity = "exited";
		mocks.terminalRecoveryVisible = true;
		const agent = {
			...mountedAgent(0),
			conversationId: "conversation-exact",
		};

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);
		act(() => mocks.terminalRecoveryPresentationChange?.(true));

		expect(screen.getByTestId("structured-attach-recovery")).toBeTruthy();
		expect(screen.queryByTestId("agent-exited-recovery")).toBeNull();

		mocks.terminalRecoveryVisible = false;
		act(() => mocks.terminalRecoveryPresentationChange?.(false));
		expect(screen.queryByTestId("structured-attach-recovery")).toBeNull();
		expect(screen.getByTestId("agent-exited-recovery")).toBeTruthy();
	});

	it("wires collision-safe worktree recreation into exact attach recovery", () => {
		const agent = {
			...mountedAgent(0),
			branch: "agent/codex-pane",
			worktreePath: "/repo/.worktrees/codex-pane",
			conversationId: "conversation-exact",
		};

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(mocks.terminalAttachRecovery?.worktree).toEqual(
			expect.objectContaining({
				path: agent.worktreePath,
				branch: agent.branch,
			}),
		);
		expect(mocks.terminalAttachRecovery?.resume).toEqual(expect.any(Function));
		expect(mocks.exitedProps?.attachRecovery).toBe(
			mocks.terminalAttachRecovery,
		);
		expect(mocks.terminalAttachRecovery?.intent).toBe("resume");
		// Mount and attach are projections only. A failed attach must leave the
		// exact Resume action available without starting a replacement Host.
		expect(mocks.terminalAttachRecovery?.automatic).not.toBe(true);
	});

	it("presents an exited Agent without an exact conversation as a fresh start", () => {
		mocks.activity = "exited";
		const agent = mountedAgent(0);

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(mocks.terminalAttachRecovery?.intent).toBe("start_fresh");
		expect(mocks.exitedProps?.attachRecovery).toBe(
			mocks.terminalAttachRecovery,
		);
	});

	it.each([
		["remote_credential_unavailable: remote profile has no credential", true],
		["SSH connection closed", false],
	])("hands an explicit remote start to login only for missing auth (%s)", async (message, needsLogin) => {
		const account = {
			id: "account-remote", provider: "codex" as const,
			name: "Remote account", dir: "/credentials/codex-remote",
		};
		const agent = {
			...mountedAgent(1), provider: "codex" as const, credentialId: account.id,
		};
		mocks.accounts = [account];
		mocks.sshHosts = [{
			id: "host-1", name: "Remote", host: "remote.example.test",
			port: 22, user: "dev", auth: "auto",
		}];
		mocks.projectOverride = {
			id: agent.projectId, name: "Remote project", path: agent.worktreePath,
			kind: "ssh", sshHostId: "host-1", isRepo: false,
		};
		const failure = new Error(message);
		mocks.recoverExitedConversation.mockRejectedValueOnce(failure);
		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged={false}
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);
		expect(mocks.openRemoteLogin).not.toHaveBeenCalled();
		const action = mocks.terminalAttachRecovery!;
		expect(action.intent).toBe("start_fresh");
		await act(async () => {
			await expect(action.resume()).rejects.toBe(failure);
		});
		if (needsLogin) expect(mocks.openRemoteLogin).toHaveBeenCalledWith(account);
		else expect(mocks.openRemoteLogin).not.toHaveBeenCalled();
		expect(mocks.recoverExitedConversation).toHaveBeenCalledOnce();
		await act(async () => { await action.resume(); });
		expect(mocks.recoverExitedConversation).toHaveBeenLastCalledWith({
			agentId: agent.id, panelId: `agent:${agent.id}`, target: { kind: "fresh" },
		});
		expect(mocks.recoverExitedConversation).toHaveBeenCalledTimes(2);
		expect(mocks.openRemoteLogin).toHaveBeenCalledTimes(needsLogin ? 1 : 0);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllEnvs();
	});

	it("direct-attaches 32 local and SSH panes without runtime preflight", () => {
		const agents = Array.from({ length: 32 }, (_, index) =>
			mountedAgent(index),
		);

		render(
			agents.map((agent) => (
				<NativeAgentPanel
					key={agent.id}
					agent={agent}
					backendManaged={false}
					panelProps={panelProps(agent.id)}
					launchSelection={launchSelection()}
					switchCredential={vi.fn()}
					switchToStructuredChat={vi.fn()}
				/>
			)),
		);

		expect(mocks.terminalEnsures).toHaveLength(32);
		expect(mocks.terminalEnsures.every((ensure) => ensure === undefined)).toBe(
			true,
		);
		expect(mocks.terminalProviderHints).toEqual(
			agents.map((agent) => agent.provider),
		);
		expect(mocks.inspectExact).not.toHaveBeenCalled();
		expect(mocks.ensureLocal).not.toHaveBeenCalled();
		expect(mocks.ensureRemote).not.toHaveBeenCalled();
		expect(mocks.workflowInspect).not.toHaveBeenCalled();
		expect(mocks.workflowRebind).not.toHaveBeenCalled();
		expect(mocks.providerInputInspect).not.toHaveBeenCalled();
	});

	it("uses the live terminal title as the native Agent Dockview title", () => {
		const agent = mountedAgent(0);
		const props = panelProps(agent.id);
		mocks.terminalTitle = "Review authentication flow";

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={props}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(mocks.automaticPaneTitle).toHaveBeenLastCalledWith(
			props.api,
			"Review authentication flow",
		);
	});

	it("uses the provider conversation title as the native Agent Dockview title", () => {
		const agent = {
			...mountedAgent(0),
			name: "codex-10",
			displayName: "codex-10",
			conversationId: "thread-native-title",
		};
		const props = panelProps(agent.id);
		publishConversationTitle(agent.id, "clean code");

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={props}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(mocks.automaticPaneTitle).toHaveBeenLastCalledWith(
			props.api,
			"clean code",
		);
	});

	it("keeps an explicit Agent display name ahead of the terminal title", () => {
		const agent = { ...mountedAgent(0), displayName: "fix-uiux" };
		const props = panelProps(agent.id);
		mocks.terminalTitle = "Review authentication flow";

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={props}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(mocks.automaticPaneTitle).toHaveBeenLastCalledWith(
			props.api,
			"fix-uiux",
		);
	});

	it("keeps Pro toolbar actions selectable in development", () => {
		const agent = mountedAgent(0);

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }),
		).toBeTruthy();
		expect(
			screen.getByRole("combobox", { name: t("agents.chat.effortLabel") }),
		).toBeTruthy();
		expect(
			screen.getByRole("combobox", { name: t("agents.chat.permissionLabel") }),
		).toBeTruthy();
	});

	it("keeps Pro toolbar actions folded when a Basic-only build receives direct store pro", () => {
		vi.stubEnv("VITE_DURE_INTERFACE_MODE_POLICY", "basic-only");
		const agent = mountedAgent(0);

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("combobox", { name: t("agents.chat.modelLabel") }),
		).toBeNull();
		expect(
			screen.queryByRole("combobox", { name: t("agents.chat.effortLabel") }),
		).toBeNull();
		expect(
			screen.queryByRole("combobox", {
				name: t("agents.chat.permissionLabel"),
			}),
		).toBeNull();
	});

	it("does not require legacy conversation identity for a structured credential action", () => {
		const agent = mountedAgent(0);

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(
			(screen.getByTestId("credential-switch") as HTMLButtonElement).disabled,
		).toBe(false);
	});

	it("loads terminal Recent Work from the committed credential profile", async () => {
		const account = {
			id: "account-work",
			provider: "codex" as const,
			name: "Work",
			dir: "/home/user/.dure/accounts/codex-work",
		};
		mocks.accounts = [account];
		const agent = {
			...mountedAgent(0),
			credentialId: "stale-account-id",
			executionProfile: {
				kind: "credential_reference" as const,
				reference_id: account.id,
				credential_generation: "generation-work",
			},
		};

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);
		const onLoad = mocks.historyProps?.onLoad;
		if (typeof onLoad !== "function") {
			throw new Error("history control did not expose a load callback");
		}
		await act(async () => onLoad());

		expect(mocks.listConversations).toHaveBeenCalledWith(
			agent.worktreePath,
			agent.provider,
			{ referenceId: account.id, directory: account.dir },
		);
	});

	it("projects the committed runtime credential after the global account changes", () => {
		const accountA = {
			id: "account-a",
			provider: "codex" as const,
			name: "A",
			dir: "/home/user/.dure/accounts/codex-a",
		};
		const accountB = {
			id: "account-b",
			provider: "codex" as const,
			name: "B",
			dir: "/home/user/.dure/accounts/codex-b",
		};
		mocks.accounts = [accountA, accountB];
		mocks.activeAccounts = { codex: accountB.id };
		const agent = {
			...mountedAgent(0),
			accountId: undefined,
			executionProfile: {
				kind: "credential_reference" as const,
				reference_id: accountA.id,
				credential_generation: "generation-a",
			},
		};
		const switchToStructuredChat = vi.fn().mockResolvedValue(undefined);

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={switchToStructuredChat}
			/>,
		);

		expect(mocks.credentialSwitcherProps?.currentAccount).toBe(accountA);
		expect(mocks.credentialSwitcherProps?.followsGlobal).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "profile switch" }));
		expect(switchToStructuredChat).toHaveBeenCalledWith(
			agent.id,
			accountA.id,
			undefined,
			undefined,
		);
	});

	it("clears a transient Recent Work error after a successful retry", async () => {
		mocks.listConversations
			.mockRejectedValueOnce(new Error("history temporarily unavailable"))
			.mockResolvedValueOnce([]);
		const agent = mountedAgent(0);
		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		const firstLoad = mocks.historyProps?.onLoad;
		if (typeof firstLoad !== "function") {
			throw new Error("history control did not expose a load callback");
		}
		act(() => firstLoad());
		expect((await screen.findByRole("alert")).textContent).toContain(
			"history temporarily unavailable",
		);

		const retry = mocks.historyProps?.onLoad;
		if (typeof retry !== "function") {
			throw new Error("history control did not expose a retry callback");
		}
		act(() => retry());
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("keeps the newest Recent Work result when an older request fails late", async () => {
		let rejectFirst: (error: Error) => void;
		let resolveSecond: (
			value: Array<{ id: string; title: string; mtime: number }>,
		) => void;
		const first = new Promise<never>((_, reject) => {
			rejectFirst = reject;
		});
		const second = new Promise<
			Array<{ id: string; title: string; mtime: number }>
		>((resolve) => {
			resolveSecond = resolve;
		});
		mocks.listConversations
			.mockReturnValueOnce(first)
			.mockReturnValueOnce(second);
		const agent = mountedAgent(0);
		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);
		const onLoad = mocks.historyProps?.onLoad;
		if (typeof onLoad !== "function") {
			throw new Error("history control did not expose a load callback");
		}
		act(() => {
			onLoad();
			onLoad();
		});
		await act(async () => {
			resolveSecond!([{ id: "newest", title: "Newest", mtime: 2 }]);
			await second;
		});
		await waitFor(() =>
			expect(mocks.historyProps?.conversations).toEqual([
				{ id: "newest", title: "Newest", mtime: 2 },
			]),
		);

		await act(async () => {
			rejectFirst!(new Error("stale history failure"));
			await first.catch(() => undefined);
		});
		expect(mocks.historyProps?.conversations).toEqual([
			{ id: "newest", title: "Newest", mtime: 2 },
		]);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("lets the user dismiss a terminal conversation-history error", async () => {
		const agent = mountedAgent(0);
		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);
		const onError = mocks.historyProps?.onError;
		if (typeof onError !== "function") {
			throw new Error("history control did not expose an error callback");
		}
		act(() => onError("history launch failed"));

		expect(screen.getByRole("alert").textContent).toContain(
			"history launch failed",
		);
		fireEvent.click(
			screen.getByRole("button", { name: t("common.close") }),
		);
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("hides managed launch actions from a standalone Hmux pane", () => {
		const agent = agentFixture({
			id: "standalone-agent",
			name: "standalone-agent",
			sessionId: "standalone-session",
			started: true,
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_standalone_v1",
				source: "local",
				hostId: "local",
				sessionId: "standalone-session",
				workspaceId: "standalone-workspace",
			},
		});

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged={false}
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("combobox", { name: t("agents.chat.modelLabel") }),
		).toBeNull();
		expect(
			screen.queryByRole("combobox", { name: t("agents.chat.effortLabel") }),
		).toBeNull();
		expect(
			screen.queryByRole("combobox", { name: t("agents.chat.permissionLabel") }),
		).toBeNull();
	});

	it("serializes credential and profile actions behind a launch replacement", () => {
		const agent = {
			...mountedAgent(0),
			conversationId: "conversation-0",
		};

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={{ ...launchSelection(), switching: true }}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		expect(
			(
				screen.getByRole("button", {
					name: "credential switch",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "profile switch",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			mocks.terminalInputDisabled[mocks.terminalInputDisabled.length - 1],
		).toBe(true);
		expect(
			mocks.terminalFallbackDisabled[mocks.terminalFallbackDisabled.length - 1],
		).toBe(true);
		expect(mocks.exitedResuming[mocks.exitedResuming.length - 1]).toBe(true);
	});

	it("attempts exact Resume before loading historical conversations", async () => {
		let resolveRecovery!: () => void;
		const recovery = new Promise<void>((resolve) => {
			resolveRecovery = () => resolve();
		});
		mocks.activity = "exited";
		mocks.resumeExactConversation.mockReturnValueOnce(recovery);
		const agent = {
			...mountedAgent(0),
			conversationId: "conversation-exact",
		};

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);
		const attachRecovery = mocks.exitedProps
			?.attachRecovery as TerminalAttachRecovery;
		if (!attachRecovery) {
			throw new Error("exited surface did not expose attach recovery");
		}
		let resumePromise: Promise<unknown> | undefined;
		act(() => {
			resumePromise = attachRecovery.resume();
		});

		await waitFor(() => {
			expect(mocks.exitedProps?.resuming).toBe(true);
			expect(mocks.credentialSwitcherProps?.disabled).toBe(true);
			expect(
				(screen.getByRole("button", { name: "profile switch" }) as HTMLButtonElement)
					.disabled,
			).toBe(true);
		});
		expect(mocks.listConversations).not.toHaveBeenCalled();
		expect(mocks.resumeExactConversation).toHaveBeenCalledWith(
			agent.id,
			`agent:${agent.id}`,
			"conversation-exact",
		);

		resolveRecovery();
		await act(async () => {
			await resumePromise;
		});
		expect(mocks.exitedProps?.resuming).toBe(false);
	});

	it("does not cancel an attempted Resume when the UI runtime owner changes", async () => {
		let resolveRecovery!: () => void;
		const recovery = new Promise<void>((resolve) => {
			resolveRecovery = () => resolve();
		});
		mocks.activity = "exited";
		mocks.resumeExactConversation.mockReturnValueOnce(recovery);
		const agent = {
			...mountedAgent(0),
			conversationId: "conversation-exact",
		};
		const rendered = render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);
		const attachRecovery = mocks.exitedProps
			?.attachRecovery as TerminalAttachRecovery;
		if (!attachRecovery) {
			throw new Error("exited surface did not expose attach recovery");
		}
		let resumePromise!: Promise<unknown>;
		act(() => {
			resumePromise = attachRecovery.resume();
		});
		await waitFor(() =>
			expect(mocks.resumeExactConversation).toHaveBeenCalledOnce(),
		);

		const replacementSessionId = `${agent.sessionId}-credential-replacement`;
		const replacement = {
			...agent,
			sessionId: replacementSessionId,
			executionProfile: { kind: "provider_default" as const },
			runtimeBinding: {
				...agent.runtimeBinding!,
				sessionId: replacementSessionId,
			},
		};
		rendered.rerender(
			<NativeAgentPanel
				agent={replacement}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		resolveRecovery();
		await expect(resumePromise).resolves.toBeUndefined();
		expect(mocks.listConversations).not.toHaveBeenCalled();
	});

	it("drops a late credential failure after the native runtime is replaced", async () => {
		const agent = {
			...mountedAgent(0),
			conversationId: "conversation-0",
		};
		const rejectSwitches: Array<(error: Error) => void> = [];
		const switchCredential = vi.fn(
			() =>
				new Promise<AgentCredentialTransitionResult>((_, reject) => {
					rejectSwitches.push(reject);
				}),
		);
		const rendered = render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={switchCredential}
				switchToStructuredChat={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByTestId("credential-switch"));
		expect(switchCredential).toHaveBeenCalledWith(agent.id, null);

		const replacementSessionId = `${agent.sessionId}-replacement`;
		const replacement = {
			...agent,
			sessionId: replacementSessionId,
			runtimeBinding: {
				...agent.runtimeBinding!,
				sessionId: replacementSessionId,
			},
		};
		rendered.rerender(
			<NativeAgentPanel
				agent={replacement}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={switchCredential}
				switchToStructuredChat={vi.fn()}
			/>,
		);
		const credentialSwitch = () =>
			screen.getByTestId("credential-switch") as HTMLButtonElement;
		expect(credentialSwitch().disabled).toBe(false);
		fireEvent.click(credentialSwitch());
		expect(switchCredential).toHaveBeenCalledTimes(2);
		expect(credentialSwitch().disabled).toBe(true);
		await act(async () => {
			rejectSwitches[0]?.(new Error("stale credential failure"));
			await Promise.resolve();
		});

		expect(credentialSwitch().disabled).toBe(true);
		expect(credentialSwitch().dataset.failure).toBe("");
		await act(async () => {
			rejectSwitches[1]?.(new Error("current credential failure"));
			await Promise.resolve();
		});
		expect(credentialSwitch().disabled).toBe(false);
		expect(credentialSwitch().dataset.failure).toContain(
			"current credential failure",
		);
	});

	it("exposes and completes the Chat action while cached project routing is absent", () => {
		const agent = mountedAgent(0);
		const switchToStructuredChat = vi.fn().mockResolvedValue(undefined);
		mocks.projectOverride = undefined;

		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={switchToStructuredChat}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "profile switch" }));

		expect(switchToStructuredChat).toHaveBeenCalledWith(
			agent.id,
			null,
			undefined,
			undefined,
		);
	});
});

describe("NativeAgentPanel runtime switch action", () => {
	afterEach(cleanup);

	it.each(["runtime", "conversation", "name"])(
		"keeps a claimed profile switch on its committed recipient (%s)",
		async (change) => {
			const agent = {
				...mountedAgent(0),
				conversationId: "original-conversation",
			};
			const next =
				change === "runtime"
					? {
							...agent,
							sessionId: "replacement-session",
							runtimeBinding: managedBindingFixture({
								sessionId: "replacement-session",
							}),
						}
					: change === "conversation"
						? { ...agent, conversationId: "replacement-conversation" }
						: { ...agent, name: "updated name" };
			const switchToStructuredChat = vi.fn().mockResolvedValue(undefined);
			const originalProps = panelProps(agent.id);
			const paneId = "pane-native-profile-claim";
			const props = {
				agent,
				backendManaged: true,
				panelProps: {
					...originalProps,
					api: { ...originalProps.api, id: paneId },
				} as AgentPanelDockProps,
				launchSelection: launchSelection(),
				switchCredential: vi.fn(),
				switchToStructuredChat,
			};
			const view = render(<NativeAgentPanel {...props} />);
			const removeStatus = registerPaneActions({
				paneId,
				owner: {},
				status: "attached",
				actions: {},
			});
			const complete = vi.fn(async () => {});
			try {
				await dispatchCliPaneActionRequest(
					{
						reqId: "native-profile-claim",
						action: "pane.act",
						params: { targetPanelId: paneId, actionId: "switch_runtime:chat" },
					},
					{
						claim: async () => {
							act(() =>
								view.rerender(<NativeAgentPanel {...props} agent={next} />),
							);
							return true;
						},
						complete,
						isFallbackWindow: () => false,
						delay: async () => {},
					},
				);
			} finally {
				removeStatus();
			}
			if (change === "name") {
				expect(switchToStructuredChat).toHaveBeenCalledExactlyOnceWith(
					agent.id,
					null,
					"preserve",
					undefined,
				);
				expect(complete).toHaveBeenCalledWith(
					"native-profile-claim",
					expect.objectContaining({ ok: true }),
					"pane.act",
				);
			} else {
				expect(switchToStructuredChat).not.toHaveBeenCalled();
				expect(complete).toHaveBeenCalledWith(
					"native-profile-claim",
					{ ok: false, error: expect.objectContaining({ code: "pane_changed" }) },
					"pane.act",
				);
			}
		},
	);

	it("exposes the toolbar's Switch to Chat as switch_runtime:chat with preserve", async () => {
		const agent = mountedAgent(0);
		const switchToStructuredChat = vi.fn().mockResolvedValue(undefined);
		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={switchToStructuredChat}
			/>,
		);
		await expect(invokePaneAction(`agent:${agent.id}`, "switch_runtime:chat")).resolves.toEqual({
			ok: true,
			paneId: `agent:${agent.id}`,
			action: "switch_runtime:chat",
		});
		expect(switchToStructuredChat).toHaveBeenCalledWith(
			agent.id,
			null,
			"preserve",
			undefined,
		);
	});

	it("treats the explicit pane action as authority to replace a retained idle source", async () => {
		const agent = mountedAgent(0);
		const retained = new DureAgentRuntimeSourceActiveError(
			new DureBackendRequestError(
				"agent_runtime_source_retained",
				"source retained",
				{ kind: "operation", disposition: "terminal" },
			),
			7,
		);
		const switchToStructuredChat = vi
			.fn()
			.mockRejectedValueOnce(retained)
			.mockResolvedValueOnce(undefined);
		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={switchToStructuredChat}
			/>,
		);

		await expect(
			invokePaneAction(`agent:${agent.id}`, "switch_runtime:chat"),
		).resolves.toEqual({
			ok: true,
			paneId: `agent:${agent.id}`,
			action: "switch_runtime:chat",
		});
		expect(switchToStructuredChat).toHaveBeenNthCalledWith(
			1,
			agent.id,
			null,
			"preserve",
			undefined,
		);
		expect(switchToStructuredChat).toHaveBeenNthCalledWith(
			2,
			agent.id,
			null,
			"discard",
			7,
		);
	});

	it("does not offer the chat switch for a pane without backend management", async () => {
		const agent = mountedAgent(1);
		render(
			<NativeAgentPanel
				agent={agent}
				backendManaged={false}
				panelProps={panelProps(agent.id)}
				launchSelection={launchSelection()}
				switchCredential={vi.fn()}
				switchToStructuredChat={vi.fn()}
			/>,
		);
		await expect(invokePaneAction(`agent:${agent.id}`, "switch_runtime:chat")).resolves.toMatchObject({
			ok: false,
		});
	});
});
