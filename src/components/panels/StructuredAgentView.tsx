import { type ComponentProps, type ReactNode, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { AccountsDialog } from "@/components/agents/AccountsDialog";
import type { AgentForkPresenter } from "@/components/agents/AgentContextMenu";
import { AgentConversationHistoryControl } from "@/components/agents/AgentConversationHistoryControl";
import { AgentCredentialSwitcher } from "@/components/agents/AgentCredentialSwitcher";
import { AgentProjectMove } from "@/components/agents/AgentProjectMove";
import { AgentRuntimeProfileSwitch } from "@/components/agents/AgentRuntimeProfileSwitch";
import type { ChatTurnFailureRecovery } from "@/components/agents/chat/ChatComposer";
import { StructuredAgentChatSurface } from "@/components/agents/chat/StructuredAgentChatSurface";
import {
	AgentToolbarSurfaceProvider,
	useAgentToolbarControls,
	useAgentToolbarGroupPresentation,
} from "@/components/agents/useAgentToolbarControls";
import { AgentPanelToolbarFrame } from "@/components/panels/AgentPanelToolbarFrame";
import { AgentPanelWindowActions } from "@/components/panels/AgentPanelWindowActions";
import { useStructuredAgentPanelState } from "@/components/panels/useAgentPanelState";
import { Alert } from "@/components/ui/alert";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import type { AgentProjectMovePort } from "@/lib/agents/agentProjectMoveTypes";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type {
	StructuredAgentPaneCommand,
	StructuredAgentPaneSurface,
} from "@/lib/agents/chat/structuredAgentPaneSurface";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import {
	supportsAccounts,
	supportsStructuredChat,
} from "@/lib/agents/providers";
import { t } from "@/lib/i18n";
import { agentRuntimeTransitionRefusalError } from "@/lib/ipc/dureAgentRuntime";
import type { AgentToolbarSurface } from "@/lib/workspace/pane/agentToolbarControls";
import type { Agent } from "@/types";

const WINDOW_ACTION_CONTROL_IDS = [
	"diff-window",
	"source-control-window",
] as const;

/** What differs between the surfaces that render one Chat Agent: where its
 * pane-owned state comes from and where its actions run. The pane passes its
 * own surface; the large window passes the one it mirrors from the pane. */
export interface StructuredAgentViewRuntime {
	readonly surface: AgentToolbarSurface;
	/** Set when the window that owns the pane cannot be reached; every control
	 * that runs there is disabled with this title. */
	readonly sourceUnavailableTitle?: string;
	/** The pane's presentation and commands. */
	readonly pane: StructuredAgentPaneSurface;
	readonly presentFork: AgentForkPresenter;
	readonly projectMove: AgentProjectMovePort;
	/** A move this surface started that the pane's presentation does not
	 * already report. */
	readonly transitioning: boolean;
	setTransitioning(busy: boolean): void;
	/** Pane-only until AGENT_TOOLBAR_CONTROLS offers it on the large window. */
	readonly history?: Omit<
		ComponentProps<typeof AgentConversationHistoryControl>,
		"agent" | "binding"
	>;
	/** Pane presence indicators that are not toolbar controls. */
	readonly paneStatus?: ReactNode;
	/** Composer inputs only the pane owns. */
	readonly composer?: {
		readonly paneApi: IDockviewPanelProps["api"];
		readonly launchSelection: AgentRuntimeLaunchSelectionView;
		readonly catalogSource?: ProviderCatalogSource;
	};
}

/** A Chat Agent's toolbar, conversation and recoveries, rendered by its pane
 * and by its large window. Which controls render, in which order and under
 * which capability checks is decided once, here, for both. */
export function StructuredAgentView(props: {
	agent: Agent;
	session: AgentChatSessionView;
	runtime: StructuredAgentViewRuntime;
	onReady?: () => void;
	/** Replaces the conversation, as the pane does while its large window
	 * presents it. */
	body?: ReactNode;
}) {
	return (
		<AgentToolbarSurfaceProvider value={props.runtime.surface}>
			<StructuredAgentViewContent {...props} />
		</AgentToolbarSurfaceProvider>
	);
}

function StructuredAgentViewContent({
	agent,
	session,
	runtime,
	onReady,
	body,
}: {
	agent: Agent;
	session: AgentChatSessionView;
	runtime: StructuredAgentViewRuntime;
	onReady?: () => void;
	body?: ReactNode;
}) {
	const runtimeOwnerKey = agentRuntimePresentationOwnerKey(agent);
	const { project, accounts, sshHosts } = useStructuredAgentPanelState(agent);
	const toolbarControls = useAgentToolbarControls();
	const windowActionsPresentation = useAgentToolbarGroupPresentation(
		WINDOW_ACTION_CONTROL_IDS,
	);
	const [accountsOpen, setAccountsOpen] = useState(false);
	// Failures of commands this surface sent that the pane does not present
	// itself, such as one that never reached the pane's window.
	const [localFailure, setLocalFailure] = useState<{
		readonly scope: "account" | "conversation";
		readonly message: string;
	}>();
	const { presentation, run } = runtime.pane;
	const { sourceUnavailableTitle } = runtime;
	const locked = runtime.transitioning || sourceUnavailableTitle !== undefined;
	const send = (
		command: StructuredAgentPaneCommand,
		scope: "account" | "conversation",
	) => {
		setLocalFailure(undefined);
		void run(command).catch((error: unknown) =>
			setLocalFailure({
				scope,
				message: error instanceof Error ? error.message : String(error),
			}),
		);
	};

	const accountPool = supportsAccounts(agent.provider)
		? accounts.filter((account) => account.provider === agent.provider)
		: [];
	const credentialReferenceId = agentCredentialReferenceId(agent);
	const currentAccount = credentialReferenceId
		? accountPool.find((account) => account.id === credentialReferenceId)
		: undefined;
	const recoveryAccount = presentation.recoveryAccountId
		? accountPool.find((account) => account.id === presentation.recoveryAccountId)
		: undefined;
	const remoteHost =
		project?.kind === "ssh"
			? sshHosts.find((host) => host.id === project.sshHostId)
			: undefined;
	const accountFailure =
		presentation.accountFailure ??
		(localFailure?.scope === "account" ? localFailure.message : undefined);
	const conversationFailure =
		(localFailure?.scope === "conversation"
			? localFailure.message
			: undefined) ?? presentation.conversationFailure;
	const dismissConversationFailure = () => {
		if (localFailure?.scope === "conversation") {
			setLocalFailure(undefined);
			return;
		}
		send({ kind: "dismiss_conversation_failure" }, "conversation");
	};

	const recovery: ChatTurnFailureRecovery | undefined = presentation.recovery
		? {
				// The pane's own switch to the account the handoff policy chose
				// from fresh observed usage — never the global active account.
				...(presentation.recovery.switchAccountTarget
					? {
							switchAccount: {
								targetName: presentation.recovery.switchAccountTarget,
								run: () =>
									send({ kind: "recovery_switch_account" }, "account"),
							},
						}
					: {}),
				manageAccounts: () => setAccountsOpen(true),
				// The episode was already answered by a handoff: say so, and
				// offer the failed message back with one click.
				...(presentation.recovery.handedOff
					? {
							handedOff: {
								...(presentation.recovery.handedOff.fromName !== undefined
									? { fromName: presentation.recovery.handedOff.fromName }
									: {}),
								toName: presentation.recovery.handedOff.toName,
								...(presentation.recovery.handedOff.resend
									? {
											resend: async () => {
												await run({ kind: "resend_last_message" });
											},
										}
									: {}),
							},
						}
					: {}),
				// Remote panes sign in on the host through the account switcher
				// instead of a local terminal.
				...(presentation.recovery.signIn
					? { signIn: () => send({ kind: "sign_in" }, "conversation") }
					: {}),
			}
		: undefined;

	return (
		<div className="flex h-full flex-col">
			<AgentPanelToolbarFrame agent={agent} hmux presentFork={runtime.presentFork}>
				{runtime.paneStatus}
				{supportsStructuredChat(agent.provider) &&
					supportsAccounts(agent.provider) &&
					toolbarControls.visible("account", {
						mustShow: !!accountFailure,
					}) &&
					toolbarControls.slot(
						"account",
						<AgentCredentialSwitcher
							agentId={agent.id}
							provider={agent.provider}
							accounts={accountPool}
							currentAccount={currentAccount}
							recoveryAccount={recoveryAccount}
							followsGlobal={false}
							failure={accountFailure}
							hostName={remoteHost?.name}
							accountBusy={presentation.accountBusy}
							allowCurrentAccountReselect={session.phase !== "ready"}
							disabled={presentation.accountMovesLocked || locked}
							disabledTitle={sourceUnavailableTitle ?? t("common.paneAccount")}
							onSwitch={(accountId) =>
								send({ kind: "switch_account", accountId }, "account")
							}
							onApplyNow={() => {}}
							onCancel={() => {}}
							onRemoteLogin={(account) =>
								send({ kind: "remote_login", accountId: account.id }, "account")
							}
							onCopyToHost={(account) =>
								send({ kind: "copy_to_host", accountId: account.id }, "account")
							}
							onManageAccounts={() => setAccountsOpen(true)}
						/>,
					)}
				{supportsStructuredChat(agent.provider) &&
					toolbarControls.visible("view-switch") &&
					toolbarControls.slot(
						"view-switch",
						<AgentRuntimeProfileSwitch
							key={`runtime-profile:${runtimeOwnerKey}`}
							target="terminal"
							disabled={presentation.runtimeSwitchLocked || locked}
							disabledTitle={
								sourceUnavailableTitle ??
								(presentation.runtimeSwitchBusy ? t("common.loading") : undefined)
							}
							onSwitch={async (sourceStopPolicy, expectedSourceRevision) => {
								const outcome = await run({
									kind: "switch_to_terminal",
									sourceStopPolicy,
									...(expectedSourceRevision !== undefined
										? { expectedSourceRevision }
										: {}),
								});
								// The pane's refusal, as its own control would see it.
								if (outcome?.kind === "runtime_transition_refused")
									throw agentRuntimeTransitionRefusalError(outcome.refusal);
							}}
						/>,
					)}
				{supportsStructuredChat(agent.provider) &&
					toolbarControls.visible("project-move") &&
					toolbarControls.slot(
						"project-move",
						<AgentProjectMove
							key={`project-move:${runtimeOwnerKey}`}
							port={runtime.projectMove}
							disabled={
								presentation.accountMovesLocked ||
								locked ||
								!!agent.pendingCmd ||
								!!agent.pendingCredentialSwitch
							}
							disabledTitle={sourceUnavailableTitle}
							onBusyChange={runtime.setTransitioning}
						/>,
					)}
				<AgentPanelWindowActions
					agent={agent}
					project={project}
					showDiff={project?.kind !== "ssh"}
					presentation={windowActionsPresentation}
				/>
				{runtime.history &&
					toolbarControls.visible("conversation-history") &&
					toolbarControls.slot(
						"conversation-history",
						<AgentConversationHistoryControl
							key={`conversation-history:${runtimeOwnerKey}`}
							{...runtime.history}
							agent={agent}
							binding={undefined}
						/>,
					)}
			</AgentPanelToolbarFrame>
			<div className="relative min-h-0 flex-1">
				{body ?? (
					<StructuredAgentChatSurface
						session={session}
						paneApi={runtime.composer?.paneApi}
						disabled={presentation.inputLocked || locked}
						attachmentsEnabled={project?.kind === "local"}
						launchSelection={runtime.composer?.launchSelection}
						catalogSource={runtime.composer?.catalogSource}
						onReady={onReady}
						onNewConversation={
							presentation.newConversation && !locked
								? () => send({ kind: "new_conversation" }, "conversation")
								: undefined
						}
						recovery={recovery}
					/>
				)}
				{conversationFailure && (
					<Alert
						surface="dock"
						className="absolute inset-x-2 top-2 z-20"
						dismiss={{
							label: t("common.close"),
							onClick: dismissConversationFailure,
						}}
					>
						<span className="min-w-0 flex-1">{conversationFailure}</span>
					</Alert>
				)}
			</div>
			{accountsOpen && (
				<AccountsDialog onClose={() => setAccountsOpen(false)} />
			)}
		</div>
	);
}
