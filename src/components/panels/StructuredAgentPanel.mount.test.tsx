// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import { AgentUsageLimitHandoffHost } from "@/components/agents/chat/AgentUsageLimitHandoffHost";
import { StructuredAgentPanel as StructuredAgentPanelImpl } from "@/components/panels/StructuredAgentPanel";
import * as credentialTransition from "@/lib/agents/agentCredentialTransition";
import * as usageResume from "@/lib/agents/chat/resumeUsageLimitTurn";
import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { dispatchCliPaneActionRequest } from "@/lib/cli/cliPaneActions";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { publishConversationTitle } from "@/lib/agents/chat/conversationPresentationState";
import {
	invokePaneAction,
	paneActionSnapshot,
} from "@/lib/workspace/pane/paneActionRegistry";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import type { Project } from "@/types";

const mocks = vi.hoisted(() => ({
	chatHook: vi.fn(),
	chatProps: undefined as Record<string, unknown> | undefined,
	historyProps: undefined as Record<string, unknown> | undefined,
	accountProps: undefined as Record<string, unknown> | undefined,
	profileProps: undefined as Record<string, unknown> | undefined,
	project: undefined as Project | undefined,
	accounts: [] as Array<{
		id: string;
		provider: "codex" | "claude";
		name: string;
		dir: string;
	}>,
	listConversations: vi.fn(),
	sshListConversations: vi.fn(),
	setAgentActivity: vi.fn(),
	automaticPaneTitle: vi.fn(),
	usageRecent: vi.fn(),
	chatSend: vi.fn(),
	autoSwitch: true,
}));

vi.mock("@/components/agents/chat/useAgentChatSession", () => ({
	useAgentChatSession: mocks.chatHook,
}));
vi.mock("@/lib/agents/agentCredentialTransition", () => ({
	requestAgentCredentialTransition: vi.fn(),
}));
vi.mock("@/lib/agents/agentRuntimeTransitionAction", () => ({
	recoverStructuredAgentRuntimeProjection: vi.fn(),
}));
vi.mock("@/components/panels/useAgentPanelState", () => ({
	useAutoSwitchAccounts: () => mocks.autoSwitch,
	useStructuredAgentPanelState: (agent: { worktreePath: string }) => ({
		agentCwd: agent.worktreePath,
		project: mocks.project,
		accounts: mocks.accounts,
		sshHosts: [],
		setAgentActivity: mocks.setAgentActivity,
		getActiveSpaceId: () => "desktop-1",
	}),
}));
vi.mock("@/lib/ipc", () => ({
	hostToOpts: vi.fn(),
	listConversations: mocks.listConversations,
	sshListConversations: mocks.sshListConversations,
	usageRecent: mocks.usageRecent,
}));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeDesktopId: () => "desktop-1",
}));
vi.mock("@/components/panels/useRemoteAgentCredentialActions", () => ({
	useRemoteAgentCredentialActions: () => ({
		busy: false,
		openRemoteLogin: vi.fn(),
		copyAccountToHost: vi.fn(),
	}),
}));
vi.mock("@/components/agents/useAgentPaneAttentionAck", () => ({
	useAgentPaneAttentionAck: vi.fn(),
}));
vi.mock("@/components/panels/AgentPanelToolbarFrame", () => ({
	AgentPanelToolbarFrame: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/agents/AgentConversationHistoryControl", () => ({
	AgentConversationHistoryControl: (props: Record<string, unknown>) => {
		mocks.historyProps = props;
		return <div data-testid="conversation-history" />;
	},
}));
vi.mock("@/components/agents/chat/StructuredAgentChatSurface", () => ({
	StructuredAgentChatSurface: (props: Record<string, unknown>) => {
		mocks.chatProps = props;
		return <div data-testid="structured-chat" />;
	},
}));
vi.mock("@/components/agents/AccountsDialog", () => ({
	AccountsDialog: () => null,
}));
vi.mock("@/components/agents/AgentCredentialSwitcher", () => ({
	AgentCredentialSwitcher: (props: Record<string, unknown>) => {
		mocks.accountProps = props;
		return null;
	},
}));
vi.mock("@/components/agents/AgentRuntimeProfileSwitch", () => ({
	AgentRuntimeProfileSwitch: (props: Record<string, unknown>) => {
		mocks.profileProps = props;
		return null;
	},
}));
vi.mock("@/components/panels/AgentPanelWindowActions", () => ({
	AgentPanelWindowActions: () => null,
}));
vi.mock("@/components/plugins/AgentPluginClaimStatus", () => ({
	AgentPluginClaimStatus: () => null,
}));
vi.mock("@/lib/workspace/pane/paneTitleOverrideStore", () => ({
	applyAutomaticPaneTitle: mocks.automaticPaneTitle,
}));
vi.mock("@/lib/workspace/performance/workspacePerformance", () => ({
	workspacePerformance: {
		beginPaneOpen: vi.fn(),
		cancelPaneOpen: vi.fn(),
		markPaneReady: vi.fn(),
	},
}));

const profile: AgentStructuredInteractionProfileV1 = {
	schemaVersion: 1,
	kind: "structured_protocol",
	backendProfileId: "local",
	interactionSessionId: "interaction-1",
};

const agent = agentFixture({
	id: "agent-1",
	projectId: "project-1",
	worktreePath: "/repo",
	runtimeBinding: undefined,
	interactionProfile: profile,
	conversationId: "conversation-1",
});

const launchSelection: AgentRuntimeLaunchSelectionView = {
	ownerKey: "fixture-runtime",
	loaded: true,
	hydrationError: false,
	model: "gpt-5.6-sol",
	effort: "high",
	permissionMode: "default",
	switching: false,
	error: null,
	switchSelection: vi.fn(),
	retryHydration: vi.fn(),
	dismissError: vi.fn(),
};

const panelProps = {
	api: {
		id: "agent:agent-1",
		isVisible: true,
		title: "Agent",
	},
	containerApi: {},
	params: {},
} as unknown as AgentPanelDockProps;

const historyActionLease = {
	busy: false,
	async run(action: () => Promise<void>) {
		await action();
		return true;
	},
};

function StructuredAgentPanel(
	props: Omit<
		ComponentProps<typeof StructuredAgentPanelImpl>,
		"historyActionLease"
	>,
) {
	return (
		<StructuredAgentPanelImpl
			{...props}
			historyActionLease={historyActionLease}
		/>
	);
}

describe("StructuredAgentPanel mount", () => {
	beforeEach(() => {
		mocks.chatProps = undefined;
		mocks.historyProps = undefined;
		mocks.accountProps = undefined;
		mocks.profileProps = undefined;
		mocks.project = {
			id: "project-1",
			name: "Project",
			path: "/repo",
			kind: "local",
			isRepo: true,
		};
		mocks.accounts = [];
		mocks.listConversations.mockReset().mockResolvedValue([]);
		mocks.sshListConversations.mockReset().mockResolvedValue([]);
		mocks.chatHook.mockReset().mockReturnValue({
			phase: "ready",
			reconnecting: false,
			sending: false,
			interrupting: false,
			answeringRequestId: undefined,
			activeTurn: undefined,
		});
		mocks.setAgentActivity.mockReset();
		mocks.automaticPaneTitle.mockReset();
	});

	afterEach(cleanup);

	it("connects runtime invalidation and the shared conversation history control", () => {
		const onRuntimeInvalidated = vi.fn();

		render(
			<StructuredAgentPanel
				agent={agent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={onRuntimeInvalidated}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);

		expect(screen.getByTestId("structured-chat")).toBeTruthy();
		expect(screen.getByTestId("conversation-history")).toBeTruthy();
		expect(mocks.chatHook).toHaveBeenCalledWith(
			agent.id,
			profile,
			onRuntimeInvalidated,
		);
		expect(mocks.historyProps).toMatchObject({
			activeConversationId: "conversation-1",
			activity: "waiting",
			agent,
			binding: undefined,
			paneDesktopId: "desktop-1",
			panelId: "agent:agent-1",
			projectKind: "local",
		});
		expect(mocks.chatProps?.attachmentsEnabled).toBe(true);
	});

	it("registers the chat pane's status and exact interrupt handler as named pane actions", async () => {
		const interrupt = vi.fn().mockResolvedValue(undefined);
		mocks.chatHook.mockReturnValue({
			phase: "ready",
			reconnecting: false,
			sending: false,
			interrupting: false,
			answeringRequestId: undefined,
			activeTurn: { turnId: "turn-1" },
			interrupt,
		});

		render(
			<StructuredAgentPanel
				agent={agent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);

		// `dure client pane state agent:agent-1` reads this snapshot; before the
		// registration it answered pane_not_found for a pane that is on screen.
		expect(paneActionSnapshot("agent:agent-1")).toEqual({
			paneId: "agent:agent-1",
			status: "turn_active",
			context:
				"agent=agent-1 pane=agent:agent-1 session=interaction-1 conversation=conversation-1",
			actions: ["interrupt", "switch_runtime:terminal"],
		});
		await expect(invokePaneAction("agent:agent-1", "interrupt")).resolves.toEqual(
			{ ok: true, paneId: "agent:agent-1", action: "interrupt" },
		);
		expect(interrupt).toHaveBeenCalledTimes(1);

		cleanup();
		expect(paneActionSnapshot("agent:agent-1")).toBeUndefined();
	});

	it("registers an idle chat pane with no actions", () => {
		render(
			<StructuredAgentPanel
				agent={agent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);

		expect(paneActionSnapshot("agent:agent-1")).toMatchObject({
			status: "idle",
			actions: ["switch_runtime:terminal"],
		});
	});

	it("uses the provider conversation title as the structured pane title", () => {
		const titledAgent = { ...agent, id: "agent-thread-title" };

		render(
			<StructuredAgentPanel
				agent={titledAgent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);
		act(() => {
			publishConversationTitle(titledAgent.id, "Review authentication flow");
		});

		expect(mocks.automaticPaneTitle).toHaveBeenLastCalledWith(
			panelProps.api,
			"Review authentication flow",
		);
	});

	it("keeps an explicit Agent display name ahead of a conversation title", () => {
		const titledAgent = {
			...agent,
			id: "agent-explicit-title",
			displayName: "fix-uiux",
		};

		render(
			<StructuredAgentPanel
				agent={titledAgent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);
		act(() => {
			publishConversationTitle(titledAgent.id, "Review authentication flow");
		});

		expect(mocks.automaticPaneTitle).toHaveBeenLastCalledWith(
			panelProps.api,
			"fix-uiux",
		);
	});

	it("disables local-path attachments for a remote execution project", () => {
		mocks.project = {
			id: "project-1",
			name: "Remote Project",
			path: "/repo",
			kind: "ssh",
			sshHostId: "host-1",
			isRepo: true,
		};

		render(
			<StructuredAgentPanel
				agent={agent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);

		expect(mocks.chatProps?.attachmentsEnabled).toBe(false);
	});

	it("keeps account and terminal switches available while chat reconnects", () => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const },
		}));
		mocks.accounts = [
			{
				id: "account-a",
				provider: "codex",
				name: "A",
				dir: "/home/user/.dure/accounts/codex-a",
			},
			{
				id: "account-b",
				provider: "codex",
				name: "B",
				dir: "/home/user/.dure/accounts/codex-b",
			},
		];
		mocks.chatHook.mockReturnValue({
			phase: "connecting",
			reconnecting: true,
			sending: false,
			interrupting: false,
			answeringRequestId: undefined,
			activeTurn: undefined,
		});

		render(
			<StructuredAgentPanel
				agent={agent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);

		expect(mocks.accountProps).toMatchObject({
			allowCurrentAccountReselect: true,
			disabled: false,
		});
		expect(mocks.profileProps).toMatchObject({ disabled: false });
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" as const },
		}));
	});

	it("keeps the terminal escape available while a stale active turn reconnects", () => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const },
		}));
		mocks.chatHook.mockReturnValue({
			phase: "connecting",
			reconnecting: true,
			sending: false,
			interrupting: false,
			answeringRequestId: undefined,
			activeTurn: {
				turnId: "turn-stale",
				clientMessageId: "message-stale",
			},
		});

		render(
			<StructuredAgentPanel
				agent={agent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);

		expect(mocks.profileProps).toMatchObject({ disabled: false });
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" as const },
		}));
	});

	it("lets the user dismiss a conversation-history launch error", () => {
		render(
			<StructuredAgentPanel
				agent={agent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);
		const onHistoryError = mocks.historyProps?.onError;
		if (typeof onHistoryError !== "function") {
			throw new Error("history control did not expose an error callback");
		}
		act(() => {
			onHistoryError("history launch failed");
		});

		expect(screen.getByRole("alert").textContent).toContain(
			"history launch failed",
		);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("loads Recent Work from the committed credential profile", async () => {
		const account = {
			id: "acc-work",
			provider: "codex" as const,
			name: "Work",
			dir: "/home/user/.dure/accounts/codex-work",
		};
		mocks.accounts = [account];
		const credentialAgent = {
			...agent,
			credentialId: account.id,
			executionProfile: {
				kind: "credential_reference" as const,
				reference_id: account.id,
				credential_generation: "credential-work-1",
			},
		};

		render(
			<StructuredAgentPanel
				agent={credentialAgent}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);
		const onLoad = mocks.historyProps?.onLoad;
		if (typeof onLoad !== "function") {
			throw new Error("history control did not expose a load callback");
		}
		act(() => onLoad());

		await waitFor(() =>
			expect(mocks.listConversations).toHaveBeenCalledWith(
				credentialAgent.worktreePath,
				credentialAgent.provider,
				{ referenceId: account.id, directory: account.dir },
			),
		);
	});

	it("rejects a late Recent Work result from the replaced credential runtime", async () => {
		let resolveAccountA: (
			value: Array<{ id: string; title: string; mtime: number }>,
		) => void;
		let resolveAccountB: (
			value: Array<{ id: string; title: string; mtime: number }>,
		) => void;
		const accountAResult = new Promise<
			Array<{ id: string; title: string; mtime: number }>
		>((resolve) => {
			resolveAccountA = resolve;
		});
		const accountBResult = new Promise<
			Array<{ id: string; title: string; mtime: number }>
		>((resolve) => {
			resolveAccountB = resolve;
		});
		mocks.listConversations
			.mockReturnValueOnce(accountAResult)
			.mockReturnValueOnce(accountBResult);
		mocks.accounts = [
			{
				id: "account-a",
				provider: "codex",
				name: "A",
				dir: "/home/user/.dure/accounts/codex-a",
			},
			{
				id: "account-b",
				provider: "codex",
				name: "B",
				dir: "/home/user/.dure/accounts/codex-b",
			},
		];
		const accountAgent = (referenceId: string, generation: string) => ({
			...agent,
			credentialId: referenceId,
			executionProfile: {
				kind: "credential_reference" as const,
				reference_id: referenceId,
				credential_generation: generation,
			},
		});
		const rendered = render(
			<StructuredAgentPanel
				agent={accountAgent("account-a", "generation-a")}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);
		const loadAccountA = mocks.historyProps?.onLoad;
		if (typeof loadAccountA !== "function") {
			throw new Error("history control did not expose a load callback");
		}
		act(() => loadAccountA());

		rendered.rerender(
			<StructuredAgentPanel
				agent={accountAgent("account-b", "generation-b")}
				profile={profile}
				panelProps={panelProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={vi.fn()}
			/>,
		);
		const loadAccountB = mocks.historyProps?.onLoad;
		if (typeof loadAccountB !== "function") {
			throw new Error("history control did not expose a load callback");
		}
		act(() => loadAccountB());
		await act(async () => {
			resolveAccountB!([{ id: "conversation-b", title: "B", mtime: 2 }]);
			await accountBResult;
		});
		await waitFor(() =>
			expect(mocks.historyProps?.conversations).toEqual([
				{ id: "conversation-b", title: "B", mtime: 2 },
			]),
		);

		await act(async () => {
			resolveAccountA!([{ id: "conversation-a", title: "A", mtime: 1 }]);
			await accountAResult;
		});
		expect(mocks.historyProps?.conversations).toEqual([
			{ id: "conversation-b", title: "B", mtime: 2 },
		]);
	});
});

const switchCredentialMock = () =>
	vi
		.fn<
			(
				agentId: string,
				targetCredentialId: string | null,
			) => Promise<AgentCredentialTransitionResult>
		>()
		.mockResolvedValue({ kind: "completed", conversationId: null });

describe("StructuredAgentPanel usage-limit handoff", () => {
	const NOW_SEC = Math.floor(Date.now() / 1000);
	const failedAt = Date.now() + 60_000;
	const failedTurnPage = {
		latestFailure: { itemId: "item-2", createdAtMs: failedAt, reason: "usage_limit", userInput: "finish the report" },
		rows: [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "item-1",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1_000,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 15 },
				item: {
					itemId: "item-15",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "message", role: "user", markdown: "finish the report" },
					createdAtMs: 1_500,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 2 },
				item: {
					itemId: "item-2",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_failed", detail: "usage_limit" },
					// Newer than any mount in this file: the automatic move only
					// acts on a failure that happened while the pane was up.
					createdAtMs: failedAt,
				},
			},
		],
	};
	const pinnedAgent = agentFixture({
		...agent,
		id: "agent-handoff",
		provider: "codex",
		credentialId: "acc-a",
	});

	beforeEach(() => {
		mocks.autoSwitch = true;
		mocks.chatSend.mockReset().mockResolvedValue(undefined);
		mocks.accounts = [
			{ id: "acc-a", provider: "codex", name: "personal", dir: "/accounts/codex-personal" },
			{ id: "acc-b", provider: "codex", name: "work", dir: "/accounts/codex-work" },
		];
		mocks.usageRecent.mockReset().mockResolvedValue({
			claude: {},
			codex: {},
			claudeAccounts: [],
			codexAccounts: [],
			codexAccountSnapshots: [
				{
					credentialId: "acc-b",
					capturedAt: NOW_SEC - 60,
					attemptedAt: NOW_SEC - 60,
					error: null,
					rateLimits: [{ limitId: "codex", limitName: null, usedPercent: 20, usedPercentWeekly: 10, resetsAt: NOW_SEC + 3600, weeklyResetsAt: null }],
				},
			],
		});
		mocks.chatHook.mockReturnValue({
			phase: "ready",
			reconnecting: false,
			sending: false,
			interrupting: false,
			answeringRequestId: undefined,
			activeTurn: undefined,
			page: failedTurnPage,
			interrupt: vi.fn(),
			send: mocks.chatSend,
		});
	});

	afterEach(cleanup);

	function pinnedPanel(switchCredential: ReturnType<typeof switchCredentialMock>, id = "agent-handoff") {
		return (
			<StructuredAgentPanel
				agent={{ ...pinnedAgent, id }}
				profile={profile}
				panelProps={{ ...panelProps, api: { ...panelProps.api, id: `agent:${id}` } } as AgentPanelDockProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={switchCredential}
				switchToNativeTerminal={vi.fn()}
			/>
		);
	}

	function renderPinned(switchCredential: ReturnType<typeof switchCredentialMock>, id = "agent-handoff") {
		return render(pinnedPanel(switchCredential, id));
	}

	function resendFromSurface() {
		return (mocks.chatProps?.recovery as
			| { handedOff?: { resend?: () => Promise<void> } }
			| undefined)?.handedOff?.resend;
	}

	it.each(["handoff", "switch_account:acc-b"])("retains a background failure for a later pane and recovers through %s", async (action) => {
		const id = `background-failure-${action}`;
		const previous = useStore.getState();
		const transition = vi.spyOn(credentialTransition, "requestAgentCredentialTransition");
		let reject!: (error: Error) => void;
		transition.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
		useStore.setState({ agents: [{ ...pinnedAgent, id }], accounts: mocks.accounts, autoSwitchAccounts: true });
		const resume = vi.spyOn(usageResume, "resumeUsageLimitTurn");
		try {
			const host = render(<AgentUsageLimitHandoffHost />);
			await waitFor(() => expect(transition).toHaveBeenCalledOnce());
			const recover = switchCredentialMock();
			let pane = renderPinned(recover, id);
			expect(paneActionSnapshot(`agent:${id}`)?.actions).not.toContain("handoff");
			expect(resendFromSurface()).toBeUndefined();
			pane.unmount();
			await act(async () => reject(new Error("Replacement account unavailable")));
			pane = renderPinned(recover, id);
			await waitFor(() => expect(paneActionSnapshot(`agent:${id}`)?.actions).toContain("handoff"));
			expect(paneActionSnapshot(`agent:${id}`)?.error).toBe("Replacement account unavailable");
			expect(mocks.accountProps?.failure).toBe("Replacement account unavailable");
			expect(transition).toHaveBeenCalledOnce();
			expect(recover).not.toHaveBeenCalled();
			expect(resume).not.toHaveBeenCalled();
			let finishRecovery!: (result: AgentCredentialTransitionResult) => void;
			recover.mockImplementationOnce(() => new Promise((resolve) => { finishRecovery = resolve; }));
			let recovery!: ReturnType<typeof invokePaneAction>;
			act(() => { recovery = invokePaneAction(`agent:${id}`, action); });
			expect(paneActionSnapshot(`agent:${id}`)?.actions).not.toContain("handoff");
			expect(resendFromSurface()).toBeUndefined();
			expect(mocks.accountProps?.failure).toBeUndefined();
			await act(async () => {
				finishRecovery({ kind: "completed", conversationId: "conversation-1" });
				await expect(recovery).resolves.toMatchObject({ ok: true });
			});
			await waitFor(() => expect(paneActionSnapshot(`agent:${id}`)?.actions).toContain("resend_last_message"));
			expect(mocks.accountProps?.failure).toBeUndefined();
			expect(paneActionSnapshot(`agent:${id}`)?.error).toBeUndefined();
			expect(recover).toHaveBeenCalledExactlyOnceWith(id, "acc-b");
			expect(transition).toHaveBeenCalledOnce();
			expect(resume).not.toHaveBeenCalled();
			expect(mocks.chatSend).not.toHaveBeenCalled();
			pane.unmount();
			host.unmount();
		} finally {
			cleanup();
			transition.mockRestore();
			resume.mockRestore();
			useStore.setState({ agents: previous.agents, accounts: previous.accounts, autoSwitchAccounts: previous.autoSwitchAccounts });
		}
	});

	it.each(["accepted", "uncertain"] as const)("does not offer GUI or CLI resend during or after automatic %s delivery", async (outcome) => {
		const id = `automatic-resume-${outcome}`;
		let finish!: (state: usageResume.UsageLimitResumeResult) => void;
		const resume = vi.spyOn(usageResume, "resumeUsageLimitTurn").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
		try {
			const transition = switchCredentialMock();
			const view = renderPinned(transition, id);
			await waitFor(() => expect(resume).toHaveBeenCalledOnce());
			expect(paneActionSnapshot(`agent:${id}`)?.actions).not.toContain("resend_last_message");
			expect(resendFromSurface()).toBeUndefined();
			await act(async () => finish(outcome));
			view.rerender(pinnedPanel(transition, id));
			expect(paneActionSnapshot(`agent:${id}`)?.actions).not.toContain("resend_last_message");
			expect(resendFromSurface()).toBeUndefined();
			expect(mocks.chatSend).not.toHaveBeenCalled();
		} finally {
			resume.mockRestore();
		}
	});

	it.each(["gui", "cli"])("awaits the retained failed message through the shared resend handler (%s)", async (surface) => {
		const id = `resend-awaited-${surface}`;
		renderPinned(switchCredentialMock(), id);
		await waitFor(() => expect(paneActionSnapshot(`agent:${id}`)?.actions).toContain("resend_last_message"));
		let finish!: () => void;
		mocks.chatSend.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
		let settled = false;
		const request = surface === "gui"
			? resendFromSurface()?.()
			: invokePaneAction(`agent:${id}`, "resend_last_message");
		expect(request).toBeInstanceOf(Promise);
		const observed = request?.then(() => { settled = true; });
		expect(mocks.chatSend).toHaveBeenCalledExactlyOnceWith("finish the report");
		await Promise.resolve();
		expect(settled).toBe(false);
		finish();
		await observed;
		expect(settled).toBe(true);
	});

	it.each(["gui", "cli"])("propagates a refused resend without a fresh submission (%s)", async (surface) => {
		const id = `resend-refused-${surface}`;
		renderPinned(switchCredentialMock(), id);
		await waitFor(() => expect(paneActionSnapshot(`agent:${id}`)?.actions).toContain("resend_last_message"));
		mocks.chatSend.mockRejectedValue(new Error("agent_chat_turn_already_pending"));
		if (surface === "gui") {
			await expect(resendFromSurface()?.()).rejects.toThrow("agent_chat_turn_already_pending");
		} else {
			await expect(invokePaneAction(`agent:${id}`, "resend_last_message")).resolves.toMatchObject({
				ok: false, error: { code: "pane_action_failed", message: "agent_chat_turn_already_pending" },
			});
		}
		expect(mocks.chatSend).toHaveBeenCalledExactlyOnceWith("finish the report");
	});

	it.each([
		["sending", { sending: true }],
		["uncertain submission", { retryTurnAvailable: true }],
		["reconnecting", { reconnecting: true }],
		["not ready", { phase: "connecting" }],
		["active turn", { activeTurn: { turnId: "next-turn" } }],
		["missing retained input", { page: { latestFailure: { ...failedTurnPage.latestFailure, userInput: null }, rows: failedTurnPage.rows.filter((row) => row.item.body.type !== "message") } }],
		["newer user input", { page: { latestFailure: null, rows: [...failedTurnPage.rows, failedTurnPage.rows[1]] } }],
	])("removes GUI and CLI resend together when %s", async (label, patch) => {
		const id = `resend-eligibility-${label}`;
		const switchCredential = switchCredentialMock();
		const view = renderPinned(switchCredential, id);
		await waitFor(() => expect(paneActionSnapshot(`agent:${id}`)?.actions).toContain("resend_last_message"));
		expect(resendFromSurface()).toEqual(expect.any(Function));
		const snapshots = mocks.chatHook.mock.results;
		mocks.chatHook.mockReturnValue({ ...snapshots[snapshots.length - 1]?.value, ...patch });
		view.rerender(pinnedPanel(switchCredential, id));
		expect(paneActionSnapshot(`agent:${id}`)?.actions).not.toContain("resend_last_message");
		expect(resendFromSurface()).toBeUndefined();
		expect(mocks.chatSend).not.toHaveBeenCalled();
	});

	it("hands the pane off once to the account with the lowest fresh usage", async () => {
		const switchCredential = switchCredentialMock();
		const view = renderPinned(switchCredential);
		await waitFor(() =>
			expect(switchCredential).toHaveBeenCalledWith("agent-handoff", "acc-b"),
		);
		// A rerender with the same failed row must not fire again.
		view.rerender(
			<StructuredAgentPanel
				agent={{ ...pinnedAgent, name: "renamed" }}
				profile={profile}
				panelProps={{ ...panelProps, api: { ...panelProps.api, id: "agent:agent-handoff" } } as AgentPanelDockProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={switchCredential}
				switchToNativeTerminal={vi.fn()}
			/>,
		);
		await act(async () => {});
		expect(switchCredential).toHaveBeenCalledTimes(1);
		// The episode is over for this pane: pane state no longer reports the
		// failure and offers no handoff back to the account it just left.
		await waitFor(() =>
			expect(paneActionSnapshot("agent:agent-handoff")?.error).toBeUndefined(),
		);
		expect(paneActionSnapshot("agent:agent-handoff")?.actions).toEqual([
			"resend_last_message",
			"switch_account:acc-b",
			"switch_account:default",
			"switch_runtime:terminal",
		]);
		// The surface is told what happened and can resend the failed message.
		const recovery = mocks.chatProps?.recovery as
			| { handedOff?: { fromName?: string; toName: string; resend?: () => void } }
			| undefined;
		expect(recovery?.handedOff).toMatchObject({ fromName: "personal", toName: "work" });
		mocks.chatSend.mockReset().mockResolvedValue(undefined);
		recovery?.handedOff?.resend?.();
		expect(mocks.chatSend).toHaveBeenCalledWith("finish the report");
	});

	it("does not move the pane by itself for a failure replayed from before it mounted", async () => {
		mocks.chatHook.mockReturnValue({
			phase: "ready",
			reconnecting: false,
			sending: false,
			interrupting: false,
			answeringRequestId: undefined,
			activeTurn: undefined,
			page: {
				latestFailure: { ...failedTurnPage.latestFailure, createdAtMs: Date.now() - 60_000 },
				rows: failedTurnPage.rows.map((row) =>
					row.item.itemId === "item-2"
						? { ...row, item: { ...row.item, createdAtMs: Date.now() - 60_000 } }
						: row,
				),
			},
			interrupt: vi.fn(),
		});
		const switchCredential = switchCredentialMock();
		renderPinned(switchCredential, "agent-replayed");
		await waitFor(() =>
			expect(paneActionSnapshot("agent:agent-replayed")?.actions).toContain("handoff"),
		);
		expect(switchCredential).not.toHaveBeenCalled();
		await expect(invokePaneAction("agent:agent-replayed", "handoff")).resolves.toMatchObject({
			ok: true,
		});
		expect(switchCredential).toHaveBeenCalledWith("agent-replayed", "acc-b");
	});

	it("with the opt-in off it names the target but never moves by itself", async () => {
		mocks.autoSwitch = false;
		const switchCredential = switchCredentialMock();
		renderPinned(switchCredential, "agent-optout");
		await waitFor(() =>
			expect(paneActionSnapshot("agent:agent-optout")?.actions).toEqual([
				"handoff",
				"switch_account:acc-b",
				"switch_account:default",
				"switch_runtime:terminal",
			]),
		);
		expect(paneActionSnapshot("agent:agent-optout")?.error).toBe("turn_failed:usage_limit");
		expect(switchCredential).not.toHaveBeenCalled();
		// An operating agent can still move the pane explicitly.
		await expect(invokePaneAction("agent:agent-optout", "switch_account:acc-b")).resolves.toEqual({
			ok: true,
			paneId: "agent:agent-optout",
			action: "switch_account:acc-b",
		});
		expect(switchCredential).toHaveBeenCalledWith("agent-optout", "acc-b");
	});

	it("continues through the registered alternative when usage readings are missing", async () => {
		mocks.usageRecent.mockResolvedValue({
			claude: {},
			codex: {},
			claudeAccounts: [],
			codexAccounts: [],
			codexAccountSnapshots: [],
		});
		const switchCredential = switchCredentialMock();
		renderPinned(switchCredential, "agent-stale");
		await waitFor(() =>
			expect(switchCredential).toHaveBeenCalledExactlyOnceWith("agent-stale", "acc-b"),
		);
		await waitFor(() =>
			expect(paneActionSnapshot("agent:agent-stale")?.error).toBeUndefined(),
		);
		expect(paneActionSnapshot("agent:agent-stale")?.actions).toContain("resend_last_message");
	});
});

describe("StructuredAgentPanel runtime switch action", () => {
	afterEach(cleanup);

	it.each(["runtime", "conversation", "name"])(
		"keeps a claimed profile switch on its committed recipient (%s)",
		async (change) => {
			mocks.chatHook.mockReturnValue({
				phase: "ready",
				reconnecting: false,
				sending: false,
				interrupting: false,
				page: { rows: [] },
				interrupt: vi.fn(),
			});
			const next =
				change === "runtime"
					? {
							...agent,
							interactionProfile: {
								...profile,
								interactionSessionId: "replacement-interaction",
							},
						}
					: change === "conversation"
						? { ...agent, conversationId: "replacement-conversation" }
						: { ...agent, name: "updated name" };
			const switchToNativeTerminal = vi.fn().mockResolvedValue(undefined);
			const paneId = "pane-profile-claim";
			const props = {
				agent,
				profile,
				panelProps: {
					...panelProps,
					api: { ...panelProps.api, id: paneId },
				} as AgentPanelDockProps,
				launchSelection,
				onRuntimeInvalidated: vi.fn(),
				switchCredential: vi.fn(),
				switchToNativeTerminal,
			};
			const view = render(<StructuredAgentPanel {...props} />);
			const complete = vi.fn(async () => {});
			await dispatchCliPaneActionRequest(
				{
					reqId: "profile-claim",
					action: "pane.act",
					params: { targetPanelId: paneId, actionId: "switch_runtime:terminal" },
				},
				{
					claim: async () => {
						act(() =>
							view.rerender(
								<StructuredAgentPanel
									{...props}
									agent={next}
									profile={next.interactionProfile!}
								/>,
							),
						);
						return true;
					},
					complete,
					isFallbackWindow: () => false,
					delay: async () => {},
				},
			);
			if (change === "name") {
				expect(switchToNativeTerminal).toHaveBeenCalledExactlyOnceWith(
					agent.id,
					"preserve",
					undefined,
				);
				expect(complete).toHaveBeenCalledWith(
					"profile-claim",
					expect.objectContaining({ ok: true }),
					"pane.act",
				);
			} else {
				expect(switchToNativeTerminal).not.toHaveBeenCalled();
				expect(complete).toHaveBeenCalledWith(
					"profile-claim",
					{ ok: false, error: expect.objectContaining({ code: "pane_changed" }) },
					"pane.act",
				);
			}
		},
	);

	it("exposes the toolbar's Switch to Terminal as switch_runtime:terminal with preserve", async () => {
		mocks.chatHook.mockReturnValue({
			phase: "ready",
			reconnecting: false,
			sending: false,
			interrupting: false,
			answeringRequestId: undefined,
			activeTurn: undefined,
			page: { rows: [] },
			interrupt: vi.fn(),
		});
		const switchToNativeTerminal = vi.fn().mockResolvedValue(undefined);
		render(
			<StructuredAgentPanel
				agent={{ ...agent, id: "agent-runtime" }}
				profile={profile}
				panelProps={{ ...panelProps, api: { ...panelProps.api, id: "agent:agent-runtime" } } as AgentPanelDockProps}
				launchSelection={launchSelection}
				onRuntimeInvalidated={vi.fn()}
				switchCredential={vi.fn()}
				switchToNativeTerminal={switchToNativeTerminal}
			/>,
		);
		await expect(invokePaneAction("agent:agent-runtime", "switch_runtime:terminal")).resolves.toEqual({
			ok: true,
			paneId: "agent:agent-runtime",
			action: "switch_runtime:terminal",
		});
		expect(switchToNativeTerminal).toHaveBeenCalledWith(
			"agent-runtime",
			"preserve",
			undefined,
		);
	});
});
